// The sign namespaces of the Cheetah key codec.
//
// Same contract as the `f:` layout the delta family uses, for the same reason:
// in a pair trie the key bytes *are* the index, so a key that round-trips
// wrongly is not a crash, it is a silently unreachable record.
//
// The extra property here is the **prefix hierarchy**. Retrieval depends on
// `sw:<word>/` naming every image that knows a word, and `sw:<word>/<image>/`
// narrowing to that image's signs. If either stops being a prefix of the full
// posting key, the drill-down the reranker does returns nothing at all.

const test = require('node:test');
const assert = require('node:assert/strict');

const keys = require('../src/lib/cheetah/keys');
const { WORD_CARDINALITY } = require('../src/lib/sign/constants');
const { mulberry32 } = require('../src/lib/sign/rng');

const MAX_IMAGE_ID = 0xffffffff;
const MAX_ORDINAL = 0xffff;

test('sign keys round-trip', () => {
    const random = mulberry32(0x51c0);
    for (let trial = 0; trial < 5000; trial += 1) {
        const word = Math.floor(random() * WORD_CARDINALITY);
        const imageId = 1 + Math.floor(random() * MAX_IMAGE_ID);
        const ordinal = Math.floor(random() * (MAX_ORDINAL + 1));

        const postingKey = keys.signWordPostingKey(word, imageId, ordinal);
        assert.deepEqual(keys.parseSignWordPostingKey(postingKey), { word, imageId, ordinal });

        const constellationKey = keys.signConstellationKey(imageId, ordinal);
        assert.deepEqual(keys.parseSignConstellationKey(constellationKey), { imageId, ordinal });

        assert.equal(keys.parseImageKey(keys.imageKey(imageId)), imageId);
        assert.equal(keys.parseWordNodeId(keys.wordNodeId(word)), word);
        assert.equal(keys.parseNodeId(keys.imageNodeId(imageId)).id, imageId);

        keys.assertValidKey(postingKey);
        keys.assertValidKey(constellationKey);
        keys.assertValidKey(keys.signImageKey(imageId));
        keys.assertValidKey(keys.signFilenameKey(`photo ${trial}.jpg`));
    }
});

test('the posting prefixes really are prefixes', () => {
    const random = mulberry32(0xc0de);
    for (let trial = 0; trial < 2000; trial += 1) {
        const word = Math.floor(random() * WORD_CARDINALITY);
        const imageId = 1 + Math.floor(random() * MAX_IMAGE_ID);
        const ordinal = Math.floor(random() * (MAX_ORDINAL + 1));

        const posting = keys.signWordPostingKey(word, imageId, ordinal);
        assert.ok(posting.startsWith(keys.signWordPrefix(word)));
        assert.ok(posting.startsWith(keys.signWordImagePrefix(word, imageId)));
        assert.ok(keys.signWordImagePrefix(word, imageId).startsWith(keys.signWordPrefix(word)));

        assert.ok(keys.signConstellationKey(imageId, ordinal)
            .startsWith(keys.signConstellationPrefix(imageId)));
    }
});

test('one image cannot leak into another image prefix', () => {
    // 0x0000000a and 0x000000ab share no prefix boundary problem only because
    // the segments are fixed width — this is the assertion that keeps it so.
    const wordPrefix = keys.signWordPrefix(42);
    assert.equal(keys.signWordImagePrefix(42, 0xa).startsWith(
        keys.signWordImagePrefix(42, 0xab)
    ), false);
    assert.equal(
        keys.signWordImagePrefix(42, 0xa).length,
        keys.signWordImagePrefix(42, 0xab).length
    );
    assert.ok(keys.signWordPrefix(4).length === wordPrefix.length);
});

test('byte order is numeric order for words and ordinals', () => {
    const words = [0, 1, 9, 10, 15, 16, 255, 256, WORD_CARDINALITY - 1];
    const encoded = words.map((word) => keys.signWordPrefix(word));
    const sorted = [...encoded].sort();
    assert.deepEqual(sorted, encoded, 'PAIR_SCAN walks bytes; the hex must sort like the numbers');

    const ordinals = [0, 1, 9, 10, 255, 4096, MAX_ORDINAL];
    const ordinalKeys = ordinals.map((ordinal) => keys.signConstellationKey(7, ordinal));
    assert.deepEqual([...ordinalKeys].sort(), ordinalKeys);
});

test('out-of-range identifiers are refused rather than truncated', () => {
    assert.throws(() => keys.signWordPrefix(WORD_CARDINALITY), RangeError);
    assert.throws(() => keys.signWordPrefix(-1), RangeError);
    assert.throws(() => keys.signConstellationKey(1, MAX_ORDINAL + 1), RangeError);
    assert.throws(() => keys.signImageKey(MAX_IMAGE_ID + 1), RangeError);
    assert.throws(() => keys.parseSignWordPostingKey('sw:00001/00000002'), TypeError);
    assert.throws(() => keys.parseSignConstellationKey('f:whatever'), TypeError);
    assert.throws(() => keys.parseWordNodeId('m0000000a'), TypeError);
});

test('sign namespaces do not collide with the delta family', () => {
    const namespaces = Object.values(keys.NAMESPACES);
    for (const left of namespaces) {
        for (const right of namespaces) {
            if (left === right) continue;
            assert.equal(
                left.startsWith(right),
                false,
                `namespace ${left} is inside ${right}: a scan of one would sweep the other`
            );
        }
    }
});
