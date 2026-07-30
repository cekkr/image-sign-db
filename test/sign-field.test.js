// The continuous colour field — studies/continuous_colors_function.md.
//
// The study makes four claims about this construction. Each is tested here
// because each one is what a later reader would otherwise have to take on
// trust:
//
//   1. the interpolator is *exact* at the reference points;
//   2. confidence is ~1 at a reference point and falls away from the samples;
//   3. a point surrounded by samples is trusted more than a point at the same
//      nearest-neighbour distance with samples only on one side;
//   4. the score's second term stops a candidate from winning by being
//      uncertain everywhere.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    RadialBasisField,
    canonicalDescriptor,
    choleskySolve,
    descriptorDistance,
    medianNearestNeighbour,
    probeGrid,
    scoreObservations,
} = require('../src/lib/sign/field');
const { FIELD_PROBE_GRID, FIELD_UNCERTAINTY_PENALTY } = require('../src/lib/sign/constants');

const POINTS = [
    { x: 0, y: 0 },
    { x: 0.10, y: 0.06 },
    { x: -0.08, y: 0.12 },
    { x: 0.05, y: -0.14 },
    { x: -0.13, y: -0.05 },
];
const DELTAS = [
    [0, 0, 0],
    [0.40, 0.22, 0.31],
    [0.11, 0.62, 0.08],
    [0.75, 0.05, 0.55],
    [0.20, 0.35, 0.90],
];

test('choleskySolve inverts a small positive-definite system', () => {
    const matrix = [[4, 1, 0], [1, 3, 1], [0, 1, 2]];
    const rightHand = [[1, 0], [2, 1], [3, -1]];
    const solution = choleskySolve(matrix, rightHand);
    for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 2; column += 1) {
            let value = 0;
            for (let k = 0; k < 3; k += 1) value += matrix[row][k] * solution[k][column];
            // The residual is the deliberate ridge, not error: the solver
            // answers for `matrix + jitter*I`, so `A x - b` is `-jitter * x`.
            assert.ok(Math.abs(value - rightHand[row][column]) < 1e-7);
        }
    }
});

test('the interpolator reproduces every reference value exactly', () => {
    const field = new RadialBasisField(POINTS, DELTAS);
    const { values, confidence } = field.predict(POINTS);
    values.forEach((row, index) => {
        row.forEach((value, channel) => {
            assert.ok(
                Math.abs(value - DELTAS[index][channel]) < 1e-6,
                `point ${index} channel ${channel}: ${value} != ${DELTAS[index][channel]}`
            );
        });
        assert.ok(confidence[index] > 0.999, `confidence at a sample was ${confidence[index]}`);
    });
});

test('confidence falls away from the samples', () => {
    const field = new RadialBasisField(POINTS, DELTAS);
    const { confidence } = field.predict([
        { x: 0, y: 0 },
        { x: 0.3, y: 0.3 },
        { x: 2, y: 2 },
    ]);
    assert.ok(confidence[0] > confidence[1], 'a sample must beat a nearby point');
    assert.ok(confidence[1] > confidence[2], 'a nearby point must beat a distant one');
    assert.ok(confidence[2] < 0.05, `a far point still reported ${confidence[2]}`);
    confidence.forEach((value) => assert.ok(value >= 0 && value <= 1));
});

test('geometry, not just nearest distance, decides confidence', () => {
    // Both queries sit 0.1 from their nearest sample. The first is surrounded;
    // the second has every sample on one side.
    const surrounded = new RadialBasisField(
        [{ x: -0.1, y: 0 }, { x: 0.1, y: 0 }, { x: 0, y: -0.1 }, { x: 0, y: 0.1 }],
        [[0.1, 0.1, 0.1], [0.2, 0.2, 0.2], [0.3, 0.3, 0.3], [0.4, 0.4, 0.4]]
    );
    const oneSided = new RadialBasisField(
        [{ x: -0.1, y: 0 }, { x: -0.2, y: 0 }, { x: -0.3, y: 0 }, { x: -0.4, y: 0 }],
        [[0.1, 0.1, 0.1], [0.2, 0.2, 0.2], [0.3, 0.3, 0.3], [0.4, 0.4, 0.4]]
    );
    const here = [{ x: 0, y: 0 }];
    assert.ok(
        surrounded.predict(here).confidence[0] > oneSided.predict(here).confidence[0],
        'being surrounded by samples must count for something'
    );
});

test('the median nearest-neighbour length scale is used by default', () => {
    const field = new RadialBasisField(POINTS, DELTAS);
    assert.ok(Math.abs(field.lengthScale - medianNearestNeighbour(POINTS)) < 1e-12);
    assert.equal(new RadialBasisField(POINTS, DELTAS, { lengthScale: 0.5 }).lengthScale, 0.5);
});

test('the canonical descriptor is fixed-length and comparable', () => {
    const probes = probeGrid();
    assert.equal(probes.length, FIELD_PROBE_GRID ** 2);

    const left = canonicalDescriptor(new RadialBasisField(POINTS, DELTAS));
    const right = canonicalDescriptor(new RadialBasisField(POINTS, DELTAS.map(
        (row) => row.map((value) => Math.min(1, value + 0.3))
    )));
    assert.equal(left.length, probes.length * 4);
    assert.equal(descriptorDistance(left, left), 0);
    assert.ok(descriptorDistance(left, right) > 0.05, 'a different colour field must be a different descriptor');
    assert.equal(descriptorDistance(left, [1, 2, 3]), Infinity);
});

test('the score penalises answers produced by extrapolation', () => {
    const field = new RadialBasisField(POINTS, DELTAS);

    // Same values, read where the field actually knows something.
    const near = POINTS.map((point, index) => ({ point, delta: DELTAS[index] }));
    // Same values, read where it does not.
    const far = POINTS.map((point, index) => ({
        point: { x: point.x + 3, y: point.y + 3 },
        delta: DELTAS[index],
    }));

    const nearScore = scoreObservations(field, near);
    const farScore = scoreObservations(field, far);
    assert.ok(nearScore < 1e-6, `a perfect match near the samples scored ${nearScore}`);
    assert.ok(
        Math.abs(farScore - FIELD_UNCERTAINTY_PENALTY) < 1e-3,
        `pure extrapolation should cost beta, scored ${farScore}`
    );

    // A wrong colour where the field is confident must beat neither.
    const wrong = POINTS.map((point) => ({ point, delta: [1, 1, 1] }));
    assert.ok(scoreObservations(field, wrong) > nearScore);
    assert.equal(scoreObservations(field, []), Infinity);
});
