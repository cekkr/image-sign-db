There are several lacks in the concept of this implementation: there is not a solid "tree dividing" merging between correlation of images, and not good real time statistical math correlation. And would be important import image manipulation libraries to mirror, apply filter etc to improve the quality of vectorization


Highlights

Added an augmentation-aware, quadtree feature extraction pipeline so every image now yields mirrored/blurred variants plus hierarchical mean/delta descriptors before persistence (src/featureExtractor.js:9, src/featureExtractor.js:114, src/featureExtractor.js:180).
Training now computes and stores mean distance, spread, cosine, and Pearson stats for the best discriminators, updating both the knowledge graph and a new feature_group_stats table used at query time (src/train.js:32, src/train.js:156, src/train.js:180).
The search server keeps richer session state and consults the recorded correlation metrics before falling back to hit/miss heuristics; responses surface the stats, which the CLI client also prints (src/index.js:39, src/index.js:68, src/index.js:160, src/clientAPI.js:47).
Database setup seeds the new statistics table, and the correlation test script was retooled to populate/inspect it (src/setupDatabase.js:54, src/testCorrelations.js:5).
Documentation explains the new extraction workflow, correlation-driven questioning, and updated tooling (README.md:26, README.md:142, README.md:170).
Notes

Tests were not run; please validate in your environment.
Next Steps

Re-run node src/setupDatabase.js to create feature_group_stats, then execute node src/train.js so the new metrics are populated.
Spot-check a search round-trip (node src/index.js server + node src/clientAPI.js …) to confirm the new metrics appear and the candidate pruning behaves as expected.
RESOLUTION_LEVELS makes no sense: you simply "merge" some vectors linearly connected looking for deeper linked pattern if similar, the linking group shouldn't be always connected by the same distance, but it's important a "relative number pointer of view" that says circa how much moved respect than "pixel by pixel". You have to consider the it has to work also with cropped image, or low resolution, or higher resolution, or filtered color or mirrored etc. For this reason everything should be a "relative vector/vector-group". And it's important to make some random edits to image to insert (train) aiming to handle these kind of issues, still checking the scoring (the affinity + computation time) as reference to avoid "too far correlations"


Replaced the fixed-resolution pipeline with relative, augmentation-aware vectors and synced training/search so correlations stay tight even under crops, flips, or jittered edits.

src/featureExtractor.js:9-420 now generates relative gradient vectors across multiple grid densities, records neighbour offsets, and adds deterministic crop/rotate/color “random combos”, with on-demand generation deriving the augmentation from the vector type.
src/train.js:6-325 rebalances candidate scoring (affinity + spread vs cost) and scales hit counters before persisting stats, filtering out weak or overly expensive correlations.
src/index.js:1-399 and src/clientAPI.js:1-105 carry the new vector specs end-to-end: sessions track augmentation, questions surface correlation metrics, and both server and CLI start from the relative gradient probe.
src/testCorrelations.js:5-90 seeds sample data using the new naming/scale scheme so feature_group_stats examples match the extractor.
README.md:13-120 documents the relative vector approach, stochastic augmentations, and the updated training/search behavior.
Notes:

Runtime checks skipped: node -e "require('./src/featureExtractor.js')" fails locally because sharp isn’t installed in the sandbox; please verify in your environment.
Next steps:

Re-run node src/setupDatabase.js and node src/train.js so existing datasets pick up the new vector schema and correlation metrics.
Smoke-test a search cycle (node src/index.js server + node src/clientAPI.js <image>) to confirm the new questions and metrics flow end-to-end.
Improve the internal correlation between scripts and internal function to improve redundancies and potentialities. Remember: a channel itself it's a dimension, so r-g-b-h-s-v are just possible combinations of vectorization/grouping comparison and correlations by channels with mysql. So divide every essential function in sub function where useful to maximum extensibility. Same for the way about how vectors are done, linking are done, what level of vector and what vectors getting (especially in case of client API) getting, management of score, statistical math etc...
And train.js should be used only for initial "basic images dataset learning", then it should be called something like insert.js (with the possibility also to remove an image sign from the database). This is different from machine learning because it works in REAL TIME, but learning from best vectorization and grouping to follow (and to remove from datbaase to be lightweight) and to ask to client.

This project born to recognize in a lightweight mode a oblivion image recognition by providers or client computers from web excluding man in the middle interception of the original image


Changes

Reworked feature extraction into modular building blocks for channels, grids, augmentations, and vector specs so every stage is extensible and channel-aware (src/featureExtractor.js:1, src/lib/constants.js:1, src/lib/colorUtils.js:1, src/lib/augmentations.js:1, src/lib/gridStats.js:1, src/lib/vectorSpecs.js:1, src/lib/vectorGenerators.js:1).
Centralized correlation math and knowledge-graph updates, and exposed them through a new ingestion controller that can add/remove images or trigger bootstrap discovery (src/lib/correlationMetrics.js:1, src/lib/knowledge.js:1, src/insert.js:1, src/train.js:1).
Updated server/client flow to use the shared modules and augmentation-aware specs, and refreshed docs to explain the real-time workflow and new commands (src/index.js:1, src/clientAPI.js:1, README.md:21, README.html:150).
Notes

Runtime checks were limited: node -e "require('./src/featureExtractor.js')" still needs sharp installed locally; please verify in your environment.
Next Steps

Run node src/setupDatabase.js (if schema needs refreshing) followed by node src/insert.js bootstrap <iterations> to rebuild correlations.
Use node src/insert.js add <image> --discover=25 for ingestion and node src/insert.js remove <image_id|filename> to prune entries.
Smoke-test the search loop (node src/index.js server + node src/clientAPI.js <image>) to ensure the modular pipeline behaves as expected.
Ok, I revolution again everything starting from a new point of view, the tables:

// Table for individual feature vectors. Unchanged.
const createFeatureVectorsTableSQL = CREATE TABLE IF NOT EXISTS feature_vectors ( vector_id BIGINT AUTO_INCREMENT PRIMARY KEY, image_id INT NOT NULL, value_type UNSIGNED MEDIUMINT NOT NULL, // create a table for the type of value (its channel) resolution_level TINYINT UNSIGNED NOT NULL, pos_x SMALLINT UNSIGNED NOT NULL, pos_y SMALLINT UNSIGNED NOT NULL, x FLOAT NOT NULL, // relative y FLOAT NOT NULL, // relative value FLOAT NOT NULL, size FLOAT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (image_id) REFERENCES images(image_id) ON DELETE CASCADE, INDEX idx_feature_lookup (vector_type, resolution_level, pos_x, pos_y) ) ENGINE=InnoDB;;

// The NEW "knowledge base" of the system. This hierarchical structure can represent
// relationships between individual features and groups of features.
const createKnowledgeNodesTableSQL = CREATE TABLE IF NOT EXISTS knowledge_nodes ( node_id INT AUTO_INCREMENT PRIMARY KEY, -- Self-referencing key to create the hierarchy. NULL for top-level nodes. parent_node_id INT, -- Differentiates a leaf ('FEATURE') from a learned combination ('GROUP'). node_type ENUM('FEATURE', 'GROUP') NOT NULL, vector_1_id INT NOT NULL, vector_2_id INT NOT NULL, -- A flexible way to describe a leaf feature node without many columns. vector_length FLOAT NOT NULL, // relative vector_angle FLOAT NOT NULL, // relative vector_value FLOAT NOT NULL, -- Raw counters for the learning algorithm to calculate utility. hit_count BIGINT DEFAULT 0, miss_count BIGINT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, FOREIGN KEY (parent_node_id) REFERENCES knowledge_nodes(node_id) ON DELETE CASCADE, -- Ensure feature definitions are unique to avoid duplicate leaf nodes. UNIQUE KEY uq_feature_definition (node_type, feature_details(256)) ) ENGINE=InnoDB;;

const createFeatureGroupStatsTableSQL = CREATE TABLE IF NOT EXISTS feature_group_stats ( stat_id BIGINT AUTO_INCREMENT PRIMARY KEY, vector_type UNSIGNED MEDIUMINT NOT NULL, resolution_level TINYINT UNSIGNED NOT NULL, length FLOAT NOT NULL, average_angle FLOAT NOT NULL, average_sample_size INT UNSIGNED DEFAULT 0, mean_distance DOUBLE DEFAULT 0, std_distance DOUBLE DEFAULT 0, mean_cosine DOUBLE DEFAULT 0, mean_pearson DOUBLE DEFAULT 0, last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, -- remove this kind of time stamp, should be obtained using mariadb functions or thirds "linking fastening" tables ) ENGINE=InnoDB;;

I hope this can help you to understand better the logic behind: no absolute references between vectors, they're resolution, they're channel, how to correlete them etc. Everything's relative, nothing's absolute, apart the initial input image as signing. And remember that the same image could be enforce by inference if someone try to find a sign with an image with better definition and larger viewport


Database & Schema

Replaced the schema in src/setupDatabase.js with a relative-first model: added value_types, rebuilt feature_vectors to store per-channel values plus relative position/offset/size, and redesigned knowledge_nodes/feature_group_stats around vector IDs, angles, and lengths.
Seeded standard channel types (r, g, b, h, s, v, luminance, stddev) during setup so ingestion can resolve value-type IDs immediately.
Feature Extraction & Storage

Refactored the extraction stack (src/featureExtractor.js, src/lib/vectorGenerators.js, src/lib/vectorSpecs.js) to emit normalized gradients per channel, capture relative offsets/size, and persist them via the new schema.
Output from generateSpecificVector now returns per-channel values plus derived displacement metadata, matching the relative storage model.
Learning & Correlation

Reworked correlation maths (src/lib/correlationMetrics.js) to operate on the new float-based feature vectors, computing distances/affinities without binary buffers.
Rebuilt the knowledge layer (src/lib/knowledge.js) so feature/group nodes reference vector IDs, derive geometry on the fly, and aggregate stats by channel/resolution.
Updated the ingestion controller (src/insert.js) and seeding tool (src/testCorrelations.js) to speak the new schema and log in channel-centric terms.
Search Pipeline & Client

Replaced the server search loop (src/index.js) with a relative-channel workflow: probe payloads carry channel, grid size, displacement, and value; sessions rotate through channels heuristically; candidates are filtered via the new distance metric.
Synced the CLI/API client (src/clientAPI.js) with the new contract, sending structured probe objects instead of base64 buffers and following the server’s channel rotation prompts.
Documentation

Refreshed README content to describe the channel-aware, relative vector storage and the new insert.js workflow (with bootstrap/remove commands); the HTML overview reflects the updated roles.
What to run / verify

Recreate the schema and seed channels: node src/setupDatabase.js.
Re-ingest images via node src/insert.js add <image> --discover=25 (or run bootstrap for a corpus).
Smoke-test the flow (node src/index.js server + node src/clientAPI.js <image>).
Notes

The real-time search now rotates through channels when multiple candidates remain; deeper knowledge-driven questioning can build on the recorded stats.
vectorCustom.js was left untouched (legacy helper).
You created an enumeration with name of type of vectors and channel (rgb/hsv/std/avg etc). It's fine for human reference in code, but it should be "irrational" in computational approach: the algorithm should be find the best patterns, indipendently by they're chaotic correlation. Imagine, for example, the recognition of the violet without a comparison between the blue and red channel (forgetting the hsv approach in parallel, only as example). These kind of stuff (also the calculus) should be edited by javascript code side, the id are used only as unique reference to avoid confusion. Even in javascript side I wanted everything modularized because of the opportunity (a part for the unique id) to describe channel, interpolations and calculus to usage (mariadb, or middleware caching table) in a "blind" way to the database itself, unless if it's needed. Everything's is relative: there is no absolute reference point for the image correlation research, but "more or less appealing" constellations of correlations (better with probabilities tree path removal, following, mergin, reinforcing etc). Then add to index.js express server the possibility to add/remove an image from signing, training start etc, so everything is more corellated


Key Updates

Redesigned the schema (src/setupDatabase.js) to keep the database “blind”: value_types now stores hashed descriptor blobs (descriptor_hash, descriptor_json), and feature_vectors persists only relative measurements (value type id, grid indices, relative offsets, value, size).
Refactored the extraction pipeline (src/featureExtractor.js, src/lib/vectorGenerators.js, src/lib/vectorSpecs.js, new src/lib/descriptor.js) so every generated feature carries a descriptor object that the DB never interprets; descriptors are hashed only when stored.
Rebuilt correlation / knowledge utilities (src/lib/knowledge.js, src/lib/correlationMetrics.js, src/testCorrelations.js) to hydrate descriptors from the DB, operate purely on relative geometry, and aggregate stats by value_type id.
Reworked the search engine (src/index.js) and API client (src/clientAPI.js) into descriptor-driven workflows: probes carry descriptor hashes, the server rotates through available descriptor variants, and Express now exposes /images (add/remove) and /discover endpoints that reuse the ingestion/bootstrapping logic from src/insert.js.
Updated documentation (README.md) to explain the hashed descriptor model and the new server capabilities.
Next Steps

Re-run node src/setupDatabase.js (schema changed), then ingest data via node src/insert.js add <image> [--discover=N] and node src/insert.js bootstrap <iterations> as needed.
Start the server (node src/index.js server) and exercise the new endpoints (/search, /images, /discover) with the updated client (node src/clientAPI.js <image>).
Now the final but important part: caching, scoring and computational efficiency. Implement everything's possible to make computational use of mariadb more efficient over the time, with settings like "maximum GB db size" to know when to delete the less relevant information, when to save common less relevant information as reference about what not to follow, and most important knowing the most computational efficient correlation finding path (for that reason, the first "generic dataset training" it's so important, even if not relevant for the effective image to find). Rapidity and computational efficiency (and storage limitation) now are to consider.


Now the final but important part: caching, scoring and computational efficiency. Implement everything's possible to make computational use of mariadb more efficient over the time, with settings like "maximum GB db size" to know when to delete the less relevant information, when to save common less relevant information as reference about what not to follow, and most important knowing the most computational efficient correlation finding path (for that reason, the first "generic dataset training" it's so important, even if not relevant for the effective image to find). Rapidity and computational efficiency (and storage limitation) now are to consider.


Caching & Pruning

Added descriptor-driven metadata tables (value_types, feature_usage, skip_patterns, system_settings) and default max-db-size setting. We now track per-vector usage/score, remember dead-end descriptors, and persist hashed descriptor definitions (src/setupDatabase.js, src/lib/storageManager.js, README.md).
featureExtractor stores descriptor hashes alongside each relative vector and seeds feature_usage rows for later scoring (src/featureExtractor.js, src/lib/vectorGenerators.js, src/lib/vectorSpecs.js, src/lib/descriptor.js).
Learning & Search Efficiency

Correlation discovery hydrates descriptors, writes usage stats, and respects skip patterns and pruning hooks (src/lib/knowledge.js, src/lib/correlationMetrics.js, src/testCorrelations.js).
The Express engine now normalizes probes, caches descriptor lookups, tracks vector usage, consults skip patterns, rotates channels intelligently, and surfaces maintenance endpoints (/images, /discover, /settings/max-db-size) (src/index.js, src/clientAPI.js).
Lifecycle Management

Ingestion/removal routines ensure storage limits are honoured and reuse the new storage manager (src/insert.js).
Docs

README updated to describe adaptive caching/pruning, new tables, and admin endpoints.
_Running node src/setupDatabase.js will create the new tables. Re-ingest data with node src/insert.js add … (use --discover=N to trigger correlation sweeps) and update the max DB size via POST /settings/max-db-size if needed.

Repopulate train.js script that is just using insert.js, but given as argument a folder full of images (dataset), for the kickoff training and realtime scoring. Would be useful randomly re-execute and re-inference an image to track the statistics about the DB model algorithm efficiency in its initial kick off training


Implemented dataset ingestion + efficiency evaluation, and added adaptive caching/pruning.

What I added and changed

Dataset training script

Rewrote src/train.js into a real trainer that:
Ingests all images in a folder using the existing insert.js ingestImage routine (optionally with --discover per-image)
Optionally runs a bootstrap correlation sweep (--bootstrap)
Randomly re-probes a subset of ingested images (--reprobe) to measure retrieval efficiency (success rate, avg initial candidates, avg refinement steps)
Usage: node src/train.js <dataset_dir> [--discover=25] [--bootstrap=100] [--reprobe=50] [--shuffle=true]
Adaptive caching and pruning

Tables and settings (src/setupDatabase.js)
value_types: hashed descriptor definition (descriptor_hash, descriptor_json)
feature_usage: per-vector usage count + score to prioritize hot vectors
skip_patterns: per-descriptor skip count (dead ends)
system_settings: runtime settings (auto-seeded max_db_size_gb=4)
Storage manager (new src/lib/storageManager.js)
loadSetting, recordVectorUsage (batched), saveSkipPattern
currentDatabaseSizeGb, pruneLowValueVectors, ensureStorageCapacity
Ingestion
featureExtractor seeds feature_usage rows on insert (src/featureExtractor.js)
insert.js calls ensureStorageCapacity after ingestion and correlation discovery
Learning + Search
knowledge.js records usage for vectors used in learning and best discriminators
index.js search path:
Caches skip patterns in-memory at startup; avoids dead-end descriptors
Records vector usage for matching results
Falls back to alternate channels/descriptors when the primary is frequently skipped
Adds admin endpoints:
POST /images { path, discover? }
DELETE /images/:identifier
POST /discover { iterations? }
POST /settings/max-db-size { value }
Descriptor-centric pipeline

Kept the DB blind: descriptors are hashed and persisted in value_types; JS remains fully modular to define channels, deltas, and transformations.
All probe generation/search uses descriptors (family/channel/neighbor offsets) and relative components.
Documentation

README describes adaptive caching/pruning, new tables, runtime setting endpoint, and how these affect ingestion and search.
How to use

Setup and ingest
node src/setupDatabase.js
node src/train.js ./path/to/dataset --discover=15 --bootstrap=75 --reprobe=50
Server and client
node src/index.js server
node src/clientAPI.js path/to/query.jpg
Admin settings
curl -X POST http://localhost:3000/settings/max-db-size -H 'Content-Type: application/json' -d '{"value":6}'
Notes

The trainer evaluates retrieval performance without running the HTTP server; it queries the DB directly and uses feature vectors + descriptors to reproduce the search logic.
All DB operations assume a MariaDB/MySQL server with the configured credentials in .env.
I need a value type fixing for the library sharp:

⚠️ Failed ingest: datasets/unsplash-images-collection/photo-1541958409-7618fd1ad26e.jpg -> Expected number for hue but received -14.62380521837622 of type number

transformed = transformed
    .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(baseMeta.width, baseMeta.height, { fit: 'cover' })
    .modulate({
        saturation,
        brightness,
        hue: hueShift,
    });
in sharp.js:
if ('hue' in options) {
if (is.integer(options.hue)) {
this.options.hue = options.hue % 360;
} else {
throw is.invalidParameterError('hue', 'number', options.hue);

A normalization is needed in this cases, or an adaption of component depth and type for sharp


Fixed hue normalization for sharp.modulate to prevent the integer error.

Change

src/lib/augmentations.js: In applyRandomCombo, hue is now rounded to an integer and normalized to [0, 359] before calling sharp.modulate.
Details

Previously, we generated a floating hue shift in degrees (e.g., -14.62). sharp.modulate({ hue }) requires an integer; the library’s internal check rejects non-integer values.
The code now does:
const hueShift = rand() * 36 - 18
let hueShiftDeg = Math.round(hueShift)
hueShiftDeg = ((hueShiftDeg % 360) + 360) % 360
.modulate({ saturation, brightness, hue: hueShiftDeg })
This eliminates “Expected number for hue” errors from sharp while maintaining the intended color jitter.