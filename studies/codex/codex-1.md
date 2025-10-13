The constellation logic: Follow more the concept of "constellation logic": you create random vectors from random distance between pixel (and pixel size, that it shouldn't be by more than 50% larger of the minimum image side length, that has as value the average of it's circles radius component values). The constellation concept is based on the fact that you shouldn't follow a particular flow while training and inference the sign of an image: just go randomly and find the path that gives more rapidly the most accurate correlation with an image. So the client can send random vectors and vectors-correlations, then the server says in basis of its experience what other constellations explorer to achieve the most accurate correlations in basis of its database image signs saved. This change of logic remove the "deterministic" approach from the "client side" and moves it on the server-side experience. Remember: to find the accuracies list have to be followed the "constellation accuracy tree paths".



The constellation logic:
Follow more the concept of "constellation logic": you create random vectors from random distance between pixel (and pixel size, that it shouldn't be by more than 50% larger of the minimum image side length, that has as value the average of it's circles radius component values). The constellation concept is based on the fact that you shouldn't follow a particular flow while training and inference the sign of an image: just go randomly and find the path that gives more rapidly the most accurate correlation with an image. So the client can send random vectors and vectors-correlations, then the server says in basis of its experience what other constellations explorer to achieve the most accurate correlations in basis of its database image signs saved. This change of logic remove the "deterministic" approach from the "client side" and moves it on the server-side experience. Remember: to find the accuracies list have to be followed the "constellation accuracy tree paths".


Built a dedicated constellation helper for randomized probe specs and cumulative accuracy tracking so every request can report its path (src/lib/constellation.js:1).
Expanded feature extraction to emit symmetric neighbour offsets and radius-based magnitudes that satisfy the ≤1.5 cell-length constraint, giving the random probes matching data to search (src/lib/constants.js:3, src/lib/vectorGenerators.js:31).
Switched default probe selection to the constellation sampler and wired the accuracy trail through training and the CLI client so reprobes and remote searches now expose constellation scores (src/lib/vectorSpecs.js:5, src/train.js:109, src/clientAPI.js:24).
Reworked the server session flow to persist constellation paths, use learned feature_group_stats to propose the next random question, and return the path with every response (src/index.js:61, src/index.js:200, src/index.js:289).
Updated the sample correlation seeding to honour the new offset budget (src/testCorrelations.js:7).
Testing: node -e "require('./src/index.js')" failed because express is missing locally; lighter module imports succeed.
Next steps:

Install/add express and re-run a full server search to verify the new flow.
Re-ingest the dataset so negative-offset constellations are persisted and searchable.




Auto context




gpt-5-codex
