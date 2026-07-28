# Image Sign DB — AI Agent Reference

Fast-access operational reference for agents working in this repository.

**Image Sign DB** is a research-stage content-based image retrieval (CBIR) engine written in CommonJS Node.js. It never stores or compares whole images: it samples a deterministic *constellation* of relative anchor/neighbour patch pairs, stores only the HSV/luminance **delta** between them, and identifies an image through a server-driven question/answer dialogue in which the client measures only the descriptors the server asks for.

> **Migration in progress — read this before touching storage.** The project is moving off **MySQL** onto **[Cheetah DB](cheetah)** (vendored as a git submodule), and rebuilding recognition around **n-gram probe paths** plus a **property graph** that resolves a set of measured descriptors into an image ID. [`ROADMAP.md`](ROADMAP.md) owns that plan. **Everything described in this handbook as current behavior is still the MySQL implementation** — no Cheetah code exists in [`src/`](src) yet. Do not read the roadmap as a description of what runs.

What this project is **not**:

- It is **not** a production service. There is no authentication, no rate limiting, no test suite, and no packaging/release pipeline.
- It is **not** an embedding/vector-database system. There are no learned embeddings, no ANN index, and no neural model — "learning" means hit/miss counters and aggregate statistics in the database.
- `src/vectorCustom.js` is **not** part of the pipeline. It is a legacy grid-averaging experiment targeting an `image_vectors` table that the current schema does not create.
- The **quadtree / `hsv_tree_mean` / `hsv_tree_delta`** feature family described in [`README.md`](README.md) is **not implemented** on this revision (see [Known Gaps](#known-gaps)).
- The [`cheetah/`](cheetah) submodule is **not** this project's code. It is a standalone Go database server with its own handbook, its own tests, and its own `main` branch — see [Working with the Cheetah submodule](#working-with-the-cheetah-submodule).

Vocabulary, defined once:

- **Descriptor** — the JSON object `{family:'delta', channel, augmentation, sample_id, anchor_u, anchor_v, span, offset_x, offset_y}`. Its SHA-1 (`descriptorKey`) is the canonical cross-process identity of a measurement.
- **Constellation** — the runtime traversal: a sequence of descriptor probes played back to isolate one image.
- **Pattern** — the persisted relationship between two cooperating vectors (`knowledge_nodes` rows of `node_type='GROUP'`); anti-patterns live in `skip_patterns`.
- **Augmentation** — a deterministic image transform (mirror, blur, crop, seeded combo) applied before sampling, so the DB learns how an image behaves under common edits.

## Read This First

1. [`AGENTS.md`](AGENTS.md) (this file) — operational map, contracts, and ownership. Authoritative for *where* things live and *what must not break* **today**.
2. [`ROADMAP.md`](ROADMAP.md) — the MySQL→Cheetah migration plan, target key layout, and phase gates. Authoritative for *where the project is going*; it proves nothing about what currently runs. Every item there is `Planned` until it is marked `Shipped` here.
3. [`TECH_NOTES.md`](TECH_NOTES.md) — the project's declared canonical technical reference (schema, pipeline, tunables). Authoritative for architecture intent; its §18 checklist is machine-enforced by [`scripts/check-maintenance.js`](scripts/check-maintenance.js). Verify its claims against source before relying on them — some are ahead of the code.
4. [`src/settings.js`](src/settings.js) — the **only** authoritative list of environment variables and their defaults. README/TECH_NOTES prose about env flags is secondary.
5. [`src/setupDatabase.js`](src/setupDatabase.js) — the authoritative MySQL schema (DDL text is inline). No migration files exist; this script *is* the migration.
6. [`cheetah/AGENTS.md`](cheetah/AGENTS.md) — the submodule's own handbook. **Authoritative for everything about Cheetah**: protocol, on-disk contracts, config, build/test commands, and its pitfalls. Never document Cheetah behavior here from memory; link there. [`cheetah/README.md`](cheetah/README.md) holds the full command reference, and its `ExecuteCommand` switch in [`cheetah/src/database.go`](cheetah/src/database.go) is the real command inventory.
7. [`README.md`](README.md) — user/operator guide and algorithm rationale. Describes some behavior that is aspirational; see [Known Gaps](#known-gaps).
8. [`README.html`](README.html) — a standalone marketing/explainer page (Tailwind + Chart.js from CDNs). Carries no authority over behavior; do not treat it as documentation to keep in sync.
9. [`studies/notes/notes.md`](studies/notes/notes.md) — dataset names and historical command lines. Convenience only.
10. [`studies/codex/`](studies/codex) and [`studies/logs_history/`](studies/logs_history) — archived agent transcripts and training logs. **Historical artifacts, lowest authority.** Their metric values reflect older schemas (e.g. integer `res=74` resolution levels) and must never be quoted as current behavior.

**Conflict order:** schema/DDL and executable code (3–6) beat prose (7–8) beat history (9–10), and current-state facts (1) beat intent (2). No test suite exists, so nothing in this repository is protected by an executable specification — treat every documented behavior as unverified until you read the source.

## Collaboration and Maintenance Rules

- **Documentation sync is enforced.** Touching `src/lib/augmentations.js`, `src/lib/constants.js`, `src/lib/constellation.js`, `src/lib/vectorGenerators.js`, `src/lib/vectorSpecs.js`, `src/lib/descriptor.js`, `src/featureExtractor.js`, `src/settings.js`, `src/setupDatabase.js`, `src/lib/schema.js`, `src/index.js`, or `src/clientAPI.js` requires an accompanying edit to `README.md` and/or `TECH_NOTES.md`. Run `npm run maintenance:check` before committing. **Exception/limitation:** the checker reads `git status --porcelain`, so it only sees the *uncommitted* working tree — it passes trivially once you commit, and it does not know about `AGENTS.md`. Update this file by hand under the same triggers.
- **No test suite exists.** `npm test` is wired to `exit 1` on purpose. Verification means running the real pipeline against a MySQL instance and a small dataset. Never report a change as "tested" without saying which command you ran and against what data.
- **Datasets are untracked.** `datasets/*` is git-ignored; `.env` is git-ignored. Never commit images, credentials, or `.env`. `.gitignore` whitelists `.env.example`, but no such file exists — if you add environment variables, adding `.env.example` is the right place to document them.
- **Preserve the dirty tree.** The working tree was clean at branch `main` when this file was written. Do not `git clean`, `git checkout --`, or stash unrelated changes to simplify your own work.
- **Schema changes go in [`src/setupDatabase.js`](src/setupDatabase.js) only**, as `CREATE TABLE IF NOT EXISTS` plus a best-effort `ALTER` wrapped in `try/catch`. The script must stay idempotent and re-runnable on a populated database.
- **Record future work in [`ROADMAP.md`](ROADMAP.md), not as present-tense prose in README.** A feature is "current" only when a symbol implements it. Migration steps belong in the roadmap's phase checklists; move an item to `Shipped` in this file only after it is implemented **and** verified, and say how it was verified.

### Working with the Cheetah submodule

[`cheetah/`](cheetah) is a git submodule tracking `https://github.com/cekkr/cheetah` (`main`). It is a
separate Go project with its own handbook, tests, and release discipline. Standing rules, per the
project owner:

1. **Pull it at the start of every request.** It is a moving target and this repository pins a SHA:

   ```bash
   git -C cheetah pull --ff-only origin main
   ```

2. **Changes to Cheetah source are committed directly on its `main`** — not on a branch, not carried
   as a local diff. Before committing inside `cheetah/`, satisfy **its** rules, which are stricter
   than this repository's:
   - `gofmt -w` the files you touched; the tree must stay `gofmt -l .`-clean.
   - `go build ./... && go vet ./... && go test ./src` must pass. Add `-race` when touching
     `ManagedFile` handle lifecycle.
   - Update [`cheetah/AGENTS.md`](cheetah/AGENTS.md) in the **same** commit when you change a command,
     on-disk format, config key, file ownership, or feature status; put new roadmap work in
     [`cheetah/NEXT_STEPS.md`](cheetah/NEXT_STEPS.md).
   - Comments in that codebase are frequently Italian — match the surrounding language.
   - New engine code goes in `cheetah/src/`, never at its repository root.
3. **A Cheetah commit is only useful once pushed**, because this repository pins a SHA that must be
   reachable for anyone else. Push to its `main` in the same step as the commit.
4. **Bump the submodule pointer deliberately.** After pulling or committing, `git add cheetah` in
   *this* repository is a separate, explicit decision — record the SHA in the commit message when
   behavior here depends on it.
5. **Never edit Cheetah to work around a bug you have not reported.** If our key shapes trip one of
   its documented trie pitfalls, add a failing test in `cheetah/src/` first, then fix.
6. **Do not vendor Cheetah's docs into this handbook.** Link to [`cheetah/AGENTS.md`](cheetah/AGENTS.md).
   Two copies of a protocol description diverge in silence.

## Essential Project Principles

### Every measurement is relative; absolute pixel geometry never reaches the database

Anchors (`anchor_u`, `anchor_v`), footprints (`span`), and displacements (`offset_x`, `offset_y`) all live in `[0,1]`-normalized space and are converted to pixels only inside [`src/lib/constellation.js`](src/lib/constellation.js) (`mapAnchorToImage`, `realiseSampleOnImage`) at measurement time. The stored `value` is a *delta* between two patches, normalized per channel by `CHANNEL_NORMALISERS` in [`src/lib/vectorGenerators.js`](src/lib/vectorGenerators.js).

- **Consequence:** the same descriptor is measurable on a cropped, rescaled, mirrored, or color-shifted copy of the image.
- **Prohibited:** persisting pixel coordinates, raw patch colors, absolute sizes, or any value that would let a reader reconstruct the source image. `feature_vectors.pos_x/pos_y` are *not* pixels — they are `anchor_u/v × ANCHOR_SCALE` buckets.

### The server drives the interrogation; the client never volunteers data

The client measures exactly one descriptor per round trip, and only the descriptor the server named. See [`src/clientAPI.js`](src/clientAPI.js) and the `/search/*` handlers in [`src/index.js`](src/index.js).

- **Consequence:** any new endpoint or CLI path must keep this shape. A "send me your whole feature set" API would defeat the project's stated purpose.
- **Prohibited:** batching multiple client-side measurements into one request, or letting the client choose the probe.

### Descriptor identity is a hash, and the database is agnostic about semantics

MySQL stores `value_types.descriptor_hash` (SHA-1) + `descriptor_json`. No column encodes descriptor meaning.

- **Consequence:** descriptor semantics can evolve in JavaScript without a schema migration — but **any change to the descriptor object's field set, field order-independence, or rounding changes every hash**, orphaning the entire existing corpus. Treat descriptor shape as a wire format.
- **Prohibited:** adding a field to the descriptor object in only one of its three construction sites (see [Pitfalls](#three-independent-descriptor-builders-must-stay-byte-identical)).

### Ingestion must stay lock-light

All ingestion writes are short autocommit statements, not one long transaction, with `READ COMMITTED` set best-effort per connection.

- **Consequence:** correctness under concurrency comes from `images.ingestion_complete`, not from transaction isolation.
- **Prohibited:** wrapping an image's whole feature batch in `BEGIN`/`COMMIT`, or reintroducing `INSERT … ON DUPLICATE KEY UPDATE` as the primary path for `value_types` (it was replaced by read → `INSERT IGNORE` → read specifically to avoid hot-row contention).

## Critical Implementation Contracts

- **`ingestion_complete` gates every read.** Every discovery, evaluation, and training query MUST include `im.ingestion_complete = 1`. Enforced in [`src/lib/knowledge.js`](src/lib/knowledge.js) (`discoverCorrelations`), [`src/evaluate.js`](src/evaluate.js) (`evaluateFilterRun`), [`src/train.js`](src/train.js) (`findCandidateImages`, `sampleRandomProbeSpec`). **Known exception:** `findCandidateImages` and `requestInitialProbe` in [`src/index.js`](src/index.js) do **not** filter on it — the live search path can surface half-ingested images. Do not copy that omission into new code; fixing it is a legitimate change.
- **Candidate lookup is exact-match on `value_type` + `pos_x` + `pos_y`, and tolerance-match on `resolution_level`, `rel_x`, `rel_y`.** The anchor buckets are compared with `=`, never with a tolerance. Any change to `ANCHOR_SCALE` or to anchor rounding invalidates every stored row. The tolerances are `RESOLUTION_LEVEL_TOLERANCE` (default `1e-4`, [`src/lib/resolutionLevel.js`](src/lib/resolutionLevel.js)) and `CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE` (`1e-3`, [`src/lib/constants.js`](src/lib/constants.js)).
- **`resolution_level` is a normalized span in `[0.02, 0.45]`, stored as `DECIMAL(6,5)` — never an integer bucket.** Produce it only via `normalizeResolutionLevel`, compare it only via `resolutionLevelsMatch` or `ABS(… - ?) <= RESOLUTION_LEVEL_TOLERANCE`, and key maps with `resolutionLevelKey`. Never compare with `=` or `===`.
- **`euclideanDistance` returns `Infinity` unless `value_type` matches exactly and resolution levels match within tolerance** ([`src/lib/correlationMetrics.js`](src/lib/correlationMetrics.js)). Any scoring code that treats `Infinity` as a large-but-finite distance is wrong; the elastic matcher drops non-finite distances outright.
- **`scoreCandidateFeature` returns `null` below `MIN_AFFINITY` / `MIN_COHESION`.** These thresholds come from `CORRELATION_*` env vars but are applied in *search and evaluation* too, not just correlation discovery. Raising `CORRELATION_MIN_AFFINITY` silently deletes matches from `/search` results and from `--evaluate` tables.
- **Signing/secret handling:** connection credentials come only from `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` in the process environment, loaded by `dotenv`. Never hard-code them, never log `process.env`, never write them into `system_settings`.
- **`knowledge_nodes.miss_count` is currently write-once-zero.** `updateNodeStats(…, 'miss', …)` exists but is never called ([`src/lib/knowledge.js:59`](src/lib/knowledge.js)). Every confidence derived from `hits/(hits+misses)` therefore evaluates to `1.0`. Do not build new ranking logic that assumes confidence is discriminative until misses are actually recorded.

## Architecture and Data/Control Flow

**Ingestion (the write path):**

`node src/train.js <dir>` → `ingestFilesConcurrently` (adaptive worker pool) → [`src/workers/ingestWorker.js`](src/workers/ingestWorker.js) → `ingestImage` ([`src/insert.js`](src/insert.js)) → `extractAndStoreFeaturesProgressive` ([`src/featureExtractor.js`](src/featureExtractor.js)) → `applyAugmentation` → `generateFeaturesForAugmentationOrdinals` ([`src/lib/vectorGenerators.js`](src/lib/vectorGenerators.js)) → `persistFeaturesBatched` → MySQL `images` / `value_types` / `feature_vectors` / `feature_usage`

**Learning (in the parent process, not the workers):**

`OnlineCorrelationRunner` ([`src/train.js`](src/train.js)) → `discoverCorrelations` ([`src/lib/knowledge.js`](src/lib/knowledge.js)) → `scoreCandidateFeature` → `knowledge_nodes` (FEATURE + GROUP) + `feature_group_stats`; `RealTimePruner` ([`src/lib/realTimePruner.js`](src/lib/realTimePruner.js)) trims in parallel.

**Search (the read path), HTTP variant:**

`src/clientAPI.js` → `POST /search/start {requestProbe:true}` → `requestInitialProbe` → server returns `probeSpec` → client measures via `generateSpecificVector` → `POST /search/start {sessionId, probe}` → `startSearch` → `findCandidateImages` → `collectElasticMatches` → `buildNextQuestion` (`fetchRelatedConstellations` → knowledge, else random) → `POST /search/refine` → `refineSearch` → intersect candidate sets → `MATCH_FOUND` | `NO_MATCH` | `CANDIDATES_FOUND`

`node src/index.js find <image>` walks the identical functions in-process, skipping HTTP.

**Trust boundary:** the Express server is the trust boundary and it is **open** — no auth on any route, including `POST /images` (which reads an arbitrary server-local filesystem path) and `POST /discover` (unbounded CPU/DB work). Session state (`searchSessions`, `descriptorCache`, `skipCache`) is process-local, in-memory, and never expires.

**Target architecture (Planned — see [`ROADMAP.md`](ROADMAP.md)):** MySQL is replaced by a Cheetah TCP
client; the measurement layer is unchanged. Candidate lookup becomes a byte-prefix walk of the pair
trie instead of an indexed SQL scan, candidate *intersection* becomes `GRAPH_RECALL` activation over
descriptor seeds returning ranked image IDs, and next-probe selection becomes an n-gram follower
lookup conditioned on the path so far rather than on the last probe alone. None of this exists in
[`src/`](src) yet.

## Linked Source Tree and File Reference

### [`package.json`](package.json)

Manifest. CommonJS (`"type": "commonjs"`), `main` is `src/index.js`. Only two scripts: `test` (deliberately fails) and `maintenance:check`. Runtime deps: `sharp` (libvips image ops), `mysql2`, `express` 5, `dotenv`, `cli-progress`.

- **Common mistakes:** There is no `engines` field, but the code requires **Node 18+** (global `fetch` in `src/clientAPI.js`) and is developed on Node 24. Do not add ESM `import` syntax — every file uses `require`. The Cheetah client planned in [`ROADMAP.md`](ROADMAP.md) needs **no new dependency** — its protocol is newline-delimited text over `net`; do not add one.

### [`ROADMAP.md`](ROADMAP.md)

The MySQL→Cheetah migration plan: rationale with a verified capability mapping, the target key/graph/n-gram layout, the Cheetah-side work queue, six phase checklists with exit gates, risks, and open questions.

- **Key sections:** §3 (key design) is the migration's wire format and must be frozen before ingestion code is written; §4 lists candidate changes to the submodule; §5 holds the phase checkboxes; §7 lists decisions that still block phases.
- **Called by / depends on:** the phase gates reference [`src/evaluate.js`](src/evaluate.js)'s harness as the parity check, since it is the only quasi-regression tool that exists.
- **Common mistakes:** it is **intent, not description**. Nothing in it is implemented. Do not cite it as evidence that a capability exists, and do not copy its target-state prose into [`README.md`](README.md).

### [`.gitmodules`](.gitmodules)

Pins the [`cheetah`](cheetah) submodule to `https://github.com/cekkr/cheetah`. One entry.

- **Common mistakes:** the submodule records a **commit SHA**, not a branch. `git -C cheetah pull` moves the checkout but does not update this repository's pointer until you `git add cheetah` — and the SHA must be pushed to Cheetah's `main` or it is unreachable for anyone else. See [Working with the Cheetah submodule](#working-with-the-cheetah-submodule).

### [`cheetah/`](cheetah) — submodule, not this project's code

Standalone single-binary **Go** key/value + graph + prediction database server (module `cheetahdb`, Go 1.24, ~23k lines under `cheetah/src/`). Speaks one newline-delimited text protocol over TCP (`0.0.0.0:4455` default) and an interactive CLI. Verified to build and run at pinned SHA `8ecdf35` on Go 1.25.4.

- **Its own handbook governs it:** [`cheetah/AGENTS.md`](cheetah/AGENTS.md) (~1400 lines) is authoritative for its protocol, on-disk contracts, config, and pitfalls. [`cheetah/README.md`](cheetah/README.md) holds the command reference. [`cheetah/NEXT_STEPS.md`](cheetah/NEXT_STEPS.md) is its roadmap. [`cheetah/CONCEPTS.md`](cheetah/CONCEPTS.md) documents the n-gram reducer payload layouts we intend to reuse.
- **The subsystems this migration depends on:** the pair trie ([`cheetah/src/database.go`](cheetah/src/database.go), [`cheetah/src/tables.go`](cheetah/src/tables.go)) for feature lookup; the graph store ([`cheetah/src/graph.go`](cheetah/src/graph.go)) and associative recall ([`cheetah/src/graph_recall.go`](cheetah/src/graph_recall.go)) for descriptor→image resolution; edge belief ([`cheetah/src/graph_uncertainty.go`](cheetah/src/graph_uncertainty.go)) to finally give confidence a meaning; and the registered reducers ([`cheetah/src/reducers.go`](cheetah/src/reducers.go)) for n-gram follower counts.
- **Build and test from this repo root:**
  - `go build -o cheetah-server ./cheetah/src` — the server binary (untracked).
  - `go test ./cheetah/src` — its unit tests. Run these before any commit inside the submodule.
- **Common mistakes:**
  - **Its `src/` is Go, not ours.** `cheetah/src/` and `src/` are unrelated trees that happen to share a name; its own handbook flags the same collision against its former Python parent project.
  - Do **not** add Cheetah's build outputs (`cheetah-server`, `cheetah_data/`) to this repository — its `.gitignore` covers them inside the submodule, ours does not cover them at the root.
  - Editing files under `cheetah/` and committing only in *this* repository records nothing: submodule content lives in the submodule's own history. Commit there, push there, then bump the pointer here.

### [`src/settings.js`](src/settings.js)

Single source of truth for configuration. Parses `.env` through `dotenv` and exposes one frozen-by-convention object; **every other module reads settings from here, never `process.env` directly** — with the deliberate exceptions listed below.

- **Key functions and subparts:**
  - `getNumber` / `getOptionalNumber` / `getBoolean` / `getStringList` — coercers that fall back to the default when the env var is absent, empty, or unparseable. `getBoolean` accepts `1/true/yes/on` and `0/false/no/off`.
  - `settings.client` — `API_BASE_URL` (default `http://localhost:3000`), `CLIENT_MAX_ITERATIONS` (10).
  - `settings.server` — `PORT` (3000).
  - `settings.search` — `VALUE_THRESHOLD` (0.08, the elastic matcher's base distance), `SKIP_THRESHOLD` (3, misses before a descriptor is treated as a dead end), `CLI_MAX_ITERATIONS` (12).
  - `settings.database` — `DB_NAME` (`image_hypercube_db`), `DEFAULT_MAX_DB_SIZE_GB` (10).
  - `settings.correlation` — `CORRELATION_SIMILARITY_THRESHOLD` (0.2), `CORRELATION_MAX_CANDIDATE_SAMPLE` (256), `CORRELATION_MIN_AFFINITY` (0.45), `CORRELATION_MIN_COHESION` (falls back to `CORRELATION_MIN_SPREAD`, then 0.25), online-runner batch caps.
  - `settings.training` — CLI defaults (`discover` 3, `bootstrap` 0, `reprobe` 0, `shuffle` true, `DEFAULT_THREADS` unset), `augmentationsPerImage` (3), `selfEvaluation.*`, `realTimePruning.*`, `progressive.*` (cycles 3, `randomPerAug` 300, `guidedPerCycle` 300), `storeImageBlob` (false), correlation debug logging.
- **Deliberate exceptions — env vars read outside this file:** `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` (every `mysql.createConnection` call site), `DB_OPERATION_MAX_RETRIES` / `DB_OPERATION_RETRY_BASE_MS` ([`src/featureExtractor.js`](src/featureExtractor.js)), `CONSTELLATION_SAMPLES_PER_AUGMENTATION` / `SAMPLES_PER_AUGMENTATION` ([`src/lib/constants.js`](src/lib/constants.js)), `RESOLUTION_LEVEL_PRECISION` / `RESOLUTION_LEVEL_TOLERANCE` ([`src/lib/resolutionLevel.js`](src/lib/resolutionLevel.js)), `TRAINING_VERBOSE_AUGMENT_LOGS` / `AUG_PROGRESS_STEPS` ([`src/lib/vectorGenerators.js`](src/lib/vectorGenerators.js)), `TRAINING_AUGMENTATION_GLOBAL_SEED` ([`src/train.js`](src/train.js)). These are read at module load; they cannot be changed at runtime.
- **Common mistakes:** `settings.correlation.minSpread` is referenced in [`src/lib/correlationMetrics.js:6`](src/lib/correlationMetrics.js) but that key does not exist on the settings object — the expression is dead and always resolves through `minCohesion`. Adding a key here without documenting it in `README.md`/`TECH_NOTES.md` fails `npm run maintenance:check`.

### [`src/setupDatabase.js`](src/setupDatabase.js)

Creates the database and all tables, then seeds `system_settings.max_db_size_gb`. Runs immediately on `require` (calls `setupDatabase()` unconditionally at module scope) and `process.exit(1)`s on error — **never `require` this file from application code.**

- **Key functions and subparts:**
  - Inline DDL constants: `createImagesTableSQL`, `createValueTypesTableSQL`, `createFeatureVectorsTableSQL`, `createKnowledgeNodesTableSQL`, `createFeatureGroupStatsTableSQL`, `createFeatureUsageTableSQL`, `createSkipPatternsTableSQL`, `createSystemSettingsTableSQL`.
  - `setupDatabase` — connects **without** a database selected, runs `CREATE DATABASE IF NOT EXISTS`, `USE`, then each table in dependency order (`images` → `value_types` → `feature_vectors` → `knowledge_nodes` → `feature_group_stats` → `feature_usage` → `skip_patterns` → `system_settings`).
  - Best-effort migrations in `try {} catch {}`: `images.ingestion_complete` + `idx_images_complete_created`, and `MODIFY COLUMN resolution_level DECIMAL(6,5)` on both `feature_vectors` and `feature_group_stats`.
- **Table ordering rule:** `feature_usage` declares a foreign key to `feature_vectors`, so it must be created after it — the current ordering already accounts for this.
- **Common mistakes:** The `ALTER … MODIFY resolution_level DECIMAL(6,5)` widens the column but does **not** rescale pre-existing integer bucket values, so legacy rows become permanently unmatchable (see [Legacy integer resolution levels](#legacy-integer-resolution-levels-never-match)). The `CREATE INDEX IF NOT EXISTS` form requires MySQL 8; on older servers the whole migration block is silently swallowed by the `catch`.

### [`src/lib/constants.js`](src/lib/constants.js)

Frozen descriptor-space constants. Change nothing here casually — these values define the descriptor hash space.

- **Key functions and subparts:**
  - `CONSTELLATION_CONSTANTS.SAMPLES_PER_AUGMENTATION` — size of the deterministic sample library per augmentation (default `10000`, overridable by `CONSTELLATION_SAMPLES_PER_AUGMENTATION`). **Changing it renumbers every `sample_id`** because `getSampleId` computes `augIndex * SAMPLES_PER_AUGMENTATION + ordinal`.
  - `MIN_RELATIVE_SPAN` (0.02) / `MAX_RELATIVE_SPAN` (0.45) — the span range every sample draws from; also the valid range of `resolution_level`.
  - `MAX_OFFSET_MAGNITUDE` (1.5) — neighbour displacement in multiples of the span.
  - `ANCHOR_SCALE` (10000) — anchor→`pos_x`/`pos_y` bucket multiplier. Exact-match column; see contracts.
  - `OFFSET_TOLERANCE` (1e-3) — the `ABS(rel_x - ?) <= ?` tolerance used by every candidate query.
  - `CHANNEL_DIMENSIONS` — `['h','s','v','luminance','stddev']`; the index into this array is drawn by the sample RNG, so reordering it reassigns channels to existing `sample_id`s.
  - `STOCHASTIC_AUGMENTATIONS` — `random_combo_0..2`.
- **Dead constants:** `TREE_DEPTHS` and `SPAN_SCALE` are exported but referenced nowhere. `TREE_DEPTHS` is the vestige of the unimplemented quadtree feature.
- **Called by / depends on:** [`src/lib/constellation.js`](src/lib/constellation.js), [`src/lib/vectorGenerators.js`](src/lib/vectorGenerators.js), [`src/lib/augmentations.js`](src/lib/augmentations.js), [`src/evaluate.js`](src/evaluate.js), [`src/index.js`](src/index.js), [`src/train.js`](src/train.js), [`src/lib/knowledge.js`](src/lib/knowledge.js).

### [`src/lib/descriptor.js`](src/lib/descriptor.js)

Canonical descriptor identity. Tiny and load-bearing.

- **Key functions and subparts:**
  - `normalizeDescriptor` — sorts keys alphabetically so hashing is order-independent. Throws on non-objects.
  - `createDescriptorKey` — `SHA1(JSON.stringify(sortedDescriptor))`, hex. This is `descriptor_hash` in MySQL.
  - `serializeDescriptor` — the exact JSON persisted in `descriptor_json`.
  - `parseDescriptor` — tolerant reader; returns the value unchanged if MySQL already handed back a parsed JSON object, `null` on parse failure.
- **Common mistakes:** floating-point values must be rounded *before* they reach here — the builders use `Number(x.toFixed(6))`. An unrounded `offset_x` produces a different hash for the same geometry.

### [`src/lib/resolutionLevel.js`](src/lib/resolutionLevel.js)

The only correct way to produce, compare, and key resolution levels.

- **Key functions and subparts:**
  - `normalizeResolutionLevel(raw)` — rounds to `RESOLUTION_LEVEL_PRECISION` decimals (default 6, capped at 10); non-finite input returns `0`.
  - `resolutionLevelsMatch(a,b)` — `|a-b| <= RESOLUTION_LEVEL_TOLERANCE` (default `1e-4`).
  - `resolutionLevelKey(raw)` — fixed-precision string for `Set`/`Map` dedupe keys.
- **Common mistakes:** the column is `DECIMAL(6,5)` (5 decimals) while the default JS precision is 6 decimals — MySQL rounds on write, which is why reads must always be re-normalized and compared with tolerance rather than equality.

### [`src/lib/augmentations.js`](src/lib/augmentations.js)

Defines the augmentation library and the seeded RNG shared across the project.

- **Key functions and subparts:**
  - `AUGMENTATION_ORDER` — `['original','mirror_horizontal','mirror_vertical','gaussian_blur','center_crop_80', 'random_combo_0..2']`. **Its index positions are baked into `sample_id`** via `getSampleId`; appending is safe, inserting or reordering is not.
  - `BASE_AUGMENTATIONS` — the four sharp one-liners (`clone`, `flop`, `flip`, `blur(1.2)`).
  - `applyAugmentation(baseImage, name, baseMeta, imagePath)` — dispatcher; also handles `center_crop_60/75/80` and the `random_combo_` prefix. Throws on unknown names.
  - `applyRandomCombo` — seeded by `` `${imagePath}:${augmentationName}:${w}x${h}` ``: crop 0.82–0.97, rotate ±6°, saturation/brightness/hue jitter, coin-flip blur. Deterministic per file *and per resolution*.
  - `applyCenterCrop` — extract then `resize(..., {fit:'cover'})` back to original dimensions, so downstream relative geometry is unchanged.
  - `createSeededRandom(seed)` — SHA-1-seeded mulberry32. Reused by [`src/evaluate.js`](src/evaluate.js) for cropping filters and by [`src/train.js`](src/train.js) for per-file augmentation selection.
- **Common mistakes:** `applyRandomCombo`'s seed includes the image dimensions, so the "same" augmentation differs between an image and a resized copy of it — intentional, but it means `random_combo_*` descriptors are not comparable across resolutions the way `original` ones are.

### [`src/lib/constellation.js`](src/lib/constellation.js)

Owns the deterministic sample library: the map from an integer `sampleId` to a descriptor, and the projection of a descriptor onto a concrete image. Does **not** read pixels.

- **Key functions and subparts:**
  - `hashToSeed` / `mulberry32` — FNV-1a + mulberry32; deterministic across processes and Node versions.
  - `getSampleId(augName, ordinal)` / `getOrdinalFromSampleId` / `getAugmentationFromSampleId` — the `augIndex * SAMPLES_PER_AUGMENTATION + ordinal` encoding.
  - `generateBaseParameters(sampleId)` — the heart of determinism: seeds an RNG from `('constellation', augName, ordinal)` and draws, **in this exact order**, `span`, `anchorU`, `anchorV`, offset `angle`, offset `magnitude`, `channelIndex`. Reordering these draws silently remaps every existing `sample_id` to a different descriptor.
  - `mapAnchorToImage` — converts the relative span into per-axis `spanXRel`/`spanYRel` using the image's *minimum* side, then insets the anchor by a margin so the patch fits.
  - `ensureTargetWithinBounds` — clamps the neighbour patch into the frame **and recomputes the offset from the clamped position**. This is why the realized `offset_x/y` can differ from the sample's nominal offset.
  - `realiseSampleOnImage` — `mapAnchorToImage` + `ensureTargetWithinBounds`; returns anchor/target/offset/span in relative units.
  - `descriptorFromBase` — builds the descriptor from **unclamped** base params (contrast with `descriptorFromSample` in `vectorGenerators.js`, which uses clamped offsets).
  - `createRandomConstellationSpec` — draws a random augmentation+ordinal and returns a spec + `descriptorKey`. Used by the server to invent exploratory probes.
  - `descriptorToSpec` — the inverse: rehydrates a stored `descriptor_json` into a measurable spec, re-normalizing and re-hashing. Returns `null` unless `family === 'delta'` and `sample_id` is finite.
  - `extendConstellationPath(path, step)` — appends one probe step and multiplies `cumulativeAccuracy` by `accuracyScore = (1/candidateCount) * confidence`. Pure; returns a new array.
- **Common mistakes:** `extendConstellationPath` treats `accuracyScore === 0` as `1` when multiplying (`* (accuracyScore || 1)`), so a step that eliminated all candidates leaves the cumulative score unchanged instead of zeroing it. Read the reported "constellation accuracy" as a heuristic, not a probability.

### [`src/lib/colorUtils.js`](src/lib/colorUtils.js)

`rgbToHsv(r,g,b)` → `[h 0–360, s 0–100, v 0–100]`. The sole HSV converter for the live pipeline.

- **Common mistakes:** [`src/vectorCustom.js`](src/vectorCustom.js) carries a private duplicate of this function; do not "unify" them by wiring the legacy script into the live path.

### [`src/lib/gridStats.js`](src/lib/gridStats.js)

Pixel-level statistics over a rectangular region.

- **Key functions and subparts:**
  - `getRawPixels(sharpInstance)` — `.raw().toBuffer({resolveWithObject:true})`; returns `{rawPixels, meta}` where `meta.channels` may be 3 or 4. Call it **once per augmented image**, never per sample.
  - `calculateStatsForRegion` — single pass accumulating sums and sums-of-squares; returns `{r,g,b,h,s,v,luminance,stdDev}`. `luminance` is Rec.709 (`0.2126R + 0.7152G + 0.0722B`); `stdDev` is the RMS of the per-channel standard deviations. Returns all-zeros for an empty region rather than throwing.
  - `getBlockRange` — **unused**; a leftover from grid-based vectorization.
- **Common mistakes:** the index guard is `index + 2 < rawPixels.length`, which assumes at least 3 channels laid out RGB-first. Grayscale (1-channel) inputs will read neighbouring pixels as G and B.

### [`src/lib/vectorGenerators.js`](src/lib/vectorGenerators.js)

Turns descriptors into measured values. This is where pixels become numbers; **change measurement semantics here, not in the extractor.**

- **Key functions and subparts:**
  - `CHANNEL_NORMALISERS` — `{h:360, s:100, v:100, luminance:255, stddev:255}`; divides raw deltas into roughly `[-1,1]`. Changing these invalidates every stored `value` and every threshold in `settings.search`/`settings.correlation`.
  - `calculateRelativeRegionStats` — maps relative center+span to a pixel rectangle and delegates to `calculateStatsForRegion`; returns `null` for a degenerate rectangle.
  - `computeChannelDeltas(anchorStats, targetStats)` — the actual feature: `(target − anchor) / normaliser` per channel. Note `stddev` reads `stats.stdDev` (capital D) and writes `stddev` — the naming asymmetry is intentional and easy to break.
  - `descriptorFromSample(baseParams, realised)` — builds the descriptor with the **clamped** `realised.offsetX/Y`.
  - `buildFeatureFromSample` — the per-sample pipeline: realise → anchor stats → neighbour stats → deltas → descriptor → row fields (`resolution_level` = normalized span, `pos_x/pos_y` = anchor × `ANCHOR_SCALE`, `rel_x/rel_y` = clamped offsets, `value` = the delta for the descriptor's channel, `size` = span). Returns `null` when either patch is degenerate.
  - `generateAllFeaturesForAugmentation` — exhaustive sweep over all `SAMPLES_PER_AUGMENTATION` ordinals. Only reachable through the non-progressive path; honours `TRAINING_VERBOSE_AUGMENT_LOGS` / `AUG_PROGRESS_STEPS`.
  - `generateFeaturesForAugmentationOrdinals` — the sampled variant used by progressive ingestion.
  - `generateSpecificVector(imagePath, spec, {imageTransform})` — measures **one** descriptor on demand; used by the client, the CLI, reprobing, and evaluation. The optional `imageTransform` async hook is applied *before* the augmentation and is how evaluation simulates cropping. Returns the *realized* descriptor and `descriptorKey`, which may differ from the requested one.
- **Called by / depends on:** [`src/featureExtractor.js`](src/featureExtractor.js), [`src/clientAPI.js`](src/clientAPI.js), [`src/index.js`](src/index.js), [`src/train.js`](src/train.js), [`src/evaluate.js`](src/evaluate.js).
- **Common mistakes:** callers must adopt `vector.descriptorKey` after measuring, not keep the requested one (see [Pitfalls](#requested-descriptorkey--measured-descriptorkey)).

### [`src/lib/vectorSpecs.js`](src/lib/vectorSpecs.js)

`resolveDefaultProbeSpec(override)` — the branch point between "rehydrate this exact descriptor" and "invent a random one".

- **Behavior:** with `override.random === false` **and** `override.descriptor`, it round-trips through `descriptorToSpec`. With `random === false` and no descriptor, it synthesizes a fixed centre-of-image `h`/`original`/`sample_id:0` descriptor — a fallback, not a meaningful probe. Otherwise it calls `createRandomConstellationSpec`.
- **Called by / depends on:** [`src/evaluate.js`](src/evaluate.js) (`normalizeProbeSpec`), re-exported from [`src/featureExtractor.js`](src/featureExtractor.js).
- **Common mistakes:** `normalizeProbeSpec` sets `random:false` **only when `spec.descriptor` is present**. Passing a spec with `anchor_u`/`span` fields but no `descriptor` yields a *random* probe, silently discarding those fields.

### [`src/lib/correlationMetrics.js`](src/lib/correlationMetrics.js)

The scoring vocabulary used by discovery, search, and evaluation alike.

- **Key functions and subparts:**
  - `buildFeatureVector(f)` — the 4-D comparison vector `[value, rel_x, rel_y, size]`. Nothing else participates in distance.
  - `euclideanDistance(a,b)` — returns `Infinity` on `value_type` mismatch or resolution mismatch. This gate, not the caller, is what keeps unrelated descriptors apart.
  - `cosineSimilarity`, `pearsonCorrelation` — computed *across the four components of one pair*, not across a population; both are direction-of-agreement heuristics.
  - `scoreCandidateFeature(target, candidates)` — samples up to `MAX_CANDIDATE_SAMPLE`, then derives **affinity** = mean of normalized cosine and Pearson, **density** = `1/(1+meanDistance)`, **stability** = `1/(1+stdDistance)`, **cohesion** = mean of density and stability. Returns `null` if `affinity < MIN_AFFINITY` or `cohesion < MIN_COHESION`; otherwise `score = affinity × cohesion × (1 + log1p(sampleSize))`.
- **Common mistakes:** the `null` return is a *filter*, not an error — callers that skip it silently drop candidates. Because `coverage` grows with sample size, `score` rewards descriptors with many near-duplicates; it is a separation heuristic, not a probability.

### [`src/lib/elasticMatcher.js`](src/lib/elasticMatcher.js)

`collectElasticMatches(rows, targetFeature, options)` — the shared "find nearby vectors, widening the net if necessary" primitive.

- **Behavior:** normalizes each row, computes distances (dropping non-finite ones), sorts ascending, then keeps everything within `baseThreshold`; while fewer than `minUniqueImages` distinct images are covered and under `maxRelaxations` (5), multiplies the threshold by `relaxFactor` (1.5) and retries. If still empty, it falls back to **the single nearest entry** regardless of distance. Returns `{grouped (Map imageId→{features,distances,vectorIds,label}), selectedEntries, thresholdUsed, relaxations, allEntries}`.
- **Called by / depends on:** [`src/index.js`](src/index.js), [`src/train.js`](src/train.js), [`src/evaluate.js`](src/evaluate.js), [`src/lib/knowledge.js`](src/lib/knowledge.js).
- **Common mistakes:** the nearest-entry fallback means **a non-empty `rows` input can never produce zero candidates**. Callers that read "1 candidate" as "confident match" are wrong when `relaxations > 0`; always surface `relaxations` and `thresholdUsed` alongside the result, as the evaluation and search paths do.

### [`src/lib/schema.js`](src/lib/schema.js)

Runtime schema guard, run before ingestion.

- **Key functions and subparts:**
  - `TARGET_COLUMNS` — the three columns that must be `MEDIUMINT UNSIGNED`: `value_types.value_type_id`, `feature_vectors.value_type`, `feature_group_stats.value_type`.
  - `fetchColumnMetadata` / `ensureColumnType` — reads `information_schema.COLUMNS` for the current `DATABASE()` and `ALTER`s only when the type does not match the regex.
  - `ensureValueTypeCapacity(connection?)` — opens its own connection when none is passed and returns the list of upgraded columns. Wraps failures in a message telling the operator to widen the columns manually.
- **Called by / depends on:** [`src/train.js`](src/train.js) (`main`), [`src/insert.js`](src/insert.js) (`handleAddCommand`).
- **Common mistakes:** this exists because descriptor cardinality outgrew `SMALLINT`. `MEDIUMINT UNSIGNED` caps at ~16.7M descriptors; a large corpus at 10 000 samples × 8 augmentations will approach it. If you widen to `INT`, update all three entries together — a partial widening breaks the foreign keys.

### [`src/lib/storageManager.js`](src/lib/storageManager.js)

Usage accounting, anti-pattern bookkeeping, and size-budget pruning.

- **Key functions and subparts:**
  - `loadSetting(db, key, default)` — reads `system_settings`, inserting the default when absent; coerces numeric strings.
  - `recordVectorUsage(db, vectorIds, increment, scoreDelta)` — bulk upsert into `feature_usage`, accumulating `usage_count` and `last_score` and stamping `last_used`.
  - `saveSkipPattern(db, descriptor)` — increments `skip_patterns.skip_count` for a descriptor that failed to discriminate.
  - `currentDatabaseSizeGb(db, schema)` — `information_schema.tables` sum of `data_length + index_length`.
  - `pruneLowValueVectors` — deletes the coldest vectors **that are not referenced by any `knowledge_nodes` row**, batch-limited to 500–5000. Ordered by `usage_count ASC, created_at ASC`.
  - `ensureStorageCapacity(db, schema)` — the entry point called after every ingest/remove/discovery; warns if still over budget after one prune pass.
- **Common mistakes:** `ensureStorageCapacity` prunes **once** and then only warns, so a badly-over-budget database shrinks slowly across many ingests rather than immediately. Pruning deletes `feature_vectors` rows; `feature_usage` follows via `ON DELETE CASCADE`, but the now-orphaned `value_types` rows are left behind (only `RealTimePruner` removes those, and only for skip-pattern descriptors).

### [`src/lib/realTimePruner.js`](src/lib/realTimePruner.js)

Background trimming during training. Class `RealTimePruner`, default export.

- **Key functions and subparts:**
  - `onImageIngested()` — the trigger; fires `schedule()` only when `ingestCounter % minIngests === 0` **and** `intervalMs` has elapsed since the last run. Both gates must pass, so raising `minIngests` above your dataset size disables it entirely.
  - `runCycle` — `pruneBySkipPatterns` then `pruneStaleConstellations`; logs a single `🧹` summary line only when something was removed.
  - `pruneBySkipPatterns` — joins `skip_patterns` to `value_types` for `skip_count >= minSkipCount`, deletes up to `vectorBatchSize` `feature_vectors`, then removes now-orphaned `value_types` **and their `skip_patterns` rows**.
  - `pruneStaleConstellations` — deletes `GROUP` `knowledge_nodes` with `hit_count <= maxGroupHitCount` older than `minGroupAgeMinutes`.
  - `flush()` / `drain()` / `dispose()` — end-of-training lifecycle; `dispose` closes the dedicated connection.
- **Common mistakes:** deleting a `skip_patterns` row resets the learned "this descriptor is a dead end" signal, and the in-memory `skipCache` in a running server is never invalidated — a long-lived server keeps skipping descriptors the pruner has already forgotten.

### [`src/lib/knowledge.js`](src/lib/knowledge.js)

The knowledge graph: correlation discovery, pattern storage, and the queries that feed guided probing. The largest and most consequential library file.

- **Key functions and subparts:**
  - `createDbConnection()` — the standard connection factory (`READ COMMITTED` best-effort). Prefer it over ad-hoc `mysql.createConnection` in new code.
  - `hydrateFeatureRow` — attaches a parsed `descriptor` and a normalized `resolution_level` to a raw row. Every row read from `feature_vectors` should pass through this.
  - `getOrCreateFeatureNode` — idempotent `FEATURE` node per `vector_1_id`.
  - `getOrCreateFeatureGroupNode` — idempotent `GROUP` node keyed by parent + both vector ids + geometry within `1e-6`.
  - `deriveVectorGeometry(base, related)` — `{length, angle, valueDelta}` in **anchor space**, preferring `descriptor.anchor_u/v` and falling back to `pos_x/ANCHOR_SCALE`.
  - `updateNodeStats(db, nodeId, 'hit'|'miss', amount)` — the only writer of hit/miss counters. **Only ever called with `'hit'`.**
  - `upsertFeatureGroupStats` — running weighted means of `avg_length`, `avg_angle`, `mean_distance`, `std_distance`, `mean_cosine`, `mean_pearson`, accumulating `sample_size`. Keyed by `(value_type, resolution_level)`.
  - `discoverCorrelations({iterations, similarityThreshold, onIterationStart, onDiscriminatorSelected})` — the batch learner: pick a random completed image → pick a random vector → find similar vectors in *other* completed images → for every vector of the target image, score it against the ambiguous set → keep the best discriminator → create FEATURE + GROUP nodes and bump hits by `max(1, round(sampleSize × affinityFactor / log1p(candidateCount)))` → upsert stats. Throws if fewer than two completed images exist.
  - `fetchConstellationGraph(db, {limit, minHits})` — top `GROUP` relationships with both descriptors parsed; drives `--reprobe`.
  - `fetchRelatedConstellations(db, {descriptorKey|valueTypeId, resolutionLevel, limit, minHits})` — the online search's "what should I ask next" query; returns deduped candidates with `confidence = hits/(hits+misses)`.
  - `selectTopDescriptors(db, {limit, minSampleSize})` — ranks `feature_group_stats` by `sample_size DESC` and returns measurable specs; drives progressive guided ingestion. **Declared after `module.exports`** (hoisted function declaration — valid, but easy to miss when searching).
- **Common mistakes:** `discoverCorrelations` runs an inner query per vector of the target image, so its cost scales with vectors-per-image; that is why `--discover` values are small. It has no `LIMIT` on `targetRows`. Also note `selectTopDescriptors` orders by `sample_size` alone — "top" means *most observed*, not *most discriminative*, despite the name.

### [`src/featureExtractor.js`](src/featureExtractor.js)

Ingestion orchestration and persistence. Owns writes to `images`, `value_types`, `feature_vectors`, `feature_usage`, and the optional `image_blobs`. Does **not** own measurement semantics (that is `vectorGenerators.js`).

- **Key functions and subparts:**
  - `extractAndStoreFeaturesProgressive(imagePath, {augmentations})` — **the default path.** Inserts the `images` row with `ingestion_complete = 0`, optionally stores the blob, runs cycle 1 (random ordinals per augmentation via `chooseUniqueOrdinals`), then cycles 2..N (guided descriptors from `selectTopDescriptors`, measured one at a time with `generateSpecificVector`), then sets `ingestion_complete = 1`.
  - `extractAndStoreFeatures` / `extractFeatures` / `collectFeaturesForAugmentations` / `storeFeatures` — the legacy exhaustive path, reachable only when `TRAINING_PROGRESSIVE_ENABLED=false` or via the file's own CLI. Sweeps all `SAMPLES_PER_AUGMENTATION` ordinals — orders of magnitude slower.
  - `ensureValueTypeId(db, descriptor, cache)` — single-descriptor resolution: cache → `SELECT` → `INSERT IGNORE` → `SELECT`, with bounded retry on `ER_LOCK_DEADLOCK`/`ER_LOCK_WAIT_TIMEOUT`.
  - `resolveValueTypesBulk` / `persistFeaturesBatched` — the batched equivalents (chunks of 500 for descriptors, 400 rows per `INSERT`), plus `feature_usage` seeding derived from `insertId + affectedRows`.
  - `persistFeatureBatch` — the row-at-a-time legacy writer used by `storeFeatures`.
  - `chooseUniqueOrdinals(count, max, seedKey)` — FNV-seeded ordinal sampler; deterministic per `imagePath:augmentation`.
  - `ensureImageBlobTable` / `guessMimeType` — created lazily, only when `STORE_IMAGE_BLOB=true`. `image_blobs` is **not** in `setupDatabase.js`.
- **Called by / depends on:** [`src/insert.js`](src/insert.js) chooses between the two extractors; [`src/lib/knowledge.js`](src/lib/knowledge.js) supplies `selectTopDescriptors`; re-exports `generateSpecificVector` and `resolveDefaultProbeSpec` for consumers.
- **Common mistakes:**
  - The guided branch hard-codes `Math.round(spec.anchor_u * 10000)` instead of using `CONSTELLATION_CONSTANTS.ANCHOR_SCALE` — changing `ANCHOR_SCALE` will desynchronize guided rows from cycle-1 rows.
  - `persistFeaturesBatched`'s `feature_usage` seeding assumes contiguous auto-increment ids from a multi-row `INSERT`; it is wrapped in a bare `catch {}` and will silently skip on any gap.
  - Several `try {} catch {}` blocks swallow errors around `ingestion_complete` and blob storage. An image can end up with rows but `ingestion_complete = 0`, invisible to every discovery query.
  - `console.log` calls in the progressive path embed raw ANSI escape bytes; keep new logging plain.

### [`src/insert.js`](src/insert.js)

The dataset CLI and the module boundary the HTTP admin routes and the ingest worker both call.

- **Key functions and subparts:**
  - `parseArgs` — minimal `--key=value` parser; bare `--flag` becomes `true`.
  - `ingestImage(imagePath, discoverIterations, {augmentations})` — resolves the path against `process.cwd()`, picks progressive vs. exhaustive from `settings.training.progressive.enabled`, then either runs discovery or just `ensureStorageCapacity`. **Exported and reused by the worker and the server.**
  - `removeImage(identifier)` — accepts a numeric `image_id` or an `original_filename`; the `DELETE` cascades to `feature_vectors` → `feature_usage` → `knowledge_nodes`.
  - `runCorrelationDiscovery(iterations)` — wraps `discoverCorrelations` with the per-iteration log line, then enforces the storage budget.
  - `bootstrapCorrelations(iterations)` / `handleBootstrapCommand` — the `bootstrap` subcommand; also called by `train.js --bootstrap` and `POST /discover`.
  - `handleAddCommand` — the only caller of `ensureValueTypeCapacity` on the `add` path.
- **Common mistakes:** `removeImage` deletes `knowledge_nodes` by cascade (`vector_1_id` `ON DELETE CASCADE`, `vector_2_id` `ON DELETE SET NULL`), which can leave `GROUP` nodes with a null second vector; `fetchConstellationGraph` and `fetchRelatedConstellations` both filter `vector_2_id IS NOT NULL`, so such nodes become invisible dead weight rather than corrupting results.

### [`src/workers/ingestWorker.js`](src/workers/ingestWorker.js)

Worker-thread wrapper around `ingestImage`. Message protocol: `{type:'ingest', payload:{file, discoverIterations, augmentations}}` in; `{type:'result', payload:{file, imageId, featureCount}}` or `{type:'error', payload:{file, message, stack}}` out; `{type:'shutdown'}` acks and exits.

- **Common mistakes:** [`src/train.js`](src/train.js) always posts `discoverIterations: 0` — **correlation discovery never runs inside a worker.** It runs in the parent through `OnlineCorrelationRunner`. Do not "optimize" by moving discovery into the workers; each worker opens its own MySQL connection and parallel discovery is what the lock-light redesign was avoiding.

### [`src/train.js`](src/train.js)

The primary operator entry point: dataset ingestion, online learning, self-evaluation, reprobing, and the `--evaluate` harness. Largest file in the repo.

- **Key functions and subparts:**
  - `parseArgs` — flags: `--discover`, `--bootstrap`, `--reprobe`, `--shuffle`, `--threads`, `--evaluate`, `--evaluate-runs`, `--evaluate-top`, `--evaluate-filters`, `--augmentations`/`--aug`, `--aug-per-pass`, `--aug-seed`. `--pattern` is parsed into `options.pattern` and **never read** — dead.
  - `walkDir` — recursive async generator filtered by `SUPPORTED_IMAGE_EXTENSIONS` (`.jpg/.jpeg/.png/.webp/.bmp`).
  - `sampleResources` / `computeDesiredWorkerCount` — the adaptive pool policy: target ≈ 75% of CPUs, reduced on load average > 0.9/1.1 or free memory < 18%/10%, increased when idle; hard-capped at `min(cpuCount, 8)` or `--threads` (max 32).
  - `ingestFilesConcurrently` — the pool itself: spawns/terminates workers on a `RESOURCE_SAMPLE_INTERVAL_MS` timer, drives `cli-progress` when TTY, and invokes `onImageIngested` per success. `selectAugmentationsForFile` picks `--aug-per-pass` augmentations per file with a seeded Fisher–Yates shuffle, **always including `original`**.
  - `OnlineCorrelationRunner` — serialized queue of discovery batches (`enqueue`/`process`/`drain`), with per-batch averages and the `TRAINING_CORRELATION_DEBUG_LOG` top-match dump.
  - `findCandidateImages` / `sampleRandomProbeSpec` — training-local mirrors of the search primitives, differing from `index.js` by adding the `ingestion_complete` + min-age filters.
  - `reprobeUsingConstellations` — the knowledge-driven retrieval test: loads `fetchConstellationGraph`, sorts by `hits − 0.35×misses`, and walks a queue that is *expanded as it goes* — same-anchor relatives are unshifted to the front (`relatedFanout`), geometry-similar entries from other anchors are pushed to the back (`globalFanout`, within `angleTolerance` π/18 and `lengthTolerance` 0.12).
  - `reprobeWithRandomSampling` — the fallback when no constellation graph exists.
  - `reprobeOne` — tries constellations, falls back to random.
  - `TrainingSelfEvaluator` — queues the first `TRAINING_SELF_EVAL_MAX_SAMPLES` ingested images and replays `evaluateFilterRun` on each, printing best match / self rank / threshold relaxation.
  - `evaluateDataset` — the `--evaluate` mode: matches files to `images.original_filename` **case-insensitively by basename**, runs each filter × run, prints per-match affinity/cohesion/distance, and summarizes "ranked the original first".
  - `main` — `ensureValueTypeCapacity` → walk+shuffle → pool → summary → optional bootstrap → optional reprobe, with `RealTimePruner`/`TrainingSelfEvaluator` disposal in `finally`.
- **Common mistakes:**
  - `--evaluate` returns **before** `ensureValueTypeCapacity`, so evaluating against a stale schema fails with a raw SQL error rather than a helpful one.
  - `options.shuffle` uses `files.sort(() => Math.random() - 0.5)` — a biased shuffle. Fine for sampling variety, wrong if you ever need a uniform permutation.
  - `evaluateDataset` matches on basename only; two files with the same name in different subdirectories collide.
  - `reprobeUsingConstellations` mutates the queue while draining it; adding a new fan-out source without registering in `enqueued` causes an infinite loop.

### [`src/evaluate.js`](src/evaluate.js)

Shared probe normalization and the single evaluation pass reused by training self-eval, `--evaluate`, and the search server. **Change probe semantics here, once.**

- **Key functions and subparts:**
  - `normalizeProbeSpec(spec)` — the canonical probe shape. Fills `rel_x/rel_y` from offsets, `size` from span, derives `pos_x/pos_y` via `ANCHOR_SCALE`, derives `resolution_level` via `normalizeResolutionLevel`, **rebuilds the descriptor object from scratch**, and recomputes `descriptorKey`. Carries through `source`, `confidence`, `reason`, `knowledgeNodeId`, `hits`, `misses` when present.
  - `resolveEvaluationFilters(list)` — maps user-facing filter names to augmentations, including aliases (`mirror`→`mirror_horizontal`, `blur`→`gaussian_blur`) and the synthetic `cropping`/`crop`/`center_crop` filter that attaches a `transformFactory`. Unknown names are **silently dropped**.
  - `createCroppingTransform(imagePath, runIndex, variant)` — seeded transform with ratio 0.55–1.45: below 1 it crops and rescales, above 1 it pads with transparency and rescales. Simulates both zoom-in and zoom-out.
  - `ensureValueTypeRecord(db, descriptor)` — `SELECT` → `INSERT IGNORE` → `SELECT`; the read-path twin of `ensureValueTypeId`.
  - `evaluateFilterRun(db, imagePath, imageId, filter, runIndex, {top, usedSpecKeys, valueThreshold})` — draws up to 12 candidate probes (deduping through `usedSpecKeys`, falling back to the first attempt if all were used), measures, queries, elastic-matches, scores per image, sorts, takes `top`, and **appends the self image out of rank order** when it exists but missed the cut so callers can report self-rank. Returns `{status, matches, totalMatches, relaxations, thresholdUsed}` with statuses `OK`/`NO_PROBE`/`NO_VECTOR`/`ERROR`.
- **Common mistakes:** `evaluateFilterRun` calls `normalizeProbeSpec({augmentation})` — with no descriptor, that yields a **random** probe each attempt. Evaluation is therefore stochastic by design; a single run proves nothing, which is why `--evaluate-runs` defaults to 3. Also, the appended self-entry means `matches.length` can exceed `top`.

### [`src/index.js`](src/index.js)

The search engine: Express server, CLI `find` mode, session state, and the next-question policy. Owns the public HTTP surface.

- **Key functions and subparts:**
  - Module state: `dbConnection` (single shared connection), `descriptorCache`, `skipCache`, `searchSessions` — all unbounded `Map`s with no eviction.
  - `SESSION_PHASE` — `AWAITING_INITIAL_PROBE` → `ACTIVE`.
  - `connectToDatabase` / `warmSkipCache` — lazy connect; loads all `skip_patterns` into `skipCache` once per process.
  - `bumpSkipCache` / `getSkipCount` — the in-memory skip counter checked against `SKIP_THRESHOLD`.
  - `rowToFeature` — parses `descriptor_json`, rebuilds the spec, normalizes `resolution_level`.
  - `requestInitialProbe` — up to 8 attempts at `ORDER BY RAND() LIMIT 1` over `feature_vectors`, skipping over-skipped descriptors; tags the result `source:'seed'`, `confidence:1`.
  - `findCandidateImages(db, probe)` — the core query (exact `value_type`/`pos_x`/`pos_y`, tolerance on `resolution_level`/`rel_x`/`rel_y`) → `collectElasticMatches` → `recordVectorUsage` on every matched vector.
  - `startSearch(probeSpec, existingSessionId)` — normalizes, applies **channel fallback** (if the descriptor is over-skipped, retry the same geometry on another channel from `CHANNEL_DIMENSIONS`), queries, and returns `NO_MATCH` (recording a skip pattern) / `MATCH_FOUND` / `CANDIDATES_FOUND` with a session.
  - `refineSearch(sessionId, probeSpec)` — intersects the new candidate set with the session's, extends the constellation path, and resolves or continues.
  - `buildNextQuestion(session)` — the policy: fetch up to 24 knowledge neighbours, drop already-asked and over-skipped ones, and **with 80% probability** ask the highest-confidence one (`source:'knowledge'`); otherwise fall through to up to 96 attempts at a random spec tagged `exploration` (0.35 confidence) or `random` (0.25).
  - `runServer` — mounts the routes listed in the [Interface Ownership Map](#interface-ownership-map) with `express.json({limit:'2mb'})`.
  - `runCli(imagePath)` — the same loop in-process, bounded by `CLI_MAX_ITERATIONS`.
  - Entrypoint: `server` | `find <path>` | usage text, dispatched from `process.argv` at module scope.
- **Common mistakes:**
  - Everything at module scope executes on `require` — never import this file from another module.
  - Sessions never expire and are never capped; a long-running server leaks one entry per abandoned search. There is no session TTL to lean on.
  - `findCandidateImages` here omits `ingestion_complete = 1`, unlike its twin in `train.js`.
  - The 80/20 knowledge/exploration split is a bare `Math.random() >= 0.2` with no configuration knob; do not document it as tunable.

### [`src/clientAPI.js`](src/clientAPI.js)

Reference HTTP client and the executable specification of the handshake. Uses global `fetch` (Node 18+).

- **Flow:** `POST /search/start {requestProbe:true}` → measure `probeSpec` → `POST /search/start {sessionId, probe}` → loop on `result.nextQuestion` via `POST /search/refine` until `MATCH_FOUND`, no `nextQuestion`, or `CLIENT_MAX_ITERATIONS`. Prints `source`, `confidence`, and cumulative constellation accuracy per step.
- **Common mistakes:** after each measurement it overwrites `descriptor`/`descriptorKey` with the values returned by `generateSpecificVector`. **This is required, not incidental** — see the pitfall below. Any new client must do the same.

### [`src/testCorrelations.js`](src/testCorrelations.js)

Seeds three hand-written `feature_group_stats` rows and prints the table. Despite the name it is **not a test** — it mutates the configured database and asserts nothing. Use it only to give `selectTopDescriptors` something to return on an empty knowledge base.

- **Common mistakes:** its `ON DUPLICATE KEY UPDATE` overwrites live aggregates for those descriptors. Never run it against a database you care about.

### [`src/vectorCustom.js`](src/vectorCustom.js)

Legacy standalone experiment: 4×4/8×8 grid average colors written to an `image_vectors` table.

- **Status:** dead code. `image_vectors` is not created by `setupDatabase.js`, the input path is hard-coded to `test_image.jpg`, it duplicates `rgbToHsv`, and its normalization uses `vector.indexOf(val)` (returns the *first* index of a duplicate value — a real bug). Kept for reference only; do not extend, and do not wire it into the pipeline.

### [`scripts/check-maintenance.js`](scripts/check-maintenance.js)

Documentation-sync guardrail run by `npm run maintenance:check`.

- **Key functions and subparts:**
  - `collectChangedFiles` — parses `git status --porcelain`, taking the last whitespace-separated token per line.
  - `hasMatch` — exact path or directory-prefix match.
  - `RULES` — four trigger→required-doc rules mirroring `TECH_NOTES.md` §18 (descriptor/augmentation code → both docs; `settings.js` → both docs; `setupDatabase.js`/`schema.js` → `TECH_NOTES.md`; `index.js`/`clientAPI.js` → both docs).
  - `main` — exits `1` listing violations, `0` otherwise; exits `0` with an info message when nothing changed.
- **Common mistakes:** rename lines (`old -> new`) yield only the new path, and the porcelain parser breaks on paths containing spaces. It sees only uncommitted work, so it cannot gate a commit that is already made — run it *before* committing. `AGENTS.md` is not in any `required` list.

## Features and Recurring Development Pitfalls

### Progressive ingestion — Shipped (default)

- **Behavior:** each image is ingested in `TRAINING_PROGRESSIVE_CYCLES` (3) short cycles instead of one exhaustive sweep. Cycle 1 draws `TRAINING_PROGRESSIVE_RANDOM_PER_AUG` (300) random ordinals per augmentation; cycles 2+ measure the `TRAINING_PROGRESSIVE_GUIDED_PER_CYCLE` (300) descriptors the knowledge base already values most.
- **Flow and owners:** `ingestImage` ([`src/insert.js`](src/insert.js)) → `extractAndStoreFeaturesProgressive` ([`src/featureExtractor.js`](src/featureExtractor.js)) → `generateFeaturesForAugmentationOrdinals` / `selectTopDescriptors` + `generateSpecificVector`.
- **Constraints:** guided descriptors are filtered to the augmentations selected for this run, and measured **one at a time** — a large `guidedPerCycle` is slow because each call re-decodes the image. Disable with `TRAINING_PROGRESSIVE_ENABLED=false` to fall back to the exhaustive path.
- **Tests and gaps:** none. Guided cycles are silently no-ops until `feature_group_stats` is populated by at least one discovery sweep.

### Augmentation sweep and per-run selection — Shipped

- **Behavior:** eight augmentations exist; `--aug-per-pass` (default 3) picks a deterministic subset per file, always including `original`. `--augmentations`/`TRAINING_AUGMENTATION_LIST` narrows the pool; `--aug-seed` varies selection between runs while staying stable per file.
- **Flow and owners:** `selectAugmentationsForFile` ([`src/train.js`](src/train.js)) → `applyAugmentation` ([`src/lib/augmentations.js`](src/lib/augmentations.js)) → `getRawPixels`.
- **Constraints:** augmented pixels are never persisted. `AUGMENTATION_ORDER` index positions are encoded in `sample_id`.
- **Tests and gaps:** none. `--augmentations` names are validated only by `applyAugmentation` throwing at measurement time.

### Correlation discovery and the knowledge graph — Shipped, with a broken feedback half

- **Behavior:** repeated sweeps pick a target image, find the images it is confusable with under one descriptor, and learn which second descriptor separates them; the pair is stored as a `GROUP` node with its relative geometry, and aggregate separation metrics land in `feature_group_stats`.
- **Flow and owners:** `OnlineCorrelationRunner` ([`src/train.js`](src/train.js)) or `bootstrapCorrelations` ([`src/insert.js`](src/insert.js)) → `discoverCorrelations` ([`src/lib/knowledge.js`](src/lib/knowledge.js)) → `scoreCandidateFeature` ([`src/lib/correlationMetrics.js`](src/lib/correlationMetrics.js)).
- **Constraints:** requires ≥2 images with `ingestion_complete = 1`. Candidates below `CORRELATION_MIN_AFFINITY`/`CORRELATION_MIN_COHESION` are rejected outright.
- **Tests and gaps:** no tests. **Only hits are ever recorded** — see the pitfall below.

### Server-guided iterative search — Shipped

- **Behavior:** `/search/start` + `/search/refine` narrow a candidate set one descriptor at a time; each response carries `constellationPath` with per-step `source`, `confidence`, and cumulative accuracy.
- **Flow and owners:** [`src/clientAPI.js`](src/clientAPI.js) → `startSearch`/`refineSearch`/`buildNextQuestion` ([`src/index.js`](src/index.js)) → `findCandidateImages` → `collectElasticMatches` ([`src/lib/elasticMatcher.js`](src/lib/elasticMatcher.js)) → `fetchRelatedConstellations` ([`src/lib/knowledge.js`](src/lib/knowledge.js)).
- **Constraints:** sessions are process-local and permanent; restarting the server invalidates every `sessionId`. No auth, no per-session limits.
- **Tests and gaps:** no tests. Search does **not** filter `ingestion_complete`, and does **not** write back to `knowledge_nodes`.

### Constellation-driven reprobing (`--reprobe`) — Shipped

- **Behavior:** replays learned patterns against just-ingested images and reports hit rate, average initial candidates, average steps, and average constellation accuracy.
- **Flow and owners:** `reprobeOne` → `reprobeUsingConstellations` (falls back to `reprobeWithRandomSampling`) ([`src/train.js`](src/train.js)) → `fetchConstellationGraph`.
- **Constraints:** capped at `CHANNEL_DIMENSIONS.length` (5) steps by default; needs a populated `knowledge_nodes` graph or it degrades to random sampling.
- **Tests and gaps:** the reported success rate depends on the biased shuffle used to pick the sample; treat it as directional.

### Evaluation harness (`--evaluate`) and training self-evaluation — Shipped

- **Behavior:** measures a random probe per filter/run and reports whether the source image ranks first, with affinity/cohesion/distance per match and threshold-relaxation notes. Self-evaluation runs the same code automatically for the first few ingests.
- **Flow and owners:** `evaluateDataset` / `TrainingSelfEvaluator` ([`src/train.js`](src/train.js)) → `evaluateFilterRun` ([`src/evaluate.js`](src/evaluate.js)).
- **Constraints:** filters resolve through `resolveEvaluationFilters`; unknown names vanish silently. Probes are random per run, so results are noisy by construction.
- **Tests and gaps:** this harness is the closest thing the project has to a regression check, but it asserts nothing and returns exit code 0 regardless of accuracy.

### Storage budget and pruning — Shipped

- **Behavior:** after every ingest/remove/discovery the database size is compared against `system_settings.max_db_size_gb`; the coldest unreferenced vectors are deleted in batches. During training, `RealTimePruner` additionally removes skip-pattern descriptors and stale low-hit `GROUP` nodes.
- **Flow and owners:** `ensureStorageCapacity` ([`src/lib/storageManager.js`](src/lib/storageManager.js)); `RealTimePruner` ([`src/lib/realTimePruner.js`](src/lib/realTimePruner.js)); tunable at runtime via `POST /settings/max-db-size`.
- **Constraints:** vectors referenced by any `knowledge_nodes` row are never pruned by the size budget, so a large graph can pin the database above its target indefinitely.
- **Tests and gaps:** none.

### Original-image blob storage — Experimental / scaffold

- **Behavior:** with `STORE_IMAGE_BLOB=true`, the source file is stored in `image_blobs` for future re-vectorization.
- **Flow and owners:** `extractAndStoreFeaturesProgressive` → `ensureImageBlobTable` ([`src/featureExtractor.js`](src/featureExtractor.js)).
- **Constraints:** **this contradicts the project's privacy premise** — the database now contains reconstructable images. The table is created lazily and is absent from `setupDatabase.js`; nothing reads it back. The write is wrapped in a bare `catch {}`, so failures are invisible.
- **Tests and gaps:** no reader exists. Do not enable it on a corpus where the privacy property matters.

---

### Three independent descriptor builders must stay byte-identical

- **Symptom / wrong assumption:** a field added or a rounding changed in one place; ingestion and search then compute different `descriptorKey`s for the same geometry and every query returns zero rows.
- **Cause and invariant:** the `{family:'delta', …}` object is constructed in **three** places, and `createDescriptorKey` hashes the whole object: `descriptorFromBase` ([`src/lib/constellation.js`](src/lib/constellation.js)), `descriptorFromSample` ([`src/lib/vectorGenerators.js`](src/lib/vectorGenerators.js)), and `normalizeProbeSpec` ([`src/evaluate.js`](src/evaluate.js)). A fourth partial builder lives in `resolveDefaultProbeSpec` ([`src/lib/vectorSpecs.js`](src/lib/vectorSpecs.js)). All four must agree on field names, presence, and `toFixed(6)` rounding.
- **Risk area:** [`src/lib/constellation.js`](src/lib/constellation.js) (`descriptorFromBase`), [`src/lib/vectorGenerators.js`](src/lib/vectorGenerators.js) (`descriptorFromSample`), [`src/evaluate.js`](src/evaluate.js) (`normalizeProbeSpec`), [`src/lib/vectorSpecs.js`](src/lib/vectorSpecs.js) (`resolveDefaultProbeSpec`).
- **Safe pattern / regression check:** change all four in one edit, then verify by ingesting one image and running `node src/index.js find <that image>` — a descriptor-shape break shows up immediately as `NO_MATCH` on the image's own file. Any such change orphans the existing corpus; plan a re-ingest.
- **Status:** deliberate structural duplication, active regression risk.

### Requested `descriptorKey` ≠ measured `descriptorKey`

- **Symptom / wrong assumption:** a client sends back the descriptor the server asked for, and the server finds no candidates even though the image is in the database.
- **Cause and invariant:** `ensureTargetWithinBounds` clamps the neighbour patch into the frame and **recomputes the offset**, so the descriptor actually measured can differ from the one requested (this is exactly the difference between `descriptorFromBase`, which uses nominal offsets, and `descriptorFromSample`, which uses clamped ones). The invariant: **the measured descriptor wins.**
- **Risk area:** any caller of `generateSpecificVector` — [`src/clientAPI.js`](src/clientAPI.js), `runCli` in [`src/index.js`](src/index.js), `reprobeUsingConstellations`/`reprobeWithRandomSampling` in [`src/train.js`](src/train.js).
- **Safe pattern / regression check:** always build the outgoing probe as `{...spec, value: v.value, size: v.size, descriptor: v.descriptor ?? spec.descriptor, descriptorKey: v.descriptorKey ?? spec.descriptorKey}` — the exact idiom used at [`src/clientAPI.js:52`](src/clientAPI.js) and [`src/index.js:622`](src/index.js). Copy it verbatim in new clients.
- **Status:** deliberate design, active regression risk in any new client.

### Legacy integer resolution levels never match

- **Symptom / wrong assumption:** an older database returns no candidates for anything, and archived logs show `res=74`, `res=7`, `res=60` — plausible-looking integers.
- **Cause and invariant:** `resolution_level` used to be a `TINYINT` bucket and is now a normalized span in `[0.02, 0.45]`. The migration in `setupDatabase.js` widens the column but does not rescale the data, and every lookup uses `ABS(resolution_level - ?) <= 1e-4`. An old row can never be within `1e-4` of a valid span.
- **Risk area:** [`src/setupDatabase.js`](src/setupDatabase.js) (the `MODIFY COLUMN` migrations); every candidate query in [`src/index.js`](src/index.js), [`src/train.js`](src/train.js), [`src/evaluate.js`](src/evaluate.js), [`src/lib/knowledge.js`](src/lib/knowledge.js).
- **Safe pattern / regression check:** `SELECT MIN(resolution_level), MAX(resolution_level) FROM feature_vectors;` — anything ≥ 1 is legacy. The only supported remedy is re-ingesting those images; there is no backfill script.
- **Status:** active known gap. Never quote metrics from [`studies/logs_history/`](studies/logs_history) as current behavior — they predate this change.

### `miss_count` is never incremented, so confidence is always 1.0

- **Symptom / wrong assumption:** every knowledge-sourced probe reports `confidence=1.000`, and ranking by confidence appears to do nothing.
- **Cause and invariant:** `updateNodeStats` supports `'miss'` but is only ever called with `'hit'` ([`src/lib/knowledge.js:455-464`](src/lib/knowledge.js)). `fetchRelatedConstellations` computes `hits/(hits+misses)`, which reduces to 1 whenever `misses = 0`. The search path calls `recordVectorUsage` and `saveSkipPattern` on failure but never touches `knowledge_nodes` — so the README's "Learning on Search" reinforcement loop does not exist in code.
- **Risk area:** [`src/lib/knowledge.js`](src/lib/knowledge.js) (`updateNodeStats`, `fetchRelatedConstellations`), [`src/index.js`](src/index.js) (`refineSearch` — the natural place to record an outcome), [`src/train.js`](src/train.js) (`computeConfidence`, `computeConstellationScore`).
- **Safe pattern / regression check:** if you implement miss recording, do it in `refineSearch` where `session.constellationPath` already carries `knowledgeNodeId`, and verify with `SELECT SUM(miss_count) FROM knowledge_nodes;` being non-zero after a failed search. Until then, do not build ranking logic that assumes confidence discriminates.
- **Status:** active known gap; the ordering fallbacks (`hit_count DESC, miss_count ASC`) are currently equivalent to `hit_count DESC`.

### The elastic matcher never returns nothing

- **Symptom / wrong assumption:** "one candidate returned" is read as a confident identification, or "the query returned rows so the match is within threshold" is assumed.
- **Cause and invariant:** `collectElasticMatches` widens the threshold up to 5× by a factor of 1.5 (≈7.6× the base) and, if still empty, returns the single nearest entry **at any distance**. Non-empty `rows` always yields ≥1 candidate.
- **Risk area:** [`src/lib/elasticMatcher.js`](src/lib/elasticMatcher.js); consumers in [`src/index.js`](src/index.js) (`findCandidateImages`), [`src/evaluate.js`](src/evaluate.js), [`src/train.js`](src/train.js), [`src/lib/knowledge.js`](src/lib/knowledge.js).
- **Safe pattern / regression check:** always read and report `relaxations` and `thresholdUsed` next to the result, as `evaluateFilterRun` and `TrainingSelfEvaluator.logSummary` already do. A match found after several relaxations is a weak match.
- **Status:** deliberate limitation.

### `pos_x`/`pos_y` are exact-match anchor buckets, not coordinates

- **Symptom / wrong assumption:** a developer "improves" anchor precision, changes `ANCHOR_SCALE`, or adds a tolerance to the anchor comparison, and recall silently collapses (or explodes).
- **Cause and invariant:** every candidate query compares `fv.pos_x = ?` and `fv.pos_y = ?` exactly while using tolerances for the other axes. The buckets are `anchor_u/v × 10000`, so they encode a 1/10000 grid; two descriptors one bucket apart never match, by design — the anchor is part of the descriptor's identity, not a search radius.
- **Risk area:** [`src/lib/constants.js`](src/lib/constants.js) (`ANCHOR_SCALE`), [`src/lib/vectorGenerators.js`](src/lib/vectorGenerators.js) (`buildFeatureFromSample`), [`src/evaluate.js`](src/evaluate.js) (`normalizeProbeSpec`), [`src/featureExtractor.js`](src/featureExtractor.js) (the guided branch's hard-coded `10000`).
- **Safe pattern / regression check:** treat `ANCHOR_SCALE` as immutable for an existing corpus. If you must change it, change the hard-coded literal in `featureExtractor.js` in the same edit and re-ingest everything.
- **Status:** deliberate design; the hard-coded duplicate is an active latent defect.

### Errors swallowed by bare `catch {}` blocks

- **Symptom / wrong assumption:** an image has feature rows but is invisible to discovery and evaluation; or `feature_usage` is empty; or blob storage silently did nothing.
- **Cause and invariant:** [`src/featureExtractor.js`](src/featureExtractor.js) wraps the `ingestion_complete = 1` update, the `feature_usage` seeding, the blob write, and the isolation-level statement in empty `catch` blocks. A failure there leaves the row at `ingestion_complete = 0` forever, and every discovery/evaluation query filters those out.
- **Risk area:** [`src/featureExtractor.js`](src/featureExtractor.js) (`storeFeatures`, `extractAndStoreFeaturesProgressive`, `persistFeaturesBatched`).
- **Safe pattern / regression check:** `SELECT COUNT(*) FROM images WHERE ingestion_complete = 0;` after a training run — a non-trivial count means ingests are failing silently. When adding code in these paths, log inside the `catch` rather than extending the silence.
- **Status:** active known gap.

### `require`-ing an entry point executes it

- **Symptom / wrong assumption:** importing a helper from `src/index.js`, `src/setupDatabase.js`, `src/testCorrelations.js`, or `src/clientAPI.js` starts a server, rewrites the schema, seeds data, or exits the process.
- **Cause and invariant:** those four files run work at module scope with no `require.main === module` guard. Only [`src/insert.js`](src/insert.js), [`src/featureExtractor.js`](src/featureExtractor.js), and [`src/train.js`](src/train.js) are safe to import (the first two guard their CLI; `train.js` is a top-level script but is never imported).
- **Risk area:** all four files above.
- **Safe pattern / regression check:** put shared logic in `src/lib/` or [`src/evaluate.js`](src/evaluate.js) and import from there. If a helper in `index.js` is needed elsewhere, move it out rather than importing the module.
- **Status:** deliberate script style; active hazard for refactors.

### `DB_NAME` is read twice, from two sources

- **Symptom / wrong assumption:** the storage-budget query measures a different schema than the one being written to.
- **Cause and invariant:** connections read `process.env.DB_NAME` directly, while `ensureStorageCapacity` is passed `settings.database.schema` (which defaults to `image_hypercube_db` when `DB_NAME` is unset). If `DB_NAME` is unset the two agree by luck; if it is set they agree by value. They diverge only if someone changes one default.
- **Risk area:** [`src/settings.js`](src/settings.js), [`src/insert.js`](src/insert.js) (`DB_SCHEMA`), [`src/lib/storageManager.js`](src/lib/storageManager.js).
- **Safe pattern / regression check:** keep `settings.database.schema`'s default identical to the `dbName` default in [`src/setupDatabase.js`](src/setupDatabase.js). Prefer `settings.database.schema` in new code.
- **Status:** deliberate limitation, low severity.

## Interface Ownership Map

**HTTP routes** — all registered in `runServer`, [`src/index.js`](src/index.js). No authentication on any route.

- `POST /search/start` → `requestInitialProbe` (when `{requestProbe:true}`) or `startSearch` + `buildNextQuestion`.
- `POST /search/refine` → `refineSearch` + `buildNextQuestion`.
- `POST /images` `{path, discover}` → `ingestImage` ([`src/insert.js`](src/insert.js)). **Reads an arbitrary server-local filesystem path.**
- `DELETE /images/:identifier` → `removeImage` ([`src/insert.js`](src/insert.js)). Accepts an id or a filename; cascades.
- `POST /discover` `{iterations}` → `bootstrapCorrelations` ([`src/insert.js`](src/insert.js)). Unbounded work, default 50 iterations.
- `POST /settings/max-db-size` `{value}` → upsert `system_settings.max_db_size_gb`.

**CLI entry points**

- `node src/train.js <dir> [flags]` → [`src/train.js`](src/train.js) `main`.
- `node src/insert.js add|remove|bootstrap …` → [`src/insert.js`](src/insert.js) `handleAddCommand` / `handleRemoveCommand` / `handleBootstrapCommand`.
- `node src/index.js server|find <image>` → [`src/index.js`](src/index.js) `runServer` / `runCli`.
- `node src/clientAPI.js <image>` → [`src/clientAPI.js`](src/clientAPI.js) `findImageRemotely`.
- `node src/setupDatabase.js` → [`src/setupDatabase.js`](src/setupDatabase.js) `setupDatabase` (runs on load).
- `node src/featureExtractor.js <image>` → exhaustive extraction, guarded by `require.main === module`.
- `node src/testCorrelations.js` → seeds sample stats (mutates the database).
- `npm run maintenance:check` → [`scripts/check-maintenance.js`](scripts/check-maintenance.js).

**Worker message protocol** — [`src/workers/ingestWorker.js`](src/workers/ingestWorker.js): `ingest` / `shutdown` in; `result` / `error` / `shutdown_ack` out.

**Library surfaces most often imported** — `generateSpecificVector` ([`src/lib/vectorGenerators.js`](src/lib/vectorGenerators.js), re-exported by `featureExtractor.js`), `normalizeProbeSpec` + `evaluateFilterRun` ([`src/evaluate.js`](src/evaluate.js)), `createDbConnection` + `discoverCorrelations` ([`src/lib/knowledge.js`](src/lib/knowledge.js)), `collectElasticMatches` ([`src/lib/elasticMatcher.js`](src/lib/elasticMatcher.js)), `createDescriptorKey` ([`src/lib/descriptor.js`](src/lib/descriptor.js)).

**Persistence surface** — tables `images`, `value_types`, `feature_vectors`, `feature_usage`, `skip_patterns`, `system_settings`, `knowledge_nodes`, `feature_group_stats` (all in [`src/setupDatabase.js`](src/setupDatabase.js)), plus `image_blobs` created lazily by [`src/featureExtractor.js`](src/featureExtractor.js).

## Build, Run, Debug, and Release

Prerequisites: Node 18+ (global `fetch`; developed on v24), a reachable MySQL 8 / MariaDB, and libvips available to `sharp` (bundled prebuilds cover macOS/Linux x64+arm64). There is no build step, no bundler, and no release pipeline.

Install dependencies:

```bash
npm install
```

Create `.env` in the repository root (values are examples — substitute your own; never commit this file):

```bash
printf 'DB_HOST=localhost\nDB_USER=your_mysql_user\nDB_PASSWORD=your_mysql_password\nDB_NAME=image_hypercube_db\n' > .env
```

Create or migrate the schema — **mutates the database**, safe to re-run, required after any schema change:

```bash
node src/setupDatabase.js
```

Train on a dataset directory (mutates the database; CPU- and IO-heavy; spawns worker threads):

```bash
node src/train.js ./datasets/your-dataset --discover=15 --bootstrap=75 --reprobe=50
```

Limit worker threads when MySQL shows lock waits:

```bash
node src/train.js ./datasets/your-dataset --threads=4
```

Restrict augmentations for a faster run:

```bash
node src/train.js ./datasets/your-dataset --augmentations=original,gaussian_blur,center_crop_80 --aug-per-pass=2
```

Ingest or remove a single image (mutates the database):

```bash
node src/insert.js add ./datasets/your-dataset/image1.jpg --discover=15
```

```bash
node src/insert.js remove image1.jpg
```

Run a correlation-only sweep over existing data (mutates `knowledge_nodes` and `feature_group_stats`):

```bash
node src/insert.js bootstrap 75
```

Evaluate retrieval accuracy (read-mostly: it queries, but `ensureValueTypeRecord` may insert new `value_types` rows):

```bash
node src/train.js ./datasets/your-dataset --evaluate --evaluate-filters=original,cropping --evaluate-runs=3 --evaluate-top=5
```

Verbose correlation diagnostics:

```bash
TRAINING_CORRELATION_DEBUG_LOG=1 TRAINING_CORRELATION_TOP_LOG_K=5 node src/train.js ./datasets/your-dataset --discover=12
```

Start the search server (listens on `PORT`, default 3000; no authentication — bind it only to a trusted network):

```bash
node src/index.js server
```

Query it from another terminal:

```bash
node src/clientAPI.js ./path/to/query.jpg
```

Search without a server:

```bash
node src/index.js find ./path/to/query.jpg
```

Adjust the storage budget on a running server:

```bash
curl -X POST http://localhost:3000/settings/max-db-size -H "Content-Type: application/json" -d '{"value":6}'
```

Documentation-sync gate — run **before** committing, since it inspects the uncommitted working tree:

```bash
npm run maintenance:check
```

Not available: `npm test` (wired to fail deliberately), lint, format, typecheck, benchmark, packaging, and deployment. Do not invent them.

### Cheetah submodule (migration work only)

Prerequisites: Go 1.24+ (verified on 1.25.4). No CGO, no external services. Full details in [`cheetah/AGENTS.md`](cheetah/AGENTS.md) — the commands below are the ones needed from this repository.

Pull it — **first action of every session**:

```bash
git -C cheetah pull --ff-only origin main
```

Build the server binary (untracked; do not commit it):

```bash
go build -o cheetah-server ./cheetah/src
```

Run it headless on a scratch port and data directory for experiments (mutates only that directory):

```bash
CHEETAH_HEADLESS=1 CHEETAH_LISTEN_ADDR=127.0.0.1:4467 CHEETAH_DATA_DIR=./scratch_data ./cheetah-server
```

Its test suite — run before any commit inside the submodule:

```bash
go test ./cheetah/src
```

Its format and vet gates, which must both be silent:

```bash
cd cheetah && gofmt -l . && go vet ./...
```

Create the feature database at stride 2 (the stride where adaptive pair indexing actually pays off; `pairs/format.dat` is authoritative on reopen, so this only takes effect at creation):

```bash
RESET_DB image_sign pair_bytes=2
```

## Test Ownership Map

**There is no automated test suite.** No test runner, no test files, no fixtures, no CI configuration. `npm test` exits 1 by design. Every contract in this document is unprotected by executable checks.

The closest substitutes, and what each actually covers:

| Contract / subsystem | Nearest check | What it does **not** cover |
| --- | --- | --- |
| End-to-end retrieval | `node src/train.js <dir> --evaluate` ([`src/train.js`](src/train.js) `evaluateDataset`) | Asserts nothing; exits 0 regardless of accuracy; probes are random per run |
| Ingest → search round-trip | training self-evaluation (`TRAINING_SELF_EVAL_*`, on by default) | Only the first `maxSamples` (8) images; `original` filter only by default |
| Learned-pattern retrieval | `--reprobe=<n>` → `reprobeOne` | Sample chosen by a biased shuffle; ≤5 steps |
| Descriptor-hash stability | none | The single highest-risk contract has no check at all |
| Schema/migration | `node src/setupDatabase.js` re-run | No verification that data survives a migration; no legacy-data backfill |
| Documentation sync | `npm run maintenance:check` | Only uncommitted changes; does not know about `AGENTS.md`; breaks on paths with spaces |
| Correlation seeding | `node src/testCorrelations.js` | Not a test — it mutates the database and asserts nothing |

**Known test gaps, in priority order:** descriptor-hash stability across the three builders; `normalizeProbeSpec` round-tripping; `collectElasticMatches` relaxation behavior; `normalizeResolutionLevel` boundaries; `extendConstellationPath` accuracy arithmetic. All are pure functions with no database dependency and would be cheap to cover first.

## Data, Security, Privacy, and Compatibility Boundaries

- **Canonical data:** `images` + `value_types` + `feature_vectors`. Everything else is derived and rebuildable: `feature_usage` (counters), `skip_patterns` (learned anti-patterns), `knowledge_nodes` and `feature_group_stats` (learned from `feature_vectors` by re-running `bootstrap`). Losing derived tables costs learning time, not data.
- **Untracked/runtime paths:** `datasets/` (git-ignored), `.env` (git-ignored), `node_modules/`. The MySQL database itself is external state — there is no backup or restore tooling in this repository; use ordinary `mysqldump`.
- **Privacy premise:** the database stores relative deltas, not pixels, so the corpus should not permit image reconstruction. **`STORE_IMAGE_BLOB=true` breaks this property** by storing the original file in `image_blobs`; leave it off unless you accept that. Augmented pixels are never persisted under any setting.
- **Secrets:** only `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`, supplied through `.env` and read by `dotenv`. Never log them, never persist them into `system_settings`, never add them to `README.html`. No API keys or tokens exist in this project.
- **Trust level of inputs — the HTTP surface is unauthenticated.** `POST /images` accepts a filesystem path chosen by the caller and reads it server-side; `DELETE /images/:identifier` destroys data; `POST /discover` schedules unbounded CPU and database work; `POST /settings/max-db-size` changes retention. Treat the server as a trusted-network-only tool. Adding authentication is a legitimate improvement; **shipping this on a public interface is not safe.**
- **Input limits:** `express.json({limit:'2mb'})` is the only bound. There is no rate limiting, no session cap, no session TTL, and no probe-value validation beyond `typeof probe.value === 'number'` on `/search/start` (`/search/refine` does not even check that).
- **SQL construction:** all queries are parameterized; the only interpolated fragments are placeholder lists built from array lengths and the `hit_count`/`miss_count` column name in `updateNodeStats`. Keep it that way — never interpolate a caller-supplied value into SQL.
- **Compatibility promises:** none. There is no API versioning and no deprecation policy. The descriptor hash is the de-facto data format contract: **changing the descriptor object invalidates the entire corpus.** Schema changes must be idempotent `ALTER`s in `setupDatabase.js` so existing installations can migrate by re-running it.
- **MySQL requirements:** `CREATE INDEX IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` need MySQL 8; on older servers the migration block is caught and skipped, leaving the schema stale without a warning. `READ COMMITTED` is set best-effort per connection.

## Current Status and Known Gaps

### Shipped

- Progressive ingestion with an adaptive worker pool, deterministic augmentation selection, and lock-light batched persistence.
- Deterministic constellation sampling with relative anchors/spans/offsets and SHA-1 descriptor identity.
- Batch correlation discovery writing `knowledge_nodes` (FEATURE + GROUP) and `feature_group_stats`.
- Server-guided iterative search over HTTP and CLI, with elastic threshold relaxation, channel fallback, skip-pattern avoidance, and constellation-path reporting.
- Evaluation harness (`--evaluate`), training self-evaluation, and constellation reprobing (`--reprobe`).
- Storage-budget pruning plus real-time pruning of skip-pattern descriptors and stale group nodes.
- Runtime schema guard (`ensureValueTypeCapacity`) and idempotent schema setup.

### Experimental / Scaffold

- **Cheetah migration groundwork** — the [`cheetah`](cheetah) submodule is added, pinned at `8ecdf35`, verified to build (`go build -o cheetah-server ./cheetah/src`) and verified over TCP for the exact mechanisms the plan depends on: `PAIR_SET`/`PAIR_GET`/`PAIR_SCAN`/`PAIR_SUMMARY`/`PAIR_REDUCE counts`, `GRAPH_NODE_SET`/`GRAPH_EDGE_SET`/`GRAPH_NEIGHBORS`/`GRAPH_DEGREE`, and `GRAPH_RECALL` returning a ranked image ID from a descriptor seed. **No integration code exists in [`src/`](src)** — the migration is at Phase 0 of [`ROADMAP.md`](ROADMAP.md).
- `STORE_IMAGE_BLOB` / `image_blobs` — writes only, no reader, table absent from `setupDatabase.js`, and it contradicts the privacy premise.
- `src/testCorrelations.js` — a seeding utility named like a test.
- `src/vectorCustom.js` — dead legacy experiment against a table that no longer exists.
- `TREE_DEPTHS`, `SPAN_SCALE`, `getBlockRange`, `train.js --pattern` — declared, unused.

### Known Gaps

- **No automated tests, no CI, no lint.** The single largest risk to every contract in this document.
- **`knowledge_nodes.miss_count` is never incremented**, so all confidences are 1.0 and the README's "Learning on Search" reinforcement loop does not exist in code.
- **The quadtree feature family described in the README is unimplemented** — there is no `hsv_tree_mean`/`hsv_tree_delta` producer or consumer.
- **The README's claim that the server picks the next question from `feature_group_stats` separation scores is stale.** `buildNextQuestion` uses `knowledge_nodes` via `fetchRelatedConstellations`, with random exploration; `feature_group_stats` feeds guided *ingestion*, not question selection.
- **Legacy integer `resolution_level` rows are permanently unmatchable** and there is no backfill path.
- **The live search path omits `ingestion_complete = 1`**, unlike training and evaluation.
- **Search sessions and the descriptor/skip caches never expire**; `skipCache` also goes stale when `RealTimePruner` clears `skip_patterns` under a running server.
- **The HTTP surface has no authentication** and exposes filesystem reads, deletion, and unbounded compute.
- **`ANCHOR_SCALE` is hard-coded as `10000`** in the guided-ingestion branch of `featureExtractor.js`.
- **No `.env.example`** despite `.gitignore` whitelisting one.
- **Errors are swallowed** around `ingestion_complete`, `feature_usage` seeding, and blob storage.

### Near-Term Priorities

The Cheetah migration in [`ROADMAP.md`](ROADMAP.md) is the primary direction; these are ordered to serve it rather than to polish the MySQL implementation that is being replaced.

1. **Freeze the Cheetah key layout** ([`ROADMAP.md`](ROADMAP.md) §3) after measuring real page sizes with `PAIR_SUMMARY`. It is the migration's wire format and every later phase depends on it.
2. **Add the first tests** (Roadmap 0.6) covering `createDescriptorKey`, the three descriptor builders, `normalizeProbeSpec`, `normalizeResolutionLevel`, and the new key codec. All pure, no database, highest risk reduction per line — and the migration needs a parity gate that does not yet exist.
3. **Build the Cheetah client + key codec** (Roadmap phases 0–1) before touching any storage call site.
4. **Record misses when porting the knowledge graph** (Roadmap 4.2). Cheetah edges carry a real belief scale, so this stops being a nice-to-have: shipping the graph layer without misses reproduces today's always-`1.0` confidence bug in a new store.
5. Reconcile [`README.md`](README.md) with the code — remove or relabel the quadtree section and the "Learning on Search"/`feature_group_stats`-question claims as `Planned` — so the migration does not carry false documentation into the new architecture.

Deferred while the migration is live (fix only if they block it): `ingestion_complete` in the search path, `searchSessions` TTL, `.env.example`. The first is explicitly carried into the new design as Roadmap 2.3.

## Task Start and Handoff Checklist

**Before you change anything:**

0. **Pull the submodule** — `git -C cheetah pull --ff-only origin main` — per [Working with the Cheetah submodule](#working-with-the-cheetah-submodule). Do this first, every session.
1. Read this file, then [`ROADMAP.md`](ROADMAP.md) (to know which phase you are in), then [`TECH_NOTES.md`](TECH_NOTES.md) and [`src/settings.js`](src/settings.js). Check `git status` and preserve unrelated changes. For anything touching Cheetah, read [`cheetah/AGENTS.md`](cheetah/AGENTS.md) rather than assuming its protocol.
2. Locate the owning file in the [source tree](#linked-source-tree-and-file-reference) and read its "Common mistakes" note before editing it.
3. If your change touches descriptors, anchors, spans, resolution levels, or channels, re-read [Critical Implementation Contracts](#critical-implementation-contracts) and the [three-builders pitfall](#three-independent-descriptor-builders-must-stay-byte-identical). Assume you are changing a wire format.
4. Verify the handbook's claim against the current source before relying on it — nothing here is enforced by tests.

**Before you finish:**

5. Verify by running the real pipeline: `node src/setupDatabase.js`, ingest a handful of images, then `node src/index.js find <one of them>` and/or `node src/train.js <dir> --evaluate`. Report the exact commands, the dataset size, and the observed output. Say plainly what you did **not** run.
6. If you changed descriptor shape, anchor scaling, channel normalisers, or `resolution_level` semantics, state explicitly that existing data is invalidated and a re-ingest is required.
7. Update the affected `###` file subsection here — responsibilities, symbols, callers, and file-specific mistakes — plus [Features](#features-and-recurring-development-pitfalls), [Interface Ownership Map](#interface-ownership-map), and [Known Gaps](#known-gaps) as applicable. Remove instructions your change made false.
8. Update [`README.md`](README.md) and/or [`TECH_NOTES.md`](TECH_NOTES.md) per the trigger table in [`scripts/check-maintenance.js`](scripts/check-maintenance.js), then run `npm run maintenance:check` **before** committing.
9. **If you completed a roadmap item**, tick it in [`ROADMAP.md`](ROADMAP.md) *and* move it to `Shipped` here with its verification note. An item is never done in only one of the two places. If you discovered new migration work, add it to the roadmap rather than describing it here as behavior.
10. **If you changed anything under [`cheetah/`](cheetah)**: `gofmt -w` the touched files, run `go build ./... && go vet ./... && go test ./src` inside the submodule, update [`cheetah/AGENTS.md`](cheetah/AGENTS.md) in the same commit, commit and push on its `main`, then bump the pointer here with `git add cheetah` and name the SHA in the commit message.
11. Confirm no secrets, dataset files, `.env`, or Cheetah build outputs (`cheetah-server`, `cheetah_data/`) are staged, and that every local link in this file still resolves.
