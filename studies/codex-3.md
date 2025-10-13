"feature_group_stats" remaing empty even after 150 images over 800 in train.js process. I need a more "on the run" calculation of correlations, so it's not needed to complete the entire training with all 800 images. Then, the process it's pretty slow: implement a threading system nodejs side evaluating in realtime how many resources (CPU, RAM) are available to not create too much processing pressure. This could make the process faster, especially with intensive initial training datasets. Then, remember to create correlation and tests (with score results) while training, to evaluate the effective progress of the training



"feature_group_stats" remaing empty even after 150 images over 800 in train.js process. I need a more "on the run" calculation of correlations, so it's not needed to complete the entire training with all 800 images. Then, the process it's pretty slow: implement a threading system nodejs side evaluating in realtime how many resources (CPU, RAM) are available to not create too much processing pressure. This could make the process faster, especially with intensive initial training datasets. Then, remember to create correlation and tests (with score results) while training, to evaluate the effective progress of the training


Key Updates

Fixed correlation sampling to use real candidate ID lists and propagate discriminator scores so feature_group_stats now fills as soon as matches appear (src/lib/knowledge.js:213, src/lib/knowledge.js:271).
Replaced the sequential trainer with an adaptive worker-thread pool that scales with current CPU/memory load, plus a --threads override if you want to cap it (src/train.js:55, src/train.js:214).
Added an online correlation runner that queues small discovery batches during ingestion and streams score/affinity statistics so you can watch learning progress without waiting for all 800 images (src/train.js:93, src/train.js:538).
Created a dedicated ingestion worker that encapsulates feature extraction so the main thread can orchestrate concurrency safely (src/workers/ingestWorker.js:1).
Notes

The training CLI now defaults to --discover=3; set --discover=0 if you need to disable online correlations.
Worker threads open their own MySQL connections; keep an eye on server limits and use --threads if you need to throttle.
Syntax checks completed via node --check src/train.js, node --check src/workers/ingestWorker.js, and node --check src/lib/knowledge.js.
Next Steps

Run node src/train.js <dataset_dir> --threads=<cap> on a subset to confirm throughput and watch the streamed correlation stats.
Inspect feature_group_stats in MySQL after a few batches to verify rows are appearing.
Optionally trigger --reprobe to compare retrieval scores before and after the new pipeline.
3 files changed
+450
-45


knowledge.js
+26
-34

train.js
+365
-11

ingestWorker.js
+59
-0





Auto context




gpt-5-codex
