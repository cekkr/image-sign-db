#!/usr/bin/env node
// Train and validate one image at a time, re-validating the whole corpus after
// every addition, with a timing breakdown of every phase.
//
// `benchmark.sh` answers "how good is the finished corpus?". This answers the
// question that comes first and that nothing else in the repository asks: *where
// does the time go, and at which corpus size does it start going there?* Those
// are different measurements and only this one can be read while a run is still
// young — a regression that shows up at image 40 is a lost day if the only
// instrument reports at image 100.
//
//   node scripts/step-benchmark.js --images sample_images --limit 12
//   node scripts/step-benchmark.js --limit 8 --constellations 512 --no-adaptive
//
// Two things it deliberately does that the pipeline itself does not:
//
//   - **It re-validates every earlier image after every new one.** The failure
//     this exists to catch is not "image N is badly trained", it is "image N-30
//     stopped being findable when image N arrived". A per-image checkpoint
//     cannot see that, and a final report sees it only once it is already true
//     of the whole corpus.
//   - **It charges every millisecond to a phase.** The store is wrapped so that
//     sampling, posting writes, graph publishing, degree lookups, recall and
//     rerank are counted separately, in calls as well as in seconds. "Training
//     is slow" is not actionable; "94% of it is GRAPH_DEGREE, at 240 round trips
//     per search round" is.

const fs = require('fs');
const path = require('path');
const settings = require('../src/settings');

// -- phase accounting --------------------------------------------------------

const phases = new Map();

function charge(name, seconds, calls = 1) {
    const entry = phases.get(name) || { seconds: 0, calls: 0 };
    entry.seconds += seconds;
    entry.calls += calls;
    phases.set(name, entry);
}

function snapshot() {
    return new Map([...phases].map(([name, entry]) => [name, { ...entry }]));
}

/** What happened between two snapshots — the per-image slice of the totals. */
function since(before) {
    const delta = [];
    for (const [name, entry] of phases) {
        const previous = before.get(name) || { seconds: 0, calls: 0 };
        const seconds = entry.seconds - previous.seconds;
        const calls = entry.calls - previous.calls;
        if (calls > 0 || seconds > 0) delta.push({ name, seconds, calls });
    }
    return delta.sort((left, right) => right.seconds - left.seconds);
}

/**
 * Wrap an async method so its wall time lands in one phase.
 *
 * Measured around the call rather than inside the store, because what is being
 * looked for is round-trip cost: a method that issues 240 pipelined commands and
 * a method that issues one are indistinguishable from inside.
 */
function timeAsync(object, method, name) {
    const original = object[method].bind(object);
    object[method] = async (...args) => {
        const started = process.hrtime.bigint();
        try {
            return await original(...args);
        } finally {
            charge(name, Number(process.hrtime.bigint() - started) / 1e9);
        }
    };
}

function timeSync(object, method, name) {
    const original = object[method];
    object[method] = (...args) => {
        const started = process.hrtime.bigint();
        try {
            return original(...args);
        } finally {
            charge(name, Number(process.hrtime.bigint() - started) / 1e9);
        }
    };
}

function instrument(store) {
    timeAsync(store, 'putSigns', 'store.putSigns');
    timeAsync(store, 'commitGraph', 'store.commitGraph');
    timeAsync(store, 'wordDegrees', 'store.wordDegrees');
    timeAsync(store, 'recallImages', 'store.recallImages');
    timeAsync(store, 'listImages', 'store.listImages');
    timeAsync(store, 'signsForWord', 'store.signsForWord');
    timeAsync(store, 'getSign', 'store.getSign');
    timeAsync(store, 'updateImage', 'store.updateImage');
    return store;
}

// The sampler is a module function, not a store method, and it is the one cost
// that is pure CPU: separating it is what tells "the database is slow" from
// "measuring the image is slow".
//
// It is patched **before the pipeline is required**, and that ordering is the
// whole trick: `signPipeline.js` destructures `sampleSigns` at load time, so a
// wrapper installed afterwards would be measured by nobody.
const sampler = require('../src/lib/sign/sampler');
timeSync(sampler, 'sampleSigns', 'sampleSigns');
timeSync(sampler, 'loadImagePixels', 'loadImagePixels');

const { collectImages } = require('../src/sign');
const { createSignStore } = require('../src/lib/cheetah/signStore');
const { searchImage, trainImage, trainImageAdaptive } = require('../src/signPipeline');

// -- arguments ---------------------------------------------------------------

function parseArgs(argv) {
    const flags = new Map();
    for (let at = 0; at < argv.length; at += 1) {
        const token = argv[at];
        if (!token.startsWith('--')) continue;
        const [name, inline] = token.slice(2).split('=');
        if (inline !== undefined) { flags.set(name, inline); continue; }
        const next = argv[at + 1];
        if (next === undefined || next.startsWith('--')) { flags.set(name, 'true'); continue; }
        flags.set(name, next);
        at += 1;
    }
    return flags;
}

const flags = parseArgs(process.argv.slice(2));
const number = (name, fallback) => (flags.has(name) && Number.isFinite(Number(flags.get(name)))
    ? Number(flags.get(name))
    : fallback);

const IMAGES_DIR = flags.get('images') || 'sample_images';
const LIMIT = number('limit', 12);
const DATABASE = flags.get('db-name') || 'step_bench';
const ADAPTIVE = flags.get('no-adaptive') !== 'true';
const COUNT = number('constellations', settings.sign.train.checkEvery);
const EXTEND_TO = number('extend-to', settings.sign.train.extendTo);
const SEARCH_MAX = number('max', settings.sign.search.maxConstellations);
const RERANK = flags.get('rerank') === 'true';
const OUT = flags.get('out') || null;

function seconds(value) {
    return `${value.toFixed(1)}s`;
}

async function main() {
    const images = collectImages(IMAGES_DIR, { quiet: true }).slice(0, LIMIT);
    if (images.length === 0) throw new Error(`no images under ${IMAGES_DIR}`);

    const store = instrument(await createSignStore({ database: DATABASE }));
    const history = [];
    try {
        console.log(`▸ resetting ${DATABASE}`);
        const resetStarted = Date.now();
        await store.reset();
        console.log(`  reset in ${seconds((Date.now() - resetStarted) / 1000)}`);

        console.log(
            `▸ ${images.length} image(s), ${ADAPTIVE ? 'adaptive' : 'fixed'} training ` +
            `${ADAPTIVE ? `from ${COUNT} up to ${Math.max(COUNT, EXTEND_TO)}` : `at ${COUNT}`}, ` +
            `search ceiling ${SEARCH_MAX}, rerank ${RERANK ? 'on' : 'off'}\n`
        );

        for (const [index, image] of images.entries()) {
            const filename = path.basename(image);
            const before = snapshot();
            const trainStarted = Date.now();

            const result = ADAPTIVE
                ? await trainImageAdaptive(store, image, {
                    count: COUNT,
                    extendTo: EXTEND_TO,
                    onCheckpoint: (checkpoint) => console.log(
                        `      · ${String(checkpoint.constellations).padStart(5)}  ` +
                        `hit ${(checkpoint.hitRate * checkpoint.probes).toFixed(0)}/${checkpoint.probes}  ` +
                        `margin ${checkpoint.margin.toFixed(3)}  acc ${checkpoint.accuracy.toFixed(3)}`
                    ),
                })
                : await trainImage(store, image, { count: COUNT });
            const trainSeconds = (Date.now() - trainStarted) / 1000;
            console.log(
                `  ▸ [${index + 1}/${images.length}] ${filename}  ` +
                `${result.signs} signs, ${result.words} words  (train ${seconds(trainSeconds)}` +
                `${result.reason ? `, ${result.reason}` : ''})`
            );

            // The re-validation pass. Every image trained so far, searched with a
            // fresh draw seeded per pass, so a later pass is a new question rather
            // than the same lucky one.
            const validateStarted = Date.now();
            const rows = [];
            for (const earlier of images.slice(0, index + 1)) {
                const expected = path.basename(earlier);
                const searchStarted = process.hrtime.bigint();
                const found = await searchImage(store, earlier, {
                    maxConstellations: SEARCH_MAX,
                    rerank: RERANK,
                    seed: `step:${index}:${expected}`,
                });
                charge('search', Number(process.hrtime.bigint() - searchStarted) / 1e9);
                const rank = found.candidates.findIndex((c) => c.filename === expected);
                rows.push({
                    expected,
                    hit: found.candidates[0]?.filename === expected,
                    rank: rank === -1 ? null : rank + 1,
                    constellations: found.constellations,
                    reason: found.reason,
                });
            }
            const validateSeconds = (Date.now() - validateStarted) / 1000;
            const hits = rows.filter((row) => row.hit).length;
            const missed = rows.filter((row) => !row.hit).map((row) => row.expected);

            console.log(
                `    ↻ corpus ${index + 1}: rank-1 ${hits}/${rows.length} ` +
                `(${((hits / rows.length) * 100).toFixed(0)}%)  ` +
                `validate ${seconds(validateSeconds)}  ` +
                `mean search ${(validateSeconds / rows.length).toFixed(2)}s` +
                (missed.length > 0 ? `  missed: ${missed.slice(0, 6).join(', ')}${missed.length > 6 ? ` +${missed.length - 6}` : ''}` : '')
            );
            const breakdown = since(before)
                .slice(0, 6)
                .map((entry) => `${entry.name} ${entry.seconds.toFixed(1)}s/${entry.calls}`)
                .join('  ');
            console.log(`      ${breakdown}\n`);

            history.push({
                index: index + 1,
                filename,
                signs: result.signs,
                words: result.words,
                reason: result.reason ?? null,
                trainSeconds,
                validateSeconds,
                rank1: hits,
                of: rows.length,
                rank1Rate: hits / rows.length,
                missed,
                phases: since(before),
                rows,
            });
        }
    } finally {
        await store.close();
    }

    console.log('════ totals ═══════════════════════════════════════════');
    const total = [...phases].sort((left, right) => right[1].seconds - left[1].seconds);
    const wall = history.reduce((sum, step) => sum + step.trainSeconds + step.validateSeconds, 0);
    for (const [name, entry] of total) {
        console.log(
            `  ${name.padEnd(22)} ${entry.seconds.toFixed(1).padStart(9)}s  ` +
            `${String(entry.calls).padStart(8)} calls  ` +
            `${((entry.seconds / Math.max(wall, 1e-9)) * 100).toFixed(1).padStart(5)}% of wall`
        );
    }
    console.log(`  ${'wall'.padEnd(22)} ${wall.toFixed(1).padStart(9)}s`);
    console.log('\n  step  image                     signs  train   validate  rank-1');
    for (const step of history) {
        console.log(
            `  ${String(step.index).padStart(4)}  ${step.filename.padEnd(24).slice(0, 24)}  ` +
            `${String(step.signs).padStart(5)}  ${seconds(step.trainSeconds).padStart(7)}  ` +
            `${seconds(step.validateSeconds).padStart(8)}  ${step.rank1}/${step.of}`
        );
    }

    if (OUT) {
        fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
        fs.writeFileSync(path.resolve(OUT), `${JSON.stringify({
            config: {
                images: IMAGES_DIR,
                limit: LIMIT,
                adaptive: ADAPTIVE,
                count: COUNT,
                extendTo: EXTEND_TO,
                searchMax: SEARCH_MAX,
                rerank: RERANK,
                sign: settings.sign,
            },
            phases: [...phases].map(([name, entry]) => ({ name, ...entry })),
            steps: history,
        }, null, 2)}\n`);
        console.log(`\nwritten to ${OUT}`);
    }
}

main().catch((error) => {
    console.error(`✗ ${error.stack || error.message}`);
    process.exit(1);
});
