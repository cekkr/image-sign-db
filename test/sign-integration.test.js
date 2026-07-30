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

const { startServer } = require('../src/lib/cheetah/server');
const { SignStore } = require('../src/lib/cheetah/signStore');
const keys = require('../src/lib/cheetah/keys');
const { scanAll } = require('../src/lib/cheetah/kv');
const { searchImage, trainImage, trainImageAdaptive } = require('../src/signPipeline');
const { mulberry32 } = require('../src/lib/sign/rng');

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
        assert.equal(record.n, 5);
        assert.equal(record.c, 2);
        assert.deepEqual(record.d[2], [0, 0, 0], 'the centre must carry no colour delta');
        assert.equal(record.l[2], null, 'the centre must carry no link');
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
});
