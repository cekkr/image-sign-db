const { euclideanDistance } = require('./correlationMetrics');
const { normalizeResolutionLevel } = require('./resolutionLevel');

function ensureNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeFeatureFromRow(row) {
  return {
    value_type: ensureNumber(row.value_type),
    resolution_level: normalizeResolutionLevel(ensureNumber(row.resolution_level)),
    value: ensureNumber(row.value),
    rel_x: ensureNumber(row.rel_x),
    rel_y: ensureNumber(row.rel_y),
    size: ensureNumber(row.size),
  };
}

function collectElasticMatches(rows, targetFeature, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      grouped: new Map(),
      selectedEntries: [],
      thresholdUsed: options.baseThreshold ?? 0,
      relaxations: 0,
      allEntries: [],
    };
  }

  const baseThreshold = options.baseThreshold ?? 0.08;
  const relaxFactor = Math.max(1.05, options.relaxFactor ?? 1.5);
  const maxRelaxations = Math.max(0, options.maxRelaxations ?? 5);
  const minUniqueImages = Math.max(1, options.minUniqueImages ?? 1);
  const maxEntries = Math.max(1, options.maxEntries ?? rows.length);

  const entries = [];
  for (const row of rows) {
    const feature = normalizeFeatureFromRow(row);
    const distance = euclideanDistance(targetFeature, feature);
    if (!Number.isFinite(distance)) continue;
    entries.push({
      imageId: ensureNumber(row.image_id, -1),
      vectorId: ensureNumber(row.vector_id, null),
      distance,
      feature,
      label: row.original_filename ?? null,
      row,
    });
  }

  entries.sort((a, b) => a.distance - b.distance);
  if (entries.length === 0) {
    return {
      grouped: new Map(),
      selectedEntries: [],
      thresholdUsed: baseThreshold,
      relaxations: 0,
      allEntries: [],
    };
  }

  let threshold = baseThreshold;
  let relaxations = 0;
  let selected = entries.filter((entry) => entry.distance <= threshold);

  function countUniqueImages(list) {
    const ids = new Set();
    for (const entry of list) {
      if (entry.imageId >= 0) ids.add(entry.imageId);
    }
    return ids.size;
  }

  while (
    countUniqueImages(selected) < Math.min(minUniqueImages, entries.length) &&
    relaxations < maxRelaxations
  ) {
    relaxations += 1;
    threshold *= relaxFactor;
    selected = entries.filter((entry) => entry.distance <= threshold);
  }

  if (selected.length === 0) {
    selected = [entries[0]];
  }

  if (selected.length > maxEntries) {
    selected = selected.slice(0, maxEntries);
  }

  const grouped = new Map();
  for (const entry of selected) {
    if (entry.imageId < 0) continue;
    if (!grouped.has(entry.imageId)) {
      grouped.set(entry.imageId, {
        imageId: entry.imageId,
        label: entry.label,
        features: [],
        distances: [],
        vectorIds: [],
      });
    }
    const group = grouped.get(entry.imageId);
    group.features.push(entry.feature);
    group.distances.push(entry.distance);
    if (entry.vectorId) group.vectorIds.push(entry.vectorId);
  }

  return {
    grouped,
    selectedEntries: selected,
    thresholdUsed: threshold,
    relaxations,
    allEntries: entries,
  };
}

module.exports = {
  collectElasticMatches,
};
