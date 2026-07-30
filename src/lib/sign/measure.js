// Turning a constellation layout into the numbers that get stored.
//
// Per the specification: read the HSV of every point, then keep only the
// **absolute difference of the three values against the neighbour** — the
// centre, having no neighbour towards the centre, is all zeros by definition.
// No absolute colour is ever recorded, which is what makes a sign survive a
// global exposure or white-balance shift, and is the colour counterpart of the
// project's "absolute pixel geometry never reaches the database" rule.
//
// Hue is circular. |0.99 - 0.01| is 0.98 as plain arithmetic and 0.02 as a hue
// distance, and those two reds are the same red; the circular distance is
// therefore doubled so that all three channels share the [0,1] range and one
// set of quantisation edges can serve them.

const { calculateStatsForRegion } = require('../gridStats');
const { POINT_PATCH_REL } = require('./constants');

/** Circular distance between two hues in [0,1], scaled to fill [0,1]. */
function hueDelta(left, right) {
    const raw = Math.abs(left - right) % 1;
    return 2 * Math.min(raw, 1 - raw);
}

/** Side, in pixels, of the square averaged for one point. Always odd and >= 1. */
function patchSide(width, height, relative = POINT_PATCH_REL) {
    const side = Math.round(Math.min(width, height) * relative);
    if (!(side > 1)) return 1;
    return side % 2 === 1 ? side : side + 1;
}

/** HSV of one point, each channel normalised to [0,1]. */
function readPointHsv(rawPixels, meta, point, side) {
    const half = (side - 1) / 2;
    const startX = Math.max(0, Math.min(meta.width - 1, point.x - half));
    const startY = Math.max(0, Math.min(meta.height - 1, point.y - half));
    const endX = Math.min(meta.width, startX + side);
    const endY = Math.min(meta.height, startY + side);
    const stats = calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY);
    return [stats.h / 360, stats.s / 100, stats.v / 100];
}

/**
 * Measure a layout against decoded pixels.
 *
 * Returns `hsv` (per point, for diagnostics only — it is never persisted),
 * `edgeDeltas` (chain-forward, one per hop) and `pointDeltas` (the stored form:
 * one per point, against the neighbour towards the centre, centre all zeros).
 */
function measureConstellation({ rawPixels, meta, layout, patchRelative = POINT_PATCH_REL }) {
    const side = patchSide(meta.width, meta.height, patchRelative);
    const hsv = layout.points.map((point) => readPointHsv(rawPixels, meta, point, side));

    const edgeDeltas = [];
    for (let index = 0; index + 1 < hsv.length; index += 1) {
        const [h1, s1, v1] = hsv[index];
        const [h2, s2, v2] = hsv[index + 1];
        edgeDeltas.push([hueDelta(h1, h2), Math.abs(s2 - s1), Math.abs(v2 - v1)]);
    }

    const { centreIndex } = layout;
    const pointDeltas = hsv.map((_, index) => {
        if (index === centreIndex) return [0, 0, 0];
        // The hop that connects this point to its parent: the edge below it on
        // the far side of the centre, the edge above it on the near side.
        return edgeDeltas[index > centreIndex ? index - 1 : index];
    });

    return { hsv, edgeDeltas, pointDeltas, patchSide: side };
}

/**
 * Inverse of the `pointDeltas` packing: the chain-forward hop deltas.
 * Used when reading a record back, where only `pointDeltas` was stored.
 */
function edgeDeltasFromPointDeltas(pointDeltas, centreIndex) {
    const edges = [];
    for (let index = 0; index + 1 < pointDeltas.length; index += 1) {
        edges.push(pointDeltas[index >= centreIndex ? index + 1 : index]);
    }
    return edges;
}

module.exports = {
    edgeDeltasFromPointDeltas,
    hueDelta,
    measureConstellation,
    patchSide,
    readPointHsv,
};
