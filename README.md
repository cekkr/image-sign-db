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

`--db-name` selects the Cheetah database for both training and search (`--database` is an older
alias, and `CHEETAH_DATABASE` sets the default). `--reset` drops that database before ingesting, so
a training run establishes the corpus rather than adding to it; it is **training only** and `find`
refuses it rather than deleting the corpus it was about to query.

`evaluate` trains the corpus and then re-identifies every image from a **fresh** random draw — the
query constellations are never the trained ones — and reports rank-1 accuracy for both the graph
recall and the field rerank. Add `--report <file>` to also write the whole run as JSON.

### Adaptive training (`--adaptive`, off by default)

With `--adaptive`, `--constellations` becomes a ceiling rather than a quota: the trainer writes
`SIGN_TRAIN_CHECK_EVERY` constellations at a time and, between chunks, runs three fresh searches for
the image it is writing against the corpus already stored. When a checkpoint no longer beats the best
one so far — in accuracy or in how much a search had to measure — the remaining chunks would be paid
for nothing, and the run stops.

**It is off by default because it was measured, not because it is unfinished.** It only pays when
images converge before the ceiling; on `sample_images/` they do not. Paired over 35 images at the
same corpus position it wrote the identical 2048 constellations and cost **21.1 s against 13.1 s per
image (+62%)** — precisely the three checkpoints × three probes × ~0.9 s it spends measuring. Turn it
on for a corpus whose images separate early, where that same measurement is what lets a flat image
stop at 512 instead of 2048.

Three things make the measurement mean what it says:

- **The probes never replay the training draw.** They redraw from the image with their own seeds,
  exactly as `evaluate` does, so a checkpoint measures recall rather than memorisation.
- **The probe seeds are fixed per image**, so consecutive checkpoints re-ask the *same* three
  questions of a better-trained image. Redrawing them each time makes the difference between two
  checkpoints a mix of "we learned something" and "we asked something else", and the second term is
  large enough on its own to keep a run going indefinitely.
- **A corpus with fewer than `SIGN_TRAIN_MIN_CORPUS` images cannot answer the question at all** —
  there is nothing to be confused with, every probe reports a perfect margin, and a stop rule reading
  those would stop at the first checkpoint. Below that threshold the ceiling is trained in full and
  the run reports `corpus-too-small`.
- **The stop rule may only fire from a state of success** (`SIGN_TRAIN_STOP_MIN_HIT_RATE`). Until
  every probe finds the image, a flat checkpoint means it is not retrievable *yet*, which is the
  opposite of "trained enough". Measured on a near-duplicate corpus, an image's margin sits at
  exactly −1 — absent from the candidate list — for its first ~1000 constellations and only then
  climbs (−1.00 at 1024, −0.34 at 1536, positive at 1792). Without this gate the run stopped those
  images at 1024, at the bottom of the curve, and called it convergence.

Each image ends with one of three reasons: `converged` (the stop rule fired), `exhausted` (it was
still improving when it hit the ceiling), or `corpus-too-small`.

**Every checkpoint is printed as it happens**, so the validation is readable while the run is going
rather than only in the JSON report afterwards:

    ▸ 003__sample-3.jpg
        ·    32/128  hit 0/3  margin -0.198  acc -0.198 (  n/a)  effort 1.000 (  n/a)
        ·    64/128  hit 3/3  margin +0.295  acc 1.295 (+1.493)  effort 0.250 (+0.750)
        ·    96/128  hit 3/3  margin +0.520  acc 1.520 (+0.224)  effort 0.250 (+0.000)
      ✓ 003__sample-3.jpg  128 signs, 345 words, 345 edges  (1.2s)  [exhausted]

`hit` is how many of the probes ranked the image first and `margin` is how far ahead of the runner-up
it was; `acc` is their sum and `effort` the share of a probe's ceiling a search had to spend. Both
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
image that is still climbing keep going past the nominal count, up to a hard cap. It is **off by
default** because it spends training time to buy recall, which is a decision to take deliberately.

The cost of the loop is honest too: with nothing converging, the probes are pure overhead — three
searches per checkpoint, at `SIGN_TRAIN_PROBE_MAX` constellations each. `--no-adaptive` turns the
whole thing off and writes the flat count.

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

    SIGN_SEARCH_SEPARATION=1.2 ./benchmark.sh -l loose   # any SIGN_* knob sweeps this way

**Training is adaptive here by default**, unlike the CLI: `-c` is a ceiling, each image gets as many
constellations as it needs, and the checkpoints stream to the console so an under-trained corpus is
visible while the sweep runs. `--adaptive`/`--no-adaptive` is always passed to `src/sign.js`
explicitly, so a run is never silently reinterpreted by whatever `SIGN_TRAIN_ADAPTIVE` says in the
environment; the mode also lands in the run id (`-fixed`, `-x<n>`) and in the CSV, because two rows
named `c600-m240` that were trained differently are a comparison waiting to be read wrong.

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
| `SIGN_CONSTELLATIONS_PER_IMAGE` | `2048` | Signs drawn per image at training time. A **ceiling** when adaptive training is on. |
| `SIGN_POINT_COUNT` | `5` | Points per constellation. Must be odd. |
| `SIGN_POINT_PATCH_REL` | `0.004` | Side of the square averaged per point, as a fraction of the shorter side. `0` reads exactly one pixel. |
| `SIGN_WORKING_MAX_SIDE` | `1024` | Longest side the sampler decodes to. |
| `SIGN_WITH_CENTRE_POSITION` | `false` | Record where the constellation centre sits in the frame. |
| `SIGN_TRAIN_ADAPTIVE` | `false` | Train in chunks and stop when more constellations stop improving recall. Off because on `sample_images/` it costs +62% and saves nothing — see below. `--adaptive` / `--no-adaptive` override it per run. |
| `SIGN_TRAIN_CHECK_EVERY` | `512` | Constellations between two self-probes. |
| `SIGN_TRAIN_PROBES` | `3` | Searches per checkpoint. Their seeds are fixed per image, so consecutive checkpoints re-ask the same questions. |
| `SIGN_TRAIN_MIN_GAIN` | `0.01` | A checkpoint must beat the best so far by this much, in accuracy **or** in search effort, or the run stops. |
| `SIGN_TRAIN_STOP_MIN_HIT_RATE` | `1` | The stop rule only applies once this share of the probes finds the image. Below it, a flat checkpoint means "not findable yet", not "trained enough". |
| `SIGN_TRAIN_MIN_CORPUS` | `4` | Below this many stored images there is nothing to be confused with, so the ceiling is trained in full. |
| `SIGN_TRAIN_PROBE_MAX` | `96` | Ceiling on one probe search. Probes also run with the reranker off. |
| `SIGN_TRAIN_EXTEND_TO` | `0` (off) | How far an image still improving at `SIGN_CONSTELLATIONS_PER_IMAGE` may keep training. Buys recall with training time. `--extend-to <n>` (`benchmark.sh -e <n>`) overrides it per run. |
| `SIGN_SEARCH_BATCH` | `12` | Constellations measured per search round. |
| `SIGN_SEARCH_MIN_CONSTELLATIONS` | `24` | Never stop before this many have been measured. |
| `SIGN_SEARCH_MAX_CONSTELLATIONS` | `240` | Ceiling on one search. |
| `SIGN_SEARCH_STOPWORD_RATIO` | `0.6` | A word carried by more than this share of the corpus is not worth a seed. |
| `SIGN_SEARCH_SEEDS_PER_ROUND` | `96` | Recall seeds per round, rarest first. |
| `SIGN_SEARCH_LENGTH_SLOPE` | `0` | Pivoted correction for how many words an image published. `0` ignores it, `1` is fully proportional. Measured: correcting made accuracy monotonically worse. |
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
