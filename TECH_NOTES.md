# TECH_NOTES

Authoritative technical reference for Image Sign DB. Update this document whenever the codebase, schema, or operational runbooks change so that humans and agents share the same canonical context.

## 1. Purpose & Conceptual Model
- Image Sign DB is a CBIR engine that identifies images via *constellation* descriptors instead of raw pixels (`README.md`).
- Every image is decomposed into relative HSV/luminance gradients plus deterministic quadtree summaries; descriptors live in hashed `value_types` records so MySQL stays agnostic (`src/featureExtractor.js`, `src/lib/descriptor.js`).
- The system enforces a server-driven interrogation: clients measure only the descriptors requested by the server, preserving privacy while exploiting the server’s learned knowledge (`src/index.js`, `src/clientAPI.js`).

## 2. High-Level Architecture
- **Extraction layer** (Sharp-based) emits descriptor batches per augmentation and persists them to
  MySQL or, for the implemented Phase 2 ingestion path, Cheetah (`src/featureExtractor.js`,
  `src/lib/cheetah/store.js`).
- **Training & ingestion** orchestrate progressive sampling, online correlation discovery, evaluation, and pruning with adaptive worker threads (`src/train.js`, `src/workers/ingestWorker.js`).
- **Knowledge graph** records cooperative feature geometry and per-descriptor statistics to guide future probes (`src/lib/knowledge.js`).
- **Search API** exposes CLI and HTTP flows that rank candidates with an elastic matcher while tracking skip patterns, usage, and constellation accuracy (`src/index.js`, `src/lib/elasticMatcher.js`).
- **Support tooling** includes dataset ingestion (`src/insert.js`), DB setup (`src/setupDatabase.js`), evaluation helpers (`src/evaluate.js`), and custom experiments (`src/vectorCustom.js`).

## 3. Data Flow Overview
1. **Image ingest**: The extractor applies deterministic + stochastic augmentations, samples constellation descriptors, and bulk-persists vectors. Each vector references a hashed descriptor in `value_types`.
2. **Progressive refinement**: Subsequent ingestion cycles request high-value descriptors ranked by `feature_group_stats`.
3. **Correlation discovery**: Online sweeps update the knowledge graph and aggregate statistics; real-time pruning removes stale or low-value data.
4. **Search**: The API requests probes, measures candidate distance/affinity with elastic thresholds, and iteratively narrows the candidate set using knowledge graph hints.
5. **Evaluation**: Dedicated loops replay probes with optional transformations (cropping, blur, mirrors) to measure retrieval accuracy.

## 4. Database Schema (MySQL)
- `images`: top-level image records with `ingestion_complete` gating partially ingested rows (`src/setupDatabase.js`).
- `value_types`: hashed descriptor definitions (`descriptor_hash`, `descriptor_json`).
- `feature_vectors`: measured constellation values per augmentation/resolution/anchor (`value_type`, `resolution_level`, `rel_x`, `rel_y`, `size`), with `resolution_level` stored as a DECIMAL(6,5) blur span to preserve relative scale.
- `feature_usage`: per-vector usage counters + last score for pruning heuristics.
- `skip_patterns`: descriptors to avoid; supports pruning and search fallbacks.
- `system_settings`: runtime settings such as `max_db_size_gb`.
- `knowledge_nodes`: hierarchical graph linking feature vectors (`node_type` `FEATURE`/`GROUP`, `vector_length`, `vector_angle`, hit/miss stats).
- `feature_group_stats`: aggregated mean/separation statistics per descriptor + resolution (matching DECIMAL(6,5) resolution levels); drives guided sampling and probing.
- Optional `image_blobs` (created on demand when `STORE_IMAGE_BLOB=true`) stores original pixels for re-vectorization (`src/featureExtractor.js`).

## 5. Constellation Descriptors
- Constellations (also referenced as *patterns*) encode how two relative anchor patches relate under a specific augmentation/channel.
- Descriptor space is defined by `CONSTELLATION_CONSTANTS` (relative span, offset magnitude, anchor/offset tolerances) and channel list `[h, s, v, luminance, stddev]` (`src/lib/constants.js`).
- Deterministic sampling uses `SAMPLES_PER_AUGMENTATION` seeds per augmentation; descriptors hash `augmentation`, anchor coordinates, span, offsets, channel (`src/lib/constellation.js`).
- Descriptors are normalized to resolution-independent anchors (`anchor_u/v`), spans (`span`), and offsets (`offset_x/y`), enabling cross-scale and mirrored matching.
- `descriptorKey = SHA1(serialized descriptor)` is the canonical identity across ingestion, search, and pruning.

## 6. Augmentation Library
- Baseline: `original`, `mirror_horizontal`, `mirror_vertical`, `gaussian_blur`, `center_crop_80`.
- Stochastic combos: `random_combo_[0-2]` apply deterministic (seeded) crop, rotate, hue/saturation/brightness modulations, and optional blur while logging vector counts to surface skew (`src/lib/augmentations.js`).
- Evaluation filters reuse these augmentations and add seeded cropping transforms (`src/evaluate.js`).
- Augmentation order and deterministic seeds are shared by extractor, evaluator, and sampler to guarantee reproducibility.

## 7. Feature Extraction & Storage
- `extractAndStoreFeaturesProgressive` powers ingestion when progressive mode is enabled (default). It:
  - Loads the image (Sharp) and metadata once.
  - Applies configured augmentations.
  - Generates random descriptor batches (`generateAllFeaturesForAugmentation`, `generateFeaturesForAugmentationOrdinals`) and logs per-augmentation volumes.
  - Resolves descriptor IDs in bulk (`ensureValueTypeId`, `resolveValueTypesBulk`) with retry guards for lock contention.
  - Inserts feature vectors with retry-aware inserts and seeds `feature_usage`.
- Progressive cycles:
  - Cycle 1: random subset per augmentation (`TRAINING_PROGRESSIVE_RANDOM_PER_AUG`).
  - Cycles 2+: guided descriptors from `selectTopDescriptors` (knowledge-driven) with `TRAINING_PROGRESSIVE_GUIDED_PER_CYCLE` rows per cycle.
- Optional `STORE_IMAGE_BLOB` persists the source image for future re-vectorization.
- With `STORAGE_BACKEND=cheetah`, exhaustive ingestion and the progressive random cycle write through
  `CheetahStore`: `i:` starts with `complete:false`, descriptors/token mappings and `f:` rows are
  pipelined, then the image record is rewritten with `complete:true` and the Cheetah payload budget
  is enforced. Cheetah guided cycles and blob storage are skipped pending their roadmap phases;
  MySQL behavior is unchanged.

## 8. Training & Ingestion Pipeline (`src/train.js`)
- CLI options: `--discover`, `--bootstrap`, `--reprobe`, `--shuffle`, `--threads`, plus evaluation flags (`--evaluate`, `--evaluate-filters`, `--evaluate-runs`, `--evaluate-top`) and augmentation controls (`--augmentations`, `--aug-per-pass`, `--aug-seed`).
- Walks dataset directories recursively, tracking supported extensions (`.jpg/.jpeg/.png/.webp/.bmp`).
- Adaptive worker pool:
  - Uses Node worker threads (`src/workers/ingestWorker.js`) for ingestion; sizing reacts to CPU load, memory, and queue length.
  - Worker jobs call `insert.js` ingestion path, so all storage safeguards remain consistent.
  - With `STORAGE_BACKEND=cheetah`, the pool is forced to one worker because token allocation is
    process-local. MySQL self-evaluation/pruning and the unported discover/bootstrap/reprobe/evaluate
    paths are disabled or rejected explicitly.
- Early bootstrapping with shuffled datasets seeds the constellation/pattern probability tree before knowledge-driven probes dominate search requests.
- Online correlation discovery:
  - `discoverCorrelations` selects discriminators, updates `knowledge_nodes`, `feature_group_stats`, and logs metrics.
  - `TRAINING_CORRELATION_DEBUG_LOG` and `TRAINING_CORRELATION_TOP_LOG_K` gate verbose per-iteration diagnostics.
- Knowledge-guided reprobes:
  - `fetchConstellationGraph` seeds queues with high-hit constellation groups (`src/lib/knowledge.js`).
  - Probing iterates per constellation, logging cumulative accuracy and fallbacks.
- Evaluation mode:
  - `--evaluate` triggers multi-run analysis per image using selected filters; emits top matches with affinity/spread/cohesion and summarizes accuracy.
  - Self-evaluation queues run automatically during early ingestion cycles (`TRAINING_SELF_EVAL_*`).
- Real-time pruning:
  - `RealTimePruner` kicks in after configurable ingest counts to delete low-value vectors, prune skip-pattern descriptors, and drop weak constellation groups.
- Resource sampling and observability:
  - Periodic load/memory snapshots inform worker scaling.
  - Training logs include ingestion time, vector counts, correlation outcomes, reprobe summary, and pruning events.

## 9. Knowledge Graph & Correlation (`src/lib/knowledge.js`)
- `discoverCorrelations`:
  - Pulls candidate vectors, computes affinity / cohesion / spread via `collectElasticMatches` & `scoreCandidateFeature`.
  - For each useful pair it creates/updates FEATURE and GROUP nodes, increments hit/miss counts, and writes aggregate stats (`feature_group_stats`).
- `fetchConstellationGraph`:
  - Returns ranked GROUP relationships (hit_count >= configurable minimum) with parsed descriptors, enabling probe queues to follow proven geometry.
- `fetchRelatedConstellations` feeds the online search loop with the highest-confidence neighbours for a descriptor, translating hit/miss history into a probability score that is echoed back to clients.
- `recordVectorUsage` tracks descriptor value whenever used in search or correlation; data feeds pruning decisions.
- `ensureValueTypeCapacity` (from `src/lib/schema.js`) upgrades schema columns to `MEDIUMINT` to avoid overflow before ingestion proceeds.

## 10. Search Server & CLI (`src/index.js`)
- HTTP server (Express 5) on `PORT` (default 3000) exposes:
  - `POST /search/start` for session initiation + first probe or measured response.
  - `POST /search/refine` for follow-up probes.
  - Admin endpoints proxied via `insert.js` helpers (image add/remove, discovery, settings).
- Session management:
  - Maintains per-session phase, candidate set, asked descriptors, and `constellationPath`.
  - Initial probe is sampled randomly from DB, skipping descriptors that exceed `SKIP_THRESHOLD` (learned failures).
  - Each probe now carries `source`, `confidence`, `hits`, and `misses`; `extendConstellationPath` multiplies those probabilities so the server (and client) can observe the evolving decision tree.
  - Each response records relaxations (elastic matcher), thresholds, and updates skip caches.
- Candidate selection:
  - `ensureValueTypeRecord` resolves descriptor IDs through shared evaluator logic (`src/evaluate.js`).
  - `collectElasticMatches` sorts vector hits with threshold relaxation to avoid losing near misses.
  - Usage of matching vectors is incremented (`recordVectorUsage`).
- Constellation-driven refinement:
  - Uses `fetchRelatedConstellations` + `extendConstellationPath` to prioritise learned patterns (`source=knowledge`) while occasionally injecting random probes (`source=exploration`/`random`) for privacy and continued learning.
- CLI mode mirrors HTTP logic for offline searches (`node src/index.js find <image>`).

## 10½. Sign Pipeline (`src/lib/sign/`, `src/lib/cheetah/signStore.js`, `src/signPipeline.js`, `src/sign.js`)

A second, independent recognition engine, Cheetah-native end to end. It shares no code path with the
`delta` family above and never touches MySQL. Implements the constellation specification plus
`studies/continuous_colors_function.md`.

- **Descriptor.** A *sign* is a chain of an odd number of points (default 5) whose middle point is
  the randomly drawn seed. Each hop draws a circumference length uniformly in
  `[0.25, 1.0] × (W+H)/2`, takes its radius, and rejects angles that leave the frame. Stored per
  point: the absolute HSV difference against the neighbour towards the centre (the centre is
  `[0,0,0]` by definition, so no absolute colour is ever persisted), and that hop's distance and
  bearing **in half-diagonal units** — `1` is the image centre to a corner. Hue is compared as a
  circular distance, doubled so all three channels share `[0,1]`. The optional centre position
  (`SIGN_WITH_CENTRE_POSITION`) is off by default because the half-diagonal unit rescales
  differently per axis and pinning it breaks matching across aspect ratios.
- **Vocabulary.** Each triple of consecutive points → one integer word from a frozen space of
  `3 × 6 × 4⁶ = 73,728` (scale band, turn angle, six colour-delta levels). Hop *lengths* are only a
  three-band scale: the radius is drawn at sampling time, so a fine length describes the sampler and
  not the image. Level tables and tolerances are frozen in `src/lib/sign/constants.js` behind
  `SIGN_LAYOUT_VERSION`; `SignStore.connect()` validates `cfg:sign_layout_version` and refuses a
  mismatch.
- **Key layout** (owned, like every Cheetah key, by `src/lib/cheetah/keys.js`):
  `si:<imageHex8>`, `sn:<sha1(filename)>`, `sc:<imageHex8>/<constHex4>`,
  `sw:<wordHex5>/<imageHex8>/<constHex4>`. Additive to the `f:` layout — a database written before
  they existed stays readable. The `sw:` segment order is load-bearing: `sw:<word>/` is the posting
  list and `sw:<word>/<image>/` is the drill-down the reranker walks.
- **Graph.** `word --sign--> image` edges, `w<hex5>` and `m<hex8>` node ids (bare prefix + hex, no
  separator word, same reason as `n`/`m` in §13). Edge weight is `min(1, tf / 3)`; Cheetah clamps
  weight into `[0,1]` before using it as activation, so saturating explicitly is what keeps "seen
  once" distinct from "seen repeatedly".
- **Ingestion.** `putImage(complete:false)` → `putSigns` → `commitGraph` → `markComplete`, the same
  commit-marker protocol as `CheetahStore`. Soft assignment lives on the **query** side: ingestion
  stores only the primary word of each triple. The choice is symmetric in effect and was decided by
  measurement — storing all four words of a sweep put ~6 900 postings and ~5 400 graph edges behind
  one image against ~2 400 postings and ~1 700 edges for the primary only (at 600 constellations),
  with accuracy unchanged, while a query-side variant costs one extra seed on a recall that was
  happening anyway. `commitGraph` remains the larger half of the cost: graph edge upserts, not pair
  writes, are what ingestion time is made of.
  **Ingestion is Cheetah-bound, not CPU-bound, and the constant moved.** Profiled at 2 048
  constellations on one image: drawing and measuring the whole constellation set — geometry,
  HSV patches, records, vocabulary — is **32 ms**; everything else is the database. Against the
  submodule as pinned before 2026-07-30 that was `putSigns` 29.3 s + `commitGraph` 66.0 s = **95 s**
  per image. The cause was in Cheetah's jump store, which reopened `jumps.bin`/`index.bin` on every
  trie hop (`open(2)` alone was 53% of server CPU); with the handles held it is `putSigns` 2.2 s +
  `commitGraph` 4.5 s = **6.7 s** into an empty corpus, and ~15 s into a 49-image one — the cost
  grows with the corpus because the trie deepens. Any timing quoted here is against a submodule at
  or after that fix; re-measure rather than trusting an older figure.
- **Adaptive ingestion (`trainImageAdaptive`, `SIGN_TRAIN_ADAPTIVE`, default off).** With it on,
  `SIGN_CONSTELLATIONS_PER_IMAGE` is a **ceiling**,
  not a quota: signs are written in `SIGN_TRAIN_CHECK_EVERY` chunks and, between chunks, the image
  being written is searched for `SIGN_TRAIN_PROBES` times against the corpus already stored. A run
  continues only while a checkpoint beats the best so far by `SIGN_TRAIN_MIN_GAIN` in accuracy
  (hit rate + margin over the best competitor) **or** in search effort. Three constraints hold it
  together: the probes redraw their own constellations (never the trained ones) so a checkpoint
  measures recall and not memorisation; their seeds are fixed per image so consecutive checkpoints
  ask the *same* questions of a better-trained image, without which checkpoint-to-checkpoint noise
  alone keeps a run alive; and a corpus below `SIGN_TRAIN_MIN_CORPUS` cannot measure
  discriminability at all, so the ceiling is trained in full (`reason: 'corpus-too-small'`).
  A fourth guard covers the failure the first three do not: the stop rule is inert until
  `SIGN_TRAIN_STOP_MIN_HIT_RATE` of the probes actually find the image. On a near-duplicate corpus an
  image's margin measures exactly −1 (it is not among the candidates at all) for its first ~1000
  constellations and only then climbs — −1.00 at 1024, −0.34 at 1536, positive at 1792 — so a flat
  early checkpoint is "not findable yet", not "trained enough", and reading it as convergence stops
  the image at the bottom of its curve.
  **What the loop actually found is the opposite of what it was built to find.** It was written to
  cut training time; on `sample_images/` it almost never stops, because the checkpoint curves say
  2048 constellations is at or below where these images become findable, not above it. Probing every
  256 against 28 images: `020.jpg` is absent from the candidate list until 1024 and first reaches a
  perfect hit rate at 1536; `022.jpg` reaches one probe in three at 1792; `021.jpg` never appears at
  all through 1792. So `reason: 'exhausted'` is a **diagnosis** — "still improving when the budget
  ran out" — and `SIGN_TRAIN_EXTEND_TO` (default `0`, off) is the knob that follows from it: it lets
  a still-improving image continue past the nominal count to a hard cap, spending training time to
  buy recall. With nothing converging the probes are pure overhead — paired over 35 images, identical
  2048 constellations written, 21.1 s against 13.1 s per image (+62%), exactly its 3 checkpoints ×
  3 probes × ~0.9 s — which is why `SIGN_TRAIN_ADAPTIVE` ships **off** and is enabled per run with
  `--adaptive`.
  Chunking needs two things from the store: `SignStore.readWhileIncomplete(imageId)` exempts exactly
  the image being written from the completion filter — the marker itself still flips once, at the
  end — and `commitGraph` is called with **cumulative** per-word counts, since an edge weight is a
  function of how often the word was seen in the whole image, not in one chunk.
- **Search.** Measure a batch of constellations → drop unknown and too-common words
  (`GRAPH_DEGREE`) → seed `GRAPH_RECALL` with the rarest survivors (`hops=1`, `decay=1`,
  `direction=out`, `type=sign`, batched at the server's 32-seed cap) → fold each hit's *per-seed*
  activations into a running belief, weighted by word idf and divided by `sqrt(image vocabulary)` →
  stop when the leader holds `SIGN_SEARCH_CONFIDENCE` of the belief and leads by
  `SIGN_SEARCH_SEPARATION`. Evidence is accumulated in Node rather than by one large recall because
  the server's noisy-OR saturates: right *inside* a batch, wrong *across* batches.
- **Rerank — reported, never applied.** Candidates are scored three ways: the study's `C·E + β(1−C)`
  rule over observations, its canonical-descriptor distance, and a plain distance between the matched
  triple's continuous features. All three first align both signs on the triple whose word matched
  (`alignToTriple`); without that the two frames share nothing but each being centred on its own seed
  pixel. Hue's circular encoding from the study's §1 is deliberately **not** implemented — the field
  interpolates delta magnitudes, which are not circular.
  Measured on the 20-image corpus, all three score *below* the graph they would reorder (5/20, 6/20,
  8/20 against 16/20), the crudest of them highest, and raising the sample from 12 signs to 60 changes
  nothing. Diagnosis and the direction a next attempt should take are in `AGENTS.md` → Known Gaps.
- **CLI.** `node src/sign.js train|find|evaluate|stats`, `--spawn` to run the vendored server for
  the command's duration. `--db-name` selects the Cheetah database for training and for search
  (`--database` is an older alias); `--reset` drops it first and is **training only** — `find` and
  `stats` refuse it rather than deleting the corpus they were about to read. `evaluate` re-identifies
  each trained image from a fresh random draw, and `--report <file>` writes the run as JSON.
- **Benchmarking.** `./benchmark.sh` sweeps `(training density × search ceiling)`, one run each,
  building `cheetah-server` if needed and holding one instance for the whole session so start-up
  cost stays out of the timings. Each density gets a fresh Cheetah database. Reports land in
  `benchmarks/<timestamp>/` and one row per run is appended to `benchmarks/scores.csv` by
  `scripts/benchmark-report.js`. That helper's `COLUMNS` order is a file format — the CSV is
  appended to across sessions, so new fields go at the end or every historical row shifts.

## 11. Client Tools & Scripts
- `src/setupDatabase.js`: Initializes database and tables; idempotent with best-effort migrations.
- `src/insert.js`:
  - Commands: `add`, `remove`, `bootstrap`.
  - Handles progressive ingestion toggles, optional per-run augmentation lists, correlation sweeps, and storage capacity enforcement (`ensureStorageCapacity`).
- `src/clientAPI.js`: Reference client for HTTP search; prints descriptor details and cumulative constellation accuracy per step.
- `src/evaluate.js`: Shared evaluator utilities (probe normalization, descriptor lookup, elastic scoring, seeded cropping filter).
- `src/testCorrelations.js`: Seeds sample correlations for testing (consult when refreshing fixture data).
- `src/vectorCustom.js`: Legacy grid-based vector experiment (uses `image_vectors` table that is not part of the current schema; keep for exploratory scripts only).

## 12. Configuration (`src/settings.js`)
- Centralizes environment parsing with helpers (`getNumber`, `getBoolean`, `getStringList`).
- Key groups:
  - `client`: `API_BASE_URL`, `CLIENT_MAX_ITERATIONS`.
  - `server`: `PORT`.
  - `search`: `VALUE_THRESHOLD`, `SKIP_THRESHOLD`, `CLI_MAX_ITERATIONS`.
  - `database`: schema name, default size cap (`DEFAULT_MAX_DB_SIZE_GB`), and `backend`
    (`STORAGE_BACKEND`, `mysql` | `cheetah`; `cheetah` supports Phase 2 ingestion and
    feature-row storage-budget pruning, but not search/evaluation/learning yet).
  - `cheetah`: connection and lifecycle settings for the Cheetah migration groundwork —
    `CHEETAH_HOST`, `CHEETAH_PORT`, `CHEETAH_DATABASE`, `CHEETAH_DATA_DIR`,
    `CHEETAH_POOL_SIZE`, `CHEETAH_CONNECT_TIMEOUT_MS`, `CHEETAH_COMMAND_TIMEOUT_MS`,
    `CHEETAH_MAX_IN_FLIGHT`, `CHEETAH_PAIR_INDEX_BYTES`, `CHEETAH_GRAPH_TERM_INDEX`.
    Read by `src/lib/cheetah/*` and the Cheetah ingestion branch in `src/featureExtractor.js`
    (see `ROADMAP.md`).
    `CHEETAH_DATA_DIR`, `CHEETAH_PAIR_INDEX_BYTES` and `CHEETAH_GRAPH_TERM_INDEX` are also
    read by the Go server process itself.
  - `sign`: operational knobs of the Cheetah-native sign pipeline (§10½) —
    `SIGN_CONSTELLATIONS_PER_IMAGE` (3600), `SIGN_POINT_COUNT` (7, must be odd; a chain of `n`
    points yields `n − 2` triples, so it scales the cost of every stage),
    `SIGN_POINT_PATCH_REL` (0.004; `0` reads exactly one pixel), `SIGN_WORKING_MAX_SIDE` (1024),
    `SIGN_WITH_CENTRE_POSITION` (false); under `train` (adaptive ingestion, which makes
    `SIGN_CONSTELLATIONS_PER_IMAGE` a ceiling rather than a quota): `SIGN_TRAIN_ADAPTIVE` (false),
    `SIGN_TRAIN_CHECK_EVERY` (512), `SIGN_TRAIN_PROBES` (3), `SIGN_TRAIN_MIN_GAIN` (0.01),
    `SIGN_TRAIN_MIN_CORPUS` (4), `SIGN_TRAIN_PROBE_MAX` (96), `SIGN_TRAIN_EXTEND_TO` (0);
    under `train.review` (rehearsal — re-probe images already trained and top up the ones the
    growing corpus can no longer find): `SIGN_TRAIN_REVIEW` (false), `SIGN_TRAIN_REVIEW_EVERY` (4),
    `SIGN_TRAIN_REVIEW_SAMPLE` (8), `SIGN_TRAIN_REVIEW_MIN_HIT_RATE` (1),
    `SIGN_TRAIN_REVIEW_TOP_UP` (512), `SIGN_TRAIN_REVIEW_CEILING` (8192),
    `SIGN_TRAIN_REVIEW_FINAL_PASSES` (2); and under `search`: `SIGN_SEARCH_BATCH` (12),
    `SIGN_SEARCH_MIN_CONSTELLATIONS` (24), `SIGN_SEARCH_MAX_CONSTELLATIONS` (720),
    `SIGN_SEARCH_STOPWORD_RATIO` (0.6), `SIGN_SEARCH_SEEDS_PER_ROUND` (96),
    `SIGN_SEARCH_LENGTH_SLOPE` (0 — but required above 0 whenever training density is
    uneven, e.g. under `--rehearse`), `SIGN_SEARCH_CHAIN_BONUS` (0 — credits a constellation
    for agreeing with itself instead of folding its triples as an unordered bag),
    `SIGN_SEARCH_CONFIDENCE_MULTIPLE` (2),
    `SIGN_SEARCH_SEPARATION` (1.35), `SIGN_SEARCH_RERANK_TOP` (5), `SIGN_SEARCH_RERANK_SIGNS` (12).
    Every one of these was measured on `sample_images/`, and three are counter-intuitive:
    `CONFIDENCE_MULTIPLE` is a multiple of the uniform share `1/corpus` because an absolute share
    stops firing when the corpus grows (the leader led with 15-28% on 11 images and ~10% on 20);
    `LENGTH_SLOPE` defaults to 0 because correcting for vocabulary size made rank-1 monotonically
    worse (80/80/60/50/35% at 0/0.25/0.5/0.75/1.0); `SEPARATION` is the criterion that carries the
    signal, and 1.35 stops 8 of 20 searches early at no accuracy cost while 1.15 stops 14 and costs
    three of them.
    The vocabulary quantisation tables are **not** here: they are frozen in
    `src/lib/sign/constants.js` behind `SIGN_LAYOUT_VERSION`, because an environment variable that
    repartitioned the vocabulary would invalidate every stored graph edge without saying so.
  - `correlation`: similarity thresholds, candidate sample caps, online runner sizing.
  - `training`: defaults for CLI flags, augmentation budgets, progressive ingestion, self-evaluation, real-time pruning, and debug logging.
- Environment variables in `.env` override defaults; always document new flags here and in this file when adding tunables.

## 13. Storage & Pruning (`src/lib/storageManager.js`, `src/lib/realTimePruner.js`, `src/lib/cheetah/store.js`)
- MySQL `ensureStorageCapacity`:
  - Reads `system_settings.max_db_size_gb` or default; prunes low-usage vectors (not part of any knowledge node) when above limit.
  - Warns if DB size remains above target after pruning.
- Cheetah `CheetahStore.ensureStorageCapacity`:
  - Reads `cfg:max_db_size_gb` or the same default and totals
    `PAIR_SUMMARY.total_payload_bytes` across every Image Sign namespace without hydrating values.
  - Ranks complete-image `f:` rows by usage count, last-use time, and key; removes one bounded batch
    of at most 5,000 rows with exact `DEL pairs key=` operations and deletes matching `use:` records.
    Incomplete ingests are never candidates.
  - The cap measures owned payload bytes, not physical storage. Trie/table/filesystem overhead is
    excluded: in the 50-image gate, summaries reported 3,854,640 payload bytes while the data
    directory occupied 30,482,677 bytes.
  - No Cheetah graph rows exist yet. Phase 4 must protect graph-pinned features before graph learning
    and budget pruning can run together.
- Real-time pruning removes:
  - High skip-count descriptors (cleans `feature_vectors`, `value_types`, and `skip_patterns`).
  - Stale GROUP nodes with low hits and age beyond threshold.
- Logs summarize pruned vectors/descriptors/constellations for audit.

## 13½. Tests (`test/`)
- `npm test` runs `node --test test/*.test.js` — no test dependency is added; the runner is Node's own.
- Coverage today is the Cheetah protocol/key groundwork plus the live Phase 2 storage contract:
  incomplete-image gating, feature writes and scans, usage/skip/settings records, payload accounting,
  bounded cold-row pruning, and pooled KV. The MySQL pipeline remains unprotected by tests;
  verification there still means running it.
- `npm run test:integration` additionally builds `cheetah-server` from the submodule, spawns it
  headless on an ephemeral port, and round-trips the client against it. It is skipped by plain
  `npm test` (gated on `CHEETAH_INTEGRATION=1`) so the default suite needs no Go toolchain.
- The sign pipeline (§10½) adds `test/sign-geometry`, `sign-field`, `sign-words` and `sign-keys`
  (28 pure tests, run by default) plus `test/sign-integration` (ingestion → postings → graph →
  search against a live server, gated the same way). Whole suite: 82 green.
- The sign real-data gate ran `node src/sign.js evaluate sample_images/` over a **20-image** corpus:
  600 constellations each, ingested at 28.0 s per image (9.3 min total), then each re-identified from
  a **fresh** random draw — 16/20 rank-1, recall@5 20/20, MRR 0.871, and 8/20 searches stopping early
  at no accuracy cost. All four misses are near-duplicate confusions (burst shots), and the true image
  always surfaces, so recall@k and MRR are the metrics to read alongside rank-1 on a corpus like this.
  An earlier 11-image corpus scored 11/11 on the same code path.
- `./benchmark.sh` records the cost/accuracy curve in `benchmarks/scores.csv`. On the 20-image corpus
  (`-c 600 -m 60,240`): 15/20 at a 60-constellation ceiling (1.54 s mean search) and 15/20 at 240
  (4.51 s), recall@5 100% and 35% early stops at both — so past 60 constellations the extra measuring
  buys almost nothing here (MRR 0.842 → 0.854). On the earlier 11-image corpus the same sweep did
  improve rank-1 (10/11 at 60 and 120, 11/11 at 240), which is the difference a corpus with
  near-duplicates makes.
- **Expect ±1 image of run-to-run variance.** Training constellations are drawn from `Math.random`
  unless seeded, so a freshly trained corpus is not the same corpus: the same code scored 16/20 on one
  training run and 15/20 on another. Compare benchmark rows, not single evaluations.
- The Phase 2 real-data gate ran `src/train.js` over 50 images against Cheetah port 4471. All 50
  records completed; 15,000 features formed 11,860 candidate-scan prefixes with page sizes p50=1,
  p95=2, p99=3, max=5, and zero above the 500-row target. This validates the version-1 scan layout
  for the measured random ingestion corpus; denser future modes should be measured again.

## 14. Dependencies & Runtime
- Node.js (CommonJS modules).
- External libs: Sharp (image processing), Express 5, mysql2, dotenv, cli-progress.
- Sharp requires libvips bindings; ensure system packages are installed before running extraction.
- MySQL 8+/MariaDB recommended; training attempts to set `READ COMMITTED` isolation to reduce gap locks (`src/lib/knowledge.js`).
- Worker threads increase concurrency; review DB connection limits accordingly (`DEFAULT_THREADS` or `--threads` to cap).

## 15. Operational Playbooks
1. **Install**: `npm install`.
2. **Configure**: `.env` with DB credentials + optional overrides (see Section 12).
3. **Setup schema**: `node src/setupDatabase.js`.
4. **Initial ingest**:
   - `node src/train.js ./datasets/<dataset> --discover=15 --bootstrap=75 --reprobe=50`.
   - Monitor augmentation vector counts and correlation logs.
5. **Self-evaluation**: review training output; optionally run `--evaluate` for deeper stats.
6. **Search**:
   - Start server: `node src/index.js server`.
   - Query via CLI: `node src/clientAPI.js path/to/query.jpg` or `node src/index.js find ...`.
7. **Maintenance**:
   - Adjust `max_db_size_gb` via `POST /settings/max-db-size`.
   - Run `node src/insert.js bootstrap <iterations>` to refresh correlations.
   - Use `node src/insert.js remove <image_id|filename>` to prune data.

## 16. Observability & Debugging Aids
- Set `TRAINING_CORRELATION_DEBUG_LOG=1` & `TRAINING_CORRELATION_TOP_LOG_K` for per-iteration candidate dumps.
- Evaluation output reports affinity/cohesion/spread and threshold relaxations; elastic matcher logs when fallback tolerances were needed.
- Search responses include relaxations and constellation path metrics so clients can trace scoring decisions.
- Constellation path steps log `source`, `confidence`, `hits`, and `misses`, making the probability tree visible during API calls.
- Real-time pruning logs begin with `🧹`; track to ensure pruning is functioning.

## 17. Dataset References & Notes
- Suggested sample datasets in repo notes: `unsplash-images-collection`, `unsplash-images-collection-mini/micro`, `pinterest_images`, `DIV2K_train_HR` (`studies/notes/notes.md`).
- Typical commands from historical runs:
  - `node src/train.js ./datasets/unsplash-images-collection --discover=20 --bootstrap=10 --reprobe=5`
  - `TRAINING_CORRELATION_DEBUG_LOG=1 TRAINING_CORRELATION_TOP_LOG_K=5 node src/train.js ./datasets/DIV2K_train_HR --discover=20 --bootstrap=75 --reprobe=50`

## 18. Maintenance Checklist
- [ ] When modifying augmentations or descriptor schema, update `src/lib/constellation.js`, `src/lib/vectorGenerators.js`, related DB migrations, and this document.
- [ ] New environment flag? Reflect in `src/settings.js`, `.env` template, README, and this file.
- [ ] Schema changes require `src/setupDatabase.js` adjustments and migration notes.
- [ ] Changes to search session flow or client handshake must be mirrored in `src/index.js`, `src/clientAPI.js`, README, and TECH_NOTES.
- [ ] After significant updates, re-run `node src/setupDatabase.js`, retrain datasets, and update evaluation baselines.

_Sync protocol_: After each development session, append updates here summarizing architectural changes, new tunables, schema migrations, and operational guidance.

Automation: run `npm run maintenance:check` to verify documentation updates accompany core code modifications enforced by the first four checklist items.
