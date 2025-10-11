# Image Sign DB
=============

Image Sign DB is an advanced content-based image retrieval (CBIR) system that identifies images by learning and querying their structural "signatures." Unlike traditional systems that compare whole images, this project deconstructs images into a multi-dimensional feature set and uses a machine learning approach to build a knowledge base of the most effective features for recognition.

The core principle is a secure, server-guided search that minimizes data transfer, preventing a client from revealing the full image it's looking for.

The Algorithm Logic
-------------------

The system is built on four key concepts that work together to create an intelligent and efficient recognition engine.

### 1\. Multidimensional Vectorization: The "Image Hypercube"

Instead of treating an image as a flat, 2D grid of pixels, we model it as a 4D data structure, or "hypercube."

*   **Dimensions 1 & 2 (X, Y):** The spatial location within the image.
    
*   **Dimension 3 (Channels):** The color space, primarily using **HSV (Hue, Saturation, Value)**, which is highly robust against lighting, filter, and contrast distortions.
    
*   **Dimension 4 (Scale / Span):** A bundle of relative grids (6×6, 10×10, 14×14, …) and neighbor offsets that describe _how far_ a pattern moves as a percentage of the image instead of locking onto a fixed downsampled resolution.
    

The system doesn't store static color values. Instead, it populates the database with thousands of tiny **"relative vector changes"**—for each grid density it records the HSV/luminance delta between a block and several neighbours, together with the normalized offset that separates them. Because those offsets live in `[0,1]` space they remain comparable even if the source image is cropped, upscaled, mirrored, or re-filtered. The collection of these relative gradients plus the hierarchical quadtree descriptors forms the image's unique signature.

In the latest revision the extractor also:

*   Runs a configurable **augmentation sweep** (horizontal/vertical mirroring, Gaussian blur, and three deterministic "random combo" crops/rotations/color jitters derived from the filename) so the database learns how an image behaves under common edits without ever persisting the transformed pixels.
*   Builds a **deterministic quadtree** on top of every image. Each node contributes both its HSV/luminance signature (`hsv_tree_mean`) and how that node diverges from its parent (`hsv_tree_delta`). This gives the search engine a true coarse‑to‑fine "tree dividing" map that can express global context and local anomalies simultaneously.
*   Persists all of these variants using a predictable naming convention (`vector_type#augmentation`) so downstream tools can request the precise feature they need (e.g. `hsv_rel_gradient_g10_dx1dy0#mirror_horizontal` or `hsv_tree_delta#random_combo_2`).

### 2\. Hierarchical Knowledge Graph via MySQL

The "brain" of the system is the `knowledge_nodes` table in MySQL. This table is designed as a self-referencing hierarchy to store learned information about feature utility. This knowledge graph is not static; it is a dynamic structure that is continuously updated and refined by the system's learning processes.

*   **Leaf Nodes (`FEATURE`):** Each unique feature descriptor (e.g., "the relative HSV gradient on the 10×10 grid using offset Δx=1, Δy=0 at cell 3,4") is a leaf node in the graph.
    
*   **Parent Nodes (`GROUP`):** The training script learns which combinations of leaf nodes are effective at distinguishing images. It can group these features under a parent node. This allows the system to build abstract knowledge, such as "The combination of _this_ texture in the top-left and _that_ color transition in the center is a powerful identifier."
    
*   **Learning via Stats:** Each node has a `hit_count` and `miss_count`. These are updated during the training phase. A "hit" means the feature helped correctly identify an image or rule out a false positive. A "miss" means it didn't. The ratio of hits to misses determines the feature's calculated utility score.
    
Complementing the graph is the new `feature_group_stats` table. It records real-time statistical summaries (mean distance, standard deviation, mean cosine similarity, and mean Pearson correlation) for every feature pair that training discovers to be useful. The search API now prefers those discriminators when they exist, falling back to raw `knowledge_nodes` scores only when no correlation has been learned yet.

### 3\. The Learning Process: Discovery and Refinement

The system learns in two primary ways: through batch analysis for broad discovery and through real-time updates for continuous refinement.

**A) Batch Training (Initial Discovery)**

The `train.js` script works without any human-provided labels. It operates "blindly" on the populated feature database to discover foundational correlations:

1.  It picks a random image from the dataset to act as a "query."
    
2.  It selects a random feature from that image and finds all other images in the database that have a similar feature (the "false positives").
    
3.  It then intelligently searches for a _second_ feature from the original image that is most different from the corresponding features in the false positive set. This is the **discriminating feature**.
    
4.  The script then updates the `knowledge_nodes` table, increasing the `hit_count` for the features that successfully discriminated.
    
During that pass it also records the mean Euclidean separation, spread (standard deviation), cosine similarity, and Pearson correlation between the winning feature pair and all of its false positives. Candidates that fail to clear minimum affinity or that require touching too many vectors are skipped outright, keeping the learned relationships tight and efficient. The aggregated metrics that make it through live in `feature_group_stats` and are consulted by the online search loop.

This process, repeated thousands of times, builds a rich knowledge graph of which vectors and vector-group correlations are most useful for telling images apart.

**B) Real-Time Learning (Continuous Refinement)**

The system is designed to learn continuously from new data and user interactions, independently of the batch training process.

*   **Learning on Ingestion:** When a new image is added via `featureExtractor.js`, its features immediately become part of the dataset, enriching the pool of potential discriminators for future learning cycles.
    
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
    
*   `src/featureExtractor.js`: The "farmer." Reads an image, applies the augmentation sweep, calculates grid gradients plus quadtree features, and populates the database. It can also be used as a module to generate specific vectors (including augmented variants) on demand.
    
*   `src/train.js`: The "chef." Performs batch analysis on the data in the `feature_vectors` table to discover foundational correlations, updates `knowledge_nodes`, and maintains the statistical summaries in `feature_group_stats`.
    
*   `src/index.js`: The main application engine. Contains the core search logic, performs real-time learning, and can be run as a standalone CLI tool or as an Express web server.
    
*   `src/clientAPI.js`: A simple command-line client that demonstrates how to interact with the Express server's secure API and now prints the correlation metrics that guided each follow-up question.
    
*   `src/testCorrelations.js`: Utility script to seed and inspect `feature_group_stats` with synthetic sample data.
    

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

Create a folder (e.g., `training_dataset`) and fill it with the images you want the system to learn. Run the feature extractor for each image.

    # Repeat for every image in your dataset
    node src/featureExtractor.js path/to/training_dataset/image1.jpg
    node src/featureExtractor.js path/to/training_dataset/image2.png
    
The extractor will automatically generate augmented mirrors/blurred variants and build the quadtree hierarchy before persisting the vectors, so one pass per source image is still all that's required.

### Step 4: Train the System (Optional but Recommended)

To bootstrap the knowledge base, run the batch training script. This is especially useful when you first add a large number of images.

    node src/train.js
    

### Step 5: Search for an Image

You can find a match for a new image in two ways. The system will continue to learn and refine itself as you perform searches.

**A) Client-Server Mode (Recommended)**

1.  **Start the Server:**
    
        node src/index.js server
        
    
2.  **Run the Client:** In a separate terminal, use the client script to find a match for a new image.
    
        node src/clientAPI.js path/to/your/image_to_find.jpg
        
    Every `/search/start` and `/search/refine` response now embeds the statistical profile that informed the next question. The CLI prints those metrics so you can monitor how separation quality evolves during the dialog.
    

**B) Standalone CLI Mode**

Use the `index.js` script directly to perform a search without starting a server.

    node src/index.js find path/to/your/image_to_find.jpg
    
The CLI mirrors the server behaviour and will surface any correlation metrics it relied upon for each follow-up vector request.
