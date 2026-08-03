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


The Sign Pipeline (Cheetah-native)
----------------------------------

Everything above describes the original `delta` pipeline on MySQL. The **sign pipeline** is a second,
independent recognition engine built directly on [Cheetah DB](cheetah): it shares the project's
principles — only relative measurements are stored, the database never sees a reconstructable image —
but it uses a different descriptor, a different index, and Cheetah's property graph instead of SQL
joins. It lives in [`src/lib/sign/`](src/lib/sign), [`src/signPipeline.js`](src/signPipeline.js) and
[`src/sign.js`](src/sign.js), and it does not touch MySQL at all.

### What a sign is

A sign is one **constellation**: an odd number of points (5 by default) chained across the image.

1. A seed pixel is drawn at random. It is the **centre** of the chain.
2. The chain grows outwards in both directions. Each hop draws a circumference length uniformly
   between 0.25 and 1.0 times the mean image side, takes its radius, and then draws a random angle,
   keeping it only if the point lands on a real pixel.
3. Each point's HSV is read, and only the **absolute difference of the three values against the
   neighbour towards the centre** is kept. The centre therefore has `(0, 0, 0)` by definition, and no
   absolute colour is ever stored — a sign survives a global exposure or white-balance shift.
   Hue is compared as a circular distance, so two nearly identical reds are near, not opposite.
4. Each hop's **distance and bearing** are stored in a single reference unit: `1` is the distance
   from the centre of the image to a corner (the half diagonal). That is what makes a sign
   comparable between an image and a rescaled copy of it.
5. Recording where the centre sits in the frame is **optional and off by default**
   (`SIGN_WITH_CENTRE_POSITION`). The half-diagonal unit rescales differently per axis, so pinning
   the centre makes a sign refuse to match the same subject at another aspect ratio.

Training draws many constellations per image; searching draws as few as it can get away with.

### How an image is found

Each triple of consecutive points — two hops, their turn angle, and their six colour deltas — is
quantised into one integer **word** out of a frozen vocabulary of 73 728. Words are the join key:

- Ingestion writes each constellation under `sc:` and one posting per word under `sw:`, then
  publishes the image's vocabulary into Cheetah's property graph as `word --sign--> image` edges.
- A search measures a small batch of constellations, drops the words that are too common or unknown,
  and hands the rest to **`GRAPH_RECALL` as seeds**. Activation spreads from all of them at once and
  the graph answers which images they converge on, saying for each hit *which* seeds reached it.
- The result is reweighted by word rarity and image vocabulary size, folded into a running belief,
  and the search stops as soon as one image is both dominant and clearly separated — or keeps
  measuring until the ceiling. This is the "as much as needed for a good confidence" loop.
- The surviving candidates are scored with a **continuous colour field**: the constellation's three
  delta magnitudes as a smooth Gaussian-RBF function of position, with the Gaussian-process
  confidence penalty from
  [`studies/continuous_colors_function.md`](studies/continuous_colors_function.md). Both signs are
  first aligned on the triple whose word matched, without which the comparison is meaningless —
  each constellation's frame is centred on its own seed pixel.

  **These scores are reported, not applied.** Measured on the 20-image corpus, reordering the
  graph's shortlist by any of them does *worse* than leaving it alone (5/20, 6/20 and 8/20 against
  the graph's 16/20). The reason is structural: after alignment only two of five points say anything
  the vocabulary did not already capture, and they sit where the candidate's field has no
  observation. Notably the crudest of the three — comparing the matched triple's raw continuous
  features, no field involved — scores best, which says the useful signal is the sub-cell precision
  the coarse vocabulary discarded rather than the interpolation itself.

### Running it

    # start (and build, if needed) the vendored server for the duration of the command
    node src/sign.js train sample_images/ --constellations 600 --reset --spawn
    node src/sign.js find sample_images/IMG_3355.jpg --spawn
    node src/sign.js evaluate sample_images/ --spawn

    # any command can name the database; training can also start from empty
    node src/sign.js train sample_images/ --db-name my_corpus --reset
    node src/sign.js find photo.jpg --db-name my_corpus
    node src/sign.js stats --db-name my_corpus

Image input is not limited to the codecs bundled with Sharp. JPEG, PNG, WebP, TIFF, GIF, SVG and
other ordinary formats stay on Sharp's in-process path. HEIC/HEIF/AVIF, JPEG 2000/JPEG XL, common
camera RAW formats, PSD and similar less-common inputs first try Sharp and then fall back, in order,
to ImageMagick (`magick`), macOS `sips`, or FFmpeg. The fallback converts only the first image/page
to lossless PNG and respects `SIGN_WORKING_MAX_SIDE`, so a phone HEIC is not expanded at full camera
resolution in Node. macOS supplies `sips`; on other systems install ImageMagick or FFmpeg with the
codec needed by the dataset. If every decoder fails, the error names each attempted decoder and its
diagnostic instead of reporting only an unsupported extension.

`--db-name` selects the Cheetah database for both training and search (`--database` is an older
alias, and `CHEETAH_DATABASE` sets the default). `--reset` drops that database before ingesting, so
a training run establishes the corpus rather than adding to it; it is **training only** and `find`
refuses it rather than deleting the corpus it was about to query.

`evaluate` trains the corpus and then re-identifies every image from a **fresh** random draw — the
query constellations are never the trained ones — and reports rank-1 accuracy for both the graph
recall and the field rerank. Add `--report <file>` to also write the whole run as JSON.

### Validation-driven training (on by default)

Normal `train` does not assume one correct constellation count. It writes
`SIGN_TRAIN_CHECK_EVERY` constellations at a time and, between chunks, runs fresh searches for the
image against the corpus already stored. When every probe finds the image *confidently* and another
chunk no longer improves accuracy or search effort, the image is done. `SIGN_TRAIN_EXTEND_TO`
(8192 by default) is a finite safety ceiling, not the target.

If `--constellations` is omitted, training starts with one chunk and validation chooses the final
density. If it is supplied, the number is a nominal starting target; an image that remains ambiguous
may continue up to `--extend-to`. Use `--extend-to 0` to turn that nominal number into a hard cap, or
`--no-adaptive` to request a genuinely fixed-density ingest.

Four things make the measurement mean what it says:

- **The probes never replay the training draw.** They redraw from the image with their own seeds,
  exactly as `evaluate` does, so a checkpoint measures recall rather than memorisation.
- **The probe seeds are fixed per image**, so consecutive checkpoints re-ask the *same* three
  questions of a better-trained image. Redrawing them each time makes the difference between two
  checkpoints a mix of "we learned something" and "we asked something else", and the second term is
  large enough on its own to keep a run going indefinitely.
- **A corpus with fewer than `SIGN_TRAIN_MIN_CORPUS` images cannot answer the question at all** —
  there is nothing to be confused with, every probe reports a perfect margin, and a stop rule reading
  those would stop at the first checkpoint. Those bootstrap images receive one chunk and report
  `awaiting-review`; corpus rehearsal revisits them once real competitors exist.
- **The stop rule may only fire from a state of success** (`SIGN_TRAIN_STOP_MIN_HIT_RATE`). Until
  every probe finds the image, a flat checkpoint means it is not retrievable *yet*, which is the
  opposite of "trained enough". Measured on a near-duplicate corpus, an image's margin sits at
  exactly −1 — absent from the candidate list — for its first ~1000 constellations and only then
  climbs (−1.00 at 1024, −0.34 at 1536, positive at 1792). Without this gate the run stopped those
  images at 1024, at the bottom of the curve, and called it convergence.
- **The bar is the hit rate, and deliberately not `conf`.** The confidence count reports whether the
  search's own early stop fired, which requires `SIGN_SEARCH_SEPARATION` over the runner-up — a
  statement about how crowded the corpus is, not about how well this image is trained. Requiring it
  as well made the rule unsatisfiable at any budget on a real corpus: on the 199-image `sample_images/`
  superset, separation *falls* as evidence accumulates (1.24 at 24 constellations, 1.03 at 192, 1.07
  at 288) because by 288 constellations 198 of the 199 images carry mass, so `004.jpg` is ranked first
  by 3 of 3 probes at both 96 and 480 constellations and still reports `conf 0/3`. Every image was
  therefore permanently behind, every rehearsal cycle topped up all of them, and the run could not
  end until all of them reached the ceiling. `conf` is still measured and printed — it is a useful
  reading of the corpus — but nothing gates on it.

Each new image ends with `converged` (the stop rule fired), `exhausted` (it was still improving when
it hit the safety ceiling), or `awaiting-review` (there were not enough competitors yet). A filename
already present in the database ends as `linked`: no duplicate image ID is written, and the existing
record enters the same rehearsal cycle as newly trained images.

**Every checkpoint is printed as it happens**, so the validation is readable while the run is going
rather than only in the JSON report afterwards:

    ▸ [6/6] 003__sample-3.jpg
        ·    32/128  hit 0/3  conf 0/3  margin -0.198  acc -0.198 (  n/a)  effort 1.000 (  n/a)
        ·    64/128  hit 3/3  conf 2/3  margin +0.295  acc 1.295 (+1.493)  effort 0.250 (+0.750)
        ·    96/128  hit 3/3  conf 3/3  margin +0.520  acc 1.520 (+0.224)  effort 0.250 (+0.000)
      ✓ [6/6] 003__sample-3.jpg  128 signs, 345 words, 345 edges  (1.2s)  [exhausted]

`hit` is how many probes ranked the image first, `conf` is how many also reached the search engine's
own early confidence stop, and `margin` is how far ahead of the runner-up it was. Rank-1 only at the
probe ceiling is not considered trained enough. `acc` is hit rate plus margin and `effort` the share
of a probe's ceiling a search had to spend. Both
parenthesised gains are signed so that **positive always means better** — accuracy rises, effort
falls — and both are measured against the best checkpoint so far, not the previous one. The first
checkpoint has nothing to compare against and reads `n/a`. `--extend-to <n>` (or
`SIGN_TRAIN_EXTEND_TO`) lets an image still climbing at the ceiling continue up to `n`.

#### What it measured on `sample_images/`, which was not what it was built to find

The loop was written to cut training time by stopping early. On this corpus it almost never stops,
and the checkpoint curves say that is the correct answer rather than a broken rule: **2048
constellations is at or below the point where these images become reliably findable, not above it.**
Probing every 256 against a 28-image corpus:

| Image | 256–1024 | 1280 | 1536 | 1792 |
| --- | --- | --- | --- | --- |
| `020.jpg` | never in the candidate list | margin −0.11 | **first perfect hit rate** | margin +0.14 |
| `022.jpg` | never in the candidate list | margin −0.16 | margin −0.09 | 1 probe of 3 hits |
| `021.jpg` | never in the candidate list | — | — | **still never in the candidate list** |

So the useful output here is not a saving, it is a **diagnosis**: `exhausted` means "this image was
still getting better when the budget ran out", and an image like `021.jpg` is telling you it is not
retrievable at any density you have tried. That is what `SIGN_TRAIN_EXTEND_TO` is for — it lets an
image that is still climbing keep going past the nominal count, up to the shipped 8192 hard cap.
Set it to `0` for a deliberately bounded experiment.

The cost of the loop is honest too: with nothing converging, the probes are pure overhead — three
searches per checkpoint, at `SIGN_TRAIN_PROBE_MAX` constellations each. `--no-adaptive` turns the
whole thing off and writes the flat count.

### Rehearsal: keeping every image findable (on by default)

Adaptive training answers "has *this* image been trained enough?" against the corpus that exists at
the moment it is asked. That is the wrong tense for a corpus that is still being built. An image
trained when five images were stored was measured against four competitors; by the time the corpus
holds fifty, forty-nine images are competing for the same words, and the first ones can stop being
answerable without a single byte of their own having changed. Nothing about them degraded — the
competition arrived. A one-pass trainer never looks back, so this shows up only at evaluation time,
as the oldest images failing.

Normal training is therefore a cycle instead of a sweep:

    node src/sign.js train datasets/mine

At startup it links every input filename already present in the database to its canonical image ID.
Those images are validated and, if needed, extended; they are not ingested again under duplicate
graph nodes. Every `--review-every` images (4 by default), it re-probes the tracked corpus least-
reviewed-first, and any image the probes cannot find confidently gets `--review-top-up` more
constellations appended to it.

After the last image, the scheduler resets its review counters and runs complete fair cycles. Each
cycle checks every image exactly once, including the first images against the final corpus. Every
review generation uses a fresh deterministic-random draw. A top-up changes the corpus and resets the
clean streak; training finishes only after `--review-passes` consecutive full cycles make no changes
(2 by default). The finite `--review-ceiling` guarantees termination and `--review-patience` bounds
how long it takes. The passes print as they happen:

```text
  ✓ [ 8/20] 069__sample-6.jpg  1200 signs, 5147 words, 5147 edges  (16.8s)
      ↻ 012__sample-5.jpg  hit 0.33 margin -0.184  +512 → 1712 constellations
    ↻ rehearsal after [ 8/20]: reviewed 8, topped up 1 (+512 constellations)
```

Four things it is careful about, each of which it would otherwise get wrong:

- **A top-up appends.** The image is reopened (`SignStore.reopenImage`), the new signs are written at
  the ordinal after its last one, and the graph is republished from the image's **cumulative** word
  counts. Publishing the chunk's own counts would *lower* the edge weight of every word it
  re-observed, because a weight is `min(1, tf / TF_SATURATION)` over the whole image. Counts a
  previous session did not leave in memory are rebuilt from the stored constellations.
- **The probe generation changes on every review.** Adaptive checkpoints reuse questions to compare
  gains within one ingest; rehearsal is certification, so repeating the same lucky draw forever
  would be a false guarantee.
- **Passes are bounded and fair.** `--review-sample` caps one pass, while least-reviewed-first
  scheduling and full final cycles guarantee eventual equal coverage instead of sampling with
  replacement.
- **`--review-ceiling` is what stops it, and `--review-patience` is what stops it *in time*.** Some
  images are genuinely indistinguishable from a near-duplicate, and no amount of constellations
  fixes that; without a cap the cycle would spend most of its budget on exactly those. The ceiling
  alone bounds that at `(ceiling - density) / top-up` top-ups **per image**, which on a 199-image
  corpus at the shipped defaults is nine 512-constellation top-ups for every image a probe misses —
  hours of writing to buy nothing. Patience stops as soon as the top-ups stop paying: an image that
  has absorbed `--review-patience` of them without improving on its own best accuracy reports `no
  gain from top-ups` and is left alone. The two give-up states are counted separately in the summary,
  because `at ceiling` argues for a bigger budget and `no gain` argues that the budget was never the
  problem.

`--no-rehearse` remains available for controlled fixed-density experiments. It deliberately gives up
the guarantee that early images are revalidated after later competitors arrive.

#### What it measured, and the assumption it broke

The mechanism does exactly what it says: over a random 20-image subset trained flat at 600
constellations, six passes topped up 17 of the 20 images by 300 each (+8 400 in total), and the
per-pass count fell from 7 of 8 to 3 of 8 as the corpus caught up. The **accuracy went down**.

…**and then it turned into the best result this corpus has produced**, once the thing it broke was
put back. Four runs, one 20-image subset, `--max 240`, back to back:

| Run | Density | Length slope | Rank-1 | Recall@k | MRR | Train s/image |
| --- | --- | --- | --- | --- | --- | --- |
| flat 600 | uniform | 0 | 15/20 (75%) | 100% | 0.867 | 5.4 |
| flat 1020 | uniform | 0 | 14/20 (70%) | 100% | 0.838 | 10.5 |
| flat 600 | uniform | 0.5 | 12/20 (60%) | 95% | 0.754 | 6.3 |
| rehearsed | 600–1500 | 0 | 14/20 (70%) | 90% | 0.783 | 11.7 |
| **rehearsed** | 600–1500 | **0.5** | **19/20 (95%)** | **100%** | **0.975** | 12.9 |

**Each ingredient alone is a regression and the pair is the best result this corpus has produced.**
Rehearsal at slope 0 costs 5 points of rank-1; the slope on a uniform corpus costs 15; together they
gain 20. That is an interaction, not two independent knobs, and the reason is the same sentence read
in both directions:

- **Rehearsal makes density uneven, and the ranking was not density-invariant.** `lengthSlope = 0`
  means no correction for how much an image published, so a topped-up image simply accumulates more
  mass; `TF_SATURATION = 3` also pins more of a denser image's edges at weight 1.0. On a uniform
  corpus neither matters and slope 0 is the right, measured answer — which is exactly why it was the
  default, and exactly why it stopped being right the moment something spent constellations
  selectively.
- **Length normalisation on a uniform corpus is a pure over-correction** — 80% → 60% at slope 0.5 in
  the earlier sweep, because it divides again for something the raw mass already accounts for. It
  only pays when the vocabulary sizes it is correcting for are genuinely *unequal*.

So the pair is the feature: rehearsal creates the inequality, the slope prices it correctly, and
together they beat both flat controls **and** the previous best on this corpus (85%, at twice the
density and twice the search ceiling). Do not enable one without the other.

This interaction is why the normal defaults now enable rehearsal and pair it with
`SIGN_SEARCH_LENGTH_SLOPE=0.5`; fixed-density benchmark runs should explicitly use
`--no-rehearse` and can restore slope `0`.

One separate warning the flat controls make plain: uniform 1020 scored **worse** than uniform 600 at
`--max 240`, while the same subset scores 85% at 1200 constellations with `--max 480`. **Training
density and search ceiling have to be raised together** — a denser corpus publishes more words per
image, and a search not allowed to measure more of them only sees more overlap.

### Five points or seven

`SIGN_POINT_COUNT` is the one sampling knob that changes cost at every stage at once: a chain of `n`
points is `n − 1` hops and **`n − 2` triples**, and a triple is what becomes a word, a posting, a
graph edge and a recall seed. Seven points is therefore 5/3 of five points' storage and measurement
for the same number of constellations, which makes "7 vs 5 at the same `--constellations`" the wrong
comparison — it compares two different budgets.

Measured over a random 20-image subset of `sample_images/`, fixed training, `--max 480`, three runs
back to back on one machine:

| Points | Constellations | Words/image | Rank-1 | MRR | Separation | Train s/image | Search s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | 1200 | 4 833 | **17/20 (85%)** | 0.908 | 1.375 | 14.8 | 2.55 |
| 5 | 1200 | 3 092 | 16/20 (80%) | 0.885 | 1.268 | 6.5 | 1.05 |
| 5 | 2000 | 4 831 | **17/20 (85%)** | 0.925 | 1.270 | 14.5 | 2.59 |

The third row is the honest comparison: `5 × 2000 = 7 × 1200` triples, so it holds the *budget* fixed
instead of the constellation count. At equal budget the two are the same answer — same rank-1, same
recall@k (100% for all three), MRR marginally better at five points, leader separation marginally
better at seven, everything inside the noise of a corpus where one image is 5 percentage points. What
is **not** noise is the first two rows against each other: at the same constellation count, seven
points costs **2.3× the training time and 2.4× the search time** for one more image.

So seven points is not a better feature; it is a bigger measurement per constellation, and buying the
same measurement with five points costs the same and works as well.

#### Why that is a defect and not a law of nature

A seven-point chain really does carry more *relative* references than a five-point one, so it ought
to discriminate better and not merely sample more. It does not, because **the chain is measured as a
chain and retrieved as a bag of triples.**

The structure is in the record — `sc:` stores the whole chain and a `sw:` posting even carries the
constellation ordinal it came from — but it never reaches the ranking. Ingestion publishes one
`word --sign--> image` graph edge per distinct word, with no ordinal on the graph side. The search
flattens every triple of every constellation in a round into one bag of words, seeds the rarest of
them, and the fold sums `activation × idf` per seed independently. **Nothing anywhere asks whether
several triples of the *same* measured constellation landed on the same image.** So `n − 2` triples
are `n − 2` independent bag items, and a longer chain contributes exactly what drawing more short
constellations contributes — which is what the table above measured.

Two structural facts compound it: consecutive triples **share a hop**, so their six delta levels
overlap by two, and individual hop lengths are deliberately excluded from a word. The extra triples
of a longer chain are therefore *correlated* evidence, not independent evidence — all the more reason
that they only pay if they are scored jointly.

`SIGN_SEARCH_CHAIN_BONUS` scores them jointly. The fold groups each recall's seeds by the
constellation that asked them and scales every group by `1 + bonus × (agreeing triples − 1)`, so a
seven-point chain putting several mutually agreeing triples behind one image outweighs the same
triples arriving from unrelated constellations — a coincidence that does not scale that way. At `0`
it is arithmetically the previous sum (a word asked by two signs splits its activation, so nothing
double counts).

**Counting *every* agreeing triple makes it worse, and that is the interesting part.** Measured at
1200 constellations, `--max 480`, with early stopping switched off on both sides so each search
measures the same amount:

| Fold | Rank-1 | MRR | Separation |
| --- | --- | --- | --- |
| bag of words (bonus 0) | **18/20 (90%)** | **0.950** | 1.39 |
| every agreeing triple (bonus 1) | 15/20 (75%) | 0.846 | 1.59 |
| non-adjacent triples only (bonus 1) | 15/20 (75%) | 0.858 | 1.54 |

The bonus makes the search **more confident and less correct** — separation up, accuracy down — and
the first explanation was not enough. The shared hop is real: triple *i* and triple *i+1* are built
from edges *(i, i+1)* and *(i+1, i+2)*, so two of their six colour-delta levels are the same
measurement counted twice, and agreement is now counted over a maximal set of pairwise **non-adjacent**
triples for that reason (a 7-point sign can contribute 3 — indices 0, 2, 4 — where a 5-point sign
contributes 2). But removing the redundancy **changed nothing**: still 15/20.

So the honest reading is stronger than "redundant evidence". **The triples of one constellation are
not independent evidence at all, adjacent or not**, because a constellation samples one
*neighbourhood* of the image and near-duplicates share neighbourhoods. The image that agrees with
several triples of a chain is exactly the near-duplicate that the corpus confuses it with, so any
fold that rewards within-chain agreement concentrates evidence on the wrong candidate. The
bag-of-words fold with idf is robust here precisely because it refuses to let one region of one
constellation speak louder than the rest.

`SIGN_SEARCH_CHAIN_BONUS` therefore ships at `0`, with the mechanism kept because the *structural*
observation stands: the chain really is discarded, and something should use it. What the measurement
rules out is doing so on the query side alone. The untried direction is the symmetric one — the
`sw:` posting already carries the candidate's own constellation ordinal, so recall could require that
a candidate's matching postings come from **one of its own constellations** too, rather than only
checking that the query's did.

Two further warnings for anyone raising it. It **widens the leader/runner-up ratio**, so
`SIGN_SEARCH_SEPARATION` has to be raised with it — left at 1.35, a bonus of 1 stopped the median
search after 24 constellations instead of 480 and scored 65%. And in the same sweep, simply
**disabling early stopping** was worth more than any fold change: 17/20 with the shipped stop rule
against 18/20 without it, on identical corpora.

### Benchmarking

`./benchmark.sh` trains, validates, and records the scores. Each *(training ceiling × search
ceiling)* pair is one run; a run writes a full JSON report under `benchmarks/<timestamp>/` and
appends one row to `benchmarks/scores.csv`, so results accumulate and a regression shows up as a
diff rather than as a number nobody wrote down.

    ./benchmark.sh                                # defaults, over sample_images/
    ./benchmark.sh -c 200,600,1200                # sweep the training ceiling
    ./benchmark.sh -c 600 -m 60,120,240           # sweep the search ceiling
    ./benchmark.sh -i datasets/mine -l nightly    # another corpus, labelled
    ./benchmark.sh --no-adaptive                  # flat density instead
    ./benchmark.sh -c 2048 -e 4096                # let still-improving images continue
    ./benchmark.sh -c 1200 -r                     # rehearse: keep the early images findable

    SIGN_SEARCH_SEPARATION=1.2 ./benchmark.sh -l loose   # any SIGN_* knob sweeps this way

Training is adaptive in both the CLI and benchmark, but the benchmark makes `-c` a controlled hard
ceiling by explicitly passing `--extend-to 0` unless `-e` was supplied. It always spells
`--adaptive`/`--no-adaptive` and `--rehearse`/`--no-rehearse`, so a benchmark is never silently
reinterpreted by environment defaults. The mode also lands in the run id (`-fixed`, `-x<n>`,
`-rehearsed`) and CSV because two rows named `c600-m240` that were trained differently are easy to
compare incorrectly.

Progress is counted at both levels, because a sweep over a real dataset is otherwise a long silence:
the banner says which run of how many is starting and over how many images (`▸ 2 run(s) over 6
image(s)`, `════ [1/2] …`), and `src/sign.js` prefixes every trained and every evaluated image with
its position (`▸ [3/6] 002__sample-1.jpg`). Each evaluation line also carries the running rank-1
tally, so "is this going well?" is answerable before the summary.

It builds `cheetah-server` if it is missing and runs one instance for the whole session, in a
temporary data directory it removes on exit (`--keep` to keep it). Each training ceiling gets its own
Cheetah database **and** is trained with `--reset` — a corpus trained at 200 constellations and then
topped up to 600 is not the same corpus as one trained at 600, and a data directory an earlier
benchmark left behind must not leak into this one. Additional search ceilings for that density reuse
the trained corpus instead of retraining.

Recorded per run: rank-1 and its rate, recall at the returned depth, mean reciprocal rank, the rank-1
each field rule would have given, median and mean constellations measured, seeds spent, early-stop
rate, mean leader confidence and separation, search seconds, and training seconds and vocabulary size
per image, plus — since adaptive training makes the density a ceiling — whether training was adaptive,
the mean constellations the images actually took, and the share of the ceiling left unwritten. The
summary table at the end compares the runs of that invocation side by side; `train/img` is what was
allowed and `wrote/img` what was used, and they differ only under adaptive training.

### Sign configuration

All of these are read by [`src/settings.js`](src/settings.js) into `settings.sign`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIGN_CONSTELLATIONS_PER_IMAGE` | `3600` | Fixed-density fallback used by `--no-adaptive`. Normal automatic training starts with one `SIGN_TRAIN_CHECK_EVERY` chunk when no count is supplied. |
| `SIGN_POINT_COUNT` | `7` | Points per constellation. Must be odd. A chain of `n` points yields `n − 2` triples, so the cost of every stage scales with it — see [Five points or seven](#five-points-or-seven). |
| `SIGN_POINT_PATCH_REL` | `0.004` | Side of the square averaged per point, as a fraction of the shorter side. `0` reads exactly one pixel. |
| `SIGN_WORKING_MAX_SIDE` | `1024` | Longest side the sampler decodes to. |
| `SIGN_WITH_CENTRE_POSITION` | `false` | Record where the constellation centre sits in the frame. |
| `SIGN_TRAIN_ADAPTIVE` | `true` | Train in chunks and let live validation choose each image's density. `--no-adaptive` requests the fixed fallback. |
| `SIGN_TRAIN_CHECK_EVERY` | `512` | Constellations between two self-probes. |
| `SIGN_TRAIN_PROBES` | `3` | Searches per checkpoint/review. Checkpoint seeds stay fixed within one ingest; rehearsal changes generation on every review. |
| `SIGN_TRAIN_MIN_GAIN` | `0.01` | A checkpoint must beat the best so far by this much, in accuracy **or** in search effort, or the run stops. |
| `SIGN_TRAIN_STOP_MIN_HIT_RATE` | `1` | The stop rule only applies once this share of probes ranks the image first. Below it, a flat checkpoint means "not findable yet", not "trained enough". Deliberately not also gated on the confidence stop — see [Adaptive training](#adaptive-training-validation-chooses-the-density). |
| `SIGN_TRAIN_MIN_CORPUS` | `4` | Below this many stored images there is nothing to be confused with, so one bootstrap chunk is written and rehearsal decides later. |
| `SIGN_TRAIN_PROBE_MAX` | `96` | Ceiling on one probe search. Probes also run with the reranker off. |
| `SIGN_TRAIN_EXTEND_TO` | `8192` | Finite automatic safety ceiling. `0` makes the nominal count a hard cap. `--extend-to <n>` (`benchmark.sh -e <n>`) overrides it per run. |
| `SIGN_TRAIN_REVIEW` | `true` | Re-probe linked and newly trained images while the corpus grows, and top up any that are not found confidently. `--no-rehearse` opts out. See [Rehearsal](#rehearsal-keeping-every-image-findable-on-by-default). |
| `SIGN_TRAIN_REVIEW_EVERY` | `4` | Images trained between two rehearsal passes. `0` rehearses only after the last image. |
| `SIGN_TRAIN_REVIEW_SAMPLE` | `8` | Images probed per pass, least recently reviewed first. `0` reviews all of them, which is quadratic in corpus size. |
| `SIGN_TRAIN_REVIEW_MIN_HIT_RATE` | `1` | Below this rank-1 rate an image is topped up. |
| `SIGN_TRAIN_REVIEW_TOP_UP` | `512` | Constellations one top-up adds. One chunk, then the image is measured again on a later pass. |
| `SIGN_TRAIN_REVIEW_CEILING` | `8192` | Total constellations an image may reach through top-ups. Some images are genuinely indistinguishable from a near-duplicate and no amount of evidence fixes that. |
| `SIGN_TRAIN_REVIEW_PATIENCE` | `2` | Top-ups an image may absorb without improving on its own best accuracy before rehearsal gives up on it (`no gain from top-ups`). The ceiling alone bounds spending at `(ceiling - density) / top-up` per image — on a 199-image corpus, nine 512-constellation top-ups for every image any probe misses. `0` restores ceiling-only termination. |
| `SIGN_TRAIN_REVIEW_FINAL_PASSES` | `2` | Consecutive clean full-corpus cycles required at the end. A top-up resets the streak. |
| `SIGN_SEARCH_BATCH` | `12` | Constellations measured per search round. |
| `SIGN_SEARCH_MIN_CONSTELLATIONS` | `24` | Never stop before this many have been measured. |
| `SIGN_SEARCH_MAX_CONSTELLATIONS` | `720` | Ceiling on one search. |
| `SIGN_SEARCH_STOPWORD_RATIO` | `0.6` | A word carried by more than this share of the corpus is not worth a seed. |
| `SIGN_SEARCH_SEEDS_PER_ROUND` | `96` | Recall seeds per round, rarest first. |
| `SIGN_SEARCH_LENGTH_SLOPE` | `0.5` | Pivoted correction for how many words an image published. This is the measured companion to default selective rehearsal (19/20 versus 14/20 at slope 0). Uniform fixed-density experiments can set `0`. |
| `SIGN_SEARCH_CHAIN_BONUS` | `0` | How much a constellation that agrees with itself outweighs the same triples arriving separately: each group of seeds from one measured sign is scaled by `1 + bonus × (agreeing triples − 1)`. `0` is the historical bag-of-words fold. **Raising it widens the leader/runner-up ratio, so `SIGN_SEARCH_SEPARATION` must be raised with it** — left at 1.35, a bonus of 1 stopped the median search after 24 constellations instead of 480. See [Five points or seven](#five-points-or-seven). |
| `SIGN_SEARCH_CONFIDENCE_MULTIPLE` | `2` | How far above an even split (`1/corpus`) the leader must be to stop. A multiple, not a share — a share cannot survive a change of corpus size. |
| `SIGN_SEARCH_SEPARATION` | `1.35` | How far ahead of the runner-up the leader must be. The criterion that actually carries the signal. |
| `SIGN_SEARCH_RERANK_TOP` | `5` | Candidates passed to the field rerank. |
| `SIGN_SEARCH_RERANK_SIGNS` | `12` | Measured signs used by the rerank. |

The quantisation tables that decide which word a measurement falls into are **not** environment
variables. They are frozen in [`src/lib/sign/constants.js`](src/lib/sign/constants.js) behind
`SIGN_LAYOUT_VERSION`, because an env var that repartitions the vocabulary would silently invalidate
every stored graph edge; `cfg:sign_layout_version` makes a mismatch fail loudly instead.

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

Cheetah DB (migration in progress — see `ROADMAP.md`). These configure the
client, storage interface, and development server helper under
`src/lib/cheetah/`. Setting `STORAGE_BACKEND=cheetah` now routes exhaustive
ingestion and the random first progressive cycle to Cheetah. Search,
evaluation, knowledge-guided cycles, correlation discovery, and image deletion
are not ported yet. Storage-budget pruning is implemented for feature rows.

• STORAGE_BACKEND
  - Description: Which storage engine the pipeline talks to, `mysql` or `cheetah`.
  - Default: `mysql` (the only backend implemented end-to-end; `cheetah` currently
    supports ingestion only)

• CHEETAH_HOST / CHEETAH_PORT
  - Description: Address of the Cheetah TCP listener.
  - Default: `127.0.0.1` / `4455`

• CHEETAH_DATABASE
  - Description: Logical database the connection selects with `DATABASE <name>`.
  - Default: `image_sign_db`

• CHEETAH_DATA_DIR
  - Description: Server data directory. Also read by the Go server itself.
  - Default: `cheetah_data`

• CHEETAH_POOL_SIZE
  - Description: Connections in each client pool. Cheetah training is currently
    forced to one worker because descriptor-token allocation is process-local.
  - Default: `4`

• CHEETAH_CONNECT_TIMEOUT_MS / CHEETAH_COMMAND_TIMEOUT_MS / CHEETAH_MAX_IN_FLIGHT
  - Description: Connect timeout, per-command timeout, and how many commands may be
    pipelined on one socket before callers are queued.
  - Defaults: `5000` / `30000` / `64`

• CHEETAH_BINARY_PROTOCOL
  - Description: Use Cheetah's byte-wise framed TCP protocol. The command helpers are
    unchanged; the binder negotiates the command/argument dictionaries and transcodes
    their canonical lines at the socket boundary. Disable only while connecting to a
    pre-binary server during a staged upgrade.
  - Default: `true`

• CHEETAH_PAIR_INDEX_BYTES
  - Description: Pair-trie stride. Only adopted when a database directory is *created* —
    `pairs/format.dat` wins on every later open.
  - Default: `2`

• CHEETAH_GRAPH_TERM_INDEX
  - Description: Cheetah's lexical term index. Off here on purpose: hex node ids that
    share a word cross-match in `GRAPH_RECALL`, and the index costs a write on every
    node upsert. Also read by the Go server itself.
  - Default: `false`

Cheetah checks `cfg:max_db_size_gb` after each committed ingest and prunes at
most 5,000 of the coldest complete-image feature rows per pass, together with
their usage records. The comparison uses the sum of
`PAIR_SUMMARY.total_payload_bytes` over Image Sign DB's namespaces. That value
does not include Cheetah's trie, table, or filesystem overhead, so the setting
is a deterministic payload-retention budget—not a physical disk quota.
Incomplete ingests are never pruned. Graph-aware pinning will be added when the
property graph lands; until then, no Cheetah graph references exist to protect.

The Phase 2 real-data gate ingested 50 images on a non-default port and wrote
15,000 feature rows. The exact prefixes used by candidate lookup contained
1 row at p50, 2 at p95, 3 at p99, and 5 at maximum (zero above the 500-row
target), validating client-side offset filtering for the measured random
ingestion corpus.

Deprecated (no longer used by ingestion):

• DB_TRANSACTION_MAX_RETRIES, DB_TRANSACTION_RETRY_BASE_MS
  - Ingestion switched to short autocommit operations with targeted per-row retries. These legacy variables are ignored by the new path.

Operational tips
----------------

• If you still observe lock waits under heavy load, temporarily lower parallelism with `--threads=<n>` on `train.js` or set `DEFAULT_THREADS` in `.env`.

• For multi-process coordination at very large scale, consider a DB-backed job queue that claims work with `SELECT ... FOR UPDATE SKIP LOCKED` (MySQL 8.0+), so idle workers skip locked rows instead of waiting. This project’s ingestion pipeline is already robust without it; add only if you run multiple independent processes.
