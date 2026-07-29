// Live round-trip against a spawned cheetah-server — ROADMAP Phase 0 exit check.
//
// Skipped unless CHEETAH_INTEGRATION=1, because it needs a Go toolchain and
// builds the submodule binary. Run it with:
//
//   npm run test:integration
//
// This is the test that proves the client, the protocol parser and the key
// codec agree with the real server rather than with the handbook.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const ENABLED = process.env.CHEETAH_INTEGRATION === '1';

const { startServer } = require('../src/lib/cheetah/server');
const { CheetahClient, CheetahPool } = require('../src/lib/cheetah/client');
const { decodePayload, numericField } = require('../src/lib/cheetah/protocol');
const { getJson, putJson, getValue, putValue, scanAll } = require('../src/lib/cheetah/kv');
const { TokenVocabulary } = require('../src/lib/cheetah/vocabulary');
const { CheetahStore } = require('../src/lib/cheetah/store');
const keys = require('../src/lib/cheetah/keys');

/** An ephemeral port the OS just told us is free. */
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

test('cheetah round-trip', { skip: ENABLED ? false : 'set CHEETAH_INTEGRATION=1 to run' }, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheetah-test-'));
    const port = await freePort();
    const server = await startServer({ port, dataDir, graphTermIndex: false, pairIndexBytes: 2 });
    const client = new CheetahClient({
        port,
        database: 'image_sign_db_test',
        // Trie geometry is only adopted when the directory is created, so the
        // override has to be recorded on the name before the RESET_DB below.
        databaseOptions: { pair_bytes: 2 },
    });

    t.after(async () => {
        await client.close();
        await server.stop();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    await client.connect();
    const reset = await client.send('RESET_DB image_sign_db_test');
    assert.equal(reset.ok, true, reset.raw);

    await t.test('PAIR_SET / PAIR_GET bind and resolve a name', async () => {
        const descriptorHash = 'a'.repeat(40);
        const key = keys.descriptorKey(descriptorHash);
        const descriptor = { family: 'delta', channel: 'h', sample_id: 7 };
        const absKey = await putJson(client, key, descriptor);
        assert.ok(absKey > 0);
        assert.deepEqual(await getJson(client, key), descriptor);

        // A point lookup, never a scan: the parent prefix has no terminal.
        const miss = await client.command('PAIR_GET', 'd:');
        assert.equal(miss.ok, false);
        assert.match(miss.error, /not_found/);
        assert.equal(await getJson(client, keys.descriptorKey('b'.repeat(40))), null);
    });

    await t.test('an upsert keeps the absolute key stable', async () => {
        const key = keys.configKey('round_trip');
        const first = await putValue(client, key, 'one', { upsert: true });
        const second = await putValue(client, key, 'a much longer value', { upsert: true });
        assert.equal(first, second, 'EDIT must relocate the bytes without changing the key');
        assert.equal(await getValue(client, key), 'a much longer value');
    });

    await t.test('the pool exposes the full KV command surface', async (t) => {
        const pool = new CheetahPool({
            size: 2,
            port,
            database: 'image_sign_db_test',
            databaseOptions: { pair_bytes: 2 },
        });
        t.after(() => pool.close());
        await pool.connect();
        const key = keys.configKey('pool_round_trip');
        await putValue(pool, key, 'pooled');
        assert.equal(await getValue(pool, key), 'pooled');
    });

    await t.test('a UTF-8 payload survives the latin1 wire', async () => {
        const key = keys.imageKey(9);
        const record = { filename: 'clichés-café.jpg', created_at: 1, complete: false };
        await putJson(client, key, record);
        assert.deepEqual(await getJson(client, key), record);
    });

    await t.test('PAIR_SCAN walks a feature prefix in key order', async () => {
        const probe = { token: 0x2a, resolutionLevel: 0.1234, anchorU: 0.5, anchorV: 0.25 };
        const written = [];
        for (let sequence = 0; sequence < 12; sequence += 1) {
            const key = keys.featureKey({
                ...probe,
                offsetX: -0.4 + sequence * 0.01,
                offsetY: 0.3,
                imageId: 100 + (sequence % 3),
                sequence,
            });
            written.push(key);
            await putJson(client, key, { value: sequence / 100, size: 0.1234, rel_x: -0.4, rel_y: 0.3 });
        }

        const prefixes = keys.featureScanPrefixes(probe);
        assert.ok(prefixes.length <= 2, `expected at most 2 scans, got ${prefixes.length}`);

        const seen = [];
        for (const prefix of prefixes) {
            // A page size of 5 over 12 rows forces the cursor to be exercised.
            for (const item of await scanAll(client, prefix, { limit: 5 })) seen.push(item.key);
        }

        assert.deepEqual(seen.slice().sort(), written.slice().sort(), 'the scan must return every row');
        assert.deepEqual(seen, seen.slice().sort(), 'PAIR_SCAN pages must be byte-ordered');

        // Every returned key must parse back into the probe it was built from.
        for (const key of seen) {
            const parsed = keys.parseFeatureKey(key);
            assert.equal(parsed.token, probe.token);
            assert.equal(parsed.anchorXBucket, keys.anchorBucket(probe.anchorU));
        }
    });

    await t.test('PAIR_SUMMARY reports the shape without hydrating', async () => {
        const summary = await client.command('PAIR_SUMMARY', 'f:', 1);
        assert.equal(summary.ok, true, summary.raw);
        assert.equal(numericField(summary.fields, 'count'), 12);
        assert.ok(numericField(summary.fields, 'total_payload_bytes') > 0);
    });

    await t.test('GRAPH_RECALL resolves descriptor seeds to image ids', async () => {
        const descriptorNode = keys.descriptorNodeId(0x2a);
        const imageNode = keys.imageNodeId(100);
        const otherImage = keys.imageNodeId(101);

        await client.commandOrThrow('GRAPH_NODE_SET', `id=${descriptorNode}`, 'labels=descriptor,ch_h');
        await client.commandOrThrow('GRAPH_NODE_SET', `id=${imageNode}`, 'labels=image');
        await client.commandOrThrow('GRAPH_NODE_SET', `id=${otherImage}`, 'labels=image');
        await client.commandOrThrow(
            'GRAPH_EDGE_SET', `from=${descriptorNode}`, `to=${imageNode}`,
            'type=observed_in', 'weight=0.9', 'confidence=probable'
        );

        const recall = await client.commandOrThrow('GRAPH_RECALL', `seeds=${descriptorNode}`, 'hops=2');
        const payload = decodePayload(recall.fields);
        const hits = (payload && payload.associations) || [];
        const ids = hits.map((hit) => hit.id);
        assert.ok(ids.includes(imageNode), `expected ${imageNode} in ${JSON.stringify(ids)}`);
        // ROADMAP §3.3: with bare n<hex>/m<hex> ids and the term index off,
        // an unrelated image must not co-activate on a shared lexical token.
        assert.equal(ids.includes(otherImage), false, `${otherImage} recalled spuriously`);
    });

    await t.test('the token vocabulary allocates stable ids', async () => {
        const vocabulary = new TokenVocabulary(client);
        const first = 'c'.repeat(40);
        const second = 'd'.repeat(40);

        const tokenA = await vocabulary.tokenFor(first);
        const tokenB = await vocabulary.tokenFor(second);
        assert.notEqual(tokenA, tokenB);
        assert.equal(await vocabulary.tokenFor(first), tokenA, 'the cache must not reallocate');

        // A fresh vocabulary reads the persisted mapping instead of allocating.
        const reopened = new TokenVocabulary(client);
        assert.equal(await reopened.tokenFor(first), tokenA);
        assert.equal(await reopened.descriptorFor(tokenB), second);

        // Concurrent first sights of the same descriptor collapse to one id.
        const third = 'e'.repeat(40);
        const raced = new TokenVocabulary(client);
        const [x, y, z] = await Promise.all([
            raced.tokenFor(third), raced.tokenFor(third), raced.tokenFor(third),
        ]);
        assert.equal(x, y);
        assert.equal(y, z);

        // Distinct descriptors resolved concurrently must not share an id.
        const many = Array.from({ length: 16 }, (unused, index) => String(index).padStart(40, 'f'));
        const tokens = await raced.tokensFor(many);
        assert.equal(new Set(tokens).size, tokens.length, 'the counter raced');
    });

    await t.test('the Image Sign store commits features behind the complete flag', async () => {
        const now = new Date('2026-07-29T12:00:00.000Z');
        const store = new CheetahStore({ pool: client, now: () => now, writeBatchSize: 2 });
        await store.connect();

        const descriptor = {
            family: 'delta',
            channel: 'h',
            augmentation: 'original',
            sample_id: 123,
            anchor_u: 0.4,
            anchor_v: 0.6,
            span: 0.2,
            offset_x: 0.12,
            offset_y: -0.08,
        };
        const feature = {
            descriptor,
            resolution_level: 0.2,
            pos_x: 4000,
            pos_y: 6000,
            rel_x: 0.12,
            rel_y: -0.08,
            value: 0.33,
            size: 0.2,
        };
        const probe = { ...feature, descriptor };

        const { imageId } = await store.putImage({
            filename: 'phase-two.jpg',
            imageId: 501,
        });
        assert.equal(imageId, 501);
        assert.equal((await store.getImage(imageId)).complete, false);
        assert.equal(await store.putFeatures(imageId, [feature, feature]), 2);
        assert.deepEqual(
            await store.findCandidates(probe),
            [],
            'incomplete images must never surface'
        );

        await store.markComplete(imageId);
        await assert.rejects(
            store.putFeatures(imageId, [feature]),
            /cannot attach features to completed image/
        );
        const candidates = await store.findCandidates(probe);
        assert.equal(candidates.length, 2, 'duplicate rows must receive distinct sequence suffixes');
        assert.ok(candidates.every((row) => row.image_id === imageId));
        assert.ok(candidates.every((row) => row.original_filename === 'phase-two.jpg'));

        await Promise.all([
            store.recordUsage([candidates[0].feature_key], 1, 0.25),
            store.recordUsage([candidates[0].feature_key], 2, 0.5),
        ]);
        assert.deepEqual(
            await getJson(client, keys.usageKey(candidates[0].feature_key)),
            {
                feature_key: candidates[0].feature_key,
                count: 3,
                last_used: now.toISOString(),
                last_score: 0.75,
            }
        );

        await store.saveSkip(descriptor);
        await store.saveSkip(descriptor);
        const descriptorHash = keys.createDescriptorKey(descriptor);
        const skipped = await getJson(client, keys.skipKey(descriptorHash));
        assert.equal(skipped.count, 2);
        assert.deepEqual(skipped.descriptor, descriptor);

        assert.equal(await store.getSetting('max_db_size_gb', 7), 7);
        assert.equal(await store.setSetting('max_db_size_gb', 9), 9);
        assert.equal(await store.getSetting('max_db_size_gb'), 9);

        const summary = await store.featureSummary();
        assert.equal(summary.count, 14);
        assert.ok(summary.totalPayloadBytes > 0);

        const pages = await store.measureFeaturePages();
        assert.equal(pages.rowCount, summary.count);
        assert.ok(pages.prefixCount > 0);
        assert.ok(pages.max >= 2);
        assert.equal(pages.over500, 0);

        const storageBefore = await store.storageSummary();
        const capacity = await store.ensureStorageCapacity({
            maxBytes: storageBefore.totalPayloadBytes - 1,
            maxBatchSize: 1,
        });
        assert.equal(capacity.pruned, 1);
        assert.equal(capacity.overLimit, false);
        assert.ok(capacity.after.totalPayloadBytes < storageBefore.totalPayloadBytes);
        assert.equal((await store.featureSummary()).count, 13);
        assert.ok(
            await getJson(client, keys.usageKey(candidates[0].feature_key)),
            'the used feature must survive a one-row cold prune'
        );
    });

    await t.test('pipelined commands keep their FIFO order', async () => {
        const written = Array.from({ length: 64 }, (unused, index) => index);
        const responses = await Promise.all(written.map((index) =>
            client.command('PAIR_SET', keys.configKey(`pipeline_${index}`), 1)));
        for (const response of responses) assert.equal(response.ok, true, response.raw);

        const summary = await client.command('PAIR_SUMMARY', 'cfg:pipeline_', 1);
        assert.equal(numericField(summary.fields, 'count'), written.length);
    });

    await t.test('DEL pairs empties a namespace', async () => {
        const deleted = await client.send('DEL pairs prefix=cfg:pipeline_');
        assert.equal(deleted.ok, true, deleted.raw);
        const summary = await client.command('PAIR_SUMMARY', 'cfg:pipeline_', 1);
        assert.equal(numericField(summary.fields, 'count'), 0);
    });
});
