# Image Sign DB
=============

Image Sign DB is an advanced content-based image retrieval (CBIR) system that identifies images by learning and querying their structural "signatures." Unlike traditional systems that compare whole images, this project deconstructs images into a multi-dimensional feature set and uses a machine learning approach to build a knowledge base of the most effective features for recognition.

The core principle is a secure, server-guided search that minimizes data transfer, preventing a client from revealing the full image it's looking for.

The Algorithm Logic
-------------------

The system is built on several key concepts that work together to create an intelligent and efficient recognition engine.

### 1\. Multidimensional Vectorization: The "Image Hypercube"

Instead of treating an image as a flat, 2D grid of pixels, we model it as a 4D data structure, or "hypercube."

*   **Dimensions 1 & 2 (X, Y):** The spatial location within the image.
    
*   **Dimension 3 (Channels):** The color space, primarily using **HSV (Hue, Saturation, Value)**, which is highly robust against lighting, filter, and contrast distortions.
    
*   **Dimension 4 (Span / Offset):** A deterministic constellation library of relative spans and offset multipliers that describe _how far_ a pattern moves as a percentage of the image’s minimum side. Every vector knows both its footprint (`span`) and how far to travel from its anchor (`offset_x`, `offset_y`).
    

The system doesn't store static color values. Instead, it samples a deterministic **constellation** of anchor pairs: for each span it records the HSV/luminance delta between an anchor patch and a displaced neighbour, together with the anchor's relative coordinates and offset multipliers. Because every value lives in `[0,1]` space the same descriptor applies regardless of crop, scale, mirroring, or filtering. The collection of these relative gradients plus the hierarchical quadtree descriptors forms the image's unique signature.

In the latest revision the extractor also:

*   Runs a configurable **augmentation sweep** (horizontal/vertical mirroring, Gaussian blur, and three deterministic "random combo" crops/rotations/color jitters derived from the filename) so the database learns how an image behaves under common edits without ever persisting the transformed pixels.
*   Builds a **deterministic quadtree** on top of every image. Each node contributes both its HSV/luminance signature (`hsv_tree_mean`) and how that node diverges from its parent (`hsv_tree_delta`). This gives the search engine a true coarse‑to‑fine "tree dividing" map that can express global context and local anomalies simultaneously.
*   Persists every measurement as a relative row (`value_type` id, span bucket, anchor bucket, offset, value, size). Vector semantics live in hashed descriptor blobs (`value_types.descriptor_hash`/`descriptor_json`), keeping the database agnostic while the JavaScript layer can evolve descriptors freely.
*   Draws **stochastic constellation samples** instead of exhaustively harvesting every neighbour. For each augmentation the extractor picks a pseudo-random subset of anchor cells, offsets, and channels (bounded by relative distance constraints). Every ingest therefore explores a different constellation while descriptors remain comparable through their hashed definitions.

### 2\. Hierarchical Knowledge Graph via MySQL

The "brain" of the system is the `knowledge_nodes` table in MySQL. This table is designed as a self-referencing hierarchy to store learned information about feature utility. This knowledge graph is not static; it is a dynamic structure that is continuously updated and refined by the system's learning processes.

*   **Leaf Nodes (`FEATURE`):** Each row in `knowledge_nodes` points at a single feature vector stored in `feature_vectors`. The node stores the relative vector value observed for that feature (`vector_value`) so it can be re-weighted without touching the original measurement.
    
*   **Group Nodes (`GROUP`):** When the system notices that two feature vectors co-operate well, it links their IDs and records the relative geometry between them (`vector_length`, `vector_angle`, and `vector_value`). This keeps the knowledge base lightweight while still capturing directionality (“vector 42 tends to follow vector 7 at a 0.4 radian turn and +0.12 intensity”).
    
*   **Learning via Stats:** Each node tracks raw `hit_count` and `miss_count`. These counters are updated whenever a feature (or feature pair) proves useful, providing the utility score that guides the search loop.
    
Complementing the graph is the `feature_group_stats` table. It aggregates relative statistics per channel and resolution (average vector length, angle, separation metrics) so discovery sweeps can be summarised without duplicating individual links. The search API can consult these stats or pick alternative channels on the fly.

### 3\. Probabilistic Constellation Tree ("Pattern Tree")

The term *constellation* (also referenced as a *pattern*) captures how relative vectors cooperate over time. Every measured descriptor becomes a branch in a probability tree that grows as the system learns.

*   **Knowledge-driven edges:** The server pulls the highest-confidence neighbours for the current descriptor from `knowledge_nodes`, using hit/miss statistics to assign a confidence score. These branches are returned to the client with metadata (`source=knowledge`, `confidence=<0-1>`), telling the client which hypothesis the server wants to test next.
*   **Exploratory probes:** To keep learning unbiased and privacy-friendly, each session also injects occasional random probes (`source=exploration`/`random`). These rely on the deterministic constellation library but avoid sending enough information to recreate the original image.
*   **Relative-only geometry:** Because anchors, spans, and offsets are stored in `[0,1]`, the same constellation tree works across mirrored, cropped, rescaled, or color-shifted images without leaking absolute pixel data to the server.
*   **Bootstrapping matters:** The first `train.js` sweep over a shuffled dataset seeds this tree with diverse evidence. Subsequent ingests continuously update probabilities so the server can decide whether to request more detail, jump across a pattern group, or abandon a failing branch.

### Patterns vs. Constellations

The codebase historically mixed the terms “pattern” and “constellation.” This release makes the relationship explicit:

- A **pattern** is a reusable relationship between feature vectors that proved discriminative. Patterns persist inside MySQL in the `knowledge_nodes` (positive associations) and `skip_patterns` (anti-patterns) tables. Group nodes store the relative angle, distance, and value offsets between two cooperating vectors.
- A **constellation** is the runtime traversal of those patterns: a sequence of descriptor probes that the trainer or the HTTP API plays back to isolate a single image. Constellation steps are tracked in-process, but every probe is backed by a persisted pattern row.
- The `feature_group_stats` table summarises the collective behaviour of every pattern family (mean distance, cosine, Pearson metrics). During ingestion or correlation discovery we update these aggregates so future searches can choose the most stable descriptors first.
- Newly-added elastic matching reports the **affinity** (directional agreement) and **cohesion** (distance stability) of every pattern, which is why the logs now highlight those two metrics together whenever a constellation step is evaluated.

### 3½. Adaptive Caching & Pruning

To keep the system responsive over time the database tracks lightweight metadata outside the core feature store:

*   **`feature_usage`** increments whenever a vector participates in a search or learning step. The pruning logic removes the least-used vectors first when the database grows beyond the configured budget.
*   **`skip_patterns`** records descriptor hashes that repeatedly fail to discriminate. After a handful of misses the server automatically avoids these “dead ends” unless new evidence reinforces them.
*   **`system_settings`** holds runtime tunables such as `max_db_size_gb`. The ingestion pipeline checks this value after every insert and trims surplus vectors so storage stays within bounds without manual intervention.

### 3\. The Learning Process: Discovery and Refinement

The system learns in two primary ways: through batch analysis for broad discovery and through real-time updates for continuous refinement.

**A) Batch Discovery (Initial Knowledge)**

The `bootstrap` mode of `insert.js` operates "blindly" on the populated feature database to discover foundational correlations:

1.  It picks a random image from the dataset to act as a "query."
    
2.  It selects a random feature from that image and finds all other images in the database that have a similar feature (the "false positives").
    
3.  It then intelligently searches for a _second_ feature from the original image that is most different from the corresponding features in the false positive set. This is the **discriminating feature**.
    
4.  The script then updates the `knowledge_nodes` table, increasing the `hit_count` for the features that successfully discriminated.
    
During that pass it also records the mean Euclidean separation, spread (standard deviation), cosine similarity, and Pearson correlation between the winning feature pair and all of its false positives. Candidates that fail to clear minimum affinity or that require touching too many vectors are skipped outright, keeping the learned relationships tight and efficient. The aggregated metrics that make it through live in `feature_group_stats` and are consulted by the online search loop.

This process, repeated thousands of times, builds a rich knowledge graph of which vectors and vector-group correlations are most useful for telling images apart.

**B) Real-Time Learning (Continuous Refinement)**

The system is designed to learn continuously from new data and user interactions, independently of the batch training process.

*   **Learning on Ingestion:** When a new image is added via `insert.js add`, its features immediately become part of the dataset, enriching the pool of potential discriminators for future learning cycles.
    
*   **Learning on Search:** After a successful search, the `index.js` server reinforces the "winning" query path by increasing the `hit_count` of all the feature nodes that led to the correct match. This makes the most effective search paths even stronger over time.

*   **Correlation-Aware Questions:** For multi-step searches the server now consults `feature_group_stats` first, asking the question with the highest observed separation score (mean distance + spread + 1 − cosine + 1 − Pearson). If no historical stats exist yet, it gracefully falls back to the hit/miss ratios in `knowledge_nodes`.
    

### 4\. Secure, Iterative Search: Requiring Only Needed Vectors

The search process is a dialogue between the client and the server, designed for maximum security and efficiency.

1.  **Probe:** The client computes and sends only a single, low-information "probe" vector from the image it wants to identify.
    
2.  **Filter:** The server uses this probe to find an initial list of potential candidates.
    
3.  **Intelligent Question:** The server consults its `knowledge_nodes` graph to determine the single most effective feature to ask for next—the one with the highest utility score for telling the current candidates apart.
    
4.  **Refined Answer:** The server requests this _one specific vector_ from the client. The client computes and sends it.
    
5.  **Repeat & Learn:** The server uses the new vector to prune its candidate list. This loop continues until only one match remains. Upon success, the server updates the knowledge graph based on the query path (as described in Real-Time Learning).
    

This method ensures the client never sends the full image or even a complete feature set, making it impossible to reconstruct the source image from the data transmitted.

Project Structure
-----------------

The project is divided into several standalone scripts that interact via the central database.

*   `src/setupDatabase.js`: Creates the necessary MySQL database and tables (`images`, `feature_vectors`, `knowledge_nodes`, `feature_group_stats`). Run this first.
    
*   `src/featureExtractor.js`: The "farmer." Reads an image, applies the augmentation sweep, and writes per-channel gradient vectors with relative coordinates (`value_types` + `feature_vectors`). It can also be used as a module to generate probe vectors on demand.
    
*   `src/insert.js`: The "conductor." Adds or removes images, optionally triggers targeted correlation discovery, and exposes a `bootstrap` mode for the initial learning pass over a dataset.
    
*   `src/index.js`: The main application engine. Contains the core search logic, performs real-time learning, and can be run as a standalone CLI tool or as an Express web server. The server also exposes `/images` (add/remove signed images), `/discover` (kick off correlation learning), `/search/*`, and `/settings/max-db-size` for runtime configuration.

*   `src/clientAPI.js`: A simple command-line client that demonstrates how to interact with the Express server's secure API and now prints the correlation metrics that guided each follow-up question.
    
*   `src/evaluate.js`: Shared evaluation helpers (normalising probe specs, running filter passes, building cropping transforms) so that training, self-evaluation, and HTTP search reuse the same matching logic without copy/paste.

*   `src/testCorrelations.js`: Utility script to seed and inspect `feature_group_stats` with synthetic sample data.

*   `src/lib/storageManager.js`: Utility helpers for descriptor hashing, vector usage tracking, skip-pattern bookkeeping, and automatic pruning based on `system_settings`.
    

How to Use
----------

### Step 1: Installation & Setup

1.  Clone the repository.
    
2.  Install dependencies:
    
        npm install
        
    
3.  Create a `.env` file in the root directory and configure your MySQL connection:
    
        DB_HOST=localhost
        DB_USER=your_mysql_user
        DB_PASSWORD=your_mysql_password
        DB_NAME=image_hypercube_db
        
    

### Step 2: Database Setup

Initialize the database schema by running the setup script once.

    node src/setupDatabase.js
    

### Step 3: Populate with Data

Create a folder (e.g., `training_dataset`) and fill it with the images you want the system to learn. Use the insertion tool to ingest each image (it calls the extractor internally and writes rows into `feature_vectors` with relative coordinates and channel IDs from `value_types`).

    # Kick off training
    node src/train.js ./path/to/dataset --discover=15 --bootstrap=75 --reprobe=50

> Tip: Start with a broad, shuffled dataset. Early random ingests populate the constellation/pattern probability tree so the server has high-confidence branches to follow during later searches.

Debugging per-iteration correlations
-----------------------------------

Enable detailed per-cycle logs that list which images correlated for each discovered discriminator during training by setting these environment variables:

- `TRAINING_CORRELATION_DEBUG_LOG=1` to turn on detailed logs.
- `TRAINING_CORRELATION_TOP_LOG_K=5` to control how many top matches to print per cycle.

Example:

    TRAINING_CORRELATION_DEBUG_LOG=1 TRAINING_CORRELATION_TOP_LOG_K=5 node src/train.js ./path/to/dataset --discover=12

This prints, for each selected discriminator, the top correlated images with their scores, affinities, cohesion, and mean distance.

    # Training check evaluation
    node src/train.js <dataset_dir> --evaluate --evaluate-filters=original,cropping --evaluate-runs=3 --evaluate-top=5 prints per-image match tables plus a summary; adjust filters/runs/top as needed.

    # Repeat for every image in your dataset
    node src/insert.js add path/to/training_dataset/image1.jpg --discover=15
    node src/insert.js add path/to/training_dataset/image2.png
    
The extractor automatically generates augmented mirrors/blurred/jittered variants and builds the quadtree hierarchy before persisting the vectors, so one pass per source image is still all that's required. Adding `--discover=<n>` triggers a small correlation sweep focused on the newly inserted data. After each ingestion the storage manager checks `system_settings.max_db_size_gb` and prunes the coldest vectors if the database exceeds the configured footprint.

Every ingest now prints how many constellation vectors each augmentation produced so you can spot skewed samples early.
When you enable `--reprobe`, the trainer now streams per-image hit/miss summaries together with the last probe accuracy so you can monitor how well the freshly inserted vectors anchor the search.
The trainer also performs an automatic self-evaluation during the first few ingests (configurable via `TRAINING_SELF_EVAL_*` env variables). It replays the same elastic matching logic used in evaluation mode and prints the best match, the self-rank, and whether the similarity threshold had to relax, so you get immediate feedback without running `--evaluate`.

Progressive Ingestion (Adaptive, Faster)
----------------------------------------

Training no longer needs a fixed, arbitrary number of vectors per image. A progressive mode (enabled by default) ingests data in multiple short cycles:

- Cycle 1: take a small, random subset of constellation samples per augmentation.
- Cycles 2+: ask the database for the highest‑value descriptors (from `feature_group_stats`) and measure just those on the image.

This reduces lock contention and dramatically cuts per‑image insert volume while focusing on features that improve evaluation.

Environment knobs (set in `.env`):

- `TRAINING_PROGRESSIVE_ENABLED` (default `true`): toggle progressive mode.
- `TRAINING_PROGRESSIVE_CYCLES` (default `3`): number of cycles per image.
- `TRAINING_PROGRESSIVE_RANDOM_PER_AUG` (default `300`): random samples per augmentation in cycle 1.
- `TRAINING_PROGRESSIVE_GUIDED_PER_CYCLE` (default `300`): guided samples per subsequent cycle.
- `STORE_IMAGE_BLOB` (default `false`): if `true`, stores a copy of the image in `image_blobs` for future re‑vectorization as the model evolves.
Augmentation Controls
---------------------

- Use `--augmentations=<list>` (or `--aug=`) to restrict the pool for this run (e.g., `original,gaussian_blur,center_crop_80`).
- Use `--aug-per-pass=<n>` to limit how many augmentations are applied per image in this run (default from `TRAINING_AUGMENTATIONS_PER_IMAGE`, default 3). `original` is always included.
- Optional `--aug-seed=<seed>` varies deterministic sampling between runs while keeping selection stable across files.

Environment variables:

- `TRAINING_AUGMENTATIONS_PER_IMAGE`: default per-image augmentation budget.
- `TRAINING_AUGMENTATION_LIST`: override the global augmentation pool (comma-separated).
- `TRAINING_VERBOSE_AUGMENT_LOGS`: if set to `true`, prints coarse progress inside each augmentation.
- `AUG_PROGRESS_STEPS`: when verbose logs are enabled, how many progress checkpoints to print per augmentation (e.g., `4`).

Note: a deterministic `center_crop_80` augmentation is included to build robustness to partial crops and resolution changes.

Need to prune the dataset later? Run:

    node src/insert.js remove <image_id|original_filename>

### Step 4: Prime Correlations (Optional but Recommended)

To bootstrap the knowledge base, run the insertion tool in `bootstrap` mode. This sweeps through the dataset with the lightweight discovery algorithm.

    node src/insert.js bootstrap 75
    

### Step 5: Search for an Image

You can find a match for a new image in two ways. The system will continue to learn and refine itself as you perform searches.

**A) Client-Server Mode (Recommended)**

1.  **Start the Server:**
    
        node src/index.js server
    
    
2.  **Run the Client:** In a separate terminal, use the client script to find a match for a new image. The client now asks the server for the first constellation vector before measuring anything, so the server stays in charge of the interrogation path.
    
    node src/clientAPI.js path/to/your/image_to_find.jpg

    # Optional: adjust the maximum on-disk footprint (in gigabytes)
    curl -X POST http://localhost:3000/settings/max-db-size -H "Content-Type: application/json" -d '{"value":6}'
        
    Every `/search/start` and `/search/refine` response now embeds the statistical profile that informed the next question. Each `nextQuestion` also reports its `source` (`knowledge`, `exploration`, or `random`) and a `confidence` score derived from the constellation/pattern probability tree. The CLI prints those metrics so you can monitor how separation quality evolves during the dialog.
        

**B) Standalone CLI Mode**

Use the `index.js` script directly to perform a search without starting a server.

    node src/index.js find path/to/your/image_to_find.jpg

The CLI mirrors the server behaviour and will surface any correlation metrics it relied upon for each follow-up vector request. Under the hood it also requests a probe descriptor from the database rather than inventing a deterministic starting point, so CLI searches exercise the same stochastic constellation logic as the network client.

### Raw API Handshake

If you are wiring a custom client, call:

1. `POST /search/start { "requestProbe": true }` → receive `{ status: "REQUEST_PROBE", sessionId, probeSpec }`. The probe includes `source`/`confidence` metadata so a client can track whether the server is pursuing a learned pattern or exploring.
2. Measure that probe on your image and send `POST /search/start { sessionId, probe: { …, value } }`.
3. For subsequent steps continue with `POST /search/refine` as before, passing each requested descriptor and measured value.


Configuration & Tuning
----------------------

This release adds several robustness features to reduce MySQL lock contention during concurrent ingestion and correlation.

Ingestion Consistency & Concurrency
-----------------------------------

• Short, autocommit writes: Image and feature rows are now inserted without a single long-running transaction. This greatly reduces lock duration under high concurrency.

• Lock-light descriptor upsert: `value_types` resolution uses a read-first pattern (`SELECT` → `INSERT IGNORE` → `SELECT`) to avoid hot UPSERT conflicts when many workers reference the same descriptor.

• Completion flag: Images now have `images.ingestion_complete TINYINT(1) DEFAULT 0`. The flag is set to `1` only after all feature rows are persisted. All discovery/evaluation queries filter to completed images only, preventing partial ingests from being read.

• Optional “min age” gating: You can exclude very recent ingests from comparisons to further reduce contention bursts right after writes.

• Session isolation: DB connections attempt to set `READ COMMITTED` to reduce gap-lock waits (best effort).

Schema migration note
---------------------

Run the setup once to add the new column and helper index if you already have a database:

    node src/setupDatabase.js

New/Updated Environment Variables
---------------------------------

Add these (optionally) to your `.env` file:

• TRAINING_MIN_COMPLETED_IMAGE_AGE_MINUTES
  - Description: Minimum age, in minutes, for an image to be eligible in correlations/evaluation queries.
  - Default: `0` (no age gating)

• DB_OPERATION_MAX_RETRIES
  - Description: Max retries for individual insert operations that encounter transient lock timeouts.
  - Default: `4`

• DB_OPERATION_RETRY_BASE_MS
  - Description: Base backoff for per-row retries (jitter added).
  - Default: `40`

• DEFAULT_THREADS
  - Description: Caps concurrent ingest workers used by `train.js`.
  - Default: unset (auto-scales to CPU, with a safe cap)

Deprecated (no longer used by ingestion):

• DB_TRANSACTION_MAX_RETRIES, DB_TRANSACTION_RETRY_BASE_MS
  - Ingestion switched to short autocommit operations with targeted per-row retries. These legacy variables are ignored by the new path.

Operational tips
----------------

• If you still observe lock waits under heavy load, temporarily lower parallelism with `--threads=<n>` on `train.js` or set `DEFAULT_THREADS` in `.env`.

• For multi-process coordination at very large scale, consider a DB-backed job queue that claims work with `SELECT ... FOR UPDATE SKIP LOCKED` (MySQL 8.0+), so idle workers skip locked rows instead of waiting. This project’s ingestion pipeline is already robust without it; add only if you run multiple independent processes.
