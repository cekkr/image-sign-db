#!/usr/bin/env node
// CLI for the sign pipeline.
//
//   node src/sign.js train sample_images/            ingest a directory
//   node src/sign.js find sample_images/IMG_3355.jpg identify one image
//   node src/sign.js evaluate sample_images/         train, then re-identify each
//   node src/sign.js stats                           what is in the database
//
// Every command talks to a running Cheetah server. `--spawn` starts (and
// builds, if needed) the vendored one for the duration of the command, which is
// what the evaluation runs use.

const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { SIGN_LAYOUT_VERSION, WORD_CARDINALITY } = require('./lib/sign/constants');
const { createSignStore } = require('./lib/cheetah/signStore');
const { startServer } = require('./lib/cheetah/server');
const { searchImage, trainImage } = require('./signPipeline');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp', '.gif']);

function collectImages(target) {
    const resolved = path.resolve(target);
    const stat = fs.statSync(resolved);
    if (stat.isFile()) return [resolved];
    return fs.readdirSync(resolved)
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .sort()
        .map((name) => path.join(resolved, name));
}

function parseArgs(argv) {
    const positional = [];
    const flags = new Map();
    for (let at = 0; at < argv.length; at += 1) {
        const token = argv[at];
        if (!token.startsWith('--')) { positional.push(token); continue; }
        const [name, inline] = token.slice(2).split('=');
        if (inline !== undefined) { flags.set(name, inline); continue; }
        const next = argv[at + 1];
        if (next === undefined || next.startsWith('--')) { flags.set(name, 'true'); continue; }
        flags.set(name, next);
        at += 1;
    }
    return { positional, flags };
}

function numberFlag(flags, name, fallback) {
    if (!flags.has(name)) return fallback;
    const value = Number(flags.get(name));
    return Number.isFinite(value) ? value : fallback;
}

/** The Cheetah database a command addresses. `--database` is the older spelling. */
function databaseName(flags) {
    return flags.get('db-name') || flags.get('database') || settings.cheetah.database;
}

/** Open a store, optionally against a server this process owns. */
async function withStore(flags, run) {
    const database = databaseName(flags);
    let server = null;
    if (flags.get('spawn') === 'true') {
        server = await startServer({ dataDir: flags.get('data-dir') || undefined });
        console.log(`▶ cheetah-server on ${server.host}:${server.port} (${server.dataDir})`);
    }
    const store = await createSignStore({
        database,
        host: server ? server.host : undefined,
        port: server ? server.port : undefined,
    });
    try {
        return await run(store);
    } finally {
        await store.close();
        if (server) await server.stop();
    }
}

async function commandTrain(store, targets, flags) {
    const count = numberFlag(flags, 'constellations', settings.sign.constellationsPerImage);
    const images = targets.flatMap(collectImages);
    if (images.length === 0) throw new Error('no images found');

    // Training only. `--reset` on a search would delete the corpus it was about
    // to interrogate, so `find` does not accept it.
    if (flags.get('reset') === 'true') {
        const existing = await store.listImages({ includeIncomplete: true });
        console.log(
            `Resetting ${store.databaseName} ` +
            `(dropping ${existing.size} image record(s) and their words)`
        );
        await store.reset();
    }
    console.log(`Training ${images.length} image(s) with ${count} constellations each`);

    const startedAll = Date.now();
    const results = [];
    for (const image of images) {
        const started = Date.now();
        const result = await trainImage(store, image, { count });
        const seconds = (Date.now() - started) / 1000;
        results.push({ ...result, seconds });
        console.log(
            `  ✓ ${result.filename}  ${result.signs} signs, ${result.words} words, ` +
            `${result.edges} edges  (${seconds.toFixed(1)}s)`
        );
    }
    return {
        constellationsPerImage: count,
        images: results.length,
        seconds: (Date.now() - startedAll) / 1000,
        perImage: results.map((result) => ({
            filename: result.filename,
            signs: result.signs,
            words: result.words,
            edges: result.edges,
            seconds: result.seconds,
        })),
    };
}

function reportCandidates(result) {
    console.log(
        `  ${result.reason} after ${result.constellations} constellations ` +
        `in ${result.rounds} round(s), ${result.seeds} seeds, corpus ${result.corpusSize}`
    );
    const score = (value) => (Number.isFinite(value) ? value.toFixed(4) : '   n/a');
    result.candidates.forEach((candidate, index) => {
        console.log(
            `  ${index === 0 ? '▶' : ' '} ${(candidate.confidence * 100).toFixed(1).padStart(5)}%  ` +
            `mass ${candidate.mass.toFixed(3).padStart(8)}  sources ${String(candidate.sources).padStart(4)}  ` +
            `obs ${score(candidate.fieldScore)}  desc ${score(candidate.descriptorScore)}  ` +
            `tri ${score(candidate.tripleScore)}  ${candidate.filename}`
        );
    });
}

/** The winner under an alternative, lower-is-better ordering of the candidates. */
function bestBy(candidates, key) {
    return [...candidates]
        .filter((candidate) => Number.isFinite(candidate[key]))
        .sort((left, right) => left[key] - right[key])[0];
}

function mean(values) {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function commandFind(store, target, flags) {
    const image = path.resolve(target);
    console.log(`Searching for ${path.basename(image)}`);
    const result = await searchImage(store, image, {
        maxConstellations: numberFlag(flags, 'max', settings.sign.search.maxConstellations),
        rerank: flags.get('no-rerank') !== 'true',
        seed: flags.has('seed') ? flags.get('seed') : null,
    });
    reportCandidates(result);
    return result;
}

/**
 * Train the corpus, then ask it to re-identify every member with a *fresh*
 * random draw. The query constellations are never the trained ones — that is
 * the whole point of the measurement, and a run that reused them would prove
 * nothing.
 */
async function commandEvaluate(store, targets, flags) {
    const images = targets.flatMap(collectImages);
    if (images.length === 0) throw new Error('no images found');
    const startedAt = new Date();
    const maxConstellations = numberFlag(flags, 'max', settings.sign.search.maxConstellations);
    const skipTrain = flags.get('skip-train') === 'true';
    const training = skipTrain ? null : await commandTrain(store, targets, flags);

    // What the corpus actually holds, read back from the store rather than from
    // the flags. On a --skip-train run there is no training result to describe
    // it, and trusting the flag would record whatever `settings.js` happened to
    // default to instead of the density the corpus was really built at.
    const corpus = await store.listImages();
    const corpusRecords = [...corpus.values()];
    const corpusDensity = corpusRecords.length > 0
        ? median(corpusRecords.map((record) => Number(record.constellations) || 0))
        : null;

    console.log(`\nEvaluating ${images.length} image(s)`);
    const rows = [];
    for (const image of images) {
        const expected = path.basename(image);
        const started = Date.now();
        const result = await searchImage(store, image, {
            maxConstellations,
            // Seeded per filename so a re-run is comparable, but never with the
            // seed training used: the query constellations must be fresh.
            seed: `evaluate:${expected}`,
        });
        const seconds = (Date.now() - started) / 1000;

        const top = result.candidates[0] || null;
        const rankIndex = result.candidates.findIndex((candidate) => candidate.filename === expected);
        rows.push({
            expected,
            got: top?.filename ?? null,
            hit: top?.filename === expected,
            // Rank within the candidates the search returned; null means the
            // true image did not surface at all, which is a different failure
            // from ranking it second and is worth telling apart.
            rank: rankIndex === -1 ? null : rankIndex + 1,
            confidence: top?.confidence ?? null,
            mass: top?.mass ?? null,
            separation: result.candidates.length > 1 && result.candidates[1].mass > 0
                ? result.candidates[0].mass / result.candidates[1].mass
                : null,
            constellations: result.constellations,
            rounds: result.rounds,
            seeds: result.seeds,
            reason: result.reason,
            seconds,
            byFieldObservations: bestBy(result.candidates, 'fieldScore')?.filename ?? null,
            byFieldDescriptor: bestBy(result.candidates, 'descriptorScore')?.filename ?? null,
            byTripleFeatures: bestBy(result.candidates, 'tripleScore')?.filename ?? null,
            candidates: result.candidates.map((candidate) => ({
                filename: candidate.filename,
                confidence: candidate.confidence,
                mass: candidate.mass,
                sources: candidate.sources,
                fieldScore: candidate.fieldScore,
                descriptorScore: candidate.descriptorScore,
            })),
        });
        console.log(`\n${rows[rows.length - 1].hit ? '✓' : '✗'} ${expected} → ${top?.filename || '(nothing)'}`);
        reportCandidates(result);
    }

    const count = (predicate) => rows.filter(predicate).length;
    const scores = {
        // The corpus is what the search ranked against; `images` is what was
        // queried. Evaluating 3 images against a corpus of 11 is not the same
        // measurement as evaluating 3 against 3, so both are recorded.
        corpus: corpus.size,
        images: rows.length,
        rank1: count((row) => row.hit),
        rank1Rate: count((row) => row.hit) / rows.length,
        // Recall at the depth the search actually returns (SIGN_SEARCH_RERANK_TOP).
        inCandidates: count((row) => row.rank !== null),
        inCandidatesRate: count((row) => row.rank !== null) / rows.length,
        meanReciprocalRank: mean(rows.map((row) => (row.rank ? 1 / row.rank : 0))),
        rank1ByFieldObservations: count((row) => row.byFieldObservations === row.expected),
        rank1ByFieldDescriptor: count((row) => row.byFieldDescriptor === row.expected),
        rank1ByTripleFeatures: count((row) => row.byTripleFeatures === row.expected),
        meanConstellations: mean(rows.map((row) => row.constellations)),
        medianConstellations: median(rows.map((row) => row.constellations)),
        meanSeeds: mean(rows.map((row) => row.seeds)),
        earlyStops: count((row) => row.reason === 'confident'),
        earlyStopRate: count((row) => row.reason === 'confident') / rows.length,
        meanTopConfidence: mean(rows.map((row) => row.confidence).filter(Number.isFinite)),
        meanSeparation: mean(rows.map((row) => row.separation).filter(Number.isFinite)),
        meanSearchSeconds: mean(rows.map((row) => row.seconds)),
        trainSecondsPerImage: training ? training.seconds / training.images : null,
        meanWordsPerImage: mean(corpusRecords.map((record) => Number(record.words) || 0)),
    };

    const share = (hits) => `${hits}/${rows.length} (${((hits / rows.length) * 100).toFixed(1)}%)`;
    console.log(`\nRank-1 by graph recall:        ${share(scores.rank1)}`);
    console.log(`Rank-1 by field observations: ${share(scores.rank1ByFieldObservations)}`);
    console.log(`Rank-1 by field descriptor:   ${share(scores.rank1ByFieldDescriptor)}`);
    console.log(`Rank-1 by triple features:    ${share(scores.rank1ByTripleFeatures)}`);
    console.log('(the last three only reorder the graph\'s top candidates, so recall@k bounds them)');
    console.log(
        `Corpus ${scores.corpus}   ` +
        `Recall@${settings.sign.search.rerankTop}: ${share(scores.inCandidates)}   ` +
        `MRR ${scores.meanReciprocalRank.toFixed(3)}   ` +
        `median ${scores.medianConstellations} constellations   ` +
        `early stops ${share(scores.earlyStops)}`
    );

    const report = {
        label: flags.get('label') || null,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        images_dir: targets.map((target) => path.resolve(target)),
        config: {
            sign_layout_version: SIGN_LAYOUT_VERSION,
            word_cardinality: WORD_CARDINALITY,
            database: databaseName(flags),
            constellations_per_image: training ? training.constellationsPerImage : corpusDensity,
            trained_this_run: !skipTrain,
            point_count: settings.sign.pointCount,
            point_patch_relative: settings.sign.pointPatchRelative,
            working_max_side: settings.sign.workingMaxSide,
            with_centre_position: settings.sign.withCentrePosition,
            search: { ...settings.sign.search, maxConstellations },
        },
        training,
        search: rows,
        scores,
    };

    const reportPath = flags.get('report');
    if (reportPath) {
        fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
        fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
        console.log(`\nReport written to ${reportPath}`);
    }
    return report;
}

async function commandStats(store) {
    const images = await store.listImages({ includeIncomplete: true });
    if (images.size === 0) {
        console.log('No sign images stored.');
        return images;
    }
    console.log(`${images.size} image(s):`);
    for (const [imageId, record] of images) {
        console.log(
            `  ${imageId.toString(16).padStart(8, '0')}  ${record.complete ? 'complete  ' : 'INCOMPLETE'}  ` +
            `${String(record.constellations).padStart(5)} signs  ${String(record.words).padStart(6)} words  ` +
            `${record.filename}`
        );
    }
    return images;
}

async function main() {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const [command, ...targets] = positional;

    // Refuse rather than ignore: a --reset that was silently dropped on a search
    // reads as "the corpus was kept" when the user asked for the opposite, and
    // one that was honoured would delete what the search is about to query.
    if (flags.get('reset') === 'true' && !['train', 'evaluate'].includes(command)) {
        throw new Error(`--reset applies to training only, not to '${command || '(no command)'}'`);
    }

    switch (command) {
        case 'train':
            await withStore(flags, (store) => commandTrain(store, targets, flags));
            break;
        case 'find':
            if (targets.length !== 1) throw new Error('usage: sign.js find <image>');
            await withStore(flags, (store) => commandFind(store, targets[0], flags));
            break;
        case 'evaluate':
            await withStore(flags, (store) => commandEvaluate(
                store,
                targets.length > 0 ? targets : ['sample_images'],
                flags
            ));
            break;
        case 'stats':
            await withStore(flags, (store) => commandStats(store));
            break;
        default:
            console.log([
                'usage: node src/sign.js <command> [options]',
                '',
                '  train <path...>       ingest images or directories',
                '  find <image>          identify one image against the corpus',
                '  evaluate [path...]    train, then re-identify every image',
                '  stats                 list what is stored',
                '',
                'options:',
                '  --db-name <name>      Cheetah database, for training and for search',
                '                        (default from CHEETAH_DATABASE; --database is an alias)',
                '  --reset               training only: drop the database first, so the run',
                '                        establishes the corpus instead of adding to it',
                '  --constellations <n>  signs per image at training time',
                '  --max <n>             ceiling on constellations measured per search',
                '  --spawn               start the vendored cheetah-server for this command',
                '  --data-dir <path>     data directory for --spawn',
                '  --skip-train          evaluate against an already-trained corpus',
                '  --no-rerank           report graph recall without the field rerank',
                '  --report <file>       write the evaluation as JSON (see benchmark.sh)',
                '  --label <text>        name this run inside the report',
            ].join('\n'));
            process.exitCode = command === undefined ? 0 : 1;
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`✗ ${error.message}`);
        process.exit(1);
    });
}

module.exports = { collectImages, parseArgs, withStore };
