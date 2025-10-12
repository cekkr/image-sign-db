I need a particular advancement. Read the README.md (and studies/codex histories) to have a reference point of the project. When I make the first train.js, it makes the same amount of features extraction from every image (and this makes no sense, seen that the "constellation" concept requires a random extraction of vectors, and then, after the response of the "server" (and mysql knowledge), knowing what other vectors extract to following the tree-paths. And same is for training (where lacks of scoring value belong the process, making me blind).
So a vector: could have a random "pixel size", and a random "a to b" with relative floating position values, and angle. Al that is useful to compensate statistical imprecision. A "vector group" even works in the same way: the angle and length is relative, so it could work even when inferencing a mirrored image, too for colors filters and cropping.
Update the README.md with latest information for helping you and users. A random vectorization is useful with the same image but altered during training/insert, to find effectively what's important, etc. I recommend you a general revision of the project and its working (database composition, queries, algorithms, etc). Remember the concept: this is a multi-dimensional confrontation: from pixel "size" to channel, and various interpolations, associative and statistical. And more information and logs in console


Key Updates

Added stochastic constellation sampling so each augmentation captures a randomised subset of anchors/offsets and channels instead of exhaustively walking the grid (src/lib/vectorGenerators.js:8-124), with ingestion now logging augmentation-level vector counts (src/featureExtractor.js:141-148).
Reworked search/session flow to let the server hand out the initial probe, track session phases, and match candidates by descriptor geometry rather than absolute grid cells; CLI search now follows the same probe handshake (src/index.js:19-612, src/lib/knowledge.js:171-187).
Updated the remote client to request the first probe before measuring, keeping the server in control of constellation paths (src/clientAPI.js:20-109).
Training reprobes now draw probe specs directly from the database, avoid duplicates, and emit per-image hit/miss logs with final probe accuracy to help diagnose learning quality (src/train.js:83-246).
Documented the stochastic sampling behaviour, richer trainer output, and the new two-step /search/start handshake for anyone scripting against the API (README.md:31,162-211).
Next Steps

Re-ingest or re-train a small dataset (node src/train.js …) to populate the DB with the new stochastic vectors and review the per-image probe logs.
Smoke-test the updated handshake (node src/index.js server + node src/clientAPI.js …) to confirm existing tooling integrates with the request/measure flow.