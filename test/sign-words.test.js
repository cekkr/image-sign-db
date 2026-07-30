// The vocabulary codec.
//
// A word is the join key between an image and everything the graph knows about
// it, so two properties decide whether recall works at all:
//
//   1. **Determinism and range.** The same measurement always produces the same
//      word, and no measurement ever produces one outside the frozen
//      vocabulary — a word out of range would be an unaddressable graph node.
//   2. **A bounded, correct sweep.** A query asks for at most
//      MAX_WORD_VARIANTS words, the first is always the cell the measurement
//      actually fell in, and a value sitting on a level edge does ask for the
//      cell on the other side. Without the last part a match is lost every time
//      a delta lands a thousandth away from a boundary.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    allWords,
    constellationWords,
    levelWithNeighbour,
    packWord,
    primaryWords,
    tripleDimensions,
    tripleWords,
    turnLevelWithNeighbour,
} = require('../src/lib/sign/words');
const {
    DELTA_LEVELS,
    DELTA_LEVEL_EDGES,
    MAX_WORD_VARIANTS,
    SCALE_LEVEL_EDGES,
    TURN_LEVELS,
    WORD_CARDINALITY,
    WORD_EDGE_TOLERANCE,
} = require('../src/lib/sign/constants');
const { createRandom } = require('../src/lib/sign/rng');

const edge = (length, direction) => ({ length, direction });

test('levels partition the range in ascending order', () => {
    const probes = [0, 0.01, 0.035, 0.05, 0.1, 0.2, 0.25, 0.4, 1];
    const levels = probes.map((value) => levelWithNeighbour(value, DELTA_LEVEL_EDGES, 0).level);
    for (let index = 1; index < levels.length; index += 1) {
        assert.ok(levels[index] >= levels[index - 1], 'levels must be monotonic in the value');
    }
    assert.equal(levels[0], 0);
    assert.equal(levels[levels.length - 1], DELTA_LEVELS - 1);
    // A value exactly on an edge belongs to the level above it.
    assert.equal(levelWithNeighbour(DELTA_LEVEL_EDGES[0], DELTA_LEVEL_EDGES, 0).level, 1);
});

test('only a value near an edge offers the neighbouring level', () => {
    const [first] = DELTA_LEVEL_EDGES;
    const tolerance = WORD_EDGE_TOLERANCE.delta;

    const onEdge = levelWithNeighbour(first - tolerance / 2, DELTA_LEVEL_EDGES, tolerance);
    assert.equal(onEdge.level, 0);
    assert.equal(onEdge.alternative, 1);

    const justOver = levelWithNeighbour(first + tolerance / 2, DELTA_LEVEL_EDGES, tolerance);
    assert.equal(justOver.level, 1);
    assert.equal(justOver.alternative, 0);

    // Far from every edge there is nothing to sweep to.
    assert.equal(levelWithNeighbour(0.5, DELTA_LEVEL_EDGES, tolerance).alternative, null);
    // And a zero tolerance never sweeps, even sitting on the edge.
    assert.equal(levelWithNeighbour(first, DELTA_LEVEL_EDGES, 0).alternative, null);
});

test('the turn angle wraps at both ends of its range', () => {
    const bin = (Math.PI * 2) / TURN_LEVELS;
    assert.equal(turnLevelWithNeighbour(-Math.PI + bin / 2).level, 0);
    assert.equal(turnLevelWithNeighbour(Math.PI - bin / 2).level, TURN_LEVELS - 1);

    // Just inside the lowest bin: the neighbour across the wrap is the highest.
    const low = turnLevelWithNeighbour(-Math.PI + WORD_EDGE_TOLERANCE.turn / 2);
    assert.equal(low.level, 0);
    assert.equal(low.alternative, TURN_LEVELS - 1);

    // The middle of a bin has no neighbour within tolerance.
    assert.equal(turnLevelWithNeighbour(-Math.PI + bin / 2).alternative, null);
});

test('every word is inside the frozen vocabulary and stable', () => {
    const random = createRandom('vocabulary');
    for (let trial = 0; trial < 4000; trial += 1) {
        const first = edge(random() * 0.3, (random() - 0.5) * 7);
        const second = edge(random() * 0.3, (random() - 0.5) * 7);
        const deltaA = [random(), random(), random()];
        const deltaB = [random(), random(), random()];

        const words = tripleWords(first, second, deltaA, deltaB);
        assert.ok(words.length >= 1 && words.length <= MAX_WORD_VARIANTS);
        assert.deepEqual(words, tripleWords(first, second, deltaA, deltaB), 'words must be deterministic');
        for (const word of words) {
            assert.ok(Number.isInteger(word) && word >= 0 && word < WORD_CARDINALITY, `word ${word} out of range`);
        }
        assert.equal(new Set(words).size, words.length, 'the sweep must not repeat a word');
    }
});

test('the primary word is the cell the measurement fell in', () => {
    const first = edge(SCALE_LEVEL_EDGES[0] / 2, 0);
    const second = edge(SCALE_LEVEL_EDGES[0] / 2, 0);
    const flat = [0.5, 0.5, 0.5];
    const dimensions = tripleDimensions(first, second, flat, flat);
    const expected = packWord(dimensions, dimensions.map((dimension) => dimension.level));
    assert.equal(tripleWords(first, second, flat, flat)[0], expected);
});

test('a measurement on a level edge asks for both sides', () => {
    const onEdge = DELTA_LEVEL_EDGES[1] - WORD_EDGE_TOLERANCE.delta / 4;
    const clear = 0.5;
    // A turn in the middle of its bin and a scale far from any band edge, so
    // the colour delta is the only sweepable dimension.
    const first = edge(0.05, 0);
    const second = edge(0.05, Math.PI / 6);

    const words = tripleWords(first, second, [onEdge, clear, clear], [clear, clear, clear]);
    assert.equal(words.length, 2, 'exactly one dimension was sweepable');

    // Nudging the same measurement across the edge must produce the pair the
    // other way round: the sweep is what keeps them mutually reachable.
    const across = tripleWords(
        first,
        second,
        [DELTA_LEVEL_EDGES[1] + WORD_EDGE_TOLERANCE.delta / 4, clear, clear],
        [clear, clear, clear]
    );
    assert.deepEqual([...words].sort(), [...across].sort());
});

test('the sweep is capped even when everything sits on an edge', () => {
    const nudge = WORD_EDGE_TOLERANCE.delta / 4;
    const onEdge = DELTA_LEVEL_EDGES.map((value) => value - nudge);
    const words = tripleWords(
        edge(SCALE_LEVEL_EDGES[0] - WORD_EDGE_TOLERANCE.scale / 4, 0),
        edge(SCALE_LEVEL_EDGES[0] - WORD_EDGE_TOLERANCE.scale / 4, 0),
        onEdge,
        onEdge
    );
    assert.equal(words.length, MAX_WORD_VARIANTS);
});

test('a constellation yields one triple per pair of consecutive hops', () => {
    const edges = [edge(0.08, 0), edge(0.12, 1), edge(0.09, 2), edge(0.14, 3)];
    const edgeDeltas = [[0.1, 0.2, 0.3], [0.4, 0.1, 0.2], [0.2, 0.3, 0.1], [0.5, 0.5, 0.5]];
    const triples = constellationWords({ edges, edgeDeltas });

    assert.equal(triples.length, edges.length - 1);
    triples.forEach((triple, index) => assert.equal(triple.index, index));
    assert.equal(primaryWords(triples).length, triples.length);
    assert.ok(allWords(triples).length >= triples.length);
    assert.equal(new Set(allWords(triples)).size, allWords(triples).length);

    assert.throws(() => constellationWords({ edges, edgeDeltas: edgeDeltas.slice(1) }), TypeError);
});
