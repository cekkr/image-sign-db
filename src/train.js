#!/usr/bin/env node

// --- LIBRARIES ---
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
require('dotenv').config();

// --- INTERNAL MODULES ---
const { bootstrapCorrelations } = require('./insert');
const { generateSpecificVector } = require('./featureExtractor');
const settings = require('./settings');
const { createDbConnection, discoverCorrelations, fetchConstellationGraph } = require('./lib/knowledge');
const { CHANNEL_DIMENSIONS, CONSTELLATION_CONSTANTS } = require('./lib/constants');
const { euclideanDistance } = require('./lib/correlationMetrics');
const { parseDescriptor } = require('./lib/descriptor');
const { extendConstellationPath, descriptorToSpec } = require('./lib/constellation');
const { collectElasticMatches } = require('./lib/elasticMatcher');
const {
  normalizeProbeSpec,
  resolveEvaluationFilters,
  ensureValueTypeRecord,
  evaluateFilterRun,
} = require('./evaluate');
const RealTimePruner = require('./lib/realTimePruner');
const { ensureValueTypeCapacity } = require('./lib/schema');
const { AUGMENTATION_ORDER, createSeededRandom } = require('./lib/augmentations');
const { resolutionLevelKey, RESOLUTION_LEVEL_TOLERANCE } = require('./lib/resolutionLevel');

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
    // Augmentation controls
    augmentations: null,
    augPerPass: settings.training.augmentationsPerImage,
    augSeed: process.env.TRAINING_AUGMENTATION_GLOBAL_SEED || '',
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
      } else if (key === 'augmentations' || key === 'aug' || key === 'augList') {
        const aug = String(val)
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (aug.length > 0) options.augmentations = aug;
      } else if (key === 'aug-per-pass' || key === 'augPerPass') {
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) options.augPerPass = Math.floor(n);
      } else if (key === 'aug-seed' || key === 'augSeed') {
        options.augSeed = String(val);
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
            onDiscriminatorSelected: ({ metrics, ambiguousCandidates, startFeature, discriminatorFeature, topMatches }) => {
              if (!metrics) return;
              batchMetrics.push({
                score: metrics.score ?? 0,
                affinity: metrics.affinity ?? 0,
                cohesion: metrics.cohesion ?? 0,
                density: metrics.density ?? 0,
                stability: metrics.stability ?? 0,
                meanDistance: metrics.meanDistance ?? 0,
                stdDistance: metrics.stdDistance ?? 0,
                sampleSize: metrics.sampleSize ?? 0,
                candidates: ambiguousCandidates ?? 0,
              });

              // Optional detailed per-iteration logging of top matches
              if (settings.training.correlationDebugLog && Array.isArray(topMatches) && topMatches.length > 0) {
                const startChannel = startFeature?.descriptor?.channel ?? `#${startFeature?.value_type ?? '?'}`;
                const discChannel = discriminatorFeature?.descriptor?.channel ?? `#${discriminatorFeature?.value_type ?? '?'}`;
                const header = `   [90m[1mSelected ${startChannel} (res=${startFeature?.resolution_level}) + ${discChannel} (res=${discriminatorFeature?.resolution_level}) | cohesion ${Number(metrics.cohesion ?? 0).toFixed(4)} | affinity ${Number(metrics.affinity ?? 0).toFixed(4)} | candidates ${ambiguousCandidates ?? 0}`;
                console.log(header);
                const k = Math.min(topMatches.length, settings.training.correlationTopLogK || 5);
                for (let i = 0; i < k; i += 1) {
                  const m = topMatches[i];
                  const label = m.filename || `image#${m.imageId}`;
                  const distLabel = m.distanceMean !== null && m.distanceMean !== undefined
                    ? ` | distance ${Number(m.distanceMean).toFixed(4)}`
                    : '';
                  console.log(`      ${i + 1}. ${label} | score ${Number(m.score).toFixed(4)} | affinity ${Number(m.affinity).toFixed(4)} | cohesion ${Number(m.cohesion).toFixed(4)} | sample ${Number(m.sampleSize)}${distLabel}`);
                }
              }
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
        acc.cohesion += metric.cohesion;
        acc.density += metric.density ?? 0;
        acc.stability += metric.stability ?? 0;
        acc.meanDistance += metric.meanDistance;
        acc.stdDistance += metric.stdDistance;
        acc.sampleSize += metric.sampleSize;
        acc.candidates += metric.candidates;
        return acc;
      },
      {
        score: 0,
        affinity: 0,
        cohesion: 0,
        density: 0,
        stability: 0,
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
      cohesion: total.cohesion / count,
      density: total.density / count,
      stability: total.stability / count,
      meanDistance: total.meanDistance / count,
      stdDistance: total.stdDistance / count,
      sampleSize: total.sampleSize / count,
      candidates: total.candidates / count,
    };

    console.log(
      `   ↳ Avg score ${avg.score.toFixed(4)} | cohesion ${avg.cohesion.toFixed(4)} | affinity ${avg.affinity.toFixed(4)} | sample ${avg.sampleSize.toFixed(1)} | candidates ${avg.candidates.toFixed(1)}`
    );
  }

  async drain() {
    while (this.running || this.pendingIterations > 0) {
      await sleep(150);
    }
  }
}

async function ingestFilesConcurrently(
  files,
  { iterationsPerIngest = 0, maxThreads, onImageIngested, augmentationPool, augPerPass, augSeed } = {},
  correlationRunner
) {
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

  // Resolve the augmentation pool from options + settings + defaults.
  const envAugList = settings.training.augmentationList;
  const baseAugPool = Array.isArray(envAugList) && envAugList.length > 0 ? envAugList : AUGMENTATION_ORDER;

  function buildAugmentationPool() {
    const list = Array.isArray(augmentationPool) && augmentationPool.length
      ? augmentationPool
      : baseAugPool;
    const unique = [...new Set(list)];
    // Always ensure 'original' is present
    if (!unique.includes('original')) unique.unshift('original');
    return unique;
  }

  function selectAugmentationsForFile(file) {
    const pool = buildAugmentationPool();
    const perPass = Math.max(1, Number(augPerPass) || 1);
    if (perPass >= pool.length) return pool;
    const withoutOriginal = pool.filter((name) => name !== 'original');
    const rng = createSeededRandom(`${augSeed || ''}:${file}`);
    // Fisher-Yates shuffle using seeded RNG
    for (let i = withoutOriginal.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [withoutOriginal[i], withoutOriginal[j]] = [withoutOriginal[j], withoutOriginal[i]];
    }
    const sample = withoutOriginal.slice(0, Math.max(0, perPass - 1));
    return ['original', ...sample];
  }

  function assignWork(info) {
    if (closed || info.busy || pending.length === 0) return;
    const file = pending.shift();
    if (!file) return;

    info.busy = true;
    info.currentFile = file;
    activeWorkers += 1;
    const augmentations = selectAugmentationsForFile(file);
    info.worker.postMessage({
      type: 'ingest',
      payload: { file, discoverIterations: 0, augmentations },
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
      if (typeof onImageIngested === 'function') {
        Promise.resolve(onImageIngested(message.payload)).catch((error) => {
          console.warn(`⚠️  onImageIngested callback failed: ${error?.message ?? error}`);
        });
      }
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

async function findCandidateImages(db, probe) {
  const valueTypeId = (await ensureValueTypeRecord(db, probe.descriptor)).id;
  const minAge = Number(settings?.training?.minCompletedImageAgeMinutes || 0);
  const ageClause = minAge > 0 ? 'AND im.created_at <= (NOW() - INTERVAL ? MINUTE)' : '';
  const params = [
    valueTypeId,
    probe.resolution_level,
    RESOLUTION_LEVEL_TOLERANCE,
    probe.pos_x,
    probe.pos_y,
    probe.rel_x,
    CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
    probe.rel_y,
    CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
  ];
  if (minAge > 0) params.push(minAge);
  const [rows] = await db.execute(
    `SELECT fv.vector_id, fv.image_id, fv.value_type, fv.resolution_level, fv.pos_x, fv.pos_y, fv.rel_x, fv.rel_y, fv.value, fv.size, vt.descriptor_json
     FROM feature_vectors fv
     JOIN value_types vt ON vt.value_type_id = fv.value_type
     JOIN images im ON im.image_id = fv.image_id
     WHERE fv.value_type = ?
       AND ABS(fv.resolution_level - ?) <= ?
       AND fv.pos_x = ?
       AND fv.pos_y = ?
       AND ABS(fv.rel_x - ?) <= ?
       AND ABS(fv.rel_y - ?) <= ?
       AND im.ingestion_complete = 1 ${ageClause}`,
    params
  );

  const targetFeature = {
    value_type: valueTypeId,
    resolution_level: probe.resolution_level,
    value: probe.value ?? 0,
    rel_x: probe.rel_x,
    rel_y: probe.rel_y,
    size: probe.size,
  };
  const { grouped } = collectElasticMatches(rows, targetFeature, {
    baseThreshold: VALUE_THRESHOLD,
    minUniqueImages: 1,
    maxEntries: rows.length,
  });
  return [...grouped.keys()];
}

async function sampleRandomProbeSpec(db) {
  const minAge = Number(settings?.training?.minCompletedImageAgeMinutes || 0);
  const ageClause = minAge > 0 ? 'AND im.created_at <= (NOW() - INTERVAL ? MINUTE)' : '';
  const params = [];
  if (minAge > 0) params.push(minAge);
  const [rows] = await db.execute(
    `SELECT fv.vector_id, fv.value_type, fv.resolution_level, fv.pos_x, fv.pos_y, fv.rel_x, fv.rel_y, fv.size, vt.descriptor_json
     FROM feature_vectors fv
     JOIN value_types vt ON vt.value_type_id = fv.value_type
     JOIN images im ON im.image_id = fv.image_id
     WHERE im.ingestion_complete = 1 ${ageClause}
     ORDER BY RAND()
     LIMIT 1`,
    params
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

async function reprobeWithRandomSampling(db, imagePath, imageId, options = {}) {
  const maxSteps = options.maxSteps ?? CHANNEL_DIMENSIONS.length;
  let constellationPath = [];
  let remaining = null;
  let steps = 0;
  const usedKeys = new Set();

  while (steps < maxSteps) {
    steps += 1;
    const probeSpec = await sampleRandomProbeSpec(db);
    if (!probeSpec) break;
    const dedupeKey = `${probeSpec.descriptorKey}:${resolutionLevelKey(probeSpec.resolution_level)}:${probeSpec.pos_x}:${probeSpec.pos_y}`;
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

function radiansToDegrees(angle) {
  return angle * (180 / Math.PI);
}

function angularDifference(a, b) {
  let diff = a - b;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff);
}

function computeConfidence(hits, misses) {
  const h = Math.max(0, Number(hits) || 0);
  const m = Math.max(0, Number(misses) || 0);
  const total = h + m;
  return total > 0 ? h / total : 0;
}

function computeConstellationScore(hits, misses) {
  const h = Math.max(0, Number(hits) || 0);
  const m = Math.max(0, Number(misses) || 0);
  return h - m * 0.35;
}

async function reprobeUsingConstellations(db, imagePath, imageId, options = {}) {
  const limit = Math.max(8, Number(options.constellationLimit ?? 80));
  const minHits = Math.max(0, Number(options.constellationMinHits ?? 1));

  let rawEntries;
  try {
    rawEntries = await fetchConstellationGraph(db, { limit, minHits });
  } catch (error) {
    console.warn(`   ↳ Unable to load constellation graph: ${error?.message ?? error}`);
    return null;
  }
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) return null;

  const normalizedEntries = [];
  const anchorGroups = new Map();

  for (const raw of rawEntries) {
    const spec = descriptorToSpec(raw.relatedDescriptor);
    if (!spec) continue;
    const normalizedSpec = normalizeProbeSpec({
      ...spec,
      descriptor: spec.descriptor ?? raw.relatedDescriptor,
      descriptorKey: spec.descriptorKey,
    });
    if (!normalizedSpec) continue;
    const anchorSpec = raw.anchorDescriptor ? descriptorToSpec(raw.anchorDescriptor) : null;
    const entry = {
      raw,
      normalizedSpec,
      dedupeKey: `${normalizedSpec.descriptorKey}:${resolutionLevelKey(normalizedSpec.resolution_level)}:${normalizedSpec.pos_x}:${normalizedSpec.pos_y}`,
      anchorDescriptorKey: anchorSpec?.descriptorKey ?? null,
      anchorVectorId: raw.anchorVectorId,
      geometry: {
        length: Number(raw.vector_length) || 0,
        angle: Number(raw.vector_angle) || 0,
        valueDelta: Number(raw.vector_value) || 0,
      },
      stats: {
        hits: Number(raw.hit_count) || 0,
        misses: Number(raw.miss_count) || 0,
      },
    };
    entry.stats.confidence = computeConfidence(entry.stats.hits, entry.stats.misses);
    entry.score = computeConstellationScore(entry.stats.hits, entry.stats.misses);
    normalizedEntries.push(entry);
    if (!anchorGroups.has(entry.anchorVectorId)) anchorGroups.set(entry.anchorVectorId, []);
    anchorGroups.get(entry.anchorVectorId).push(entry);
  }

  if (normalizedEntries.length === 0) return null;

  normalizedEntries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.stats.confidence !== a.stats.confidence) return b.stats.confidence - a.stats.confidence;
    return a.dedupeKey.localeCompare(b.dedupeKey);
  });

  for (const group of anchorGroups.values()) {
    group.sort((a, b) => {
      if (b.stats.confidence !== a.stats.confidence) return b.stats.confidence - a.stats.confidence;
      if (b.stats.hits !== a.stats.hits) return b.stats.hits - a.stats.hits;
      return a.dedupeKey.localeCompare(b.dedupeKey);
    });
  }

  const queue = [];
  const enqueued = new Set();
  for (const entry of normalizedEntries) {
    if (enqueued.has(entry.dedupeKey)) continue;
    queue.push(entry);
    enqueued.add(entry.dedupeKey);
  }

  if (queue.length === 0) return null;

  const used = new Set();
  let steps = 0;
  let remaining = null;
  let constellationPath = [];
  const maxSteps = Math.max(1, Number(options.maxSteps ?? CHANNEL_DIMENSIONS.length));
  const relatedFanout = Math.max(1, Number(options.relatedFanout ?? 3));
  const globalFanout = Math.max(1, Number(options.globalFanout ?? 2));
  const angleTolerance = Number.isFinite(options.angleTolerance) ? options.angleTolerance : Math.PI / 18;
  const lengthTolerance = Number.isFinite(options.lengthTolerance) ? options.lengthTolerance : 0.12;

  let initialCount = 0;

  while (queue.length > 0 && steps < maxSteps) {
    const entry = queue.shift();
    if (!entry) break;
    if (used.has(entry.dedupeKey)) continue;
    used.add(entry.dedupeKey);

    const spec = entry.normalizedSpec;
    const vector = await generateSpecificVector(imagePath, spec);
    if (!vector) {
      console.log(`   ↳ ⚠️ Unable to realize constellation ${spec.descriptorKey}; skipping.`);
      continue;
    }

    const probe = {
      ...spec,
      value: vector.value,
      size: vector.size ?? spec.size,
      descriptor: vector.descriptor ?? spec.descriptor,
      descriptorKey: vector.descriptorKey ?? spec.descriptorKey,
    };

    steps += 1;
    console.log(
      `   ✳️ Constellation step ${steps}: ${probe.descriptorKey} (anchor ${entry.anchorDescriptorKey ?? entry.anchorVectorId ?? 'n/a'})`
    );
    console.log(
      `      geometry angle ${radiansToDegrees(entry.geometry.angle).toFixed(1)}° | length ${entry.geometry.length.toFixed(
        4
      )} | confidence ${(entry.stats.confidence * 100).toFixed(1)}% (hits ${entry.stats.hits}, misses ${entry.stats.misses})`
    );

    const candidateRaw = await findCandidateImages(db, probe);
    const candidateIds = Array.isArray(candidateRaw) ? [...candidateRaw] : [];
    const candidateSet = new Set(candidateIds);
    const nextRemaining =
      remaining === null ? candidateIds : remaining.filter((id) => candidateSet.has(id));
    const prevLabel = remaining === null ? '∅' : String(remaining.length);
    console.log(`      candidates ${prevLabel} → ${nextRemaining.length}`);

    remaining = nextRemaining;
    if (steps === 1) {
      initialCount = remaining.length;
    }

    constellationPath = extendConstellationPath(constellationPath, {
      descriptorKey: probe.descriptorKey,
      candidateCount: remaining.length,
      rel_x: probe.rel_x,
      rel_y: probe.rel_y,
      size: probe.size,
    });

    if (remaining.length <= 1) break;

    const relatedGroup = anchorGroups.get(entry.anchorVectorId) || [];
    const anchorQueued = [];
    for (const candidate of relatedGroup) {
      if (candidate.dedupeKey === entry.dedupeKey) continue;
      if (used.has(candidate.dedupeKey) || enqueued.has(candidate.dedupeKey)) continue;
      anchorQueued.push(candidate);
      enqueued.add(candidate.dedupeKey);
      if (anchorQueued.length >= relatedFanout) break;
    }
    if (anchorQueued.length > 0) {
      for (let i = anchorQueued.length - 1; i >= 0; i -= 1) {
        queue.unshift(anchorQueued[i]);
      }
      console.log(
        `      ↺ queued ${anchorQueued.length} related constellation(s) from anchor ${
          entry.anchorDescriptorKey ?? entry.anchorVectorId ?? 'n/a'
        }: ${anchorQueued.map((c) => c.normalizedSpec.descriptorKey).join(', ')}`
      );
    }

    const similar = [];
    for (const candidate of normalizedEntries) {
      if (candidate.anchorVectorId === entry.anchorVectorId) continue;
      if (candidate.dedupeKey === entry.dedupeKey) continue;
      if (used.has(candidate.dedupeKey) || enqueued.has(candidate.dedupeKey)) continue;
      const angleDiff = angularDifference(candidate.geometry.angle, entry.geometry.angle);
      if (angleDiff > angleTolerance) continue;
      const lengthDiff = Math.abs(candidate.geometry.length - entry.geometry.length);
      if (lengthDiff > lengthTolerance) continue;
      similar.push({ candidate, angleDiff, lengthDiff });
    }
    similar.sort((a, b) => {
      if (a.angleDiff !== b.angleDiff) return a.angleDiff - b.angleDiff;
      return a.lengthDiff - b.lengthDiff;
    });
    const globalQueued = [];
    for (const item of similar.slice(0, globalFanout)) {
      globalQueued.push(item);
      enqueued.add(item.candidate.dedupeKey);
      queue.push(item.candidate);
    }
    if (globalQueued.length > 0) {
      console.log(
        `      ↺ queued ${globalQueued.length} geometry-similar constellation(s): ${globalQueued
          .map(
            (entryLike) =>
              `${entryLike.candidate.normalizedSpec.descriptorKey} (Δθ=${radiansToDegrees(entryLike.angleDiff).toFixed(
                1
              )}°, Δℓ=${entryLike.lengthDiff.toFixed(3)})`
          )
          .join(', ')}`
      );
    }
  }

  if (constellationPath.length === 0) return null;

  const ok = Array.isArray(remaining) && remaining.length === 1 && remaining[0] === imageId;
  const remainingCount = Array.isArray(remaining) ? remaining.length : 0;
  if (!ok && remainingCount > 1) {
    const preview = remaining.slice(0, 6).join(', ');
    console.log(
      `      ↳ remaining ambiguous candidates (${remainingCount}): ${preview}${
        remaining.length > 6 ? '…' : ''
      }`
    );
  }

  return {
    ok,
    initial: initialCount,
    steps: constellationPath.length,
    path: constellationPath,
    remainingCount,
  };
}

async function reprobeOne(db, imagePath, imageId, options = {}) {
  const constellationResult = await reprobeUsingConstellations(db, imagePath, imageId, options);
  if (constellationResult) return constellationResult;
  console.log('   ↳ Falling back to random constellation sampling.');
  return reprobeWithRandomSampling(db, imagePath, imageId, options);
}

class TrainingSelfEvaluator {
  constructor(config = {}) {
    this.enabled = Boolean(config.enabled);
    this.maxSamples = Math.max(0, Number(config.maxSamples ?? 0));
    if (this.maxSamples <= 0) this.enabled = false;
    this.runsPerFilter = Math.max(1, Number(config.runsPerFilter ?? 1));
    this.topMatches = Math.max(1, Number(config.topMatches ?? 1));
    const filterList = Array.isArray(config.filters) && config.filters.length > 0
      ? config.filters
      : ['original'];
    this.filterConfigs = resolveEvaluationFilters(filterList);
    if (this.filterConfigs.length === 0) {
      this.filterConfigs = resolveEvaluationFilters(['original']);
    }
    this.queue = [];
    this.running = false;
    this.completed = 0;
    this.db = null;
  }

  async ensureDb() {
    if (!this.db) {
      this.db = await createDbConnection();
    }
  }

  enqueue(payload) {
    if (!this.enabled) return;
    if (this.completed >= this.maxSamples) return;
    if (!payload || !payload.file || !payload.imageId) return;
    this.queue.push({ file: payload.file, imageId: payload.imageId });
    if (!this.running) {
      void this.process();
    }
  }

  async process() {
    if (this.running || !this.enabled) return;
    this.running = true;
    try {
      await this.ensureDb();
      while (this.queue.length > 0 && this.completed < this.maxSamples) {
        const item = this.queue.shift();
        if (!item) continue;
        await this.evaluateOne(item);
        this.completed += 1;
      }
    } catch (error) {
      console.warn(`⚠️  Self-evaluation pipeline failed: ${error?.message ?? error}`);
    } finally {
      this.running = false;
    }
  }

  async evaluateOne({ file, imageId }) {
    if (!this.db) return;
    const baseName = path.basename(file);
    console.log(`   ↗ Self-evaluating ${baseName} (image_id=${imageId})`);
    const usedSpecKeys = new Set();
    for (const filter of this.filterConfigs) {
      for (let runIndex = 0; runIndex < this.runsPerFilter; runIndex += 1) {
        let summary;
        try {
          summary = await evaluateFilterRun(this.db, file, imageId, filter, runIndex, {
            top: this.topMatches,
            usedSpecKeys,
          });
        } catch (error) {
          console.warn(
            `      ↳ [self] ${filter.label} run ${runIndex + 1}: failed (${error?.message ?? 'unknown error'})`
          );
          continue;
        }
        this.logSummary(filter, runIndex, summary, imageId);
      }
    }
  }

  logSummary(filter, runIndex, summary, imageId) {
    const runLabel = this.runsPerFilter > 1 ? `run ${runIndex + 1}` : 'run';
    if (!summary || summary.status === 'ERROR') {
      console.warn(
        `      ↳ [self] ${filter.label} ${runLabel}: error (${summary?.error?.message ?? 'unknown'})`
      );
      return;
    }
    if (summary.status === 'NO_PROBE') {
      console.log(`      ↳ [self] ${filter.label} ${runLabel}: unable to create probe.`);
      return;
    }
    if (summary.status === 'NO_VECTOR') {
      console.log(`      ↳ [self] ${filter.label} ${runLabel}: descriptor yielded no vector.`);
      return;
    }
    if (!summary.matches || summary.matches.length === 0) {
      const note =
        summary.relaxations && summary.relaxations > 0
          ? `relaxed ${summary.relaxations}× → ${Number(summary.thresholdUsed ?? VALUE_THRESHOLD).toFixed(4)}`
          : 'no matches';
      console.log(`      ↳ [self] ${filter.label} ${runLabel}: ${note}.`);
      return;
    }

    const best = summary.matches[0];
    const bestLabel = best
      ? `${best.filename || `image#${best.imageId}`} (score ${best.score.toFixed(4)})`
      : '—';
    const selfRank =
      summary.matches.findIndex((entry) => entry.imageId === imageId) + 1;
    const selfNote =
      selfRank > 0 ? `self rank ${selfRank}` : 'self missing';
    const relaxNote =
      summary.relaxations && summary.relaxations > 0
        ? `relaxed ${summary.relaxations}× → ${Number(summary.thresholdUsed ?? VALUE_THRESHOLD).toFixed(4)}`
        : 'threshold stable';

    console.log(
      `      ↳ [self] ${filter.label} ${runLabel}: best ${bestLabel}; ${selfNote}; ${relaxNote}`
    );
  }

  async drain() {
    if (!this.enabled) return;
    while (this.running || this.queue.length > 0) {
      await sleep(120);
    }
  }

  async dispose() {
    if (this.db) {
      try {
        await this.db.end();
      } catch {
        // ignore close errors
      }
      this.db = null;
    }
  }
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
          const relaxedNote =
            result.relaxations && result.relaxations > 0
              ? ` after relaxing threshold ${result.relaxations}× → ${Number(result.thresholdUsed ?? VALUE_THRESHOLD).toFixed(4)}`
              : '';

          if (!result.matches || result.matches.length === 0) {
            console.log(
              `      ↳ ${runLabel}: descriptor ${descriptorKey} produced no matches${relaxedNote || ' within threshold'}.`
            );
            continue;
          }

          const candidatesLabel = `${result.matches.length}/${result.totalMatches}`;
          console.log(
            `      ↳ ${runLabel}: descriptor ${descriptorKey} (matches ${candidatesLabel}${relaxedNote})`
          );

          result.matches.forEach((match, idx) => {
            const rank = idx + 1;
            const label = match.filename || `image#${match.imageId}`;
            const marker = match.imageId === record.imageId ? ' (self)' : '';
            const distanceLabel =
              match.distanceMean !== null && match.distanceMean !== undefined
                ? ` | distance ${match.distanceMean.toFixed(4)}`
                : '';
            console.log(
              `         ${rank}. ${label}${marker} | score ${match.score.toFixed(4)} | affinity ${match.affinity.toFixed(4)} | cohesion ${match.cohesion.toFixed(4)} | sample ${match.sampleSize}${distanceLabel}`
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

  let upgradedColumns = [];
  try {
    upgradedColumns = await ensureValueTypeCapacity();
  } catch (error) {
    throw new Error(`Unable to prepare database schema: ${error?.message ?? error}`);
  }
  if (upgradedColumns.length > 0) {
    console.log(`🔧 Upgraded schema columns: ${upgradedColumns.join(', ')}`);
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

  const selfEvalConfig = settings.training.selfEvaluation ?? {};
  const selfEvaluator = new TrainingSelfEvaluator({
    enabled: selfEvalConfig.enabled,
    maxSamples: selfEvalConfig.maxSamples,
    runsPerFilter: selfEvalConfig.runsPerFilter,
    topMatches: selfEvalConfig.topMatches,
    filters: selfEvalConfig.filters,
  });
  if (selfEvaluator.enabled) {
    console.log(
      `🔍 Training self-evaluation enabled (up to ${selfEvaluator.maxSamples} sample(s), top ${selfEvaluator.topMatches})`
    );
  }

  const prunerConfig = {
    ...(settings.training.realTimePruning || {}),
    skipThresholdOverride: settings.search.skipThreshold,
  };
  const realTimePruner = new RealTimePruner(prunerConfig);

  let ingested = [];
  let failures = [];
  let ingestionDurationMs = 0;

  try {
    const ingestionStartedAt = Date.now();
    const ingestionResult = await ingestFilesConcurrently(
      files,
      {
        iterationsPerIngest: correlationIterations,
        maxThreads,
        augmentationPool: Array.isArray(options.augmentations) && options.augmentations.length > 0
          ? options.augmentations
          : undefined,
        augPerPass: options.augPerPass,
        augSeed: options.augSeed,
        onImageIngested: (payload) => {
          selfEvaluator.enqueue(payload);
          realTimePruner.onImageIngested(payload);
        },
      },
      correlationRunner
    );
    ingested = ingestionResult?.ingested ?? [];
    failures = ingestionResult?.failures ?? [];
    ingestionDurationMs = Date.now() - ingestionStartedAt;

    await selfEvaluator.drain();
    await realTimePruner.flush();

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
            acc.cohesion += metric.cohesion ?? 0;
            acc.sampleSize += metric.sampleSize;
            acc.count += 1;
            return acc;
          },
          { score: 0, affinity: 0, cohesion: 0, sampleSize: 0, count: 0 }
        );
        if (totals.count > 0) {
          console.log(
            `\n🧪 Online correlation results across ${totals.count} discriminator(s): avg score ${(totals.score / totals.count).toFixed(4)}, affinity ${(totals.affinity / totals.count).toFixed(4)}, cohesion ${(totals.cohesion / totals.count).toFixed(4)}, sample size ${(totals.sampleSize / totals.count).toFixed(1)}`
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
  } finally {
    await realTimePruner.dispose();
    await selfEvaluator.dispose();
  }
}

main().catch((err) => {
  console.error('❌ Training failed:', err);
  process.exit(1);
});
