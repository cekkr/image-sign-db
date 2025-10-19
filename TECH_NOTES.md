# TECH_NOTES

Authoritative technical reference for Image Sign DB. Update this document whenever the codebase, schema, or operational runbooks change so that humans and agents share the same canonical context.

## 1. Purpose & Conceptual Model
- Image Sign DB is a CBIR engine that identifies images via *constellation* descriptors instead of raw pixels (`README.md`).
- Every image is decomposed into relative HSV/luminance gradients plus deterministic quadtree summaries; descriptors live in hashed `value_types` records so MySQL stays agnostic (`src/featureExtractor.js`, `src/lib/descriptor.js`).
- The system enforces a server-driven interrogation: clients measure only the descriptors requested by the server, preserving privacy while exploiting the server’s learned knowledge (`src/index.js`, `src/clientAPI.js`).

## 2. High-Level Architecture
- **Extraction layer** (Sharp-based) emits descriptor batches per augmentation and persists them to MySQL (`src/featureExtractor.js`).
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
- `feature_vectors`: measured constellation values per augmentation/resolution/anchor (`value_type`, `resolution_level`, `rel_x`, `rel_y`, `size`).
- `feature_usage`: per-vector usage counters + last score for pruning heuristics.
- `skip_patterns`: descriptors to avoid; supports pruning and search fallbacks.
- `system_settings`: runtime settings such as `max_db_size_gb`.
- `knowledge_nodes`: hierarchical graph linking feature vectors (`node_type` `FEATURE`/`GROUP`, `vector_length`, `vector_angle`, hit/miss stats).
- `feature_group_stats`: aggregated mean/separation statistics per descriptor + resolution; drives guided sampling and probing.
- Optional `image_blobs` (created on demand when `STORE_IMAGE_BLOB=true`) stores original pixels for re-vectorization (`src/featureExtractor.js`).

## 5. Constellation Descriptors
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

## 8. Training & Ingestion Pipeline (`src/train.js`)
- CLI options: `--discover`, `--bootstrap`, `--reprobe`, `--shuffle`, `--threads`, plus evaluation flags (`--evaluate`, `--evaluate-filters`, `--evaluate-runs`, `--evaluate-top`) and augmentation controls (`--augmentations`, `--aug-per-pass`, `--aug-seed`).
- Walks dataset directories recursively, tracking supported extensions (`.jpg/.jpeg/.png/.webp/.bmp`).
- Adaptive worker pool:
  - Uses Node worker threads (`src/workers/ingestWorker.js`) for ingestion; sizing reacts to CPU load, memory, and queue length.
  - Worker jobs call `insert.js` ingestion path, so all storage safeguards remain consistent.
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
  - Each response records relaxations (elastic matcher), thresholds, and updates skip caches.
- Candidate selection:
  - `ensureValueTypeRecord` resolves descriptor IDs through shared evaluator logic (`src/evaluate.js`).
  - `collectElasticMatches` sorts vector hits with threshold relaxation to avoid losing near misses.
  - Usage of matching vectors is incremented (`recordVectorUsage`).
- Constellation-driven refinement:
  - Uses `extendConstellationPath` and `createRandomConstellationSpec` to walk the knowledge graph; falls back to random sampling when knowledge is missing.
- CLI mode mirrors HTTP logic for offline searches (`node src/index.js find <image>`).

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
  - `database`: schema name, default size cap (`DEFAULT_MAX_DB_SIZE_GB`).
  - `correlation`: similarity thresholds, candidate sample caps, online runner sizing.
  - `training`: defaults for CLI flags, augmentation budgets, progressive ingestion, self-evaluation, real-time pruning, and debug logging.
- Environment variables in `.env` override defaults; always document new flags here and in this file when adding tunables.

## 13. Storage & Pruning (`src/lib/storageManager.js`, `src/lib/realTimePruner.js`)
- `ensureStorageCapacity`:
  - Reads `system_settings.max_db_size_gb` or default; prunes low-usage vectors (not part of any knowledge node) when above limit.
  - Warns if DB size remains above target after pruning.
- Real-time pruning removes:
  - High skip-count descriptors (cleans `feature_vectors`, `value_types`, and `skip_patterns`).
  - Stale GROUP nodes with low hits and age beyond threshold.
- Logs summarize pruned vectors/descriptors/constellations for audit.

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
