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
const { edgesFromLocal, localFromLinks } = require('./geometry');
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
 * smooth function of position in the constellation's own local frame.
 */
function constellationField(parsed) {
    return new RadialBasisField(parsed.local, parsed.pointDeltas);
}

/** The fixed-grid canonical descriptor, for cheap first-pass reranking. */
function constellationDescriptor(parsed) {
    return canonicalDescriptor(constellationField(parsed));
}

/**
 * How well a stored sign explains a measured one, lower is better.
 *
 * The candidate's field is evaluated at the query's own point positions and
 * compared against the query's own deltas, with the study's confidence penalty:
 * agreeing where the candidate actually has observations is cheap, agreeing
 * only by extrapolation is not.
 */
function compareConstellations(candidateParsed, queryParsed, options) {
    const field = constellationField(candidateParsed);
    const observations = queryParsed.local.map((point, index) => ({
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
