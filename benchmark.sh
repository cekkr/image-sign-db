#!/usr/bin/env bash
#
# Benchmark the sign pipeline: train a corpus, re-identify every image from a
# fresh random draw, and record the scores.
#
#   ./benchmark.sh                                   # defaults, sample_images/
#   ./benchmark.sh -c 200,600,1200                   # sweep the training ceiling
#   ./benchmark.sh -c 600 -m 60,120,240              # sweep the search ceiling
#   ./benchmark.sh -i datasets/mine -o benchmarks    # another corpus
#   ./benchmark.sh --no-adaptive                     # fixed density instead
#
# Training is **adaptive** by default: each image gets as many constellations as
# it needs rather than a flat quota. `--constellations` is therefore a ceiling —
# the trainer writes in chunks, re-searches for the image it is writing against
# everything already stored, and stops once more constellations no longer buy
# accuracy or a cheaper search. Those checkpoints stream to the console as they
# happen (`· 512/2048  hit 3/3  margin +0.21  acc … effort …`), so an under-
# trained corpus is visible while the run is going rather than afterwards, and
# `--extend-to` lets an image that is still climbing at the ceiling continue.
#
# Each (training ceiling x search ceiling) pair is one run. A run writes a full
# JSON report under --out and appends one row to benchmarks/scores.csv, so
# results accumulate across sessions and a regression shows up as a diff rather
# than as a number nobody wrote down. Under adaptive training the row records
# both what was allowed (`constellations_per_image`) and what the images took
# (`mean_trained_constellations`); they are the same number only with
# `--no-adaptive`.
#
# Three things this deliberately does *not* do:
#
#   - It never reuses a trained database across densities. Each density gets its
#     own Cheetah database *and* trains it with `--reset`, because a corpus
#     trained at 200 constellations and then topped up to 600 is not the same
#     corpus as one trained at 600 — and a data directory left behind by an
#     earlier benchmark must not leak into this one.
#   - It never evaluates with the seed training used. `src/sign.js evaluate`
#     seeds per filename with an `evaluate:` prefix; a benchmark that replayed
#     the trained constellations would score itself on its own homework.
#   - It never lets the environment decide whether training is adaptive.
#     `--adaptive`/`--no-adaptive` is always passed explicitly, so a run is not
#     silently reinterpreted by whatever `SIGN_TRAIN_ADAPTIVE` happens to say.
#
# It runs one cheetah-server for the whole session rather than letting each
# command spawn its own, so start-up cost does not land inside the timings.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

IMAGES="sample_images"
CONSTELLATIONS="600"
MAX_LIST=""
OUT_DIR="benchmarks"
DATA_DIR=""
KEEP_DATA=0
PORT=4477
LABEL=""
ADAPTIVE=1
EXTEND_TO=""

usage() {
    cat <<'EOF'
usage: ./benchmark.sh [options]

  -i, --images DIR          image directory or file (default: sample_images)
  -c, --constellations LIST comma-separated training ceilings (default: 600)
  -m, --max LIST            comma-separated search ceilings (default: SIGN_SEARCH_MAX_CONSTELLATIONS)
  -o, --out DIR             where reports and scores.csv go (default: benchmarks)
  -l, --label TEXT          prefix for run ids inside the reports
  -a, --adaptive            as many constellations as needed, up to -c (default)
      --no-adaptive         write exactly -c constellations per image instead
  -e, --extend-to N         adaptive only: let an image still improving at -c
                            keep going up to N constellations
      --data-dir DIR        Cheetah data directory (default: a temp dir, removed on exit)
      --keep                keep the Cheetah data directory
      --port N              port for the benchmark's own cheetah-server (default: 4477)
  -h, --help

Training always runs with --reset against a per-density database, so every run
establishes its corpus rather than adding to one; there is nothing to pass.

Every other tunable is read from the environment by src/settings.js, so a sweep
over, say, the stop rule is just:

  SIGN_SEARCH_SEPARATION=1.2 ./benchmark.sh -l loose

and the adaptive loop's own knobs are SIGN_TRAIN_CHECK_EVERY (constellations
between validations), SIGN_TRAIN_PROBES, SIGN_TRAIN_MIN_GAIN,
SIGN_TRAIN_STOP_MIN_HIT_RATE and SIGN_TRAIN_MIN_CORPUS:

  SIGN_TRAIN_CHECK_EVERY=256 ./benchmark.sh -c 2048 -l fine-grained
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        -i|--images)         IMAGES="$2"; shift 2 ;;
        -c|--constellations) CONSTELLATIONS="$2"; shift 2 ;;
        -m|--max)            MAX_LIST="$2"; shift 2 ;;
        -o|--out)            OUT_DIR="$2"; shift 2 ;;
        -l|--label)          LABEL="$2"; shift 2 ;;
        -a|--adaptive)       ADAPTIVE=1; shift ;;
        --no-adaptive)       ADAPTIVE=0; shift ;;
        -e|--extend-to)      EXTEND_TO="$2"; shift 2 ;;
        --data-dir)          DATA_DIR="$2"; shift 2 ;;
        --keep)              KEEP_DATA=1; shift ;;
        --port)              PORT="$2"; shift 2 ;;
        -h|--help)           usage; exit 0 ;;
        *) echo "✗ unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

[ -d "$IMAGES" ] || [ -f "$IMAGES" ] || { echo "✗ no such image path: $IMAGES" >&2; exit 1; }

# The training flags, decided once. `--adaptive`/`--no-adaptive` is always sent
# rather than left to SIGN_TRAIN_ADAPTIVE: a benchmark whose meaning depends on
# an unstated environment variable is not a benchmark.
TRAIN_FLAGS=()
if [ "$ADAPTIVE" -eq 1 ]; then
    TRAIN_FLAGS+=(--adaptive)
    [ -n "$EXTEND_TO" ] && TRAIN_FLAGS+=(--extend-to "$EXTEND_TO")
else
    TRAIN_FLAGS+=(--no-adaptive)
    # Refuse rather than ignore: without the checkpoints there is nothing to
    # decide whether an image is still improving, so --extend-to would do
    # nothing at all and the run would silently answer a different question.
    [ -z "$EXTEND_TO" ] || { echo "✗ --extend-to needs adaptive training; drop --no-adaptive" >&2; exit 1; }
fi

# The search ceiling defaults to whatever settings.js resolves, so an unset
# --max benchmarks the configuration the project actually ships.
if [ -z "$MAX_LIST" ]; then
    MAX_LIST="$(node -e 'process.stdout.write(String(require("./src/settings").sign.search.maxConstellations))')"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$OUT_DIR/$STAMP"
CSV="$OUT_DIR/scores.csv"
mkdir -p "$RUN_DIR"

if [ -z "$DATA_DIR" ]; then
    DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sign-bench.XXXXXX")"
    [ "$KEEP_DATA" -eq 1 ] || TEMP_DATA_DIR="$DATA_DIR"
fi
mkdir -p "$DATA_DIR"

SERVER_PID=""
cleanup() {
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    if [ -n "${TEMP_DATA_DIR:-}" ] && [ -d "$TEMP_DATA_DIR" ]; then
        rm -rf "$TEMP_DATA_DIR"
    fi
}
trap cleanup EXIT INT TERM

# -- server ------------------------------------------------------------------

BINARY="$REPO_ROOT/cheetah-server"
if [ ! -x "$BINARY" ]; then
    echo "▸ building cheetah-server from the submodule"
    [ -f "$REPO_ROOT/cheetah/go.mod" ] || {
        echo "✗ cheetah submodule is not checked out — run: git submodule update --init" >&2
        exit 1
    }
    ( cd "$REPO_ROOT/cheetah" && go build -o "$BINARY" ./src )
fi

echo "▸ starting cheetah-server on 127.0.0.1:$PORT (data: $DATA_DIR)"
CHEETAH_HEADLESS=1 \
CHEETAH_LISTEN_ADDR="127.0.0.1:$PORT" \
CHEETAH_DATA_DIR="$DATA_DIR" \
CHEETAH_GRAPH_TERM_INDEX=0 \
CHEETAH_PAIR_INDEX_BYTES=2 \
"$BINARY" > "$RUN_DIR/cheetah-server.log" 2>&1 &
SERVER_PID=$!

# Poll rather than sleep: the listener is up in well under a second on a warm
# machine and several on a cold one, and a fixed sleep would be wrong on both.
deadline=$((SECONDS + 30))
until node -e 'const s=require("net").connect(+process.argv[2],process.argv[1]);s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))' 127.0.0.1 "$PORT" 2>/dev/null; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "✗ cheetah-server exited during start-up:" >&2
        tail -20 "$RUN_DIR/cheetah-server.log" >&2
        exit 1
    fi
    [ "$SECONDS" -lt "$deadline" ] || { echo "✗ cheetah-server did not accept on port $PORT" >&2; exit 1; }
    sleep 0.5
done

export CHEETAH_HOST=127.0.0.1
export CHEETAH_PORT="$PORT"

# -- runs --------------------------------------------------------------------

REPORTS=()
IFS=',' read -r -a DENSITIES <<< "$CONSTELLATIONS"
IFS=',' read -r -a CEILINGS <<< "$MAX_LIST"

# The training mode belongs in the run id, not only in the report: scores.csv
# accumulates across sessions and two rows named `c600-m240` that were trained
# differently are a comparison waiting to be read wrong. The default mode gets
# no tag, so existing run ids keep their spelling.
MODE_TAG=""
[ "$ADAPTIVE" -eq 1 ] || MODE_TAG="-fixed"
[ -z "$EXTEND_TO" ] || MODE_TAG="-x${EXTEND_TO}"

if [ "$ADAPTIVE" -eq 1 ]; then
    echo "▸ adaptive training: up to ${CONSTELLATIONS} constellations per image${EXTEND_TO:+, extending to $EXTEND_TO while still improving}"
    echo "  validation runs every $(node -e 'process.stdout.write(String(require("./src/settings").sign.train.checkEvery))') constellations and is printed as it happens"
else
    echo "▸ fixed training: exactly ${CONSTELLATIONS} constellations per image"
fi

# How many (density x ceiling) pairs this invocation will do, counted up front so
# the banner can say where in the sweep a run is. Inside a run, src/sign.js
# prints the per-image position of its own.
RUN_TOTAL=$(( ${#DENSITIES[@]} * ${#CEILINGS[@]} ))
RUN_INDEX=0
IMAGE_TOTAL=$(node -e '
    const { collectImages } = require("./src/sign");
    process.stdout.write(String(collectImages(process.argv[1]).length));
' "$IMAGES")
echo "▸ $RUN_TOTAL run(s) over $IMAGE_TOTAL image(s)"

for density in "${DENSITIES[@]}"; do
    database="bench_${STAMP}_c${density}${MODE_TAG}"
    trained=0
    for ceiling in "${CEILINGS[@]}"; do
        RUN_INDEX=$((RUN_INDEX + 1))
        name="${LABEL:+${LABEL}-}c${density}${MODE_TAG}-m${ceiling}"
        report="$RUN_DIR/$name.json"
        echo
        echo "════ [$RUN_INDEX/$RUN_TOTAL] $name ═══════════════════════════════════════════"

        # The first ceiling for a density pays for training; the rest reuse the
        # corpus it built, which is why --skip-train appears only after one
        # successful pass.
        if [ "$trained" -eq 0 ]; then
            # --reset makes the run reproducible even against a data directory
            # that a previous benchmark left behind: the corpus is established
            # here, not added to.
            #
            # Unbuffered through `tee` on purpose: the adaptive checkpoints are
            # the run's live validation, and a benchmark that only showed them
            # once training finished would be no better than reading the report.
            node src/sign.js evaluate "$IMAGES" \
                --db-name "$database" \
                --reset \
                --constellations "$density" \
                "${TRAIN_FLAGS[@]}" \
                --max "$ceiling" \
                --label "$name" \
                --report "$report" | tee "$RUN_DIR/$name.log"
            trained=1
        else
            # No --constellations here on purpose: with nothing trained this
            # run, the report reads the corpus's real density back out of the
            # store rather than believing a flag.
            node src/sign.js evaluate "$IMAGES" \
                --db-name "$database" \
                --skip-train \
                --max "$ceiling" \
                --label "$name" \
                --report "$report" | tee "$RUN_DIR/$name.log"
        fi
        REPORTS+=("$report")
    done
done

# -- scores ------------------------------------------------------------------

# An array, not a space-joined string: --out may contain a space, and word
# splitting would then hand the reporter two nonexistent paths.
node scripts/benchmark-report.js csv "$CSV" "${REPORTS[@]}" > /dev/null
echo
echo "════ benchmark ═══════════════════════════════════════════"
node scripts/benchmark-report.js table "${REPORTS[@]}"
echo
echo "reports:  $RUN_DIR"
echo "scores:   $CSV  (appended, one row per run)"
