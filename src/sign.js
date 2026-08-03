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
const { partitionImageNames, describeSkipped } = require('./lib/imageFiles');
const { createSignStore } = require('./lib/cheetah/signStore');
const { startServer } = require('./lib/cheetah/server');
const {
    reviewCorpus,
    searchImage,
    trainImage,
    trainImageAdaptive,
} = require('./signPipeline');

// collectImages says what it left behind. A corpus that silently drops a file
// is a run whose image count cannot be reproduced from the directory, and the
// benchmark writes that count into scores.csv. The notice goes to stderr
// because benchmark.sh captures the count from stdout.
function collectImages(target, { quiet = false } = {}) {
    const resolved = path.resolve(target);
    const stat = fs.statSync(resolved);
    if (stat.isFile()) return [resolved];
    const { accepted, skipped } = partitionImageNames(fs.readdirSync(resolved));
    if (!quiet && skipped.length > 0) {
        console.warn(`⚠ ${resolved}\n  ${describeSkipped(skipped).split('\n').join('\n  ')}`);
    }
    return accepted.sort().map((name) => path.join(resolved, name));
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

/**
 * An error as one line of a progress log.
 *
 * The batch writers report which item failed and why in the message itself, so
 * the message is the useful part; the stack is not, in a loop that names the
 * image on the same line. Newlines are folded because a multi-line entry breaks
 * the alignment of a column the run is read by.
 */
function describeError(error) {
    const message = (error && error.message) || String(error);
    return message.replace(/\s+/g, ' ').trim();
}

/**
 * One adaptive checkpoint, as it happens.
 *
 * This is the run's only view of the validation the trainer performs on itself:
 * `probeQuality` searches for the image being written, against everything
 * already stored, and the loop decides from these numbers whether to keep
 * going. Printing them live is what makes an "exhausted" run legible — the
 * curve says whether the image was still climbing when the budget ran out or
 * had been flat for two chunks.
 *
 * Gains are `null` at the first checkpoint (nothing to compare against), and
 * both are signed so that positive always means better: accuracy rises, search
 * effort falls.
 */
function reportCheckpoint(checkpoint, ceiling) {
    const gain = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(3)}` : '  n/a');
    const hits = Math.round(checkpoint.hitRate * checkpoint.probes);
    console.log(
        `      · ${String(checkpoint.constellations).padStart(5)}/${ceiling}  ` +
        `hit ${hits}/${checkpoint.probes}  ` +
        `conf ${Math.round(checkpoint.confidentRate * checkpoint.probes)}/${checkpoint.probes}  ` +
        `margin ${checkpoint.margin >= 0 ? '+' : ''}${checkpoint.margin.toFixed(3)}  ` +
        `acc ${checkpoint.accuracy.toFixed(3)} (${gain(checkpoint.accuracyGain)})  ` +
        `effort ${checkpoint.effort.toFixed(3)} (${gain(checkpoint.effortGain)})`
    );
}

/**
 * One rehearsal pass, printed as it happens.
 *
 * Same reasoning as the adaptive checkpoints: the pass *is* validation, and a
 * validation nobody sees until the report is a validation that cannot be
 * interrupted. Only the images that were behind are printed — a pass over eight
 * images that all still answer is one summary line, not eight.
 */
async function runReviewPass(store, tracked, review, label) {
    const started = Date.now();
    const outcome = await reviewCorpus(store, tracked, {
        minHitRate: review.minHitRate,
        topUp: review.topUp,
        ceiling: review.ceiling,
        sample: review.sample,
        patience: review.patience,
        onReview: (result) => {
            if (result.reason === 'findable') return;
            console.log(
                `      ↻ ${result.filename}  hit ${result.hitRate.toFixed(2)} ` +
                `conf ${result.confidentRate.toFixed(2)} ` +
                `margin ${result.margin >= 0 ? '+' : ''}${result.margin.toFixed(3)}  ` +
                (result.added > 0
                    ? `+${result.added} → ${result.signs} constellations`
                    // Why it stopped, not just that it stopped: "the allowance
                    // ran out" and "the allowance was not the problem" call for
                    // different responses from whoever reads the run.
                    : `${result.reason === 'no-gain' ? 'no gain from top-ups' : 'at ceiling'} (${result.signs})`)
            );
        },
    });
    const seconds = (Date.now() - started) / 1000;
    console.log(
        `    ↻ rehearsal ${label}: reviewed ${outcome.reviewed.length}, ` +
        `topped up ${outcome.toppedUp} (+${outcome.added} constellations)  (${seconds.toFixed(1)}s)`
    );
    return { label, seconds, ...outcome };
}

async function commandTrain(store, targets, flags) {
    // `--adaptive` / `--no-adaptive` both override the configured default, so a
    // run can go either way without touching the environment.
    const adaptive = flags.get('no-adaptive') === 'true'
        ? false
        : (flags.get('adaptive') === 'true' || settings.sign.train.adaptive);
    const countWasSpecified = flags.has('constellations');
    // With no count, automatic training begins with one checkpoint-sized chunk
    // and lets validation choose the rest. A supplied count is a nominal target,
    // not an instruction to stop an image that fresh searches still cannot find.
    const count = countWasSpecified
        ? numberFlag(flags, 'constellations', settings.sign.constellationsPerImage)
        : (adaptive ? settings.sign.train.checkEvery : settings.sign.constellationsPerImage);
    // Finite hard cap for an image that keeps improving. `--extend-to 0` is the
    // deliberate way to make the nominal count a hard ceiling again.
    const extendTo = adaptive
        ? numberFlag(flags, 'extend-to', settings.sign.train.extendTo)
        : 0;
    // Rehearsal: keep the images already trained findable as the corpus that
    // competes with them grows. `--rehearse` / `--no-rehearse` override the
    // configured default the same way `--adaptive` does.
    const review = { ...settings.sign.train.review };
    review.enabled = flags.get('no-rehearse') === 'true'
        ? false
        : (flags.get('rehearse') === 'true' || review.enabled);
    review.every = numberFlag(flags, 'review-every', review.every);
    review.sample = numberFlag(flags, 'review-sample', review.sample);
    review.topUp = numberFlag(flags, 'review-top-up', review.topUp);
    review.ceiling = numberFlag(flags, 'review-ceiling', review.ceiling);
    review.patience = numberFlag(flags, 'review-patience', review.patience);
    review.finalPasses = numberFlag(flags, 'review-passes', review.finalPasses);
    const images = targets.flatMap((target) => collectImages(target));
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
    const ceiling = adaptive ? Math.max(1, count, extendTo || 0) : Math.max(1, count);
    if (adaptive && extendTo <= 0 && !flags.has('review-ceiling')) {
        review.ceiling = ceiling;
    }
    // Automatic stabilisation needs a finite proof boundary. Preserve the
    // historical `0` spelling as "use the training ceiling" rather than letting
    // an indistinguishable pair create an endless final review loop.
    if (review.enabled && review.ceiling <= 0) review.ceiling = ceiling;

    // Link inputs to the canonical filename record before doing any writes.
    // `putImage` allocates by design, so skipping this lookup used to create a
    // second graph image every time `train sample_images/` was rerun. Besides
    // wasting work, those duplicate IDs competed with the image they represented.
    const tracked = new Map();
    const linkedByPath = new Map();
    const stored = await store.listImages();
    for (const image of images) {
        const filename = path.basename(image);
        const imageId = await store.findImageIdByFilename(filename);
        const record = imageId === null ? null : (stored.get(imageId) || await store.getImage(imageId));
        if (!record?.complete) continue;
        const entry = {
            imageId,
            filename,
            path: image,
            signs: Number(record.constellations) || 0,
            words: Number(record.words) || 0,
            wordCounts: null,
            reviewedAt: 0,
            linked: true,
            record,
        };
        tracked.set(imageId, entry);
        linkedByPath.set(image, entry);
    }

    console.log(
        adaptive
            ? `Training ${images.length} image(s), validation chooses the constellation count ` +
              `up to ${ceiling}${countWasSpecified ? ` (requested ${count})` : ' (automatic)'}, ` +
              `validating every ${settings.sign.train.checkEvery} with ` +
              `${settings.sign.train.probes} probe(s)`
            : `Training ${images.length} image(s) with ${count} constellations each`
    );
    if (linkedByPath.size > 0) {
        console.log(`  linked ${linkedByPath.size} already-trained image(s); validating instead of duplicating`);
    }
    if (review.enabled) {
        console.log(
            `  rehearsing: every ${review.every || images.length} image(s), ` +
            `${review.sample || 'all'} image(s) per pass, ` +
            `+${review.topUp} constellations below hit rate ${review.minHitRate} ` +
            `up to ${review.ceiling}; final validation requires ` +
            `${Math.max(1, review.finalPasses)} clean fair cycle(s)`
        );
    }

    const startedAll = Date.now();
    const results = [];
    // What rehearsal needs and the per-image results do not carry: where the
    // image is on disk, and its running per-word counts. Keeping the counts here
    // is what lets a top-up republish cumulative edge weights without reading
    // the whole image back — see signPipeline.extendImage.
    const reviews = [];
    // One image that cannot be written must not end the run. A failure leaves
    // the image record *incomplete*, and every reader ignores incomplete
    // records, so the corpus stays consistent with the images that did land —
    // the rest of the directory is still worth ingesting. The names are
    // collected and re-printed at the end, and the process exits non-zero, so a
    // partial run is never mistaken for a clean one.
    const failures = [];
    // Position in the corpus, right-aligned so the column does not wobble at 10
    // and 100. A benchmark over a real dataset is a long silence otherwise:
    // "how far in is this?" should not require counting lines.
    const at = (index) => `[${String(index + 1).padStart(String(images.length).length)}/${images.length}]`;
    for (const [index, image] of images.entries()) {
        const started = Date.now();
        const linked = linkedByPath.get(image) || null;
        // Named before the work, not after: the checkpoint lines belong to this
        // image and arrive while it is still being written.
        if (adaptive && !linked) console.log(`  ▸ ${at(index)} ${path.basename(image)}`);
        let result;
        try {
            result = linked
                ? {
                    imageId: linked.imageId,
                    filename: linked.filename,
                    signs: linked.signs,
                    words: linked.words,
                    edges: linked.words,
                    wordCounts: linked.wordCounts,
                    record: linked.record,
                    reason: 'linked',
                    checkpoints: [],
                    reused: true,
                }
                : (adaptive
                    ? await trainImageAdaptive(store, image, {
                        count,
                        extendTo,
                        // The trainer validates itself between chunks whether anyone is
                        // watching; this is what makes it visible while it runs rather
                        // than only in the report afterwards.
                        onCheckpoint: (checkpoint) => reportCheckpoint(checkpoint, ceiling),
                    })
                    : await trainImage(store, image, { count }));
        } catch (error) {
            const seconds = (Date.now() - started) / 1000;
            const filename = path.basename(image);
            failures.push({ filename, error: describeError(error) });
            console.log(`  ✗ ${at(index)} ${filename}  ${describeError(error)}  (${seconds.toFixed(1)}s)`);
            continue;
        }
        const seconds = (Date.now() - started) / 1000;
        results.push({ ...result, seconds });
        console.log(
            `  ✓ ${at(index)} ${result.filename}  ${result.signs} signs, ${result.words} words, ` +
            `${result.edges} edges  (${seconds.toFixed(1)}s)` +
            (result.reused ? '  [linked; queued for validation]' : (result.reason ? `  [${result.reason}]` : ''))
        );
        const tracker = tracked.get(result.imageId);
        if (tracker) {
            // A linked image may already have been reviewed before its position
            // in the input list. Preserve that generation and any top-up it
            // received rather than replacing it with the stale stored record.
            tracker.path = image;
            tracker.wordCounts = tracker.wordCounts ?? result.wordCounts ?? null;
        } else {
            tracked.set(result.imageId, {
                imageId: result.imageId,
                filename: result.filename,
                path: image,
                signs: result.signs,
                words: result.words,
                wordCounts: result.wordCounts ?? null,
                reviewedAt: 0,
                linked: false,
            });
        }

        // The pass runs *between* images, not after the run, because that is
        // where the damage happens: the corpus this image just joined is the one
        // the earlier images were not trained against.
        if (review.enabled && review.every > 0 && (index + 1) % review.every === 0
            && tracked.size > 1 && index + 1 < images.length) {
            reviews.push(await runReviewPass(store, tracked, review, `after ${at(index)}`));
        }
    }

    // Final validation is made of complete, fair corpus cycles. Resetting only
    // the scheduler generation (not any learned data) means every image — first
    // and last, linked and newly trained — is probed exactly once per cycle.
    // A top-up changes the corpus, invalidating that cycle as a final proof, so
    // the clean streak resets. Finite per-image ceilings guarantee termination:
    // once nothing else can be added, a clean cycle necessarily follows.
    if (review.enabled && tracked.size > 1) {
        for (const entry of tracked.values()) entry.reviewedAt = 0;
        const cleanNeeded = Math.max(1, Math.trunc(review.finalPasses) || 1);
        let cleanCycles = 0;
        let cycle = 0;
        while (cleanCycles < cleanNeeded) {
            cycle += 1;
            let cycleToppedUp = 0;
            let part = 0;
            while ([...tracked.values()].some((entry) => entry.reviewedAt < cycle)) {
                part += 1;
                // Restrict a pass to entries not yet seen in this cycle. Without
                // this view, a batch larger than the remaining tail would sample
                // already-reviewed images again and slowly starve the tail.
                const pending = new Map(
                    [...tracked].filter(([, entry]) => entry.reviewedAt < cycle)
                );
                const outcome = await runReviewPass(
                    store,
                    pending,
                    review,
                    `final cycle ${cycle}.${part}`
                );
                reviews.push(outcome);
                cycleToppedUp += outcome.toppedUp;
            }
            cleanCycles = cycleToppedUp === 0 ? cleanCycles + 1 : 0;
            console.log(
                `    ↻ final cycle ${cycle}: ${cycleToppedUp === 0 ? 'clean' : `${cycleToppedUp} top-up(s)`}; ` +
                `clean streak ${cleanCycles}/${cleanNeeded}`
            );
        }
    }

    if (failures.length > 0) {
        console.log(`\n  ${failures.length} of ${images.length} image(s) failed to train:`);
        for (const failure of failures) console.log(`    ✗ ${failure.filename}  ${failure.error}`);
        // Trained nothing at all: there is no corpus, and every command that
        // would follow is meaningless. That is a failed run, not a partial one.
        if (results.length === 0) throw new Error('every image failed to train');
    }

    // Read off `tracked`, not off `results`: a topped-up image holds more
    // constellations than the trainer originally wrote for it, and reporting the
    // trainer's number would describe a corpus that no longer exists.
    const signs = [...tracked.values()].reduce((sum, entry) => sum + entry.signs, 0);
    if (review.enabled && reviews.length > 0) {
        const added = reviews.reduce((sum, pass) => sum + pass.added, 0);
        const toppedUp = new Set(
            reviews.flatMap((pass) => pass.reviewed.filter((r) => r.added > 0).map((r) => r.filename))
        );
        // Both give-up states, counted apart. An image the budget could not
        // reach and an image the budget did not help are different problems:
        // the first argues for a higher ceiling, the second argues that this
        // corpus cannot separate it and no ceiling will change that.
        const filenamesWhere = (reason) => new Set(
            reviews.flatMap((pass) => pass.reviewed.filter((r) => r.reason === reason).map((r) => r.filename))
        );
        const stuck = filenamesWhere('at-ceiling');
        const noGain = filenamesWhere('no-gain');
        console.log(
            `  rehearsal: ${reviews.length} pass(es), ${toppedUp.size} image(s) topped up ` +
            `(+${added} constellations)` +
            (stuck.size > 0 ? `, ${stuck.size} still unfindable at the ceiling` : '') +
            (noGain.size > 0 ? `, ${noGain.size} unfindable and not improving` : '')
        );
    }
    if (adaptive) {
        // Why each image entered rehearsal. `awaiting-review` is the bootstrap
        // state for the first few images, and `linked` means no duplicate was
        // written; the fair final cycles are their actual completion proof.
        const reasons = new Map();
        for (const result of results) {
            const reason = result.reason ?? 'unknown';
            reasons.set(reason, (reasons.get(reason) || 0) + 1);
        }
        const densities = [...tracked.values()].map((entry) => entry.signs);
        console.log(
            `  final density ${Math.min(...densities)}–${Math.max(...densities)} ` +
            `(mean ${(signs / Math.max(1, tracked.size)).toFixed(0)}, safety ceiling ${ceiling})  ` +
            [...reasons].map(([reason, images_]) => `${reason} ${images_}`).join(', ')
        );
    }
    return {
        // Null is meaningful: no count was specified, so validation selected
        // the per-image densities. `startingConstellations` records the first
        // chunk used to begin that process.
        constellationsPerImage: countWasSpecified || !adaptive ? count : null,
        startingConstellations: count,
        automatic: adaptive && !countWasSpecified,
        adaptive,
        extendTo: adaptive ? extendTo : 0,
        ceiling,
        images: results.length,
        linked: results.filter((result) => result.reused).length,
        // What was asked for, versus what is actually in the corpus. A report
        // that recorded only the images that worked would describe a corpus of
        // 199 as a corpus of 198 with no trace of the difference.
        attempted: images.length,
        failed: failures,
        seconds: (Date.now() - startedAll) / 1000,
        // What adaptive training actually bought: the share of the ceiling it
        // did not need to write. Measured against `ceiling`, not `count`, or an
        // extended run reports a negative saving against a budget it was
        // explicitly allowed to exceed.
        meanConstellations: signs / Math.max(1, tracked.size),
        constellationsSaved: adaptive && linkedByPath.size === 0
            ? 1 - signs / (ceiling * Math.max(1, tracked.size))
            : null,
        // `null` rather than an empty summary when rehearsal was off, so a
        // report cannot be read as "rehearsed, and it found nothing to do".
        rehearsal: review.enabled
            ? {
                passes: reviews.length,
                sample: review.sample,
                every: review.every,
                topUp: review.topUp,
                ceiling: review.ceiling,
                patience: review.patience,
                minHitRate: review.minHitRate,
                requiredCleanCycles: Math.max(1, Math.trunc(review.finalPasses) || 1),
                added: reviews.reduce((sum, pass) => sum + pass.added, 0),
                toppedUp: reviews.reduce((sum, pass) => sum + pass.toppedUp, 0),
                seconds: reviews.reduce((sum, pass) => sum + pass.seconds, 0),
                perPass: reviews.map((pass) => ({
                    label: pass.label,
                    reviewed: pass.reviewed.length,
                    toppedUp: pass.toppedUp,
                    added: pass.added,
                    seconds: pass.seconds,
                    images: pass.reviewed,
                })),
            }
            : null,
        perImage: results.map((result) => ({
            filename: result.filename,
            // The corpus's count, which a top-up may have raised past the one
            // training wrote.
            signs: tracked.get(result.imageId)?.signs ?? result.signs,
            trainedSigns: result.reused ? 0 : result.signs,
            reused: Boolean(result.reused),
            words: tracked.get(result.imageId)?.words ?? result.words,
            edges: result.edges,
            seconds: result.seconds,
            reason: result.reason ?? null,
            checkpoints: result.checkpoints ?? null,
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
    const images = targets.flatMap((target) => collectImages(target));
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
    const at = (index) => `[${String(index + 1).padStart(String(images.length).length)}/${images.length}]`;
    for (const [index, image] of images.entries()) {
        const expected = path.basename(image);
        const started = Date.now();
        let result;
        try {
            result = await searchImage(store, image, {
                maxConstellations,
                // Seeded per filename so a re-run is comparable, but never with the
                // seed training used: the query constellations must be fresh.
                seed: `evaluate:${expected}`,
            });
        } catch (error) {
            // A search that threw is a miss, not an absence: it still gets a row,
            // so the rates below are measured against every image that was asked
            // for. Dropping the row would quietly raise the accuracy of a run
            // that went worse than one where the image was merely not found.
            rows.push({
                expected,
                got: null,
                hit: false,
                rank: null,
                confidence: null,
                mass: null,
                separation: null,
                constellations: null,
                rounds: null,
                seeds: null,
                reason: 'error',
                error: describeError(error),
                seconds: (Date.now() - started) / 1000,
                byFieldObservations: null,
                byFieldDescriptor: null,
                byTripleFeatures: null,
                candidates: [],
            });
            const hitsSoFar = rows.filter((row) => row.hit).length;
            console.log(
                `\n✗ ${at(index)} ${expected} → (error: ${describeError(error)})   ` +
                `(rank-1 so far ${hitsSoFar}/${rows.length}, ${((hitsSoFar / rows.length) * 100).toFixed(1)}%)`
            );
            continue;
        }
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
            error: null,
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
        // The running tally is on the same line as the position: an evaluation
        // over a large corpus is long enough that "is this going well?" should
        // be answerable without waiting for the summary.
        const hits = rows.filter((row) => row.hit).length;
        console.log(
            `\n${rows[rows.length - 1].hit ? '✓' : '✗'} ${at(index)} ${expected} → ` +
            `${top?.filename || '(nothing)'}   ` +
            `(rank-1 so far ${hits}/${rows.length}, ${((hits / rows.length) * 100).toFixed(1)}%)`
        );
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
        // Effort statistics describe the searches that ran. A row that errored
        // measured nothing, and folding its nulls in as zeroes would report a
        // cheaper search than the one that happened; the failures are counted
        // separately, as `errors`.
        errors: count((row) => row.reason === 'error'),
        meanConstellations: mean(rows.map((row) => row.constellations).filter(Number.isFinite)),
        medianConstellations: median(rows.map((row) => row.constellations).filter(Number.isFinite)),
        meanSeeds: mean(rows.map((row) => row.seeds).filter(Number.isFinite)),
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
    if (scores.errors > 0) {
        console.log(`\n${scores.errors} search(es) failed and are counted as misses above:`);
        for (const row of rows.filter((row_) => row_.reason === 'error')) {
            console.log(`  ✗ ${row.expected}  ${row.error}`);
        }
    }

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
            automatic_training: training?.automatic ?? false,
            training_ceiling: training?.ceiling ?? null,
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

    // A run that skipped past failures still failed at them. The commands report
    // what went wrong and keep going; deciding what that means for the exit
    // status is this function's job, so `commandTrain`/`commandEvaluate` stay
    // callable from a test without setting the test runner's own exit code.
    switch (command) {
        case 'train': {
            const training = await withStore(flags, (store) => commandTrain(store, targets, flags));
            if (training.failed.length > 0) process.exitCode = 1;
            break;
        }
        case 'find':
            if (targets.length !== 1) throw new Error('usage: sign.js find <image>');
            await withStore(flags, (store) => commandFind(store, targets[0], flags));
            break;
        case 'evaluate': {
            const report = await withStore(flags, (store) => commandEvaluate(
                store,
                targets.length > 0 ? targets : ['sample_images'],
                flags
            ));
            if (report.scores.errors > 0 || (report.training?.failed.length ?? 0) > 0) {
                process.exitCode = 1;
            }
            break;
        }
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
                '  --constellations <n>  nominal starting target. If omitted, training starts with',
                '                        one validation chunk; it is not a fixed default count.',
                '  --adaptive            use as many constellations as each image needs: train in',
                '                        chunks, validate against the corpus between them, and stop',
                '                        when more constellations stop improving recall. This is the',
                '                        default; checkpoints are printed as they happen.',
                '  --no-adaptive         force the flat count when the default is adaptive',
                '  --extend-to <n>       adaptive only: how far an image that is *still* improving',
                '                        may keep going (default 8192; 0 makes --constellations a',
                '                        hard cap; SIGN_TRAIN_EXTEND_TO sets it too)',
                '  --rehearse            training only: between images, re-probe the ones already',
                '                        trained and give more constellations to any the corpus can',
                '                        no longer find. An image is trained against the corpus that',
                '                        existed at the time; every later image competes for the',
                '                        same words, so without this the earliest images quietly',
                '                        stop being answerable as the corpus grows. On by default.',
                '  --no-rehearse         force it off when the default is on',
                '  --review-every <n>    images trained between two rehearsal passes (0 = only at',
                '                        the end)',
                '  --review-sample <n>   images probed per pass, least recently reviewed first',
                '                        (0 = all of them)',
                '  --review-top-up <n>   constellations one top-up adds',
                '  --review-ceiling <n>  total constellations an image may reach through top-ups',
                '  --review-patience <n> top-ups an image may absorb without improving on its own',
                '                        best accuracy before rehearsal gives up on it (0 = never)',
                '  --review-passes <n>   clean full-corpus cycles required at the end. Every cycle',
                '                        rechecks every image with fresh random probes; a top-up',
                '                        resets the clean streak.',
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

module.exports = { collectImages, parseArgs, withStore, describeError, commandTrain, commandEvaluate };
