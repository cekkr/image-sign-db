// The sign pipeline against a live cheetah-server.
//
// Skipped unless CHEETAH_INTEGRATION=1 — it builds the submodule binary. Run:
//
//   npm run test:integration
//
// The pure tests prove the algorithm is self-consistent. This one proves the
// parts that only exist against a real server: that the trie postings and the
// graph edges written at ingestion are the ones a search reads back, and that a
// search seeded with fresh constellations — never the trained ones — identifies
// the image they came from.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const sharp = require('sharp');

const ENABLED = process.env.CHEETAH_INTEGRATION === '1';

const settings = require('../src/settings');
const { startServer } = require('../src/lib/cheetah/server');
const { SignStore } = require('../src/lib/cheetah/signStore');
const keys = require('../src/lib/cheetah/keys');
const { scanAll } = require('../src/lib/cheetah/kv');
const {
    extendImage,
    reviewCorpus,
    searchImage,
    storedWordCounts,
    trainImage,
    trainImageAdaptive,
} = require('../src/signPipeline');
const { mulberry32 } = require('../src/lib/sign/rng');
const { commandTrain, collectImages } = require('../src/sign');

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/**
 * Deterministic fixtures with structure at the scale the sampler works at.
 *
 * Two constraints shape these, and both were learned by getting them wrong:
 *
 *   - Flat noise is useless. Constellation hops span roughly 5-20% of the
 *     frame, so two white-noise images are statistically identical at that
 *     distance and nothing could separate them.
 *   - Varying *parameters* of one generator is not enough either. Three
 *     sinusoid fields differing only in frequency and phase produce nearly the
 *     same distribution of colour deltas at hop range, which is exactly what the
 *     vocabulary quantises — so they are near-duplicates as far as a sign is
 *     concerned, however different they look side by side.
 *
 * Each style below therefore has its own spatial character *and* its own palette.
 */
const STYLES = {
    rings: (u, v, random) => {
        const radius = Math.hypot(u - 0.5, v - 0.5) * 14 + random() * 0.2;
        const band = Math.sin(radius) * 0.5 + 0.5;
        return [band, 0.15 + band * 0.2, 0.9 - band * 0.5];
    },
    stripes: (u, v, random) => {
        const phase = Math.sin((u * 3 + v) * 11) * 0.5 + 0.5;
        return [0.05 + phase * 0.15, 0.85 - phase * 0.6, 0.2 + phase * 0.7 + random() * 0.05];
    },
    blobs: (u, v, random) => {
        const blob =
            Math.sin(u * 7.3 + Math.cos(v * 5.1) * 2.2) *
            Math.cos(v * 6.7 + Math.sin(u * 4.3) * 1.8);
        const level = blob * 0.5 + 0.5;
        return [0.45 + level * 0.25, 0.3 + level * 0.6, 0.35 + level * 0.55 + random() * 0.03];
    },
};

/** HSV in [0,1] → RGB bytes. Fixtures are authored in the space signs measure. */
function hsvToRgb(h, s, v) {
    const sector = (((h % 1) + 1) % 1) * 6;
    const index = Math.floor(sector);
    const fraction = sector - index;
    const p = v * (1 - s);
    const q = v * (1 - s * fraction);
    const t = v * (1 - s * (1 - fraction));
    const table = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][index % 6];
    return table.map((value) => Math.max(0, Math.min(255, Math.round(value * 255))));
}

async function writeSyntheticImage(file, style, seed, size = 288) {
    const random = mulberry32(seed);
    const pixels = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const [h, s, v] = STYLES[style](x / size, y / size, random);
            const [r, g, b] = hsvToRgb(h, Math.min(1, s), Math.min(1, v));
            const at = (y * size + x) * 3;
            pixels[at] = r;
            pixels[at + 1] = g;
            pixels[at + 2] = b;
        }
    }
    await sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toFile(file);
}

test('sign pipeline round-trip', { skip: ENABLED ? false : 'set CHEETAH_INTEGRATION=1 to run' }, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-test-'));
    const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-images-'));
    const port = await freePort();
    const server = await startServer({ port, dataDir, graphTermIndex: false, pairIndexBytes: 2 });
    const store = new SignStore({ port, database: 'sign_db_test' });

    t.after(async () => {
        await store.close();
        await server.stop();
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.rmSync(imageDir, { recursive: true, force: true });
    });

    await store.connect();
    assert.ok(store.pool.clients.every((conn) => conn.binary), 'every store socket negotiated binary mode');

    const files = [];
    for (const [index, style] of Object.keys(STYLES).entries()) {
        const file = path.join(imageDir, `${style}.png`);
        await writeSyntheticImage(file, style, 0x51c0 + index * 7919);
        files.push(file);
    }

    // -- ingestion ----------------------------------------------------------

    const trained = [];
    for (const file of files) {
        trained.push(await trainImage(store, file, { count: 300, seed: `train:${file}` }));
    }
    for (const result of trained) {
        assert.equal(result.signs, 300);
        assert.ok(result.words > 50, `${result.filename} published only ${result.words} words`);
        assert.equal(result.record.complete, true);
    }

    await t.test('the image record and its filename index agree', async () => {
        for (const result of trained) {
            assert.equal(await store.findImageIdByFilename(result.filename), result.imageId);
            const record = await store.getImage(result.imageId);
            assert.equal(record.filename, result.filename);
            assert.equal(record.constellations, 300);
        }
    });

    await t.test('every constellation is stored under its own address', async () => {
        const first = trained[0];
        const stored = await scanAll(store.pool, keys.signConstellationPrefix(first.imageId));
        assert.equal(stored.length, 300);
        const record = await store.getSign(first.imageId, 0);
        // Read from settings, not hard-coded: `SIGN_POINT_COUNT` is a knob, and
        // pinning 5 here made this test fail the moment the default became 7
        // without anything actually being wrong. What must hold at any count is
        // the shape — odd, with the centre exactly in the middle.
        assert.equal(record.n, settings.sign.pointCount);
        assert.equal(record.c, (settings.sign.pointCount - 1) / 2);
        assert.equal(record.n % 2, 1, 'a chain needs a single centre');
        // The centre is the seed pixel: it has no parent to differ from, so its
        // delta slot is the zero it was born with and its link is absent. Index
        // it by `record.c` rather than by a literal, or this only tests 5 points.
        assert.deepEqual(record.d[record.c], [0, 0, 0], 'the centre must carry no colour delta');
        assert.equal(record.l[record.c], null, 'the centre must carry no link');
        // Every other point does carry one, which is what makes `pointDeltas` a
        // repacking of the hops rather than a sparse array.
        assert.equal(record.d.length, record.n);
        assert.equal(record.l.filter((link) => link !== null).length, record.n - 1);
    });

    await t.test('a word posting resolves back to a real sign of that image', async () => {
        const first = trained[0];
        const postings = await scanAll(store.pool, keys.NAMESPACES.signWord, { maxItems: 1 });
        assert.ok(postings.length > 0, 'no word postings were written');
        const parsed = keys.parseSignWordPostingKey(postings[0].key);
        const signs = await store.signsForWord(parsed.word, parsed.imageId, { limit: 4 });
        assert.ok(signs.length > 0);
        assert.ok(signs.every((entry) => entry.record !== null));
        assert.ok(Number.isInteger(first.imageId));
    });

    await t.test('the graph knows which images a word belongs to', async () => {
        const postings = await scanAll(store.pool, keys.NAMESPACES.signWord, { maxItems: 64 });
        const words = [...new Set(postings.map((item) => keys.parseSignWordPostingKey(item.key).word))];
        const degrees = await store.wordDegrees(words);
        for (const word of words) {
            assert.ok(degrees.get(word) >= 1, `word ${word} has no graph edge`);
            assert.ok(degrees.get(word) <= trained.length);
        }
        const recalled = await store.recallImages(words.slice(0, 8));
        assert.ok(recalled.length > 0, 'GRAPH_RECALL returned nothing for words it was given');
        for (const hit of recalled) {
            assert.ok(trained.some((result) => result.imageId === hit.imageId));
            assert.ok(hit.seeds.length > 0, 'a recall hit must say which seeds reached it');
        }
    });

    // -- search -------------------------------------------------------------

    await t.test('a fresh sample identifies the image it came from', async () => {
        for (const [index, file] of files.entries()) {
            const result = await searchImage(store, file, {
                seed: `search:${index}`,
                maxConstellations: 120,
                rerank: false,
            });
            assert.equal(result.corpusSize, files.length);
            assert.ok(result.candidates.length > 0, `no candidate at all for ${path.basename(file)}`);
            assert.equal(
                result.candidates[0].filename,
                path.basename(file),
                `${path.basename(file)} was identified as ${result.candidates[0].filename}`
            );
        }
    });

    // The rerank is asserted to *run and report*, not to win.
    //
    // Measured on sample_images/, reordering the graph's top candidates by
    // either of the study's rules is at or below chance (3/11 by observation
    // score, 1/11 by descriptor distance, against 11/11 for the graph alone).
    // Two constellations that share a word were still sampled at unrelated
    // places, so most query points land where the candidate's field has no
    // observation and the uncertainty term dominates. Asserting a win here
    // would encode a property the pipeline does not have — the rerank rides
    // along as evidence and reorders nothing.
    await t.test('the field rerank reports a score for every candidate it sees', async () => {
        const result = await searchImage(store, files[1], { seed: 'rerank', maxConstellations: 120 });
        const scored = result.candidates.filter((candidate) => Number.isFinite(candidate.fieldScore));
        assert.ok(scored.length > 0, 'the rerank produced no field scores at all');
        for (const candidate of scored) {
            assert.ok(candidate.fieldScore >= 0, 'the study score is a mean of non-negative terms');
            assert.ok(candidate.fieldSamples > 0);
            assert.ok(Number.isFinite(candidate.descriptorScore) && candidate.descriptorScore >= 0);
        }
        // The graph's ranking is what the caller gets, rerank or not.
        assert.equal(result.candidates[0].filename, path.basename(files[1]));
    });

    // `--reset` is destructive and runs mid-session against a pool, so what has
    // to hold is that the database is *usable* afterwards: the old corpus gone,
    // and a write made after the reset readable on every connection.
    //
    // Note what this test cannot do. It does not distinguish a correctly
    // re-pointed pool from a stale one, because a stale connection re-opens the
    // same path with `O_CREATE` and answers plausibly instead of failing. It
    // passes with and without the re-point in `SignStore.reset`, so treat it as a
    // usability check, not as cover for that reasoning.
    await t.test('the database a reset recreated is usable on every connection', async () => {
        const store = new SignStore({ port, database: 'sign_db_reset_test', poolSize: 4 });
        try {
            await store.connect();
            await trainImage(store, files[0], { count: 20, seed: 'pre-reset' });
            await store.reset();

            const after = await trainImage(store, files[1], { count: 20, seed: 'post-reset' });
            assert.equal((await store.listImages()).size, 1, 'the reset must have dropped the old corpus');

            // More reads than connections, so every socket is exercised. A stale
            // one reads an empty recreated file and answers null.
            for (let attempt = 0; attempt < 16; attempt += 1) {
                assert.equal(
                    await store.findImageIdByFilename(after.filename),
                    after.imageId,
                    `read ${attempt} did not see the post-reset write`
                );
                assert.ok(
                    (await store.getSign(after.imageId, attempt % 20)) !== null,
                    `read ${attempt} did not see the post-reset constellation`
                );
            }
        } finally {
            await store.close();
        }
    });

    await t.test('an incomplete image is invisible to search', async () => {
        const { imageId } = await store.putImage({ filename: 'never-completed.png' });
        const listed = await store.listImages();
        assert.equal(listed.has(imageId), false);
        assert.equal((await store.listImages({ includeIncomplete: true })).has(imageId), true);
    });

    // The exemption adaptive training needs, and its limits: one named image
    // becomes readable, the exemption is revocable, and it never widens to other
    // half-written images.
    await t.test('readWhileIncomplete exempts exactly one image', async () => {
        const mine = await store.putImage({ filename: 'in-progress.png' });
        const other = await store.putImage({ filename: 'someone-elses.png' });

        const release = store.readWhileIncomplete(mine.imageId);
        const during = await store.listImages();
        assert.equal(during.has(mine.imageId), true, 'the exempted image must be readable');
        assert.equal(during.has(other.imageId), false, 'the exemption must not widen');

        release();
        assert.equal((await store.listImages()).has(mine.imageId), false);
    });

    await t.test('adaptive training writes in chunks and never exceeds its ceiling', async () => {
        const file = files[0];
        // The callbacks are passed on purpose: `onProgress?.(…)` does not
        // evaluate its argument when no callback is given, so a run without them
        // cannot catch a mistake in what they report.
        const progress = [];
        const checkpointsSeen = [];
        const result = await trainImageAdaptive(store, file, {
            count: 400,
            checkEvery: 100,
            probes: 2,
            minCorpus: 1,
            probeMaxConstellations: 48,
            seed: 'adaptive',
            onProgress: (event) => progress.push(event),
            onCheckpoint: (event) => checkpointsSeen.push(event),
        });

        const chunks = progress.filter((event) => event.stage === 'chunk');
        const completed = progress.filter((event) => event.stage === 'complete');
        assert.ok(chunks.length >= 1, 'a chunked run must report its chunks');
        assert.equal(completed.length, 1);
        assert.equal(completed[0].edges, result.edges);
        assert.equal(completed[0].imageId, result.imageId);
        assert.equal(chunks[chunks.length - 1].signs, result.signs);
        assert.equal(checkpointsSeen.length, result.checkpoints.length);

        assert.ok(result.signs > 0 && result.signs <= 400, `wrote ${result.signs} signs`);
        assert.equal(result.signs % 100, 0, 'a run stops on a chunk boundary');
        assert.equal(result.record.complete, true, 'the image must end up complete');
        assert.equal(result.record.constellations, result.signs);
        assert.equal(result.edges, result.words, 'one edge per distinct word');
        assert.ok(result.edgeWrites >= result.edges, 'a republished word costs an extra write');
        assert.ok(['converged', 'exhausted'].includes(result.reason), result.reason);

        // Every checkpoint is a real measurement of a real corpus.
        for (const checkpoint of result.checkpoints) {
            assert.ok(checkpoint.constellations > 0 && checkpoint.constellations < 400);
            assert.ok(checkpoint.hitRate >= 0 && checkpoint.hitRate <= 1);
            assert.ok(checkpoint.margin >= -1 && checkpoint.margin <= 1);
            assert.equal(checkpoint.probes, 2);
        }

        // The constellations really are addressable, all the way to the last
        // chunk — a chunked write that mis-tracked its ordinal would leave holes.
        const stored = await scanAll(store.pool, keys.signConstellationPrefix(result.imageId));
        assert.equal(stored.length, result.signs);
        assert.ok(await store.getSign(result.imageId, result.signs - 1) !== null);
    });

    // `extendTo` is off by default, so the default path must never write more
    // than it was asked for; when it is on, a still-improving image may.
    await t.test('extendTo is inert by default and raises the ceiling when set', async () => {
        const base = await trainImageAdaptive(store, files[2], {
            count: 200,
            checkEvery: 100,
            probes: 1,
            minCorpus: 1,
            probeMaxConstellations: 36,
            seed: 'no-extend',
        });
        assert.equal(base.ceiling, 200, 'the default ceiling is the requested count');
        assert.ok(base.signs <= 200);
        assert.equal(base.extended, false);

        const extended = await trainImageAdaptive(store, files[1], {
            count: 100,
            extendTo: 300,
            checkEvery: 100,
            probes: 1,
            // Never satisfied, so the run always has a reason to keep going and
            // the ceiling is what has to stop it.
            minGain: -Infinity,
            stopMinHitRate: 2,
            minCorpus: 1,
            probeMaxConstellations: 36,
            seed: 'extend',
        });
        assert.equal(extended.ceiling, 300);
        assert.equal(extended.signs, 300, 'a still-improving image should use the extension');
        assert.equal(extended.extended, true);
        assert.equal(extended.record.constellations, 300);
    });

    // Extending an image already in the corpus. The property everything else
    // rests on is that a top-up *adds*: it must not redraw over the ordinals the
    // image already has, and it must republish edge weights from the cumulative
    // count rather than from its own chunk's.
    await t.test('an image already in the corpus can be extended', async () => {
        const file = files[1];
        const base = await trainImage(store, file, { count: 200, seed: 'extend-base' });
        assert.equal(base.record.complete, true);

        // The counts a later session would have to rebuild, rebuilt: this is what
        // keeps a cross-session top-up from lowering edge weights.
        //
        // It is deliberately **not** an exact-equality assertion, and that is a
        // property of the format rather than a weak test. A constellation record
        // stores its deltas and links rounded to `STORED_DECIMALS` (1e-5), so a
        // triple whose measurement sits within rounding distance of a
        // quantisation edge comes back in the neighbouring cell: measured at
        // ~0.15% of triples. Every such flip moves one observation from one word
        // to another, so each affected count is off by exactly one — an edge
        // weight moved by at most 1/TF_SATURATION for a handful of words. What
        // must hold is that the rebuild is faithful in bulk and never silently
        // collapses; asserting bit-equality here would be asserting something
        // the stored record cannot deliver.
        const rebuilt = await storedWordCounts(store, base.imageId);
        assert.equal(rebuilt.signs, 200);
        let differing = 0;
        for (const [word, count] of base.wordCounts) {
            const back = rebuilt.wordCounts.get(word) ?? 0;
            if (back === count) continue;
            differing += 1;
            assert.ok(
                Math.abs(back - count) === 1,
                `word ${word} rebuilt as ${back} against ${count}: a rounding flip moves a count by one, not more`
            );
        }
        assert.ok(
            differing <= Math.ceil(base.wordCounts.size * 0.02),
            `${differing} of ${base.wordCounts.size} words diverged; the round trip should touch well under 2%`
        );
        assert.ok(
            Math.abs(rebuilt.wordCounts.size - base.wordCounts.size) <= differing,
            'the rebuilt vocabulary must not drift further than the flips explain'
        );

        const before = await store.getSign(base.imageId, 0);
        const extended = await extendImage(store, file, {
            imageId: base.imageId,
            count: 100,
            // Deliberately *not* passing wordCounts/startOrdinal: the rebuild
            // path is the one a later session takes.
            seed: 'extend-top-up',
        });

        assert.equal(extended.added, 100);
        assert.equal(extended.signs, 300);
        assert.equal(extended.record.complete, true, 'a top-up must put the image back on the shelf');
        assert.equal(extended.record.constellations, 300);
        assert.equal(extended.record.topUps, 1, 'the record counts how often it has been extended');
        assert.deepEqual(await store.getSign(base.imageId, 0), before, 'a top-up must not overwrite ordinal 0');
        assert.ok(await store.getSign(base.imageId, 299) !== null, 'the appended signs must be addressable');

        const stored = await scanAll(store.pool, keys.signConstellationPrefix(base.imageId));
        assert.equal(stored.length, 300, 'no holes and no overwrites');

        // Cumulative, never per-chunk: every word the top-up re-observed must
        // come back with a total at least as large as it had before.
        for (const [word, count] of base.wordCounts) {
            assert.ok(
                extended.wordCounts.get(word) >= count,
                `word ${word} fell from ${count} to ${extended.wordCounts.get(word)}`
            );
        }
        assert.ok(extended.words >= base.words);
    });

    // The rehearsal pass: probe what is already stored, top up what the corpus
    // can no longer find. Both directions have to be provable, or a pass that
    // did nothing would look the same as a corpus that needed nothing.
    await t.test('rehearsal tops up only the images that are behind', async () => {
        const tracked = new Map();
        for (const [index, file] of files.entries()) {
            const result = await trainImage(store, file, { count: 150, seed: `rehearse:${index}` });
            tracked.set(result.imageId, {
                imageId: result.imageId,
                filename: result.filename,
                path: file,
                signs: result.signs,
                words: result.words,
                wordCounts: result.wordCounts,
                reviewedAt: 0,
            });
        }

        // Nothing is behind when the bar is on the floor, so nothing may be
        // written — a pass that topped up regardless would be measuring nothing.
        const satisfied = await reviewCorpus(store, tracked, {
            probes: 1,
            minHitRate: 0,
            topUp: 50,
            ceiling: 0,
            sample: 0,
            probeMaxConstellations: 36,
        });
        assert.equal(satisfied.reviewed.length, tracked.size);
        assert.equal(satisfied.toppedUp, 0);
        assert.equal(satisfied.added, 0);
        assert.ok(satisfied.reviewed.every((entry) => entry.reason === 'findable'));

        // With an unreachable bar every reviewed image is behind, so every one
        // is topped up — once, by one chunk, not to the ceiling.
        const before = new Map([...tracked].map(([id, entry]) => [id, entry.signs]));
        const behind = await reviewCorpus(store, tracked, {
            probes: 1,
            minHitRate: 2,
            topUp: 50,
            ceiling: 0,
            sample: 2,
            probeMaxConstellations: 36,
        });
        assert.equal(behind.reviewed.length, 2, 'sample bounds the pass');
        assert.equal(behind.toppedUp, 2);
        assert.equal(behind.added, 100);
        for (const entry of behind.reviewed) {
            assert.equal(entry.reason, 'topped-up');
            assert.equal(entry.added, 50);
            const tracker = [...tracked.values()].find((item) => item.filename === entry.filename);
            assert.equal(tracker.signs, before.get(tracker.imageId) + 50);
            assert.equal((await store.getImage(tracker.imageId)).constellations, tracker.signs);
        }

        // Least recently reviewed first: the second bounded pass must look at
        // the images the first one did not, or a large corpus would only ever
        // rehearse its head.
        const reviewedFirst = new Set(behind.reviewed.map((entry) => entry.filename));
        const next = await reviewCorpus(store, tracked, {
            probes: 1,
            minHitRate: 0,
            topUp: 50,
            ceiling: 0,
            sample: 1,
            probeMaxConstellations: 36,
        });
        assert.equal(next.reviewed.length, 1);
        assert.equal(reviewedFirst.has(next.reviewed[0].filename), false);

        // The ceiling is what stops an image no amount of evidence can fix.
        const capped = await reviewCorpus(store, tracked, {
            probes: 1,
            minHitRate: 2,
            topUp: 50,
            ceiling: 1,
            sample: 0,
            probeMaxConstellations: 36,
        });
        assert.equal(capped.toppedUp, 0);
        assert.equal(capped.added, 0);
        assert.ok(capped.reviewed.every((entry) => entry.reason === 'at-ceiling'));
    });

    // A corpus with nothing to be confused with cannot measure discriminability,
    // so the stop rule must not fire on it.
    await t.test('adaptive training writes the full ceiling on a corpus too small to probe', async () => {
        const solo = new SignStore({ port, database: 'sign_db_solo_test' });
        try {
            await solo.connect();
            const result = await trainImageAdaptive(solo, files[0], {
                count: 200,
                checkEvery: 50,
                minCorpus: 4,
                seed: 'solo',
            });
            assert.equal(result.reason, 'corpus-too-small');
            assert.equal(result.signs, 200);
            assert.equal(result.checkpoints.length, 0);
            assert.equal(result.record.training, 'fixed');
        } finally {
            await solo.close();
        }
    });

    // A store write can fail for reasons that have nothing to do with the image
    // in front of it — the server running out of file descriptors partway
    // through a directory is the case this was written for. The failed image is
    // left incomplete, which every reader already ignores, so the run has no
    // reason to abandon the images after it.
    await t.test('training reports a failed image and keeps going', async () => {
        const resilient = new SignStore({ port, database: 'sign_db_resilient_test' });
        try {
            await resilient.connect();
            // The order the CLI will walk, not the order the fixtures were
            // written in: the doomed image has to be the one the second call
            // actually lands on.
            const listing = collectImages(imageDir).map((file) => path.basename(file));
            const putSigns = resilient.putSigns.bind(resilient);
            const doomed = listing[1];
            let seen = 0;
            resilient.putSigns = async (imageId, signs) => {
                seen += 1;
                if (seen === 2) throw new Error('cheetah PAIR_SET failed: internal_error:too many open files');
                return putSigns(imageId, signs);
            };

            const result = await commandTrain(resilient, [imageDir], new Map([['constellations', '120']]));

            assert.equal(result.attempted, listing.length);
            assert.equal(result.images, listing.length - 1);
            assert.deepEqual(result.failed.map((failure) => failure.filename), [doomed]);
            assert.match(result.failed[0].error, /too many open files/);
            // Everything after the failure was still written, and the failed
            // image is not in the corpus a reader sees.
            const stored = await resilient.listImages();
            const names = [...stored.values()].map((record) => record.filename).sort();
            assert.deepEqual(names, listing.filter((name) => name !== doomed).sort());
        } finally {
            await resilient.close();
        }
    });
});
