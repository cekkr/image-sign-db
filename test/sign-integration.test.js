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
const { searchImage, trainImage } = require('../src/signPipeline');
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

    await t.test('an incomplete image is invisible to search', async () => {
        const { imageId } = await store.putImage({ filename: 'never-completed.png' });
        const listed = await store.listImages();
        assert.equal(listed.has(imageId), false);
        assert.equal((await store.listImages({ includeIncomplete: true })).has(imageId), true);
    });
});
