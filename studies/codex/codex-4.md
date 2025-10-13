Move all constant settings in the code in the file settings.js with an object with every editable costant setting in the project



Move all constant settings in the code in the file settings.js with an object with every editable costant setting in the project


Centralized all editable configuration into a shared settings module and updated every consumer to read from it instead of hard-coded literals.

Changes

src/settings.js:27 introduces a single settings object that maps environment variables and sensible fallbacks for client, server, search, database, correlation, and training knobs (with helper parsers for numbers/booleans).
src/index.js:17 now sources the server port, value/skip thresholds, and CLI iteration limit from the shared settings.
src/clientAPI.js:6 reads the API base URL and remote iteration cap from the centralized configuration.
src/train.js:23 pulls probe thresholds, CLI defaults, resource sampling cadence, and online correlation runner sizing from the new settings module.
src/insert.js:10 relies on the shared settings for DB schema name, correlation similarity threshold, and bootstrap default iterations.
src/lib/correlationMetrics.js:1 and src/lib/storageManager.js:1 use the shared settings so scoring limits and storage caps stay in sync with the rest of the app.
Verification

node -e "require('./src/settings');" (ensures the consolidated settings module loads without runtime issues)
Next steps

Review/update .env or documentation to reflect the new tunable keys before running the server or training routines.
7 files changed
+112
-23


clientAPI.js
+4
-2

index.js
+8
-6

insert.js
+4
-3

correlationMetrics.js
+5
-3

storageManager.js
+4
-2

settings.js
+65
-0

train.js
+22
-7





Auto context




gpt-5-codex
