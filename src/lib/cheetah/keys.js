// Cheetah key codec — the single owner of ROADMAP §3. Phase 1.1.
//
// **No other file may concatenate a Cheetah key.** In a pair trie the key bytes
// *are* the index, so a layout change means rebuilding the whole database —
// exactly like changing the descriptor object's shape today. Treat everything
// in this file as a wire format.
//
// Three rules hold for every key produced here:
//
//   1. Fixed-width, zero-padded lowercase hex for every numeric segment.
//      PAIR_SCAN is byte-ordered, so `String(n)` sorts `10` before `9`.
//   2. `/` separates segments and never appears inside one. Hex guarantees it.
//   3. No key may start with a byte Cheetah reserves (`\x01`…`\x05`, `graph/`,
//      `idx/`) — see protocol.assertKeySpaceIsOurs.
//
// Two deliberate deviations from ROADMAP §3.1, both recorded there:
//
//   - The filename-lookup namespace is `fn:`, not `x:`. Cheetah's argument
//     parser (cheetah/src/helpers.go → parseValue) decodes any argument with a
//     leading `x` as hex, so an `x:` key is unaddressable in its bare spelling.
//   - `<order>` in the n-gram namespace is two hex digits, not a bare number,
//     so orders stay byte-ordered against each other like every other segment.

const crypto = require('crypto');
const { CONSTELLATION_CONSTANTS } = require('../constants');
const {
    RESOLUTION_LEVEL_TOLERANCE,
    normalizeResolutionLevel,
} = require('../resolutionLevel');
const { createDescriptorKey } = require('../descriptor');
const { assertKeySpaceIsOurs } = require('./protocol');

const { ANCHOR_SCALE, OFFSET_TOLERANCE, MIN_RELATIVE_SPAN, MAX_RELATIVE_SPAN } = CONSTELLATION_CONSTANTS;

/**
 * Bump when any layout below changes. It is stored at `cfg:key_layout_version`
 * so a database written by an older codec can be recognised instead of
 * silently misread.
 */
const KEY_LAYOUT_VERSION = 1;

const NAMESPACES = Object.freeze({
    descriptor: 'd:',
    token: 't:',
    reverseToken: 'r:',
    feature: 'f:',
    image: 'i:',
    filename: 'fn:',
    usage: 'use:',
    skip: 'skip:',
    stat: 'stat:',
    ngram: 'g:',
    config: 'cfg:',
});

const SEGMENT = '/';

const HEX_WIDTH = Object.freeze({
    token: 8,
    image: 8,
    sequence: 4,
    resolution: 4,
    anchor: 4,
    offset: 4,
    order: 2,
});

/**
 * **Bucketing happens in integers, not floats.**
 *
 * Every value that reaches a key is first quantized to `KEY_QUANTUM` (1e-6 —
 * the precision the descriptor builders already round to with
 * `Number(x.toFixed(6))`). Bucketing then divides integers.
 *
 * This is not tidiness. With float division, `(v - tol) / width` lands on
 * `224.99999999999997` where exact arithmetic gives `225`, so the sweep below
 * silently widened to three buckets for roughly half of all probes — the
 * tolerance is an exact multiple of the rounding grid, so boundary alignment is
 * the common case, not the rare one. Integer division removes the whole class.
 */
const KEY_QUANTUM = 1e-6;
const QUANTA_PER_UNIT = 1e6;

/**
 * Bucket widths are **frozen constants**, expressed in quanta, and not derived
 * from the (env-tunable) tolerances. A width that moved with
 * `RESOLUTION_LEVEL_TOLERANCE` would change the key layout from the
 * environment, which is the one thing §3 forbids.
 *
 * The property each width must keep is `width >= 2 * tolerance`: the interval
 * `[v - tol, v + tol]` is then no wider than one bucket, so it meets at most
 * two, and sweeping `bucket(v - tol)` … `bucket(v + tol)` is guaranteed to
 * contain every row within tolerance of `v`. It over-includes — rows up to two
 * widths away also land in the swept buckets — which is why callers still
 * filter exactly.
 */
const RESOLUTION_BUCKET_UNITS = 200;    // 2e-4, ~2150 buckets over [0.02, 0.45]
const OFFSET_BUCKET_UNITS = 2000;       // 2e-3, ~1500 buckets over [-1.5, 1.5]
const RESOLUTION_BUCKET_WIDTH = RESOLUTION_BUCKET_UNITS * KEY_QUANTUM;
const OFFSET_BUCKET_WIDTH = OFFSET_BUCKET_UNITS * KEY_QUANTUM;
/** Offsets are signed; the bias keeps the hex segment byte-ordered. */
const OFFSET_BUCKET_BIAS = 0x8000;

/** A value in its integer quantum domain. The only entry point to bucketing. */
function quantize(value) {
    if (!Number.isFinite(value)) throw new TypeError(`cannot quantize non-finite value ${value}`);
    return Math.round(value * QUANTA_PER_UNIT);
}

const RESOLUTION_TOLERANCE_UNITS = quantize(RESOLUTION_LEVEL_TOLERANCE);
const OFFSET_TOLERANCE_UNITS = quantize(OFFSET_TOLERANCE);

if (RESOLUTION_BUCKET_UNITS < 2 * RESOLUTION_TOLERANCE_UNITS) {
    throw new Error(
        `RESOLUTION_LEVEL_TOLERANCE=${RESOLUTION_LEVEL_TOLERANCE} exceeds half the frozen resolution ` +
        `bucket width ${RESOLUTION_BUCKET_WIDTH}; the sweep would miss matching rows. ` +
        'Widening the tolerance requires a new key layout and a full rebuild.'
    );
}
if (OFFSET_BUCKET_UNITS < 2 * OFFSET_TOLERANCE_UNITS) {
    throw new Error(
        `OFFSET_TOLERANCE=${OFFSET_TOLERANCE} exceeds half the frozen offset bucket width ` +
        `${OFFSET_BUCKET_WIDTH}; the sweep would miss matching rows. ` +
        'Widening the tolerance requires a new key layout and a full rebuild.'
    );
}

const SHA1_HEX = /^[0-9a-f]{40}$/;
const CONFIG_NAME = /^[A-Za-z0-9_.-]+$/;

function hex(value, width, what) {
    if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`${what} must be a non-negative integer, got ${value}`);
    }
    const text = value.toString(16);
    if (text.length > width) {
        throw new RangeError(`${what} ${value} does not fit in ${width} hex digits`);
    }
    return text.padStart(width, '0');
}

function unhex(text, what) {
    if (typeof text !== 'string' || !/^[0-9a-f]+$/.test(text)) {
        throw new TypeError(`${what} is not lowercase hex: ${text}`);
    }
    return Number.parseInt(text, 16);
}

function assertSha1(value, what) {
    if (typeof value !== 'string' || !SHA1_HEX.test(value)) {
        throw new TypeError(`${what} must be a 40-char lowercase sha1 hex string, got ${value}`);
    }
    return value;
}

function sha1(text) {
    return crypto.createHash('sha1').update(String(text)).digest('hex');
}

// ---------------------------------------------------------------------------
// Bucketing (ROADMAP §3.2)
// ---------------------------------------------------------------------------

/**
 * `floor(quantize(v) / widthUnits)`. Signed; the caller applies any bias.
 * `widthUnits` is a bucket width **in quanta**, never in value units.
 */
function bucketize(value, widthUnits) {
    if (!Number.isInteger(widthUnits) || widthUnits <= 0) {
        throw new RangeError(`bucket width must be a positive integer of quanta, got ${widthUnits}`);
    }
    return Math.floor(quantize(value) / widthUnits);
}

/**
 * The distinct buckets that can hold a row within `toleranceUnits` of `value`.
 * Ordered ascending; length 1 or 2 while `widthUnits >= 2 * toleranceUnits`.
 */
function bucketSweep(value, widthUnits, toleranceUnits) {
    const centre = quantize(value);
    const low = Math.floor((centre - toleranceUnits) / widthUnits);
    const high = Math.floor((centre + toleranceUnits) / widthUnits);
    const buckets = [];
    for (let b = low; b <= high; b += 1) buckets.push(b);
    return buckets;
}

function resolutionBucket(resolutionLevel) {
    const level = normalizeResolutionLevel(resolutionLevel);
    if (level < 0) throw new RangeError(`resolution_level must be non-negative, got ${level}`);
    return bucketize(level, RESOLUTION_BUCKET_UNITS);
}

/** The ≤2 resolution buckets a tolerance match must read (ROADMAP §3.2). */
function resolutionBucketSweep(resolutionLevel) {
    const level = normalizeResolutionLevel(resolutionLevel);
    return bucketSweep(level, RESOLUTION_BUCKET_UNITS, RESOLUTION_TOLERANCE_UNITS)
        .filter((bucket) => bucket >= 0);
}

/**
 * Anchors are an **exact-match** contract, not a tolerance one, so this is a
 * straight re-encoding of MySQL's `pos_x`/`pos_y`: `round(u * ANCHOR_SCALE)`.
 * It must stay `round` — `floor` would put half the corpus in the wrong cell.
 */
function anchorBucket(anchorValue) {
    if (!Number.isFinite(anchorValue)) {
        throw new TypeError(`anchor must be finite, got ${anchorValue}`);
    }
    const bucket = Math.round(anchorValue * ANCHOR_SCALE);
    if (bucket < 0) throw new RangeError(`anchor bucket must be non-negative, got ${bucket}`);
    return bucket;
}

function offsetBucket(offsetValue) {
    return bucketize(offsetValue, OFFSET_BUCKET_UNITS) + OFFSET_BUCKET_BIAS;
}

/** The ≤2 offset buckets a tolerance match must read, biased for encoding. */
function offsetBucketSweep(offsetValue) {
    return bucketSweep(offsetValue, OFFSET_BUCKET_UNITS, OFFSET_TOLERANCE_UNITS)
        .map((bucket) => bucket + OFFSET_BUCKET_BIAS);
}

/**
 * Inverse of `offsetBucket`: the half-open interval `[lo, hi)` it covers, in
 * quanta. Compare against `quantize(value)`, never against the raw float — the
 * float endpoints are not exactly representable.
 */
function offsetBucketRange(biasedBucket) {
    const bucket = biasedBucket - OFFSET_BUCKET_BIAS;
    return [bucket * OFFSET_BUCKET_UNITS, (bucket + 1) * OFFSET_BUCKET_UNITS];
}

/** Inverse of `resolutionBucket`: the half-open interval `[lo, hi)` in quanta. */
function resolutionBucketRange(bucket) {
    return [bucket * RESOLUTION_BUCKET_UNITS, (bucket + 1) * RESOLUTION_BUCKET_UNITS];
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/** `d:<descriptorKey>` → descriptor JSON. Replaces `value_types`. */
function descriptorKey(descriptorHash) {
    return `${NAMESPACES.descriptor}${assertSha1(descriptorHash, 'descriptorKey')}`;
}

/** `t:<descriptorKey>` → uint32 token id. The n-gram vocabulary. */
function tokenKey(descriptorHash) {
    return `${NAMESPACES.token}${assertSha1(descriptorHash, 'descriptorKey')}`;
}

/** `r:<tokenHex8>` → descriptorKey. The reverse vocabulary. */
function reverseTokenKey(token) {
    return `${NAMESPACES.reverseToken}${hex(token, HEX_WIDTH.token, 'token')}`;
}

/** `i:<imageHex8>` → `{filename, created_at, complete}`. Replaces `images`. */
function imageKey(imageId) {
    return `${NAMESPACES.image}${hex(imageId, HEX_WIDTH.image, 'imageId')}`;
}

/** `fn:<sha1(filename)>` → imageHex8. Replaces `images.original_filename`. */
function filenameKey(originalFilename) {
    return `${NAMESPACES.filename}${sha1(originalFilename)}`;
}

/** `skip:<descriptorKey>` → `{count, last_used}`. Replaces `skip_patterns`. */
function skipKey(descriptorHash) {
    return `${NAMESPACES.skip}${assertSha1(descriptorHash, 'descriptorKey')}`;
}

/** `use:<sha1(featureKey)>` → `{count, last_used, last_score}`. Replaces `feature_usage`. */
function usageKey(featureKeyText) {
    return `${NAMESPACES.usage}${sha1(featureKeyText)}`;
}

/** `stat:<tokenHex8>/<resB>` → aggregates. Replaces `feature_group_stats`. */
function statKey({ token, resolutionLevel, resolutionBucket: bucket }) {
    const resB = bucket !== undefined ? bucket : resolutionBucket(resolutionLevel);
    return `${NAMESPACES.stat}${hex(token, HEX_WIDTH.token, 'token')}${SEGMENT}` +
        `${hex(resB, HEX_WIDTH.resolution, 'resolutionBucket')}`;
}

/** `cfg:<key>` → setting value. Replaces `system_settings`. */
function configKey(name) {
    if (typeof name !== 'string' || !CONFIG_NAME.test(name)) {
        throw new TypeError(`config key must match ${CONFIG_NAME}, got ${name}`);
    }
    return `${NAMESPACES.config}${name}`;
}

/**
 * `g:<orderHex2>:<tokenHex8>…` → follower counts (ROADMAP §3.4).
 * `context` holds `order - 1` token ids: the path so far.
 */
function ngramKey(order, context) {
    if (!Number.isInteger(order) || order < 1) {
        throw new RangeError(`n-gram order must be a positive integer, got ${order}`);
    }
    const tokens = Array.isArray(context) ? context : [];
    if (tokens.length !== order - 1) {
        throw new RangeError(`order ${order} needs ${order - 1} context tokens, got ${tokens.length}`);
    }
    const body = tokens.map((token) => hex(token, HEX_WIDTH.token, 'token')).join('');
    return `${NAMESPACES.ngram}${hex(order, HEX_WIDTH.order, 'order')}:${body}`;
}

// ---------------------------------------------------------------------------
// Feature keys — the hot path (ROADMAP §3.1, §3.2)
// ---------------------------------------------------------------------------
//
// f:<tokenHex8>/<resB>/<axB>/<ayB>/<offXB>/<offYB>/<imageHex8>/<seqHex4>
//
// Segment order is load-bearing: token and the two anchors are exact-match, so
// they sit shallowest together with the singly-swept resolution bucket. The
// offsets — the dimensions that would multiply the scan count — sit *deeper*
// than the scan prefix and are filtered client-side instead. That keeps the
// per-probe scan count at ≤2 rather than ≤8.

/** The prefix a candidate scan walks: everything exact plus one resolution bucket. */
function featureScanPrefix({ token, resolutionBucket: bucket, resolutionLevel, anchorU, anchorV, anchorXBucket, anchorYBucket }) {
    const resB = bucket !== undefined ? bucket : resolutionBucket(resolutionLevel);
    const axB = anchorXBucket !== undefined ? anchorXBucket : anchorBucket(anchorU);
    const ayB = anchorYBucket !== undefined ? anchorYBucket : anchorBucket(anchorV);
    return `${NAMESPACES.feature}${hex(token, HEX_WIDTH.token, 'token')}${SEGMENT}` +
        `${hex(resB, HEX_WIDTH.resolution, 'resolutionBucket')}${SEGMENT}` +
        `${hex(axB, HEX_WIDTH.anchor, 'anchorXBucket')}${SEGMENT}` +
        `${hex(ayB, HEX_WIDTH.anchor, 'anchorYBucket')}${SEGMENT}`;
}

/**
 * Every prefix a tolerance-matched probe must scan: one per resolution bucket,
 * anchors exact. ROADMAP §3.2 — this is the list that keeps the scan count at
 * ≤2 instead of 3³.
 */
function featureScanPrefixes({ token, resolutionLevel, anchorU, anchorV, anchorXBucket, anchorYBucket }) {
    return resolutionBucketSweep(resolutionLevel).map((bucket) => featureScanPrefix({
        token,
        resolutionBucket: bucket,
        anchorU,
        anchorV,
        anchorXBucket,
        anchorYBucket,
    }));
}

/** The full feature-row key. `sequence` disambiguates rows sharing a cell. */
function featureKey({
    token,
    resolutionLevel,
    resolutionBucket: resB,
    anchorU,
    anchorV,
    anchorXBucket,
    anchorYBucket,
    offsetX,
    offsetY,
    offsetXBucket,
    offsetYBucket,
    imageId,
    sequence = 0,
}) {
    const offXB = offsetXBucket !== undefined ? offsetXBucket : offsetBucket(offsetX);
    const offYB = offsetYBucket !== undefined ? offsetYBucket : offsetBucket(offsetY);
    const prefix = featureScanPrefix({
        token,
        resolutionBucket: resB,
        resolutionLevel,
        anchorU,
        anchorV,
        anchorXBucket,
        anchorYBucket,
    });
    return `${prefix}${hex(offXB, HEX_WIDTH.offset, 'offsetXBucket')}${SEGMENT}` +
        `${hex(offYB, HEX_WIDTH.offset, 'offsetYBucket')}${SEGMENT}` +
        `${hex(imageId, HEX_WIDTH.image, 'imageId')}${SEGMENT}` +
        `${hex(sequence, HEX_WIDTH.sequence, 'sequence')}`;
}

/** Inverse of `featureKey`. Throws on anything that is not one. */
function parseFeatureKey(key) {
    if (typeof key !== 'string' || !key.startsWith(NAMESPACES.feature)) {
        throw new TypeError(`not a feature key: ${key}`);
    }
    const segments = key.slice(NAMESPACES.feature.length).split(SEGMENT);
    if (segments.length !== 8) {
        throw new TypeError(`feature key must have 8 segments, got ${segments.length}: ${key}`);
    }
    const widths = [
        HEX_WIDTH.token, HEX_WIDTH.resolution, HEX_WIDTH.anchor, HEX_WIDTH.anchor,
        HEX_WIDTH.offset, HEX_WIDTH.offset, HEX_WIDTH.image, HEX_WIDTH.sequence,
    ];
    segments.forEach((segment, index) => {
        if (segment.length !== widths[index]) {
            throw new TypeError(`feature key segment ${index} must be ${widths[index]} hex digits: ${key}`);
        }
    });
    return {
        token: unhex(segments[0], 'token'),
        resolutionBucket: unhex(segments[1], 'resolutionBucket'),
        anchorXBucket: unhex(segments[2], 'anchorXBucket'),
        anchorYBucket: unhex(segments[3], 'anchorYBucket'),
        offsetXBucket: unhex(segments[4], 'offsetXBucket'),
        offsetYBucket: unhex(segments[5], 'offsetYBucket'),
        imageId: unhex(segments[6], 'imageId'),
        sequence: unhex(segments[7], 'sequence'),
    };
}

function parseImageKey(key) {
    if (typeof key !== 'string' || !key.startsWith(NAMESPACES.image)) {
        throw new TypeError(`not an image key: ${key}`);
    }
    return unhex(key.slice(NAMESPACES.image.length), 'imageId');
}

function parseReverseTokenKey(key) {
    if (typeof key !== 'string' || !key.startsWith(NAMESPACES.reverseToken)) {
        throw new TypeError(`not a reverse-token key: ${key}`);
    }
    return unhex(key.slice(NAMESPACES.reverseToken.length), 'token');
}

function parseStatKey(key) {
    if (typeof key !== 'string' || !key.startsWith(NAMESPACES.stat)) {
        throw new TypeError(`not a stat key: ${key}`);
    }
    const [tokenHex, resHex, ...rest] = key.slice(NAMESPACES.stat.length).split(SEGMENT);
    if (rest.length > 0 || resHex === undefined) {
        throw new TypeError(`stat key must have 2 segments: ${key}`);
    }
    return { token: unhex(tokenHex, 'token'), resolutionBucket: unhex(resHex, 'resolutionBucket') };
}

function parseNgramKey(key) {
    if (typeof key !== 'string' || !key.startsWith(NAMESPACES.ngram)) {
        throw new TypeError(`not an n-gram key: ${key}`);
    }
    const body = key.slice(NAMESPACES.ngram.length);
    const colon = body.indexOf(':');
    if (colon !== HEX_WIDTH.order) throw new TypeError(`malformed n-gram key: ${key}`);
    const order = unhex(body.slice(0, colon), 'order');
    const tokensText = body.slice(colon + 1);
    if (tokensText.length !== (order - 1) * HEX_WIDTH.token) {
        throw new TypeError(`n-gram key order ${order} has the wrong context length: ${key}`);
    }
    const context = [];
    for (let at = 0; at < tokensText.length; at += HEX_WIDTH.token) {
        context.push(unhex(tokensText.slice(at, at + HEX_WIDTH.token), 'token'));
    }
    return { order, context };
}

// ---------------------------------------------------------------------------
// Graph node ids (ROADMAP §3.3)
// ---------------------------------------------------------------------------
//
// Bare `n<hex>` / `m<hex>`: no separator word, so the lexical term index has no
// shared token to cross-match on. Verified in the roadmap's probe run, where
// `desc:abc123` recalled `desc:def456` at 0.33 purely on the word `desc`.
// Run the database with CHEETAH_GRAPH_TERM_INDEX=0 as well — both mitigations.

function descriptorNodeId(token) {
    return `n${hex(token, HEX_WIDTH.token, 'token')}`;
}

function imageNodeId(imageId) {
    return `m${hex(imageId, HEX_WIDTH.image, 'imageId')}`;
}

function parseNodeId(nodeId) {
    if (typeof nodeId !== 'string' || nodeId.length < 2) {
        throw new TypeError(`not a graph node id: ${nodeId}`);
    }
    const kind = nodeId[0];
    if (kind !== 'n' && kind !== 'm') throw new TypeError(`unknown node id kind: ${nodeId}`);
    return {
        kind: kind === 'n' ? 'descriptor' : 'image',
        id: unhex(nodeId.slice(1), 'nodeId'),
    };
}

/**
 * Validate any key this module produced against Cheetah's reserved space and
 * the bare-argument rules. Cheap enough to call on every write in tests.
 */
function assertValidKey(key) {
    assertKeySpaceIsOurs(key);
    if (/[\s]/.test(key)) throw new Error(`cheetah key must not contain whitespace: ${key}`);
    if (key.startsWith('x')) {
        throw new Error(`cheetah key must not start with 'x' (it would be read as hex): ${key}`);
    }
    return key;
}

module.exports = {
    ANCHOR_SCALE,
    HEX_WIDTH,
    KEY_LAYOUT_VERSION,
    KEY_QUANTUM,
    OFFSET_BUCKET_UNITS,
    RESOLUTION_BUCKET_UNITS,
    MAX_RELATIVE_SPAN,
    MIN_RELATIVE_SPAN,
    NAMESPACES,
    OFFSET_BUCKET_BIAS,
    OFFSET_BUCKET_WIDTH,
    RESOLUTION_BUCKET_WIDTH,
    SEGMENT,
    anchorBucket,
    assertValidKey,
    bucketSweep,
    bucketize,
    configKey,
    createDescriptorKey,
    descriptorKey,
    descriptorNodeId,
    featureKey,
    featureScanPrefix,
    featureScanPrefixes,
    filenameKey,
    imageKey,
    imageNodeId,
    ngramKey,
    offsetBucket,
    offsetBucketRange,
    offsetBucketSweep,
    parseFeatureKey,
    parseImageKey,
    parseNgramKey,
    parseNodeId,
    parseReverseTokenKey,
    parseStatKey,
    quantize,
    resolutionBucket,
    resolutionBucketRange,
    resolutionBucketSweep,
    reverseTokenKey,
    skipKey,
    statKey,
    tokenKey,
    usageKey,
};
