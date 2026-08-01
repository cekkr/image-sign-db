// Centralised configuration for editable project settings.
//
// `quiet` because dotenv v17 prints a banner to stdout on load, and this module
// is required by one-liners whose stdout is captured: benchmark.sh reads the
// search ceiling with `node -e '…process.stdout.write(…)'`, and the banner ended
// up inside the run label and from there into benchmarks/scores.csv.
require('dotenv').config({ quiet: true });

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
  // Which storage engine the pipeline talks to. `mysql` is the only backend
  // implemented end-to-end today; `cheetah` selects the Phase 2 ingestion path
  // being built out in ROADMAP.md. Search/evaluation/learning are not wired.
  backend: (function () {
    const raw = String(process.env.STORAGE_BACKEND || 'mysql').trim().toLowerCase();
    return raw === 'cheetah' ? 'cheetah' : 'mysql';
  })(),
};

// Cheetah DB (ROADMAP.md). `dataDir`, `pairIndexBytes` and `graphTermIndex` are
// also read by the Go server itself from CHEETAH_DATA_DIR /
// CHEETAH_PAIR_INDEX_BYTES / CHEETAH_GRAPH_TERM_INDEX — they live here because
// src/lib/cheetah/server.js spawns the server for development and tests.
const cheetahSettings = {
  host: process.env.CHEETAH_HOST || '127.0.0.1',
  port: getNumber('CHEETAH_PORT', 4455),
  database: process.env.CHEETAH_DATABASE || 'image_sign_db',
  dataDir: process.env.CHEETAH_DATA_DIR || 'cheetah_data',
  poolSize: getNumber('CHEETAH_POOL_SIZE', 4),
  connectTimeoutMs: getNumber('CHEETAH_CONNECT_TIMEOUT_MS', 5000),
  commandTimeoutMs: getNumber('CHEETAH_COMMAND_TIMEOUT_MS', 30000),
  maxInFlight: getNumber('CHEETAH_MAX_IN_FLIGHT', 64),
  // Stride 2 is a no-op at creation time only: pairs/format.dat wins on every
  // later open, so this must be right the first time (ROADMAP §4).
  pairIndexBytes: getNumber('CHEETAH_PAIR_INDEX_BYTES', 2),
  // Off by default: hex node ids that share a lexical token cross-match in
  // GRAPH_RECALL, and the index costs a write on every node upsert (§3.3).
  graphTermIndex: getBoolean('CHEETAH_GRAPH_TERM_INDEX', false),
};

// The sign pipeline (src/lib/sign/, src/signPipeline.js, src/sign.js).
//
// Only *operational* knobs live here. The quantisation tables that decide which
// vocabulary word a measurement falls into are frozen in
// src/lib/sign/constants.js and are deliberately not environment variables: an
// env var that repartitions the vocabulary would silently invalidate every
// stored graph edge.
const signSettings = {
  constellationsPerImage: getNumber('SIGN_CONSTELLATIONS_PER_IMAGE', 3600),
  pointCount: getNumber('SIGN_POINT_COUNT', 7),
  pointPatchRelative: getNumber('SIGN_POINT_PATCH_REL', 0.004),
  workingMaxSide: getNumber('SIGN_WORKING_MAX_SIDE', 1024),
  // Off by default: pinning where the centre sits makes a sign refuse to match
  // the same subject at another aspect ratio, because the half-diagonal unit
  // rescales differently per axis.
  withCentrePosition: getBoolean('SIGN_WITH_CENTRE_POSITION', false),
  // Adaptive ingestion: train in chunks and stop when more constellations stop
  // buying discriminability (src/signPipeline.js → trainImageAdaptive).
  // `constellationsPerImage` becomes a ceiling rather than a quota.
  train: {
    // **Off by default, on measurement, not on principle.** The loop only pays
    // when images converge before the ceiling, and on sample_images/ they do
    // not: paired over 35 images it wrote the identical 2 048 constellations and
    // cost 21.1 s against 13.1 s per image (+62%), which is exactly the 3
    // checkpoints x 3 probes x ~0.9 s it spends measuring. Turn it on with
    // `--adaptive` for a corpus whose images separate early, where the same
    // measurement is what lets a flat image stop at 512.
    adaptive: getBoolean('SIGN_TRAIN_ADAPTIVE', false),
    // Constellations between two self-probes. Small enough to stop early on a
    // flat image, large enough that a checkpoint costs less than the chunk.
    checkEvery: getNumber('SIGN_TRAIN_CHECK_EVERY', 512),
    probes: getNumber('SIGN_TRAIN_PROBES', 3),
    // Improvement below this in *both* accuracy and search effort ends the run.
    minGain: getNumber('SIGN_TRAIN_MIN_GAIN', 0.01),
    // The stop rule may only fire once this share of the probes finds the image.
    // A flat checkpoint below it means "not findable yet", which is the opposite
    // of "trained enough": on a near-duplicate corpus an image can sit at the
    // floor for a thousand constellations and then climb.
    stopMinHitRate: getNumber('SIGN_TRAIN_STOP_MIN_HIT_RATE', 1),
    // Below this many stored images there is nothing to be confused with, so a
    // probe cannot measure discriminability and the ceiling is trained in full.
    minCorpus: getNumber('SIGN_TRAIN_MIN_CORPUS', 4),
    // A probe is a cost, not a deliverable: it runs to a lower ceiling than a
    // real search and with the reranker off.
    probeMaxConstellations: getNumber('SIGN_TRAIN_PROBE_MAX', 96),
    // Rehearsal: re-probe images already in the corpus and top up the ones it
    // has stopped being able to find (src/signPipeline.js → reviewCorpus).
    //
    // An image is trained against the corpus that existed when it was trained,
    // and every later image is a new competitor for the same words — so the
    // early images of a growing corpus lose findability without changing. This
    // is the loop that notices. Off by default because it costs probes; turn it
    // on with `--rehearse` while a corpus is being built up.
    review: {
      enabled: getBoolean('SIGN_TRAIN_REVIEW', false),
      // Images trained between two review passes. 0 reviews only at the end.
      every: getNumber('SIGN_TRAIN_REVIEW_EVERY', 4),
      // Images looked at per pass, least recently reviewed first. 0 = all of
      // them, which is quadratic in corpus size and only sane on small corpora.
      sample: getNumber('SIGN_TRAIN_REVIEW_SAMPLE', 8),
      // Below this probe hit rate an image is topped up. The default is the
      // same "every probe must find it" bar the chunked trainer stops on.
      minHitRate: getNumber('SIGN_TRAIN_REVIEW_MIN_HIT_RATE', 1),
      // Constellations one top-up buys. One chunk, then measure again: giving a
      // struggling image everything at once spends the budget on whichever
      // image happened to be probed first.
      topUp: getNumber('SIGN_TRAIN_REVIEW_TOP_UP', 512),
      // Total constellations an image may reach through top-ups. Some images
      // are genuinely indistinguishable from a near-duplicate and no amount of
      // evidence fixes that; without a cap the pass buys most for exactly those.
      ceiling: getNumber('SIGN_TRAIN_REVIEW_CEILING', 8192),
      // Final passes after the last image, repeated while any top-up happened.
      // The last images trained have had the fewest chances to be reviewed.
      finalPasses: getNumber('SIGN_TRAIN_REVIEW_FINAL_PASSES', 2),
    },
    // How far an image that is *still improving* at `constellationsPerImage`
    // may keep going. `0` disables it, which is the shipped default: extending
    // buys recall with training time and that is a decision, not a default.
    // Measured on sample_images/, most images are still climbing steeply at
    // 2048, so this is the knob the data actually asks for — see README.
    extendTo: getNumber('SIGN_TRAIN_EXTEND_TO', 0),
  },
  search: {
    batchSize: getNumber('SIGN_SEARCH_BATCH', 12),
    minConstellations: getNumber('SIGN_SEARCH_MIN_CONSTELLATIONS', 24),
    maxConstellations: getNumber('SIGN_SEARCH_MAX_CONSTELLATIONS', 720),
    // A word carried by more than this share of the corpus is a stop word and
    // is not worth a recall seed.
    stopWordImageRatio: getNumber('SIGN_SEARCH_STOPWORD_RATIO', 0.6),
    seedsPerRound: getNumber('SIGN_SEARCH_SEEDS_PER_ROUND', 96),
    // Pivoted length normalisation: 0 ignores how many words an image
    // published, 1 divides its evidence in full proportion to them.
    //
    // The default is 0 because correcting for length made things monotonically
    // worse, which was not the expected result. Measured on a 20-image corpus,
    // rank-1 went 80% (0), 80% (0.25), 60% (0.5), 50% (0.75), 35% (1.0). Idf
    // weighting already handles selectivity, and an image with few distinct
    // words already accumulates less raw mass because it has fewer words to be
    // matched on — dividing again double-counts that and let four flat images
    // (261-280 words against a corpus mean near 1300) win other images'
    // searches. The knob stays for a corpus whose vocabulary sizes are uniform.
    lengthSlope: getNumber('SIGN_SEARCH_LENGTH_SLOPE', 0),
    // How much a constellation that agrees with *itself* is worth over the same
    // triples arriving separately: each group of seeds from one measured sign is
    // scaled by `1 + chainBonus * (agreeing triples - 1)`.
    //
    // 0 is the historical behaviour, exactly — the fold is a bag of words, and
    // that is why point count behaved like a sampling rate rather than like a
    // richer feature: a 7-point chain is 5 triples where a 5-point chain is 3,
    // but scattered across a bag those extra triples are indistinguishable from
    // simply drawing more constellations. Measured at equal triple budget the
    // two scored the same, which is the symptom. Above 0, a longer chain can put
    // more *mutually agreeing* evidence behind one image, which is the thing the
    // extra points actually add and which coincidence does not reproduce.
    // **It moves the separation scale, so `separationTarget` has to move with
    // it.** The bonus is larger for the image a chain actually agrees with than
    // for the ones it brushes, which is the whole point — but that widens the
    // leader/runner-up ratio the stop rule reads, and a threshold calibrated on
    // the bag-of-words scale then fires almost immediately. Measured: at bonus 1
    // and `separationTarget` left at 1.35, the median search stopped after 24
    // constellations instead of 480 and rank-1 fell 85% -> 65%. Raise the target
    // when raising this, and judge the two together.
    chainBonus: getNumber('SIGN_SEARCH_CHAIN_BONUS', 0),
    // How far ahead of an even split the leader must be before a search stops,
    // as a **multiple of the uniform share** `1/corpus`.
    //
    // This is deliberately not an absolute share, which is what it used to be
    // and which cannot work: the leader's share of the mass falls as the corpus
    // grows because more candidates divide it. The same searches that led with
    // 15-28% on an 11-image corpus lead with ~10% on a 20-image one, so a fixed
    // 0.25 stopped firing entirely the moment the corpus doubled. Measured as a
    // multiple, both corpora sit near 2.1-2.4x uniform.
    confidenceMultiple: getNumber('SIGN_SEARCH_CONFIDENCE_MULTIPLE', 2),
    // The safety brake, and the criterion that actually carries the signal: how
    // far ahead of the runner-up the leader is. It is why a corpus containing
    // near-duplicates keeps measuring — on sample_images the true match often
    // leads the second place by only ~1.1, and stopping there would be stopping
    // on a coin flip.
    separationTarget: getNumber('SIGN_SEARCH_SEPARATION', 1.35),
    rerankTop: getNumber('SIGN_SEARCH_RERANK_TOP', 5),
    rerankSigns: getNumber('SIGN_SEARCH_RERANK_SIGNS', 12),
  },
};

const correlationSettings = {
  similarityThreshold: getNumber('CORRELATION_SIMILARITY_THRESHOLD', 0.2),
  maxCandidateSample: getNumber('CORRELATION_MAX_CANDIDATE_SAMPLE', 512),
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
  // Debug/observability for correlation discovery
  correlationDebugLog: getBoolean('TRAINING_CORRELATION_DEBUG_LOG', false),
  correlationTopLogK: getNumber('TRAINING_CORRELATION_TOP_LOG_K', 5),
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
  cheetah: cheetahSettings,
  sign: signSettings,
  correlation: correlationSettings,
  training: trainingSettings,
};

module.exports = settings;
