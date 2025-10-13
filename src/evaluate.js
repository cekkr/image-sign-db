// Shared helpers for evaluating image descriptors and constellations.
const settings = require('./settings');
const { generateSpecificVector, AUGMENTATION_ORDER } = require('./featureExtractor');
const { resolveDefaultProbeSpec } = require('./lib/vectorSpecs');
const { createDescriptorKey, serializeDescriptor } = require('./lib/descriptor');
const { CONSTELLATION_CONSTANTS, CHANNEL_DIMENSIONS } = require('./lib/constants');
const { createSeededRandom } = require('./lib/augmentations');
const { collectElasticMatches } = require('./lib/elasticMatcher');
const { scoreCandidateFeature } = require('./lib/correlationMetrics');

const VALUE_THRESHOLD = settings.search.valueThreshold;
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

async function ensureValueTypeRecord(db, descriptor) {
  const descriptorKey = createDescriptorKey(descriptor);
  const [rows] = await db.execute(
    'SELECT value_type_id FROM value_types WHERE descriptor_hash = ?',
    [descriptorKey]
  );
  if (rows.length > 0) {
    return { id: rows[0].value_type_id, descriptorKey };
  }
  const [result] = await db.execute(
    'INSERT INTO value_types (descriptor_hash, descriptor_json) VALUES (?, ?)',
    [descriptorKey, serializeDescriptor(descriptor)]
  );
  return { id: result.insertId, descriptorKey };
}

async function evaluateFilterRun(db, imagePath, imageId, filter, runIndex, options = {}) {
  const dedupeSet = options.usedSpecKeys ?? null;
  const top = Math.max(1, Number(options.top) || 1);
  const threshold = Number.isFinite(options.valueThreshold) ? options.valueThreshold : VALUE_THRESHOLD;

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

  const selection = collectElasticMatches(rows, targetFeature, {
    baseThreshold: threshold,
    minUniqueImages: Math.max(1, Math.min(top, rows.length || 0)),
    maxEntries: Math.max(32, top * 12),
  });

  const scored = [];
  for (const group of selection.grouped.values()) {
    const evaluation = scoreCandidateFeature(targetFeature, group.features);
    if (!evaluation) continue;
    scored.push({
      imageId: group.imageId,
      filename: group.label,
      score: Number(evaluation.score) || 0,
      metrics: evaluation.metrics ?? {},
      distances: group.distances ?? [],
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
      cohesion: Number(entry.metrics?.cohesion) || 0,
      density: Number(entry.metrics?.density) || 0,
      stability: Number(entry.metrics?.stability) || 0,
      sampleSize: Number(entry.metrics?.sampleSize ?? entry.metrics?.originalCandidateCount ?? 0) || 0,
      distanceMean:
        entry.distances && entry.distances.length > 0
          ? entry.distances.reduce((acc, val) => acc + val, 0) / entry.distances.length
          : null,
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
        cohesion: Number(selfEntry.metrics?.cohesion) || 0,
        density: Number(selfEntry.metrics?.density) || 0,
        stability: Number(selfEntry.metrics?.stability) || 0,
        sampleSize: Number(selfEntry.metrics?.sampleSize ?? selfEntry.metrics?.originalCandidateCount ?? 0) || 0,
        distanceMean:
          selfEntry.distances && selfEntry.distances.length > 0
            ? selfEntry.distances.reduce((acc, val) => acc + val, 0) / selfEntry.distances.length
            : null,
      });
    }
  }

  return {
    status: 'OK',
    filter,
    spec,
    matches,
    totalMatches: scored.length,
    relaxations: selection.relaxations,
    thresholdUsed: selection.thresholdUsed,
  };
}

module.exports = {
  normalizeProbeSpec,
  resolveEvaluationFilters,
  createCroppingTransform,
  ensureValueTypeRecord,
  evaluateFilterRun,
};
