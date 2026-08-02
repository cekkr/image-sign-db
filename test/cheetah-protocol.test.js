// The seam between this project and Cheetah's Node binder.
//
// The protocol codec itself now lives in the submodule
// (cheetah/binders/nodejs/lib/protocol.js) and is covered by the binder's own
// suite — `npm run test:binder`, or `node --test cheetah/binders/nodejs/test/*.test.js`.
// Duplicating those assertions here would only mean two places to update when
// the server changes a response shape.
//
// What this file covers is what the binder cannot: that the submodule at the
// SHA we pin still exports the surface this project builds on, and that the
// handful of behaviours our key layout and scan loops actually depend on are
// the ones we think they are. It is the test that should fail first after a
// submodule bump moves the binder out from under us.

const test = require('node:test');
const assert = require('node:assert/strict');

const binder = require('../src/lib/cheetah/binder');
const settings = require('../src/settings');
const protocol = require('../src/lib/cheetah/protocol');
const client = require('../src/lib/cheetah/client');
const kv = require('../src/lib/cheetah/kv');
const graph = require('../src/lib/cheetah/graph');
const { CheetahStore } = require('../src/lib/cheetah/store');
const { SignStore } = require('../src/lib/cheetah/signStore');

test('the shims re-export the binder modules themselves, not copies', () => {
    assert.equal(protocol, binder.protocol);
    assert.equal(client, binder.client);
    assert.equal(kv, binder.kv);
    assert.equal(graph, binder.graph);
});

test('the binder exports every symbol this project builds on', () => {
    for (const name of [
        'assertKeySpaceIsOurs', 'buildCommand', 'buildKeyValueCommand', 'decodeHexKey',
        'decodeItemPayload', 'decodePayload', 'encodeArgument', 'numericField',
        'parseCursor', 'parseItems', 'parseResponse', 'rawArgument',
    ]) {
        assert.equal(typeof protocol[name], 'function', `protocol.${name}`);
    }
    for (const name of ['CheetahClient', 'CheetahPool', 'CheetahError', 'CheetahConnectionError']) {
        assert.equal(typeof client[name], 'function', `client.${name}`);
    }
    for (const name of [
        'getJson', 'getValue', 'putJson', 'putJsonBatch', 'putValue', 'scanAll',
        'scanPrefix', 'deletePair',
    ]) {
        assert.equal(typeof kv[name], 'function', `kv.${name}`);
    }
    for (const name of ['degree', 'recall', 'recallBatched', 'setEdgeBatch', 'setNode']) {
        assert.equal(typeof graph[name], 'function', `graph.${name}`);
    }
    assert.equal(typeof binder.database.CheetahDatabase, 'function');
    assert.equal(typeof binder.database.hydrateJson, 'function');
    assert.equal(typeof binder.vocabulary.TokenVocabulary, 'function');
    for (const name of ['hex', 'unhex', 'sha1', 'quantize', 'bucketize', 'bucketSweep']) {
        assert.equal(typeof binder.keys[name], 'function', `keys.${name}`);
    }
});

test('both stores apply the configured byte-wise transport to owned pools', async () => {
    for (const Store of [CheetahStore, SignStore]) {
        const store = new Store({ poolSize: 2 });
        assert.equal(store.pool.clients.length, 2);
        assert.ok(store.pool.clients.every(
            (conn) => conn.options.binary === settings.cheetah.binary
        ));
        await store.close();
    }

    const textStore = new CheetahStore({ binary: false });
    assert.ok(textStore.pool.clients.every((conn) => conn.options.binary === false));
    await textStore.close();
});

test('a READ payload keeps the commas inside our JSON records', () => {
    // Every feature and image record we store is JSON with several fields, so
    // a `value=` parsed as comma-separated tokens would corrupt all of them.
    const response = protocol.parseResponse('SUCCESS,size=27,value={"a":1,"b":"x,y"}');
    assert.equal(response.fields.value, '{"a":1,"b":"x,y"}');
});

test('the `x` escape still holds, which is why our namespace is `fn:`', () => {
    // ROADMAP §3.1 asked for `x:`; the server decodes a leading `x` as hex, so
    // the namespace became `fn:`. If this ever stopped being true the roadmap
    // note would be stale rather than the code wrong.
    assert.equal(protocol.encodeArgument('x:hello'), 'x783a68656c6c6f');
    assert.equal(protocol.encodeArgument('fn:0123'), 'fn:0123');
});

test('a cursor handed back through rawArgument is not encoded twice', () => {
    // The failure this guards is silent: a re-encoded cursor resumes from a
    // prefix that does not exist, so a candidate sweep returns its first page
    // and reports no more results rather than failing.
    const cursor = protocol.parseCursor(
        protocol.parseResponse('SUCCESS,count=1,next_cursor=x6374783a4d554e494348').fields
    );
    assert.equal(
        protocol.buildCommand('PAIR_SCAN', 'f:0000000a/', 500, protocol.rawArgument(cursor)),
        'PAIR_SCAN f:0000000a/ 500 x6374783a4d554e494348'
    );
});

test('our key namespaces are outside the space Cheetah reserves', () => {
    const keys = require('../src/lib/cheetah/keys');
    for (const prefix of Object.values(keys.NAMESPACES)) {
        assert.doesNotThrow(() => protocol.assertKeySpaceIsOurs(`${prefix}0`), prefix);
    }
});
