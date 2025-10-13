Implemented dataset evaluation mode with scoring and cropping support.

src/train.js:72 CLI parsing now handles --evaluate, --evaluate-runs, --evaluate-top, and --evaluate-filters, wiring defaults for evaluation runs.
src/train.js:626 Added evaluation helpers: filter resolution, a seeded cropping transform, per-run scoring via scoreCandidateFeature, and a final summary emitted from evaluateDataset.
src/train.js:868 New evaluation loop walks the dataset, applies the selected filters multiple times per image, reports top matches with affinity/spread, and captures aggregate accuracy stats.
src/lib/vectorGenerators.js:134 generateSpecificVector accepts an optional imageTransform, allowing evaluation filters such as cropping to preprocess each probe before augmentation.
Usage: node src/train.js <dataset_dir> --evaluate --evaluate-filters=original,cropping --evaluate-runs=3 --evaluate-top=5 prints per-image match tables plus a summary; adjust filters/runs/top as needed.

Tests not run (no automated suite provided). Suggested next steps:

Run the above --evaluate command against a trained dataset to validate outputs.
Review affinity summaries to decide if additional filters or tuning are needed.