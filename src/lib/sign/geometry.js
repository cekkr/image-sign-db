// Constellation geometry: where the points of one sign land, and in what units
// their relationship is written down.
//
// A constellation is a chain of an odd number of points (default 5). The seed
// pixel is the **centre** of the chain, which is what makes "the central point
// has everything at 0" well defined; the chain then grows outwards in both
// directions, each new point one random hop from the previous one.
//
// One hop:
//   - draw a circumference length uniformly between 0.25 and 1.0 times the mean
//     image side, and take its radius (see constants.js on why the radius
//     reading of the specification cannot be placed inside the frame);
//   - draw a uniform angle, and keep it only if the point lands on a real pixel;
//   - after MAX_ANGLE_ATTEMPTS rejections, shrink the radius and try again.
//
// Rejection sampling rather than solving for the admissible angular intervals is
// deliberate: it keeps the distribution of *accepted* angles uniform over the
// part of the circle that is inside the image, which is exactly the "random
// angle on an existing pixel" the specification asks for. Solving for the
// intervals and drawing uniformly within them would give the same set but a
// different measure once several disjoint arcs are involved.
//
// **The unit of length is the half diagonal** — "1" is the distance from the
// centre of the image to a corner. Every distance and every optional centre
// position below is expressed in it, which is what makes a sign comparable
// between an image and a rescaled copy of it.

const {
    CIRCUMFERENCE_MAX_FACTOR,
    CIRCUMFERENCE_MIN_FACTOR,
    CIRCUMFERENCE_TO_RADIUS,
    DEFAULT_POINT_COUNT,
    MAX_ANGLE_ATTEMPTS,
    MAX_RADIUS_SHRINKS,
    RADIUS_SHRINK_FACTOR,
} = require('./constants');

const TWO_PI = Math.PI * 2;

/** Wrap an angle into (-pi, pi]. The comparison form for every turn. */
function wrapAngle(angle) {
    const wrapped = ((angle + Math.PI) % TWO_PI + TWO_PI) % TWO_PI;
    return wrapped - Math.PI;
}

/** Wrap an angle into [0, 2pi). The storage form for every hop bearing. */
function normalizeAngle(angle) {
    return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

/** The measurement units an image imposes on a sign. */
function imageScale(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
        throw new RangeError(`image must be at least 2x2 with integer sides, got ${width}x${height}`);
    }
    return {
        width,
        height,
        meanSide: (width + height) / 2,
        halfDiagonal: Math.sqrt(width * width + height * height) / 2,
    };
}

function assertPointCount(pointCount) {
    if (!Number.isInteger(pointCount) || pointCount < 3 || pointCount % 2 === 0) {
        throw new RangeError(`pointCount must be an odd integer >= 3, got ${pointCount}`);
    }
    return pointCount;
}

/** One hop from `(x, y)`, or null when no admissible angle was found. */
function hopFrom(x, y, scale, random) {
    const { width, height, meanSide } = scale;
    for (let shrink = 0; shrink <= MAX_RADIUS_SHRINKS; shrink += 1) {
        const circumference = meanSide * (
            CIRCUMFERENCE_MIN_FACTOR +
            random() * (CIRCUMFERENCE_MAX_FACTOR - CIRCUMFERENCE_MIN_FACTOR)
        );
        const radius = circumference * CIRCUMFERENCE_TO_RADIUS * RADIUS_SHRINK_FACTOR ** shrink;
        for (let attempt = 0; attempt < MAX_ANGLE_ATTEMPTS; attempt += 1) {
            const angle = random() * TWO_PI;
            const nextX = Math.round(x + radius * Math.cos(angle));
            const nextY = Math.round(y + radius * Math.sin(angle));
            if (nextX < 0 || nextY < 0 || nextX > width - 1 || nextY > height - 1) continue;
            return { x: nextX, y: nextY };
        }
    }
    return null;
}

/**
 * Sample one constellation on a `width` x `height` image.
 *
 * Returns null when the seed pixel could not be grown into a full chain — the
 * caller draws another seed rather than accepting a truncated sign. Points are
 * returned in **chain order**, so `points[centreIndex]` is the seed.
 *
 * `withCentrePosition` is off by default. Recording where the centre sits makes
 * a sign refuse to match the same subject photographed at a different aspect
 * ratio, because the half-diagonal unit rescales differently on each axis; the
 * specification calls this out and the flag exists to study it, not to use it.
 */
function sampleConstellation({
    width,
    height,
    pointCount = DEFAULT_POINT_COUNT,
    random = Math.random,
    withCentrePosition = false,
} = {}) {
    assertPointCount(pointCount);
    const scale = imageScale(width, height);
    const centreIndex = (pointCount - 1) / 2;

    const points = new Array(pointCount);
    points[centreIndex] = {
        x: Math.floor(random() * width),
        y: Math.floor(random() * height),
    };

    // Outwards in both directions: every point hops from the one nearer the
    // centre, so the chain is generated from the same seed the deltas are
    // measured against.
    for (const step of [1, -1]) {
        for (
            let index = centreIndex + step;
            index >= 0 && index < pointCount;
            index += step
        ) {
            const from = points[index - step];
            const next = hopFrom(from.x, from.y, scale, random);
            if (next === null) return null;
            points[index] = next;
        }
    }

    return layoutFromPoints(points, centreIndex, scale, withCentrePosition);
}

/** Chain-order pixel points → the derived, unit-normalised layout. */
function layoutFromPoints(points, centreIndex, scale, withCentrePosition = false) {
    const centre = points[centreIndex];
    const local = points.map((point) => ({
        x: (point.x - centre.x) / scale.halfDiagonal,
        y: (point.y - centre.y) / scale.halfDiagonal,
    }));

    const edges = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
        const dx = local[index + 1].x - local[index].x;
        const dy = local[index + 1].y - local[index].y;
        edges.push({
            length: Math.hypot(dx, dy),
            direction: Math.atan2(dy, dx),
        });
    }

    // The stored form the specification asks for: per point, the distance from
    // its neighbour towards the centre and the bearing of that hop. The centre
    // itself has no parent, so it carries null — the counterpart of its
    // all-zero colour delta.
    const links = points.map((point, index) => {
        if (index === centreIndex) return null;
        const parent = index > centreIndex ? index - 1 : index + 1;
        const dx = local[index].x - local[parent].x;
        const dy = local[index].y - local[parent].y;
        return {
            distance: Math.hypot(dx, dy),
            angle: normalizeAngle(Math.atan2(dy, dx)),
        };
    });

    return {
        pointCount: points.length,
        centreIndex,
        points,
        local,
        edges,
        links,
        centrePosition: withCentrePosition
            ? {
                u: (centre.x - scale.width / 2) / scale.halfDiagonal,
                v: (centre.y - scale.height / 2) / scale.halfDiagonal,
            }
            : null,
        scale,
    };
}

/**
 * Rebuild the local frame from stored `links` alone.
 *
 * This is the reason `links` is the persisted form and `local` is not: distance
 * plus bearing per hop is the whole geometry, and walking it back out here
 * proves the record kept everything the field needs.
 */
function localFromLinks(links, centreIndex) {
    const pointCount = links.length;
    const local = new Array(pointCount);
    local[centreIndex] = { x: 0, y: 0 };
    for (const step of [1, -1]) {
        for (
            let index = centreIndex + step;
            index >= 0 && index < pointCount;
            index += step
        ) {
            const parent = local[index - step];
            const link = links[index];
            if (!link) throw new TypeError(`link ${index} is missing from the record`);
            local[index] = {
                x: parent.x + link.distance * Math.cos(link.angle),
                y: parent.y + link.distance * Math.sin(link.angle),
            };
        }
    }
    return local;
}

/** Chain-forward hop lengths and bearings derived from a local frame. */
function edgesFromLocal(local) {
    const edges = [];
    for (let index = 0; index + 1 < local.length; index += 1) {
        const dx = local[index + 1].x - local[index].x;
        const dy = local[index + 1].y - local[index].y;
        edges.push({ length: Math.hypot(dx, dy), direction: Math.atan2(dy, dx) });
    }
    return edges;
}

module.exports = {
    TWO_PI,
    assertPointCount,
    edgesFromLocal,
    hopFrom,
    imageScale,
    layoutFromPoints,
    localFromLinks,
    normalizeAngle,
    sampleConstellation,
    wrapAngle,
};
