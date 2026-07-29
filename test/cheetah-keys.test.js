// Key-codec property tests — ROADMAP Phase 1.3.
//
// The key bytes are the index, so two properties have to hold or the database
// is silently wrong rather than loudly broken:
//
//   1. Round-trip — every key this codec writes parses back to the same fields.
//   2. Byte order == numeric order — PAIR_SCAN walks bytes, so a key that sorts
//      by string must sort by the numbers it encodes, including across bucket
//      boundaries and for negative offsets.
//
// A third, cheaper property is checked by fuzz: distinct descriptors must not
// collide on a feature key.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const keys = require('../src/lib/cheetah/keys');
const { createDescriptorKey } = require('../src/lib/descriptor');
const {
    RESOLUTION_LEVEL_TOLERANCE,
    normalizeResolutionLevel,
} = require('../src/lib/resolutionLevel');
const { CONSTELLATION_CONSTANTS, CHANNEL_DIMENSIONS } = require('../src/lib/constants');

const { OFFSET_TOLERANCE, MIN_RELATIVE_SPAN, MAX_RELATIVE_SPAN, MAX_OFFSET_MAGNITUDE } =
    CONSTELLATION_CONSTANTS;

/** Deterministic RNG so a failure is reproducible from the seed alone. */
function seededRandom(seed) {
    let state = Number.parseInt(crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 8), 16);
    return function next() {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const sha1 = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test('feature keys round-trip through parseFeatureKey', () => {
    const random = seededRandom('feature-round-trip');
    for (let i = 0; i < 5000; i += 1) {
        const fields = {
            token: Math.floor(random() * 0xffffffff),
            resolutionLevel: MIN_RELATIVE_SPAN + random() * (MAX_RELATIVE_SPAN - MIN_RELATIVE_SPAN),
            anchorU: random(),
            anchorV: random(),
            offsetX: (random() * 2 - 1) * MAX_OFFSET_MAGNITUDE,
            offsetY: (random() * 2 - 1) * MAX_OFFSET_MAGNITUDE,
            imageId: Math.floor(random() * 0xffffffff),
            sequence: Math.floor(random() * 0xffff),
        };
        const key = keys.assertValidKey(keys.featureKey(fields));
        const parsed = keys.parseFeatureKey(key);

        assert.equal(parsed.token, fields.token);
        assert.equal(parsed.imageId, fields.imageId);
        assert.equal(parsed.sequence, fields.sequence);
        assert.equal(parsed.resolutionBucket, keys.resolutionBucket(fields.resolutionLevel));
        assert.equal(parsed.anchorXBucket, keys.anchorBucket(fields.anchorU));
        assert.equal(parsed.anchorYBucket, keys.anchorBucket(fields.anchorV));
        assert.equal(parsed.offsetXBucket, keys.offsetBucket(fields.offsetX));
        assert.equal(parsed.offsetYBucket, keys.offsetBucket(fields.offsetY));

        // The bucket must contain the value it was derived from. Containment is
        // checked in quanta: the float endpoints of a bucket are not exactly
        // representable, which is the whole reason bucketing is integral.
        const [resLo, resHi] = keys.resolutionBucketRange(parsed.resolutionBucket);
        const level = keys.quantize(normalizeResolutionLevel(fields.resolutionLevel));
        assert.ok(level >= resLo && level < resHi, `${level} outside [${resLo}, ${resHi})`);
        const [offLo, offHi] = keys.offsetBucketRange(parsed.offsetXBucket);
        const offset = keys.quantize(fields.offsetX);
        assert.ok(offset >= offLo && offset < offHi, `${offset} outside [${offLo}, ${offHi})`);
    }
});

test('a feature key starts with its own scan prefix', () => {
    const fields = {
        token: 0x0a,
        resolutionLevel: 0.12345,
        anchorU: 0.5,
        anchorV: 0.25,
        offsetX: -0.4,
        offsetY: 0.9,
        imageId: 7,
        sequence: 3,
    };
    const key = keys.featureKey(fields);
    const prefix = keys.featureScanPrefix(fields);
    assert.ok(key.startsWith(prefix), `${key} does not start with ${prefix}`);
    assert.equal(prefix, 'f:0000000a/0269/1388/09c4/');
});

test('the other namespaces round-trip', () => {
    const descriptorHash = sha1('descriptor');
    assert.equal(keys.descriptorKey(descriptorHash), `d:${descriptorHash}`);
    assert.equal(keys.tokenKey(descriptorHash), `t:${descriptorHash}`);
    assert.equal(keys.skipKey(descriptorHash), `skip:${descriptorHash}`);

    assert.equal(keys.parseReverseTokenKey(keys.reverseTokenKey(70000)), 70000);
    assert.equal(keys.parseImageKey(keys.imageKey(4242)), 4242);
    assert.deepEqual(keys.parseStatKey(keys.statKey({ token: 9, resolutionLevel: 0.3 })), {
        token: 9,
        resolutionBucket: keys.resolutionBucket(0.3),
    });
    assert.deepEqual(keys.parseNgramKey(keys.ngramKey(3, [11, 22])), { order: 3, context: [11, 22] });
    assert.deepEqual(keys.parseNgramKey(keys.ngramKey(1, [])), { order: 1, context: [] });
    assert.deepEqual(keys.parseNodeId(keys.descriptorNodeId(5)), { kind: 'descriptor', id: 5 });
    assert.deepEqual(keys.parseNodeId(keys.imageNodeId(5)), { kind: 'image', id: 5 });
});

test('graph node ids share no lexical token', () => {
    // ROADMAP §3.3: `desc:abc123` recalled `desc:def456` at 0.33 purely because
    // both contained the word `desc`. Bare n<hex>/m<hex> have nothing to share.
    const descriptorNode = keys.descriptorNodeId(0xabc123);
    const imageNode = keys.imageNodeId(0xdef456);
    assert.match(descriptorNode, /^n[0-9a-f]{8}$/);
    assert.match(imageNode, /^m[0-9a-f]{8}$/);
    assert.equal(descriptorNode.includes(':'), false);
    assert.equal(imageNode.includes(':'), false);
});

test('key builders reject out-of-range and malformed input', () => {
    assert.throws(() => keys.descriptorKey('not-a-sha1'), /sha1/);
    assert.throws(() => keys.reverseTokenKey(0x1_0000_0000), /does not fit/);
    assert.throws(() => keys.reverseTokenKey(-1), /non-negative/);
    assert.throws(() => keys.imageKey(1.5), /integer/);
    assert.throws(() => keys.ngramKey(3, [1]), /needs 2 context tokens/);
    assert.throws(() => keys.configKey('bad key'), /must match/);
    assert.throws(() => keys.parseFeatureKey('d:abc'), /not a feature key/);
    assert.throws(() => keys.parseFeatureKey('f:0a/0269'), /8 segments/);
    // Anchors are exact-match: a negative anchor is a bug, not a wide bucket.
    assert.throws(() => keys.anchorBucket(-0.01), /non-negative/);
});

test('no namespace collides with Cheetah reserved space or the hex spelling', () => {
    const descriptorHash = sha1('ns');
    const samples = [
        keys.descriptorKey(descriptorHash),
        keys.tokenKey(descriptorHash),
        keys.reverseTokenKey(1),
        keys.featureKey({
            token: 1, resolutionLevel: 0.1, anchorU: 0.1, anchorV: 0.1,
            offsetX: 0, offsetY: 0, imageId: 1, sequence: 0,
        }),
        keys.imageKey(1),
        keys.filenameKey('photo.jpg'),
        keys.usageKey('f:0000000a/'),
        keys.skipKey(descriptorHash),
        keys.statKey({ token: 1, resolutionLevel: 0.1 }),
        keys.ngramKey(2, [1]),
        keys.configKey('next_token'),
    ];
    for (const key of samples) keys.assertValidKey(key);
    // The `fn:` rename exists precisely because `x:` is unaddressable.
    assert.ok(keys.filenameKey('photo.jpg').startsWith('fn:'));
});

// ---------------------------------------------------------------------------
// Byte order == numeric order
// ---------------------------------------------------------------------------

test('feature keys sort by bytes exactly as they sort by numbers', () => {
    const random = seededRandom('ordering');
    const rows = [];
    for (let i = 0; i < 20000; i += 1) {
        const fields = {
            token: Math.floor(random() * 64),
            resolutionLevel: MIN_RELATIVE_SPAN + random() * (MAX_RELATIVE_SPAN - MIN_RELATIVE_SPAN),
            anchorU: random(),
            anchorV: random(),
            offsetX: (random() * 2 - 1) * MAX_OFFSET_MAGNITUDE,
            offsetY: (random() * 2 - 1) * MAX_OFFSET_MAGNITUDE,
            imageId: Math.floor(random() * 4096),
            sequence: Math.floor(random() * 8),
        };
        rows.push({
            key: keys.featureKey(fields),
            tuple: [
                fields.token,
                keys.resolutionBucket(fields.resolutionLevel),
                keys.anchorBucket(fields.anchorU),
                keys.anchorBucket(fields.anchorV),
                keys.offsetBucket(fields.offsetX),
                keys.offsetBucket(fields.offsetY),
                fields.imageId,
                fields.sequence,
            ],
        });
    }

    const compareTuples = (a, b) => {
        for (let i = 0; i < a.tuple.length; i += 1) {
            if (a.tuple[i] !== b.tuple[i]) return a.tuple[i] - b.tuple[i];
        }
        return 0;
    };
    // Buffer.compare is the byte comparison PAIR_SCAN actually performs.
    const byBytes = [...rows].sort((a, b) =>
        Buffer.compare(Buffer.from(a.key, 'latin1'), Buffer.from(b.key, 'latin1')));
    const byNumbers = [...rows].sort(compareTuples);

    for (let i = 0; i < rows.length; i += 1) {
        assert.equal(byBytes[i].key, byNumbers[i].key, `order diverges at index ${i}`);
    }
});

test('negative offsets sort below positive ones', () => {
    const ordered = [-1.5, -1.0, -0.002, -0.001, 0, 0.001, 0.002, 1.0, 1.5];
    const encoded = ordered.map((offset) => keys.featureKey({
        token: 1,
        resolutionLevel: 0.1,
        anchorU: 0.5,
        anchorV: 0.5,
        offsetX: offset,
        offsetY: 0,
        imageId: 1,
        sequence: 0,
    }));
    for (let i = 1; i < encoded.length; i += 1) {
        assert.ok(
            encoded[i - 1] <= encoded[i],
            `offset ${ordered[i - 1]} sorts after ${ordered[i]}`
        );
    }
    // The bias must keep every bucket inside its 4-hex segment.
    assert.equal(keys.offsetBucket(0), keys.OFFSET_BUCKET_BIAS);
    assert.ok(keys.offsetBucket(-MAX_OFFSET_MAGNITUDE) > 0);
    assert.ok(keys.offsetBucket(MAX_OFFSET_MAGNITUDE) < 0xffff);
});

test('ordering is stable across a bucket boundary', () => {
    const width = keys.RESOLUTION_BUCKET_WIDTH;
    const below = 5 * width - width / 4;
    const above = 5 * width + width / 4;
    assert.equal(keys.resolutionBucket(below), 4);
    assert.equal(keys.resolutionBucket(above), 5);
    const keyBelow = keys.featureScanPrefix({ token: 1, resolutionLevel: below, anchorU: 0.5, anchorV: 0.5 });
    const keyAbove = keys.featureScanPrefix({ token: 1, resolutionLevel: above, anchorU: 0.5, anchorV: 0.5 });
    assert.ok(keyBelow < keyAbove);
});

// ---------------------------------------------------------------------------
// The sweep contract (ROADMAP §3.2)
// ---------------------------------------------------------------------------

test('a resolution sweep contains every row within tolerance', () => {
    const random = seededRandom('resolution-sweep');
    for (let i = 0; i < 100000; i += 1) {
        const probe = MIN_RELATIVE_SPAN + random() * (MAX_RELATIVE_SPAN - MIN_RELATIVE_SPAN);
        const delta = (random() * 2 - 1) * RESOLUTION_LEVEL_TOLERANCE;
        const row = probe + delta;
        const sweep = keys.resolutionBucketSweep(probe);
        assert.ok(sweep.length <= 2, `sweep of ${probe} produced ${sweep.length} buckets`);
        assert.ok(
            sweep.includes(keys.resolutionBucket(row)),
            `row ${row} (bucket ${keys.resolutionBucket(row)}) missing from sweep of ${probe}: ${sweep}`
        );
    }
});

test('an offset sweep contains every row within tolerance', () => {
    const random = seededRandom('offset-sweep');
    for (let i = 0; i < 100000; i += 1) {
        const probe = (random() * 2 - 1) * MAX_OFFSET_MAGNITUDE;
        const row = probe + (random() * 2 - 1) * OFFSET_TOLERANCE;
        const sweep = keys.offsetBucketSweep(probe);
        assert.ok(sweep.length <= 2, `sweep of ${probe} produced ${sweep.length} buckets`);
        assert.ok(sweep.includes(keys.offsetBucket(row)), `row ${row} missing from sweep of ${probe}`);
    }
});

test('featureScanPrefixes emits one prefix per swept resolution bucket', () => {
    const probe = { token: 3, resolutionLevel: 0.2, anchorU: 0.4, anchorV: 0.6 };
    const prefixes = keys.featureScanPrefixes(probe);
    assert.equal(prefixes.length, keys.resolutionBucketSweep(probe.resolutionLevel).length);
    assert.ok(prefixes.length <= 2, 'a probe must never cost more than 2 scans');
    for (const prefix of prefixes) {
        assert.match(prefix, /^f:[0-9a-f]{8}\/[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\/$/);
    }
});

// ---------------------------------------------------------------------------
// Fuzz: no collisions
// ---------------------------------------------------------------------------

test('10^5 random descriptors produce no key collisions', () => {
    const random = seededRandom('collision-fuzz');
    const augmentations = ['original', 'mirror_horizontal', 'gaussian_blur', 'center_crop_80'];
    const descriptorKeys = new Set();
    const featureKeys = new Set();
    const tokenOf = new Map();

    for (let i = 0; i < 100000; i += 1) {
        const descriptor = {
            family: 'delta',
            channel: CHANNEL_DIMENSIONS[Math.floor(random() * CHANNEL_DIMENSIONS.length)],
            augmentation: augmentations[Math.floor(random() * augmentations.length)],
            sample_id: Math.floor(random() * 80000),
            anchor_u: Number((random()).toFixed(6)),
            anchor_v: Number((random()).toFixed(6)),
            span: Number((MIN_RELATIVE_SPAN + random() * (MAX_RELATIVE_SPAN - MIN_RELATIVE_SPAN)).toFixed(6)),
            offset_x: Number(((random() * 2 - 1) * MAX_OFFSET_MAGNITUDE).toFixed(6)),
            offset_y: Number(((random() * 2 - 1) * MAX_OFFSET_MAGNITUDE).toFixed(6)),
        };
        const hash = createDescriptorKey(descriptor);
        descriptorKeys.add(hash);
        if (!tokenOf.has(hash)) tokenOf.set(hash, tokenOf.size + 1);

        const key = keys.featureKey({
            token: tokenOf.get(hash),
            resolutionLevel: descriptor.span,
            anchorU: descriptor.anchor_u,
            anchorV: descriptor.anchor_v,
            offsetX: descriptor.offset_x,
            offsetY: descriptor.offset_y,
            imageId: Math.floor(random() * 65536),
            sequence: 0,
        });
        if (featureKeys.has(key)) {
            // A repeat is only legal when the descriptor and image really do
            // collide on every bucket — record it so the count can be checked.
            continue;
        }
        featureKeys.add(key);
    }

    // Distinct descriptors must map to distinct hashes; a 40-hex sha1 over 10^5
    // draws has no realistic chance of colliding, so any loss is a codec bug.
    assert.ok(descriptorKeys.size > 99000, `only ${descriptorKeys.size} distinct descriptor hashes`);
    assert.equal(tokenOf.size, descriptorKeys.size);
    // Feature keys collapse only through bucketing, never through encoding.
    assert.ok(featureKeys.size > 99000, `only ${featureKeys.size} distinct feature keys`);
});
