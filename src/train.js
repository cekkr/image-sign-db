#!/usr/bin/env node

// --- LIBRARIES ---
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
require('dotenv').config();

// --- INTERNAL MODULES ---
const { bootstrapCorrelations } = require('./insert');
const { generateSpecificVector, AUGMENTATION_ORDER } = require('./featureExtractor');
const settings = require('./settings');
const { createDbConnection, discoverCorrelations } = require('./lib/knowledge');
const { CHANNEL_DIMENSIONS, CONSTELLATION_CONSTANTS } = require('./lib/constants');
const { euclideanDistance, scoreCandidateFeature } = require('./lib/correlationMetrics');
const { createDescriptorKey, serializeDescriptor, parseDescriptor } = require('./lib/descriptor');
const { extendConstellationPath, descriptorToSpec } = require('./lib/constellation');
const { resolveDefaultProbeSpec } = require('./lib/vectorSpecs');
const { createSeededRandom } = require('./lib/augmentations');

let cliProgress;
try {
  // Optional dependency for richer progress reporting.
  cliProgress = require('cli-progress');
} catch {
  cliProgress = null;
}

// --- HELPERS ---

const VALUE_THRESHOLD = settings.search.valueThreshold;
const TRAINING_DEFAULT_OPTIONS = {
  discover: settings.training.defaults.discover,
  bootstrap: settings.training.defaults.bootstrap,
  reprobe: settings.training.defaults.reprobe,
  shuffle: settings.training.defaults.shuffle,
  threads: settings.training.defaults.threads,
};
const EVALUATION_DEFAULT_OPTIONS = {
  runs: 3,
  top: 5,
  filters: ['original', 'gaussian_blur', 'cropping'],
};
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const KNOWN_AUGMENTATIONS = new Set(AUGMENTATION_ORDER);
const EVALUATION_FILTER_ALIASES = new Map([
  ['mirror', 'mirror_horizontal'],
  ['mirror-h', 'mirror_horizontal'],
  ['mirror-horizontal', 'mirror_horizontal'],
  ['mirror_v', 'mirror_vertical'],
  ['mirror-v', 'mirror_vertical'],
  ['mirror-vertical', 'mirror_vertical'],
  ['blur', 'gaussian_blur'],
]);
const WORKER_SCRIPT = path.resolve(__dirname, 'workers/ingestWorker.js');
const RESOURCE_SAMPLE_INTERVAL_MS = settings.training.resourceSampleIntervalMs;

async function* walkDir(dir, exts) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full, exts);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (!exts || exts.has(ext)) yield full;
    }
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    ...TRAINING_DEFAULT_OPTIONS,
    evaluate: false,
    evaluateRuns: EVALUATION_DEFAULT_OPTIONS.runs,
    evaluateTop: EVALUATION_DEFAULT_OPTIONS.top,
    evaluateFilters: [...EVALUATION_DEFAULT_OPTIONS.filters],
  };
  const positional = [];
  for (const token of args) {
    if (token.startsWith('--')) {
      const [k, v] = token.slice(2).split('=');
      const key = k.trim();
      const val = v === undefined ? true : v;
      if (key === 'discover' || key === 'bootstrap' || key === 'reprobe') {
        options[key] = Number(val) || 0;
      } else if (key === 'shuffle') {
        options.shuffle = val !== 'false';
      } else if (key === 'pattern') {
        options.pattern = String(val);
      } else if (key === 'threads') {
        options.threads = Number(val) || 0;
      } else if (key === 'evaluate') {
        options.evaluate = val !== 'false';
      } else if (key === 'evaluate-runs' || key === 'evaluateRuns') {
        const runs = Number(val);
        if (Number.isFinite(runs) && runs > 0) options.evaluateRuns = Math.floor(runs);
      } else if (key === 'evaluate-top' || key === 'evaluateTop') {
        const top = Number(val);
        if (Number.isFinite(top) && top > 0) options.evaluateTop = Math.floor(top);
      } else if (key === 'evaluate-filters' || key === 'evaluateFilters') {
        const filters = String(val)
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (filters.length > 0) options.evaluateFilters = filters;
      }
    } else {
      positional.push(token);
    }
  }
  return { dir: positional[0], options };
}

function sampleResources() {
  const cpuInfo = typeof os.cpus === 'function' ? os.cpus() : [];
  const cpuCount = Math.max(1, Array.isArray(cpuInfo) ? cpuInfo.length : 1);
  const load = os.loadavg ? os.loadavg()[0] : 0;
  const normalizedLoad = cpuCount ? load / cpuCount : 0;
  const totalMem = os.totalmem() || 1;
  const freeMem = os.freemem();
  const freeMemRatio = Math.max(0, Math.min(1, freeMem / totalMem));
  const rss = process.memoryUsage().rss;
  return { cpuCount, normalizedLoad, freeMemRatio, rss };
}

function computeDesiredWorkerCount(currentWorkers, resources, limits, pendingCount) {
  if (pendingCount <= 0) return 0;
  const { cpuCount, normalizedLoad, freeMemRatio } = resources;
  const safeMax = Math.max(limits.min, Math.min(limits.max, Math.max(1, cpuCount - 1)));
  let target = Math.min(safeMax, Math.max(limits.min, Math.round(cpuCount * 0.75)));

  if (normalizedLoad > 1.1) target = Math.max(limits.min, target - 2);
  else if (normalizedLoad > 0.9) target = Math.max(limits.min, target - 1);

  if (freeMemRatio < 0.1) target = Math.max(limits.min, target - 2);
  else if (freeMemRatio < 0.18) target = Math.max(limits.min, target - 1);

  if (normalizedLoad < 0.35 && freeMemRatio > 0.25 && target < safeMax) target += 1;
  if (normalizedLoad < 0.22 && freeMemRatio > 0.4 && target < safeMax) target += 1;

  target = Math.min(target, pendingCount);
  return Math.max(limits.min, target);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class OnlineCorrelationRunner {
  constructor({ maxBatchSize = settings.correlation.onlineRunnerMaxBatchSize, similarityThreshold = settings.correlation.similarityThreshold } = {}) {
    this.maxBatchSize = Math.max(1, maxBatchSize);
    this.similarityThreshold = similarityThreshold;
    this.pendingIterations = 0;
    this.running = false;
    this.history = [];
    this.warnedInsufficient = false;
  }

  enqueue(iterations) {
    if (!iterations || iterations <= 0) return;
    this.pendingIterations += iterations;
    void this.process();
  }

  async process() {
    if (this.running || this.pendingIterations <= 0) return;
    this.running = true;
    try {
      while (this.pendingIterations > 0) {
        const batchIterations = Math.min(this.pendingIterations, this.maxBatchSize);
        this.pendingIterations -= batchIterations;
        const batchMetrics = [];

        try {
          await discoverCorrelations({
            iterations: batchIterations,
            similarityThreshold: this.similarityThreshold,
            onIterationStart: (iteration, total) => {
              if (iteration === 1) {
                console.log(`\n🔎 Running ${batchIterations} online correlation iteration(s)...`);
              }
            },
            onDiscriminatorSelected: ({ metrics, ambiguousCandidates }) => {
              if (!metrics) return;
              batchMetrics.push({
                score: metrics.score ?? 0,
                affinity: metrics.affinity ?? 0,
                spread: metrics.spread ?? 0,
                meanDistance: metrics.meanDistance ?? 0,
                stdDistance: metrics.stdDistance ?? 0,
                sampleSize: metrics.sampleSize ?? 0,
                candidates: ambiguousCandidates ?? 0,
              });
            },
          });
          this.warnedInsufficient = false;
        } catch (error) {
          if (error && /requires at least two images/i.test(error.message)) {
            if (!this.warnedInsufficient) {
              console.log('   ⏳ Waiting for a larger image set before running correlations...');
              this.warnedInsufficient = true;
            }
            break;
          } else {
            console.warn(`⚠️  Online correlation failed: ${error.message}`);
          }
        }

        if (batchMetrics.length > 0) {
          this.history.push(...batchMetrics);
          this.logBatchSummary(batchMetrics);
        }

        if (this.pendingIterations <= 0) break;
      }
    } finally {
      this.running = false;
      if (this.pendingIterations > 0) {
        setImmediate(() => void this.process());
      }
    }
  }

  logBatchSummary(batchMetrics) {
    const total = batchMetrics.reduce(
      (acc, metric) => {
        acc.score += metric.score;
        acc.affinity += metric.affinity;
        acc.spread += metric.spread;
        acc.meanDistance += metric.meanDistance;
        acc.stdDistance += metric.stdDistance;
        acc.sampleSize += metric.sampleSize;
        acc.candidates += metric.candidates;
        return acc;
      },
      {
        score: 0,
        affinity: 0,
        spread: 0,
        meanDistance: 0,
        stdDistance: 0,
        sampleSize: 0,
        candidates: 0,
      }
    );

    const count = batchMetrics.length;
    const avg = {
      score: total.score / count,
      affinity: total.affinity / count,
      spread: total.spread / count,
      meanDistance: total.meanDistance / count,
      stdDistance: total.stdDistance / count,
      sampleSize: total.sampleSize / count,
      candidates: total.candidates / count,
    };

    console.log(
      `   ↳ Avg score ${avg.score.toFixed(4)} | spread ${avg.spread.toFixed(4)} | affinity ${avg.affinity.toFixed(4)} | sample ${avg.sampleSize.toFixed(1)} | candidates ${avg.candidates.toFixed(1)}`
    );
  }

  async drain() {
    while (this.running || this.pendingIterations > 0) {
      await sleep(150);
    }
  }
}

async function ingestFilesConcurrently(files, { iterationsPerIngest = 0, maxThreads } = {}, correlationRunner) {
  if (!files || files.length === 0) return { ingested: [], failures: [] };

  const pending = [...files];
  const ingested = [];
  const failures = [];
  const workers = new Set();

  let processedCount = 0;
  let activeWorkers = 0;
  let closed = false;
  let resolveFn;

  const progressBar =
    cliProgress && process.stdout.isTTY && files.length > 0
      ? new cliProgress.SingleBar(
          {
            format: '   ↻ ingesting {value}/{total} | active {active} | queue {pending} | workers {workers} | eta {eta_formatted}',
            hideCursor: true,
            etaBuffer: 20,
          },
          cliProgress.Presets.shades_classic
        )
      : null;

  function updateProgress() {
    if (!progressBar) return;
    progressBar.update(processedCount, {
      active: activeWorkers,
      pending: pending.length,
      workers: workers.size,
    });
  }

  const resultPromise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  const cpuInfo = typeof os.cpus === 'function' ? os.cpus() : [];
  const cpuCount = Math.max(1, Array.isArray(cpuInfo) ? cpuInfo.length : 1);
  const limits = {
    min: 1,
    max: maxThreads && maxThreads > 0 ? Math.max(1, Math.min(maxThreads, 32)) : Math.max(1, Math.min(cpuCount, 8)),
  };

  function assignWork(info) {
    if (closed || info.busy || pending.length === 0) return;
    const file = pending.shift();
    if (!file) return;

    info.busy = true;
    info.currentFile = file;
    activeWorkers += 1;
    info.worker.postMessage({
      type: 'ingest',
      payload: { file, discoverIterations: 0 },
    });
    updateProgress();
  }

  async function terminateWorker(info) {
    if (!workers.has(info)) return;
    workers.delete(info);
    try {
      await info.worker.terminate();
    } catch {
      // best effort
    }
  }

  function maybeComplete() {
    if (closed) return;
    if (pending.length === 0 && activeWorkers === 0) {
      closed = true;
      clearInterval(monitor);
      if (progressBar) {
        updateProgress();
        progressBar.stop();
      }
      Promise.all([...workers].map((info) => info.worker.terminate().catch(() => {})))
        .then(() => resolveFn({ ingested, failures }))
        .catch((error) => resolveFn({ ingested, failures, error }));
    }
  }

  function handleMessage(info, message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'result') {
      activeWorkers = Math.max(0, activeWorkers - 1);
      info.busy = false;
      delete info.currentFile;
      processedCount += 1;
      ingested.push(message.payload);
      if (correlationRunner && iterationsPerIngest > 0) {
        correlationRunner.enqueue(iterationsPerIngest);
      }
      if (
        !progressBar &&
        (processedCount % 10 === 0 || processedCount === files.length)
      ) {
        console.log(
          `   ↳ Progress: ${processedCount}/${files.length} image(s) ingested (workers ${workers.size}, queue ${pending.length})`
        );
      }
      assignWork(info);
      updateProgress();
      maybeComplete();
    } else if (message.type === 'error') {
      activeWorkers = Math.max(0, activeWorkers - 1);
      info.busy = false;
      const failedFile = message.payload?.file ?? info.currentFile;
      delete info.currentFile;
      processedCount += 1;
      failures.push(message.payload ?? { message: 'Unknown worker error' });
      console.warn(
        `⚠️  Worker failed to ingest ${failedFile ?? 'unknown file'}: ${message.payload?.message ?? 'error'}`
      );
      assignWork(info);
      updateProgress();
      maybeComplete();
    }
  }

  function handleWorkerError(info, error) {
    activeWorkers = Math.max(0, activeWorkers - 1);
    info.busy = false;
    const failedFile = info.currentFile;
    delete info.currentFile;
    processedCount += 1;
    failures.push({ file: failedFile, message: error?.message ?? 'Worker crashed' });
    console.warn(`⚠️  Worker ${info.id} crashed: ${error?.message ?? 'unknown error'}`);
    terminateWorker(info).finally(() => {
      updateProgress();
      maybeComplete();
    });
  }

  let nextWorkerId = 1;

  function spawnWorker() {
    const worker = new Worker(WORKER_SCRIPT);
    const info = { id: nextWorkerId++, worker, busy: false };
    workers.add(info);

    worker.on('message', (message) => handleMessage(info, message));
    worker.on('error', (error) => handleWorkerError(info, error));
    worker.on('exit', (code) => {
      workers.delete(info);
      if (!closed && code !== 0) {
        console.warn(`⚠️  Worker ${info.id} exited with code ${code}`);
      }
      maybeComplete();
    });

    assignWork(info);
  }

  function rebalance() {
    if (closed) return;
    const resources = sampleResources();
    const target = computeDesiredWorkerCount(workers.size, resources, limits, pending.length);
    if (target > workers.size) {
      const toCreate = Math.min(target - workers.size, pending.length);
      for (let i = 0; i < toCreate; i += 1) {
        spawnWorker();
      }
    } else if (target < workers.size) {
      const idleWorkers = [...workers].filter((info) => !info.busy);
      const toRemove = Math.min(workers.size - target, idleWorkers.length);
      for (let i = 0; i < toRemove; i += 1) {
        void terminateWorker(idleWorkers[i]);
      }
    }

    for (const info of workers) {
      assignWork(info);
    }

    updateProgress();
    maybeComplete();
  }

  const monitor = setInterval(rebalance, RESOURCE_SAMPLE_INTERVAL_MS);
  if (progressBar) {
    progressBar.start(files.length, 0, {
      active: activeWorkers,
      pending: pending.length,
      workers: workers.size,
    });
  }
  rebalance();

  return resultPromise;
}

function normalizeProbeSpec(spec = {}) {
  const resolved = resolveDefaultProbeSpec(spec.descriptor ? { ...spec, random: false } : spec);
  if (!resolved) return null;

  const normalized = {
    ...resolved,
  };

  normalized.rel_x = normalized.rel_x ?? normalized.offset_x ?? 0;
  normalized.rel_y = normalized.rel_y ?? normalized.offset_y ?? 0;
  normalized.size = normalized.size ?? normalized.span ?? 0;
  normalized.anchor_u = normalized.anchor_u ?? 0.5;
  normalized.anchor_v = normalized.anchor_v ?? 0.5;
  normalized.sampleId = normalized.sampleId ?? normalized.sample_id ?? normalized.descriptor?.sample_id ?? 0;
  normalized.augmentation = normalized.augmentation ?? normalized.descriptor?.augmentation ?? 'original';
  normalized.channel = normalized.channel ?? normalized.descriptor?.channel ?? CHANNEL_DIMENSIONS[0];
  normalized.span = normalized.size ?? normalized.span ?? 0.05;
  normalized.offset_x = normalized.offset_x ?? normalized.rel_x;
  normalized.offset_y = normalized.offset_y ?? normalized.rel_y;

  normalized.pos_x = Math.round(normalized.anchor_u * CONSTELLATION_CONSTANTS.ANCHOR_SCALE);
  normalized.pos_y = Math.round(normalized.anchor_v * CONSTELLATION_CONSTANTS.ANCHOR_SCALE);
  normalized.resolution_level = Math.max(
    0,
    Math.min(255, Math.round(normalized.size * CONSTELLATION_CONSTANTS.SPAN_SCALE)),
  );

  normalized.descriptor = {
    family: 'delta',
    channel: normalized.channel,
    augmentation: normalized.augmentation,
    sample_id: normalized.sampleId,
    anchor_u: Number(normalized.anchor_u.toFixed(6)),
    anchor_v: Number(normalized.anchor_v.toFixed(6)),
    span: Number(normalized.size.toFixed(6)),
    offset_x: Number(normalized.offset_x.toFixed(6)),
    offset_y: Number(normalized.offset_y.toFixed(6)),
  };
  normalized.descriptorKey = createDescriptorKey(normalized.descriptor);

  return normalized;
}

async function ensureValueTypeRecord(db, descriptor) {
  const descriptorKey = createDescriptorKey(descriptor);
  const [rows] = await db.execute('SELECT value_type_id, descriptor_json FROM value_types WHERE descriptor_hash = ?', [descriptorKey]);
  if (rows.length > 0) return { id: rows[0].value_type_id };
  const [result] = await db.execute(
    'INSERT INTO value_types (descriptor_hash, descriptor_json) VALUES (?, ?)',
    [descriptorKey, serializeDescriptor(descriptor)]
  );
  return { id: result.insertId };
}

async function findCandidateImages(db, probe) {
  const valueTypeId = (await ensureValueTypeRecord(db, probe.descriptor)).id;
  const [rows] = await db.execute(
    `SELECT fv.vector_id, fv.image_id, fv.value_type, fv.resolution_level, fv.pos_x, fv.pos_y, fv.rel_x, fv.rel_y, fv.value, fv.size, vt.descriptor_json
     FROM feature_vectors fv
     JOIN value_types vt ON vt.value_type_id = fv.value_type
     WHERE fv.value_type = ?
       AND fv.resolution_level = ?
       AND fv.pos_x = ?
       AND fv.pos_y = ?
       AND ABS(fv.rel_x - ?) <= ?
       AND ABS(fv.rel_y - ?) <= ?`,
    [
      valueTypeId,
      probe.resolution_level,
      probe.pos_x,
      probe.pos_y,
      probe.rel_x,
      CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
      probe.rel_y,
      CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
    ]
  );

  const candidates = new Set();
  for (const row of rows) {
    const distance = euclideanDistance(
      { ...probe, value_type: valueTypeId, resolution_level: probe.resolution_level, size: probe.size },
      { value: row.value, rel_x: row.rel_x, rel_y: row.rel_y, size: row.size }
    );
    if (distance <= VALUE_THRESHOLD) candidates.add(row.image_id);
  }
  return [...candidates];
}

async function sampleRandomProbeSpec(db) {
  const [rows] = await db.execute(
    `SELECT fv.vector_id, fv.value_type, fv.resolution_level, fv.pos_x, fv.pos_y, fv.rel_x, fv.rel_y, fv.size, vt.descriptor_json
     FROM feature_vectors fv
     JOIN value_types vt ON vt.value_type_id = fv.value_type
     ORDER BY RAND()
     LIMIT 1`
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const descriptor = parseDescriptor(row.descriptor_json);
  const baseSpec = descriptorToSpec(descriptor);
  if (!baseSpec) return null;
  return normalizeProbeSpec({
    ...baseSpec,
    descriptor: descriptor ?? baseSpec.descriptor,
    descriptorKey: baseSpec.descriptorKey,
  });
}

async function reprobeOne(db, imagePath, imageId, options = {}) {
  const maxSteps = options.maxSteps ?? CHANNEL_DIMENSIONS.length;
  let constellationPath = [];
  let remaining = null;
  let steps = 0;
  const usedKeys = new Set();

  while (steps < maxSteps) {
    steps += 1;
    const probeSpec = await sampleRandomProbeSpec(db);
    if (!probeSpec) break;
    const dedupeKey = `${probeSpec.descriptorKey}:${probeSpec.resolution_level}:${probeSpec.pos_x}:${probeSpec.pos_y}`;
    if (usedKeys.has(dedupeKey)) {
      steps -= 1;
      continue;
    }
    usedKeys.add(dedupeKey);
    const vector = await generateSpecificVector(imagePath, probeSpec);
    if (!vector) continue;
    const probe = {
      ...probeSpec,
      value: vector.value,
      size: vector.size,
      descriptor: vector.descriptor ?? probeSpec.descriptor,
      descriptorKey: vector.descriptorKey ?? probeSpec.descriptorKey,
    };

    const candidates = await findCandidateImages(db, probe);
    remaining = remaining === null
      ? candidates
      : candidates.filter((id) => remaining.includes(id));

    constellationPath = extendConstellationPath(constellationPath, {
      descriptorKey: probe.descriptorKey,
      candidateCount: remaining.length,
      rel_x: probe.rel_x,
      rel_y: probe.rel_y,
      size: probe.size,
    });

    if (remaining.length <= 1) break;
  }

  const initial = constellationPath.length > 0 ? constellationPath[0].candidateCount : 0;
  const remainingCount = Array.isArray(remaining) ? remaining.length : 0;
  const ok = remaining && remainingCount === 1 && remaining[0] === imageId;
  return { ok, initial, steps: constellationPath.length, path: constellationPath, remainingCount };
}

function resolveEvaluationFilters(rawFilters = []) {
  if (!Array.isArray(rawFilters)) return [];
  const resolved = [];
  const seen = new Set();
  for (const raw of rawFilters) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim();
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    let config = null;
    if (lower === 'cropping' || lower === 'crop' || lower === 'center_crop') {
      config = {
        name: 'cropping',
        label: 'cropping',
        augmentation: 'original',
        transformFactory({ imagePath, runIndex }) {
          return createCroppingTransform(imagePath, runIndex, 'cropping');
        },
      };
    } else {
      const augmentation = EVALUATION_FILTER_ALIASES.get(lower) ?? normalized;
      if (!KNOWN_AUGMENTATIONS.has(augmentation)) continue;
      config = {
        name: normalized,
        label: augmentation,
        augmentation,
      };
    }
    const dedupeKey = `${config.label}:${config.augmentation}:${Boolean(config.transformFactory)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    resolved.push(config);
  }
  return resolved;
}

function createCroppingTransform(imagePath, runIndex = 0, variant = 'cropping') {
  const rng = createSeededRandom(`${variant}:${imagePath}:${runIndex}`);
  return async (image) => {
    const meta = await image.metadata();
    const width = Number(meta.width) || 0;
    const height = Number(meta.height) || 0;
    if (!width || !height) return image;

    const ratio = 0.55 + rng() * 0.9;
    if (ratio <= 1) {
      const cropWidth = Math.max(1, Math.round(width * ratio));
      const cropHeight = Math.max(1, Math.round(height * ratio));
      const maxLeft = Math.max(0, width - cropWidth);
      const maxTop = Math.max(0, height - cropHeight);
      const left = Math.floor(rng() * (maxLeft + 1));
      const top = Math.floor(rng() * (maxTop + 1));
      return image
        .extract({ left, top, width: cropWidth, height: cropHeight })
        .resize(width, height, { fit: 'cover' });
    }

    const scale = Math.min(ratio, 1.45);
    const paddedWidth = Math.max(width, Math.round(width * scale));
    const paddedHeight = Math.max(height, Math.round(height * scale));
    const leftPad = Math.floor((paddedWidth - width) / 2);
    const rightPad = paddedWidth - width - leftPad;
    const topPad = Math.floor((paddedHeight - height) / 2);
    const bottomPad = paddedHeight - height - topPad;

    return image
      .extend({
        top: topPad,
        bottom: bottomPad,
        left: leftPad,
        right: rightPad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .resize(width, height, { fit: 'cover' });
  };
}

async function evaluateFilterRun(db, imagePath, imageId, filter, runIndex, { top, usedSpecKeys }) {
  const dedupeSet = usedSpecKeys ?? null;
  const attempted = new Set();
  let spec = null;
  let fallback = null;
  const maxAttempts = 12;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = normalizeProbeSpec({ augmentation: filter.augmentation });
    if (!candidate) continue;
    const dedupeKey = `${candidate.descriptorKey}:${candidate.resolution_level}:${candidate.pos_x}:${candidate.pos_y}`;
    if (attempted.has(dedupeKey)) continue;
    attempted.add(dedupeKey);
    if (!fallback) fallback = candidate;
    if (dedupeSet && dedupeSet.has(dedupeKey)) continue;
    spec = candidate;
    if (dedupeSet) dedupeSet.add(dedupeKey);
    break;
  }
  if (!spec && fallback) {
    spec = fallback;
    if (dedupeSet) {
      const fallbackKey = `${spec.descriptorKey}:${spec.resolution_level}:${spec.pos_x}:${spec.pos_y}`;
      dedupeSet.add(fallbackKey);
    }
  }
  if (!spec) {
    return { status: 'NO_PROBE', filter };
  }

  let imageTransform = null;
  if (typeof filter.transformFactory === 'function') {
    imageTransform = filter.transformFactory({
      imagePath,
      imageId,
      runIndex,
      descriptorKey: spec.descriptorKey,
      filter,
    });
  }

  let vector;
  try {
    vector = await generateSpecificVector(
      imagePath,
      spec,
      imageTransform ? { imageTransform } : undefined
    );
  } catch (error) {
    return { status: 'ERROR', filter, spec, error };
  }

  if (!vector) {
    return { status: 'NO_VECTOR', filter, spec };
  }

  const valueTypeRecord = await ensureValueTypeRecord(db, spec.descriptor);
  const targetFeature = {
    value_type: valueTypeRecord.id,
    resolution_level: spec.resolution_level,
    pos_x: spec.pos_x,
    pos_y: spec.pos_y,
    rel_x: spec.rel_x,
    rel_y: spec.rel_y,
    size: spec.size,
    value: vector.value,
  };

  const tolerance = CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE;
  const [rows] = await db.execute(
    `SELECT fv.image_id, fv.value, fv.rel_x, fv.rel_y, fv.size, fv.value_type, fv.resolution_level, fv.pos_x, fv.pos_y, img.original_filename
     FROM feature_vectors fv
     JOIN images img ON img.image_id = fv.image_id
     WHERE fv.value_type = ?
       AND fv.resolution_level = ?
       AND fv.pos_x = ?
       AND fv.pos_y = ?
       AND ABS(fv.rel_x - ?) <= ?
       AND ABS(fv.rel_y - ?) <= ?`,
    [
      targetFeature.value_type,
      targetFeature.resolution_level,
      targetFeature.pos_x,
      targetFeature.pos_y,
      spec.rel_x,
      tolerance,
      spec.rel_y,
      tolerance,
    ]
  );

  const grouped = new Map();
  for (const row of rows) {
    const candidateFeature = {
      value_type: Number(row.value_type),
      resolution_level: Number(row.resolution_level),
      value: Number(row.value),
      rel_x: Number(row.rel_x),
      rel_y: Number(row.rel_y),
      size: Number(row.size),
    };
    if (!Number.isFinite(candidateFeature.value)) continue;
    const distance = euclideanDistance(targetFeature, candidateFeature);
    if (!Number.isFinite(distance) || distance > VALUE_THRESHOLD) continue;

    const candidateId = Number(row.image_id);
    if (!grouped.has(candidateId)) {
      grouped.set(candidateId, {
        imageId: candidateId,
        filename: row.original_filename,
        features: [],
      });
    }
    grouped.get(candidateId).features.push(candidateFeature);
  }

  const scored = [];
  for (const group of grouped.values()) {
    const evaluation = scoreCandidateFeature(targetFeature, group.features);
    if (!evaluation) continue;
    scored.push({
      imageId: group.imageId,
      filename: group.filename,
      score: Number(evaluation.score) || 0,
      metrics: evaluation.metrics ?? {},
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const matches = [];
  for (const entry of scored) {
    matches.push({
      imageId: entry.imageId,
      filename: entry.filename,
      score: entry.score,
      affinity: Number(entry.metrics?.affinity) || 0,
      spread: Number(entry.metrics?.spread) || 0,
      sampleSize: Number(entry.metrics?.sampleSize ?? entry.metrics?.originalCandidateCount ?? 0) || 0,
    });
    if (matches.length >= top) break;
  }

  if (imageId !== undefined && imageId !== null) {
    const selfEntry = scored.find((entry) => entry.imageId === imageId);
    if (selfEntry && !matches.some((entry) => entry.imageId === imageId)) {
      matches.push({
        imageId: selfEntry.imageId,
        filename: selfEntry.filename,
        score: selfEntry.score,
        affinity: Number(selfEntry.metrics?.affinity) || 0,
        spread: Number(selfEntry.metrics?.spread) || 0,
        sampleSize: Number(selfEntry.metrics?.sampleSize ?? selfEntry.metrics?.originalCandidateCount ?? 0) || 0,
      });
    }
  }

  return {
    status: 'OK',
    filter,
    spec,
    matches,
    totalMatches: scored.length,
  };
}

async function evaluateDataset(dir, options) {
  const filters = resolveEvaluationFilters(options.evaluateFilters);
  if (filters.length === 0) {
    filters.push({
      name: 'original',
      label: 'original',
      augmentation: 'original',
    });
  }
  const runsPerFilter = Math.max(1, Number(options.evaluateRuns) || EVALUATION_DEFAULT_OPTIONS.runs);
  const topCount = Math.max(1, Number(options.evaluateTop) || EVALUATION_DEFAULT_OPTIONS.top);

  const files = [];
  for await (const file of walkDir(dir, SUPPORTED_IMAGE_EXTENSIONS)) files.push(file);
  files.sort((a, b) => a.localeCompare(b));

  console.log(
    `🧪 Evaluating ${files.length} file(s) with filters: ${filters.map((f) => f.label).join(', ')}`
  );

  const db = await createDbConnection();
  const filenameIndex = new Map();
  try {
    const [imageRows] = await db.execute('SELECT image_id, original_filename FROM images');
    for (const row of imageRows) {
      const key = String(row.original_filename || '').toLowerCase();
      if (!key) continue;
      filenameIndex.set(key, {
        imageId: Number(row.image_id),
        originalName: row.original_filename,
      });
    }

    let totalRuns = 0;
    let selfTopHits = 0;
    const selfAffinitySamples = [];

    for (const file of files) {
      const baseName = path.basename(file);
      const record = filenameIndex.get(baseName.toLowerCase());
      if (!record) {
        console.warn(`⚠️  Skipping ${baseName}: not present in the trained dataset.`);
        continue;
      }

      console.log(`\n🖼️  Image ${baseName} (id=${record.imageId})`);
      const usedSpecKeys = new Set();

      for (const filter of filters) {
        console.log(`   • Filter '${filter.label}'`);
        for (let runIndex = 0; runIndex < runsPerFilter; runIndex += 1) {
          const runLabel = runsPerFilter > 1 ? `run ${runIndex + 1}` : 'run';
          const result = await evaluateFilterRun(db, file, record.imageId, filter, runIndex, {
            top: topCount,
            usedSpecKeys,
          });

          if (result.status === 'ERROR') {
            console.warn(
              `      ↳ ${runLabel}: failed (${result.error?.message ?? 'unknown error'})`
            );
            continue;
          }
          if (result.status === 'NO_PROBE') {
            console.log(`      ↳ ${runLabel}: unable to create probe specification.`);
            continue;
          }
          if (result.status === 'NO_VECTOR') {
            console.log(`      ↳ ${runLabel}: probe descriptor ${result.spec?.descriptorKey} yielded no vector.`);
            continue;
          }

          totalRuns += 1;
          const descriptorKey = result.spec?.descriptorKey ?? '(unknown)';
          if (!result.matches || result.matches.length === 0) {
            console.log(
              `      ↳ ${runLabel}: descriptor ${descriptorKey} produced no matches within threshold.`
            );
            continue;
          }

          const candidatesLabel = `${result.matches.length}/${result.totalMatches}`;
          console.log(
            `      ↳ ${runLabel}: descriptor ${descriptorKey} (matches ${candidatesLabel})`
          );

          result.matches.forEach((match, idx) => {
            const rank = idx + 1;
            const label = match.filename || `image#${match.imageId}`;
            const marker = match.imageId === record.imageId ? ' (self)' : '';
            console.log(
              `         ${rank}. ${label}${marker} | score ${match.score.toFixed(4)} | affinity ${match.affinity.toFixed(4)} | spread ${match.spread.toFixed(4)} | sample ${match.sampleSize}`
            );
          });

          const topMatch = result.matches[0];
          if (topMatch && topMatch.imageId === record.imageId) {
            selfTopHits += 1;
          }
          const selfEntry = result.matches.find((entry) => entry.imageId === record.imageId);
          if (selfEntry) {
            selfAffinitySamples.push(selfEntry.affinity);
          }
        }
      }
    }

    if (totalRuns > 0) {
      const avgAffinity =
        selfAffinitySamples.length > 0
          ? selfAffinitySamples.reduce((acc, val) => acc + val, 0) / selfAffinitySamples.length
          : 0;
      console.log(
        `\n✅ Evaluation summary: ${selfTopHits}/${totalRuns} run(s) ranked the original image first.`
      );
      if (selfAffinitySamples.length > 0) {
        console.log(
          `   • Avg self affinity across matches: ${avgAffinity.toFixed(4)} (${selfAffinitySamples.length} sample(s))`
        );
      }
    } else {
      console.log('\n⚠️  Evaluation did not yield any comparable runs.');
    }
  } finally {
    await db.end();
  }
}

async function main() {
  const { dir, options } = parseArgs(process.argv);
  if (!dir) {
    console.error('Usage: node src/train.js <dataset_dir> [--discover=3] [--bootstrap=100] [--reprobe=50] [--threads=4] [--shuffle=true] [--evaluate]');
    process.exit(1);
  }

  if (options.evaluate) {
    await evaluateDataset(dir, options);
    return;
  }

  const files = [];
  for await (const file of walkDir(dir, SUPPORTED_IMAGE_EXTENSIONS)) files.push(file);
  if (options.shuffle) files.sort(() => Math.random() - 0.5);
  console.log(`📚 Found ${files.length} file(s) to ingest.`);

  const correlationIterations = Math.max(0, options.discover || 0);
  const correlationRunner = correlationIterations > 0
    ? new OnlineCorrelationRunner({
        maxBatchSize: Math.max(
          1,
          Math.min(
            Math.max(1, settings.correlation.onlineRunnerMaxBatchSizeCap),
            correlationIterations * 2
          )
        ),
      })
    : null;

  const maxThreads = options.threads && options.threads > 0 ? options.threads : undefined;
  if (maxThreads) {
    console.log(`⚙️  Using up to ${maxThreads} worker thread(s) for ingestion.`);
  } else {
    console.log('⚙️  Using adaptive worker pool for ingestion (auto threads).');
  }

  const ingestionStartedAt = Date.now();
  const { ingested, failures } = await ingestFilesConcurrently(
    files,
    { iterationsPerIngest: correlationIterations, maxThreads },
    correlationRunner
  );
  const ingestionDurationMs = Date.now() - ingestionStartedAt;
  const successCount = ingested.length;
  const failureCount = failures.length;
  const processedCount = successCount + failureCount;
  const totalFeatures = ingested.reduce((acc, item) => acc + (item?.featureCount ?? 0), 0);
  const avgFeatures = successCount > 0 ? totalFeatures / successCount : 0;
  const recentExamples = ingested.slice(-3).map((entry) => {
    const imageLabel = path.basename(entry.file ?? '');
    return `${imageLabel || '(unknown)'}#${entry.imageId ?? '?'}`;
  });
  const failureReasons = failureCount
    ? [...failures.reduce((acc, failure) => {
        const reason = failure?.message ?? 'unknown error';
        acc.set(reason, (acc.get(reason) ?? 0) + 1);
        return acc;
      }, new Map())]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
    : [];

  console.log('\n📊 Ingestion summary:');
  console.log(
    `   • Processed ${processedCount}/${files.length} file(s) in ${(ingestionDurationMs / 1000).toFixed(1)}s`
  );
  console.log(`   • Stored ${successCount} image(s); ${failureCount} failure(s)`);
  if (successCount > 0) {
    console.log(`   • Total feature vectors: ${totalFeatures}`);
    console.log(`   • Avg vectors per image: ${avgFeatures.toFixed(1)}`);
    if (recentExamples.length > 0) {
      console.log(`   • Recent ingests: ${recentExamples.join(', ')}`);
    }
  }
  if (failureReasons.length > 0) {
    console.log('   • Failure highlights:');
    for (const [reason, count] of failureReasons) {
      console.log(`       - ${reason} (${count})`);
    }
  }

  if (failures && failures.length > 0) {
    console.warn(`⚠️  ${failures.length} file(s) failed during ingestion.`);
    for (const failure of failures) {
      console.warn(`   ↳ ${failure.file ?? 'unknown'} :: ${failure.message ?? 'unknown error'}`);
    }
  }

  if (correlationRunner) {
    await correlationRunner.drain();
    if (correlationRunner.history.length > 0) {
      const totals = correlationRunner.history.reduce(
        (acc, metric) => {
          acc.score += metric.score;
          acc.affinity += metric.affinity;
          acc.spread += metric.spread;
          acc.sampleSize += metric.sampleSize;
          acc.count += 1;
          return acc;
        },
        { score: 0, affinity: 0, spread: 0, sampleSize: 0, count: 0 }
      );
      if (totals.count > 0) {
        console.log(
          `\n🧪 Online correlation results across ${totals.count} discriminator(s): avg score ${(totals.score / totals.count).toFixed(4)}, affinity ${(totals.affinity / totals.count).toFixed(4)}, spread ${(totals.spread / totals.count).toFixed(4)}, sample size ${(totals.sampleSize / totals.count).toFixed(1)}`
        );
      }
    }
  }

  if (options.bootstrap && options.bootstrap > 0) {
    await bootstrapCorrelations(options.bootstrap);
  }

  const reprobeN = Math.min(options.reprobe || 0, ingested.length);
  if (reprobeN > 0) {
    console.log(`\n🧪 Re-probing ${reprobeN} random image(s) to measure retrieval efficiency...`);
    const sample = [...ingested].sort(() => Math.random() - 0.5).slice(0, reprobeN);
    const db = await createDbConnection();
    try {
      let okCount = 0;
      let totalInitial = 0;
      let totalSteps = 0;
      let totalAccuracyScore = 0;
      for (const item of sample) {
        const result = await reprobeOne(db, item.file, item.imageId);
        const imageLabel = path.basename(item.file);
        const statusLabel = result.ok ? 'hit' : 'miss';
        console.log(
          `   • ${imageLabel}: ${statusLabel} after ${result.steps} step(s) (candidates ${result.initial} → ${result.remainingCount})`
        );
        if (!result.ok && result.path && result.path.length > 0) {
          const lastStep = result.path[result.path.length - 1];
          console.log(
            `     ↳ last probe ${lastStep.descriptorKey} accuracy ${(lastStep.accuracyScore ?? 0).toFixed(6)} (cumulative ${(lastStep.cumulativeAccuracy ?? 0).toFixed(6)})`
          );
        }
        if (result.ok) okCount += 1;
        totalInitial += result.initial || 0;
        totalSteps += result.steps || 0;
        if (result.path && result.path.length > 0) {
          totalAccuracyScore += result.path[result.path.length - 1].cumulativeAccuracy ?? 0;
        }
      }
      console.log(`   ✔️ Success rate: ${(100 * okCount / reprobeN).toFixed(1)}% (${okCount}/${reprobeN})`);
      console.log(`   ⓘ Avg initial candidates: ${(totalInitial / reprobeN).toFixed(2)}`);
      console.log(`   ⓘ Avg refinement steps: ${(totalSteps / reprobeN).toFixed(2)}`);
      if (totalAccuracyScore > 0) {
        console.log(`   ✨ Avg constellation accuracy: ${(totalAccuracyScore / reprobeN).toFixed(6)}`);
      }
    } finally {
      await db.end();
    }
  }
}

main().catch((err) => {
  console.error('❌ Training failed:', err);
  process.exit(1);
});
