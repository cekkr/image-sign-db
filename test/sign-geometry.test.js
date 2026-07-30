// Constellation geometry — the properties the rest of the pipeline assumes.
//
// Three of them are load-bearing:
//
//   1. Every point lands on a real pixel. A hop that fell outside the frame
//      would be measured against clamped coordinates, so its distance and its
//      colour delta would describe a place the image does not have.
//   2. `links` is a complete description of the geometry. It is the only form
//      persisted, so if walking it back out does not reproduce the local frame,
//      every stored sign is unreadable.
//   3. The unit is the half diagonal, and it is the same unit at every size, so
//      the same layout on a rescaled image gives the same numbers.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    edgesFromLocal,
    imageScale,
    layoutFromPoints,
    localFromLinks,
    normalizeAngle,
    sampleConstellation,
    wrapAngle,
} = require('../src/lib/sign/geometry');
const { createRandom } = require('../src/lib/sign/rng');
const { DEFAULT_POINT_COUNT } = require('../src/lib/sign/constants');

const SIZES = [[64, 64], [640, 480], [480, 640], [1024, 768], [4000, 3000], [300, 1200]];

test('every sampled point lands on a real pixel', () => {
    for (const [width, height] of SIZES) {
        const random = createRandom(`bounds:${width}x${height}`);
        let placed = 0;
        for (let trial = 0; trial < 200; trial += 1) {
            const layout = sampleConstellation({ width, height, random });
            if (layout === null) continue;
            placed += 1;
            assert.equal(layout.points.length, DEFAULT_POINT_COUNT);
            for (const point of layout.points) {
                assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
                assert.ok(point.x >= 0 && point.x <= width - 1, `x ${point.x} outside 0..${width - 1}`);
                assert.ok(point.y >= 0 && point.y <= height - 1, `y ${point.y} outside 0..${height - 1}`);
            }
        }
        // Rejection sampling is allowed to fail on a hostile aspect ratio, but
        // not often enough to starve ingestion.
        assert.ok(placed > 150, `only ${placed}/200 constellations placed on ${width}x${height}`);
    }
});

test('the centre is the seed and has no link', () => {
    const layout = sampleConstellation({ width: 800, height: 600, random: createRandom('centre') });
    assert.equal(layout.centreIndex, (DEFAULT_POINT_COUNT - 1) / 2);
    assert.equal(layout.links[layout.centreIndex], null);
    assert.deepEqual(layout.local[layout.centreIndex], { x: 0, y: 0 });
    layout.links.forEach((link, index) => {
        if (index === layout.centreIndex) return;
        assert.ok(link.distance > 0);
        assert.ok(link.angle >= 0 && link.angle < Math.PI * 2);
    });
});

test('links alone reproduce the local frame', () => {
    const random = createRandom('roundtrip');
    for (let trial = 0; trial < 200; trial += 1) {
        const layout = sampleConstellation({ width: 1024, height: 768, random });
        if (layout === null) continue;
        const rebuilt = localFromLinks(layout.links, layout.centreIndex);
        layout.local.forEach((point, index) => {
            assert.ok(Math.abs(point.x - rebuilt[index].x) < 1e-9, `x drift at ${index}`);
            assert.ok(Math.abs(point.y - rebuilt[index].y) < 1e-9, `y drift at ${index}`);
        });
        const rebuiltEdges = edgesFromLocal(rebuilt);
        layout.edges.forEach((edge, index) => {
            assert.ok(Math.abs(edge.length - rebuiltEdges[index].length) < 1e-9);
            assert.ok(Math.abs(wrapAngle(edge.direction - rebuiltEdges[index].direction)) < 1e-9);
        });
    }
});

test('the half-diagonal unit makes a rescaled image give the same numbers', () => {
    // The same relative layout, laid out on a 2x larger canvas.
    const small = [{ x: 100, y: 80 }, { x: 200, y: 120 }, { x: 150, y: 200 },
        { x: 60, y: 260 }, { x: 240, y: 300 }];
    const large = small.map((point) => ({ x: point.x * 2, y: point.y * 2 }));

    const layoutSmall = layoutFromPoints(small, 2, imageScale(400, 400));
    const layoutLarge = layoutFromPoints(large, 2, imageScale(800, 800));

    layoutSmall.links.forEach((link, index) => {
        if (link === null) return assert.equal(layoutLarge.links[index], null);
        assert.ok(Math.abs(link.distance - layoutLarge.links[index].distance) < 1e-12);
        assert.ok(Math.abs(link.angle - layoutLarge.links[index].angle) < 1e-12);
    });
});

test('the centre position is opt-in and measured from the image centre', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 50, y: 50 }, { x: 90, y: 90 }, { x: 99, y: 99 }];
    const scale = imageScale(100, 100);
    assert.equal(layoutFromPoints(points, 2, scale).centrePosition, null);

    const withPosition = layoutFromPoints(points, 2, scale, true);
    // The seed sits exactly on the image centre, so both coordinates are zero.
    assert.ok(Math.abs(withPosition.centrePosition.u) < 1e-12);
    assert.ok(Math.abs(withPosition.centrePosition.v) < 1e-12);

    // A corner is exactly one unit away: that is the definition of the unit.
    const corner = layoutFromPoints(
        [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 20 }, { x: 30, y: 30 }],
        2,
        scale,
        true
    );
    assert.ok(Math.abs(Math.hypot(corner.centrePosition.u, corner.centrePosition.v) - 1) < 1e-9);
});

test('an even or too-small point count is refused', () => {
    for (const pointCount of [2, 4, 6, 1, 0, 3.5]) {
        assert.throws(
            () => sampleConstellation({ width: 100, height: 100, pointCount }),
            RangeError
        );
    }
    assert.ok(sampleConstellation({ width: 200, height: 200, pointCount: 7 }) !== null);
});

test('angle helpers agree on the two conventions', () => {
    for (const angle of [-7, -Math.PI, 0, 0.5, Math.PI, 3.5, 9]) {
        assert.ok(wrapAngle(angle) > -Math.PI - 1e-12 && wrapAngle(angle) <= Math.PI + 1e-12);
        assert.ok(normalizeAngle(angle) >= 0 && normalizeAngle(angle) < Math.PI * 2);
        assert.ok(Math.abs(wrapAngle(normalizeAngle(angle) - angle)) < 1e-12);
    }
});
