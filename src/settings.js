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

const settings = {
  client: {
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
    maxIterations: getNumber('CLIENT_MAX_ITERATIONS', 10),
  },
  server: {
    port: getNumber('PORT', 3000),
  },
  search: {
    valueThreshold: getNumber('VALUE_THRESHOLD', 0.08),
    skipThreshold: getNumber('SKIP_THRESHOLD', 3),
    maxCliIterations: getNumber('CLI_MAX_ITERATIONS', 12),
  },
  database: {
    schema: process.env.DB_NAME || 'image_hypercube_db',
    defaultMaxSizeGb: getNumber('DEFAULT_MAX_DB_SIZE_GB', 10),
  },
  correlation: {
    similarityThreshold: getNumber('CORRELATION_SIMILARITY_THRESHOLD', 0.2),
    maxCandidateSample: getNumber('CORRELATION_MAX_CANDIDATE_SAMPLE', 256),
    minAffinity: getNumber('CORRELATION_MIN_AFFINITY', 0.45),
    minCohesion: getNumber(
      'CORRELATION_MIN_COHESION',
      getNumber('CORRELATION_MIN_SPREAD', 0.25)
    ),
    onlineRunnerMaxBatchSize: getNumber('ONLINE_RUNNER_MAX_BATCH_SIZE', 6),
    onlineRunnerMaxBatchSizeCap: getNumber('ONLINE_RUNNER_MAX_BATCH_SIZE_CAP', 12),
  },
  training: {
    defaults: {
      discover: getNumber('DEFAULT_DISCOVER_ITERATIONS', 3),
      bootstrap: getNumber('DEFAULT_BOOTSTRAP_ITERATIONS', 0),
      reprobe: getNumber('DEFAULT_REPROBE_COUNT', 0),
      shuffle: getBoolean('DEFAULT_SHUFFLE', true),
      threads: getOptionalNumber('DEFAULT_THREADS'),
    },
    resourceSampleIntervalMs: getNumber('RESOURCE_SAMPLE_INTERVAL_MS', 2500),
    bootstrapCommandDefaultIterations: getNumber('BOOTSTRAP_COMMAND_DEFAULT_ITERATIONS', 75),
    selfEvaluation: {
      enabled: getBoolean('TRAINING_SELF_EVAL_ENABLED', true),
      maxSamples: getNumber('TRAINING_SELF_EVAL_MAX_SAMPLES', 8),
      runsPerFilter: getNumber('TRAINING_SELF_EVAL_RUNS', 1),
      topMatches: getNumber('TRAINING_SELF_EVAL_TOP', 3),
      filters: getStringList('TRAINING_SELF_EVAL_FILTERS', ['original']),
    },
  },
};

module.exports = settings;
