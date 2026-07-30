// The persisted form of one sign, and what can be recomputed from it.
//
// The record holds exactly what the specification says to store and nothing
// else: per point, the absolute HSV differences against the neighbour towards
// the centre (the centre being all zeros), and, per point, the distance and
// bearing of that same hop in half-diagonal units. The optional centre position
// rides along only when it was asked for.
//
// Everything downstream — the local frame, the hop lengths and turns, the
// vocabulary words, the continuous colour field, the canonical descriptor — is
// **derived** from those two arrays. That is the invariant worth keeping: if a
// value can be recomputed it is not stored, so there is exactly one place it can
// be wrong.
//
// Keys are one letter because the corpus is thousands of these per image and the
// payload is the dominant cost in Cheetah.

const { RadialBasisField, canonicalDescriptor, descriptorDistance, scoreObservations } = require('./field');
const { SIGN_LAYOUT_VERSION } = require('./constants');
const { alignToTriple, edgesFromLocal, localFromLinks } = require('./geometry');
const { edgeDeltasFromPointDeltas } = require('./measure');

/** Payload precision. 1e-5 of a half diagonal is sub-pixel on a 4K image. */
const STORED_DECIMALS = 5;

function round(value) {
    const factor = 10 ** STORED_DECIMALS;
    return Math.round(Number(value) * factor) / factor;
}

/** Layout + measurement → the record that goes into Cheetah. */
function buildConstellationRecord(layout, measurement) {
    return {
        v: SIGN_LAYOUT_VERSION,
        n: layout.pointCount,
        c: layout.centreIndex,
        d: measurement.pointDeltas.map((delta) => delta.map(round)),
        l: layout.links.map((link) => (
            link === null ? null : [round(link.distance), round(link.angle)]
        )),
        p: layout.centrePosition
            ? [round(layout.centrePosition.u), round(layout.centrePosition.v)]
            : null,
    };
}

/** Record → everything derived from it, in one object. */
function parseConstellationRecord(record) {
    if (!record || typeof record !== 'object') {
        throw new TypeError('constellation record must be an object');
    }
    if (record.v !== SIGN_LAYOUT_VERSION) {
        throw new TypeError(
            `constellation record layout ${record.v} is not ${SIGN_LAYOUT_VERSION}; re-ingest`
        );
    }
    const centreIndex = record.c;
    const links = record.l.map((link) => (
        link === null ? null : { distance: link[0], angle: link[1] }
    ));
    const local = localFromLinks(links, centreIndex);
    const pointDeltas = record.d;
    return {
        pointCount: record.n,
        centreIndex,
        links,
        local,
        edges: edgesFromLocal(local),
        pointDeltas,
        edgeDeltas: edgeDeltasFromPointDeltas(pointDeltas, centreIndex),
        centrePosition: record.p ? { u: record.p[0], v: record.p[1] } : null,
    };
}

/**
 * The continuous colour field of this sign: the three delta magnitudes as a
 * smooth function of position.
 *
 * `tripleIndex` selects the frame. Omitted, the field lives in the
 * constellation's own frame (centre at the origin) — right for describing one
 * sign in isolation. Given, the frame is aligned on that triple, which is the
 * only way two independently sampled signs can be compared: see
 * `alignToTriple`.
 */
function constellationField(parsed, tripleIndex = null) {
    const points = tripleIndex === null ? parsed.local : alignToTriple(parsed.local, tripleIndex);
    return new RadialBasisField(points, parsed.pointDeltas);
}

/**
 * The fixed-grid canonical descriptor.
 *
 * Only comparable between two signs when both were built on an aligned frame:
 * the grid is fixed, so an unaligned descriptor encodes where the sampler
 * happened to put the points as much as what the colours do.
 */
function constellationDescriptor(parsed, tripleIndex = null) {
    return canonicalDescriptor(constellationField(parsed, tripleIndex));
}

/**
 * How well a stored sign explains a measured one, lower is better.
 *
 * Both are re-expressed in the frame of the triple whose word matched, then the
 * candidate's field is evaluated at the query's point positions and compared
 * against the query's deltas with the study's confidence penalty: agreeing where
 * the candidate actually has observations is cheap, agreeing only by
 * extrapolation is not.
 *
 * The triple indices are not optional in practice. Without them the two frames
 * share nothing but the fact that each is centred on its own seed pixel, and the
 * score degenerates into a measure of how far apart two unrelated draws landed.
 */
function compareConstellations(candidateParsed, queryParsed, {
    candidateTriple = null,
    queryTriple = null,
    ...options
} = {}) {
    const field = constellationField(candidateParsed, candidateTriple);
    const queryPoints = queryTriple === null
        ? queryParsed.local
        : alignToTriple(queryParsed.local, queryTriple);
    const observations = queryPoints.map((point, index) => ({
        point,
        delta: queryParsed.pointDeltas[index],
    }));
    return scoreObservations(field, observations, options);
}

module.exports = {
    STORED_DECIMALS,
    buildConstellationRecord,
    compareConstellations,
    constellationDescriptor,
    constellationField,
    descriptorDistance,
    parseConstellationRecord,
    round,
};
