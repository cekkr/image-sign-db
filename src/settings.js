// Centralised configuration for editable project settings.
require('dotenv').config();

function getNumber(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getOptionalNumber(envKey) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function getBoolean(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function getStringList(envKey, fallback = []) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === null || raw === '') return [...fallback];
  const list = String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [...fallback];
}

const clientSettings = {
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
  maxIterations: getNumber('CLIENT_MAX_ITERATIONS', 10),
};

const serverSettings = {
  port: getNumber('PORT', 3000),
};

const searchSettings = {
  valueThreshold: getNumber('VALUE_THRESHOLD', 0.08),
  skipThreshold: getNumber('SKIP_THRESHOLD', 3),
  maxCliIterations: getNumber('CLI_MAX_ITERATIONS', 12),
};

const databaseSettings = {
  schema: process.env.DB_NAME || 'image_hypercube_db',
  defaultMaxSizeGb: getNumber('DEFAULT_MAX_DB_SIZE_GB', 10),
};

const correlationSettings = {
  similarityThreshold: getNumber('CORRELATION_SIMILARITY_THRESHOLD', 0.2),
  maxCandidateSample: getNumber('CORRELATION_MAX_CANDIDATE_SAMPLE', 256),
  minAffinity: getNumber('CORRELATION_MIN_AFFINITY', 0.45),
  minCohesion: getNumber(
    'CORRELATION_MIN_COHESION',
    getNumber('CORRELATION_MIN_SPREAD', 0.25)
  ),
  onlineRunnerMaxBatchSize: getNumber('ONLINE_RUNNER_MAX_BATCH_SIZE', 6),
  onlineRunnerMaxBatchSizeCap: getNumber('ONLINE_RUNNER_MAX_BATCH_SIZE_CAP', 12),
};

const trainingSettings = {
  defaults: {
    discover: getNumber('DEFAULT_DISCOVER_ITERATIONS', 3),
    bootstrap: getNumber('DEFAULT_BOOTSTRAP_ITERATIONS', 0),
    reprobe: getNumber('DEFAULT_REPROBE_COUNT', 0),
    shuffle: getBoolean('DEFAULT_SHUFFLE', true),
    threads: getOptionalNumber('DEFAULT_THREADS'),
  },
  resourceSampleIntervalMs: getNumber('RESOURCE_SAMPLE_INTERVAL_MS', 2500),
  bootstrapCommandDefaultIterations: getNumber('BOOTSTRAP_COMMAND_DEFAULT_ITERATIONS', 75),
  minCompletedImageAgeMinutes: getNumber('TRAINING_MIN_COMPLETED_IMAGE_AGE_MINUTES', 0),
  augmentationsPerImage: getNumber('TRAINING_AUGMENTATIONS_PER_IMAGE', 3),
  augmentationList: getStringList('TRAINING_AUGMENTATION_LIST', []),
  selfEvaluation: {
    enabled: getBoolean('TRAINING_SELF_EVAL_ENABLED', true),
    maxSamples: getNumber('TRAINING_SELF_EVAL_MAX_SAMPLES', 8),
    runsPerFilter: getNumber('TRAINING_SELF_EVAL_RUNS', 1),
    topMatches: getNumber('TRAINING_SELF_EVAL_TOP', 3),
    filters: getStringList('TRAINING_SELF_EVAL_FILTERS', ['original']),
  },
  realTimePruning: {
    enabled: getBoolean('TRAINING_REALTIME_PRUNING_ENABLED', true),
    intervalMs: getNumber('TRAINING_REALTIME_PRUNING_INTERVAL_MS', 60000),
    minIngests: getNumber('TRAINING_REALTIME_PRUNING_MIN_INGESTS', 24),
    batchSize: getNumber('TRAINING_REALTIME_PRUNING_BATCH_SIZE', 24),
    vectorBatchSize: getNumber('TRAINING_REALTIME_PRUNING_VECTOR_BATCH', 400),
    minSkipCount: getNumber(
      'TRAINING_REALTIME_PRUNING_MIN_SKIP',
      Math.max(searchSettings.skipThreshold, 4)
    ),
    minGroupAgeMinutes: getNumber('TRAINING_REALTIME_PRUNING_MIN_GROUP_AGE_MINUTES', 45),
    maxGroupHitCount: getNumber('TRAINING_REALTIME_PRUNING_MAX_GROUP_HIT_COUNT', 1),
  },
  progressive: {
    enabled: getBoolean('TRAINING_PROGRESSIVE_ENABLED', true),
    cycles: getNumber('TRAINING_PROGRESSIVE_CYCLES', 3),
    randomPerAug: getNumber('TRAINING_PROGRESSIVE_RANDOM_PER_AUG', 300),
    guidedPerCycle: getNumber('TRAINING_PROGRESSIVE_GUIDED_PER_CYCLE', 300),
  },
  // Optional: store a copy of the original image in DB for future re-vectorization
  storeImageBlob: getBoolean('STORE_IMAGE_BLOB', false),
};

const settings = {
  client: clientSettings,
  server: serverSettings,
  search: searchSettings,
  database: databaseSettings,
  correlation: correlationSettings,
  training: trainingSettings,
};

module.exports = settings;
