#!/usr/bin/env node

// --- LIBRARIES ---
const fs = require('fs/promises');
const path = require('path');
require('dotenv').config();

// --- INTERNAL MODULES ---
const { ingestImage, bootstrapCorrelations } = require('./insert');
const { generateSpecificVector } = require('./featureExtractor');
const { createDbConnection } = require('./lib/knowledge');
const { CHANNEL_DIMENSIONS, CONSTELLATION_CONSTANTS } = require('./lib/constants');
const { euclideanDistance } = require('./lib/correlationMetrics');
const { createDescriptorKey, serializeDescriptor, parseDescriptor } = require('./lib/descriptor');
const { extendConstellationPath, descriptorToSpec } = require('./lib/constellation');
const { resolveDefaultProbeSpec } = require('./lib/vectorSpecs');

// --- HELPERS ---

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
  const options = { discover: 0, bootstrap: 0, reprobe: 0, shuffle: true };
  const positional = [];
  for (const token of args) {
    if (token.startsWith('--')) {
      const [k, v] = token.slice(2).split('=');
      const key = k.trim();
      const val = v === undefined ? true : v;
      if (key === 'discover' || key === 'bootstrap' || key === 'reprobe') options[key] = Number(val) || 0;
      else if (key === 'shuffle') options.shuffle = val !== 'false';
      else if (key === 'pattern') options.pattern = String(val);
    } else {
      positional.push(token);
    }
  }
  return { dir: positional[0], options };
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
    if (distance <= 0.08) candidates.add(row.image_id);
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

async function main() {
  const { dir, options } = parseArgs(process.argv);
  if (!dir) {
    console.error('Usage: node src/train.js <dataset_dir> [--discover=25] [--bootstrap=100] [--reprobe=50] [--shuffle=true]');
    process.exit(1);
  }

  const allowed = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
  const files = [];
  for await (const file of walkDir(dir, allowed)) files.push(file);
  if (options.shuffle) files.sort(() => Math.random() - 0.5);
  console.log(`📚 Found ${files.length} file(s) to ingest.`);

  const ingested = [];
  for (const file of files) {
    try {
      const { imageId, featureCount } = await ingestImage(file, options.discover || 0);
      ingested.push({ file, imageId, featureCount });
    } catch (err) {
      console.warn(`⚠️  Failed ingest: ${file} -> ${err.message}`);
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
