// The vocabulary: one integer per triple of consecutive constellation points.
//
// Why a triple and not a whole constellation, and not a single hop:
//
//   - A whole 5-point sign is 8 quantised dimensions of geometry and colour.
//     Two independently sampled constellations would essentially never land in
//     the same cell, so the vocabulary would never collide and nothing would
//     ever be recalled.
//   - A single hop is four dimensions and a few hundred cells. Every image
//     covers nearly all of them, so nothing would ever be *discriminated*.
//   - A triple — two hops, their turn angle, and the six colour deltas — sits
//     in a vocabulary of 73728 cells. An image trained with a few hundred
//     constellations occupies a characteristic subset of it, and a fresh sample
//     from the same image lands in that subset far more often than in another
//     image's. Recall is statistical, not a geometric correspondence: the query
//     never re-finds the pixels the training used.
//
// The turn angle is the reason a triple is used rather than two independent
// hops: it is invariant to the constellation's absolute orientation, so it says
// something about the image rather than about the draw.
//
// Hop *lengths* are almost absent on purpose — only a three-band scale survives.
// The radius of every hop is drawn from a distribution at sampling time, so a
// length describes the sampler, not the picture; quantising it finely would
// shatter the vocabulary along an axis that carries no signal. The band is kept
// because it conditions the colour deltas: a strong |dV| across a short hop and
// the same |dV| across a long one are different events.

const {
    DELTA_LEVELS,
    DELTA_LEVEL_EDGES,
    MAX_WORD_VARIANTS,
    SCALE_LEVELS,
    SCALE_LEVEL_EDGES,
    TURN_LEVELS,
    WORD_CARDINALITY,
    WORD_EDGE_TOLERANCE,
} = require('./constants');
const { edgesFromLocal, wrapAngle, TWO_PI } = require('./geometry');

const TURN_BIN = TWO_PI / TURN_LEVELS;

/** Level of `value` against ascending upper edges, plus its distance to the
 *  nearest edge and the level on the other side of it. */
function levelWithNeighbour(value, edges, tolerance) {
    let level = edges.length;
    for (let index = 0; index < edges.length; index += 1) {
        if (value < edges[index]) { level = index; break; }
    }
    let bestGap = Infinity;
    let alternative = null;
    for (let index = 0; index < edges.length; index += 1) {
        // The edge at `index` separates level `index` from level `index + 1`;
        // only the two edges bounding the current level can be crossed.
        if (level !== index && level !== index + 1) continue;
        const gap = Math.abs(value - edges[index]);
        // Strictly inside the tolerance, so a tolerance of 0 never sweeps.
        if (gap >= bestGap || !(gap < tolerance)) continue;
        bestGap = gap;
        alternative = level === index ? index + 1 : index;
    }
    return { level, alternative, gap: bestGap };
}

/** The same, for the cyclic turn angle: uniform bins that wrap at +/- pi. */
function turnLevelWithNeighbour(turn) {
    const wrapped = wrapAngle(turn);
    const position = (wrapped + Math.PI) / TURN_BIN;
    const level = Math.min(TURN_LEVELS - 1, Math.max(0, Math.floor(position)));
    const lower = (position - level) * TURN_BIN;
    const upper = TURN_BIN - lower;
    if (!(Math.min(lower, upper) < WORD_EDGE_TOLERANCE.turn)) {
        return { level, alternative: null, gap: Infinity };
    }
    const goDown = lower <= upper;
    return {
        level,
        alternative: (level + (goDown ? TURN_LEVELS - 1 : 1)) % TURN_LEVELS,
        gap: Math.min(lower, upper),
    };
}

/**
 * The eight quantised dimensions of one triple, in word order.
 * `edges[k]` and `edges[k+1]` are the two hops; `deltas` are their colour
 * deltas, chain-forward.
 */
function tripleDimensions(firstEdge, secondEdge, firstDelta, secondDelta) {
    const scale = (firstEdge.length + secondEdge.length) / 2;
    return [
        { ...levelWithNeighbour(scale, SCALE_LEVEL_EDGES, WORD_EDGE_TOLERANCE.scale), radix: SCALE_LEVELS },
        { ...turnLevelWithNeighbour(secondEdge.direction - firstEdge.direction), radix: TURN_LEVELS },
        ...[firstDelta[0], firstDelta[1], firstDelta[2], secondDelta[0], secondDelta[1], secondDelta[2]]
            .map((value) => ({
                ...levelWithNeighbour(value, DELTA_LEVEL_EDGES, WORD_EDGE_TOLERANCE.delta),
                radix: DELTA_LEVELS,
            })),
    ];
}

/** Mixed-radix pack of one level vector into a single word id. */
function packWord(dimensions, levels) {
    let word = 0;
    for (let index = 0; index < dimensions.length; index += 1) {
        word = word * dimensions[index].radix + levels[index];
    }
    if (!Number.isInteger(word) || word < 0 || word >= WORD_CARDINALITY) {
        throw new RangeError(`word ${word} is outside the frozen vocabulary of ${WORD_CARDINALITY}`);
    }
    return word;
}

/**
 * The words one triple asks for.
 *
 * Ingestion writes only `words[0]` — the cell the measurement actually fell in.
 * Search asks for the sweep as well: at most `MAX_WORD_VARIANTS` words, formed
 * by moving the (at most two) dimensions that sit closest to a level edge to the
 * other side of it. Soft assignment is asymmetric on purpose — it costs the
 * query a few extra seeds instead of costing every stored triple a duplicate.
 */
function tripleWords(firstEdge, secondEdge, firstDelta, secondDelta) {
    const dimensions = tripleDimensions(firstEdge, secondEdge, firstDelta, secondDelta);
    const levels = dimensions.map((dimension) => dimension.level);
    const primary = packWord(dimensions, levels);

    const sweepable = dimensions
        .map((dimension, index) => ({ index, ...dimension }))
        .filter((dimension) => dimension.alternative !== null)
        .sort((left, right) => left.gap - right.gap)
        .slice(0, Math.floor(Math.log2(MAX_WORD_VARIANTS)));

    const words = [primary];
    for (let mask = 1; mask < 2 ** sweepable.length; mask += 1) {
        const variant = levels.slice();
        sweepable.forEach((dimension, bit) => {
            if (mask & (1 << bit)) variant[dimension.index] = dimension.alternative;
        });
        words.push(packWord(dimensions, variant));
    }
    return words;
}

/** Every triple of a constellation, as `{ index, words }` in chain order. */
function constellationWords({ edges, edgeDeltas }) {
    if (!Array.isArray(edges) || !Array.isArray(edgeDeltas) || edges.length !== edgeDeltas.length) {
        throw new TypeError('edges and edgeDeltas must be parallel arrays');
    }
    const triples = [];
    for (let index = 0; index + 1 < edges.length; index += 1) {
        triples.push({
            index,
            words: tripleWords(
                edges[index],
                edges[index + 1],
                edgeDeltas[index],
                edgeDeltas[index + 1]
            ),
        });
    }
    return triples;
}

/** `constellationWords` from a local frame instead of precomputed edges. */
function constellationWordsFromLocal(local, edgeDeltas) {
    return constellationWords({ edges: edgesFromLocal(local), edgeDeltas });
}

/**
 * The eight **continuous** features of one triple, before quantisation.
 *
 * A word says only which cell a triple fell into, and the cells are coarse on
 * purpose — the top colour-delta level spans `[0.25, 1]`, so two triples sharing
 * a word can still differ by 0.6 in a channel. These are the values the word
 * threw away, and they are what lets a rerank distinguish two candidates that
 * the vocabulary cannot.
 *
 * Order matches `tripleDimensions`, so the two can be read side by side.
 */
function tripleFeatures(edges, edgeDeltas, index) {
    const first = edges[index];
    const second = edges[index + 1];
    return [
        (first.length + second.length) / 2,
        wrapAngle(second.direction - first.direction),
        ...edgeDeltas[index],
        ...edgeDeltas[index + 1],
    ];
}

/**
 * Distance between two triples in that continuous space, lower is better.
 *
 * Each dimension is divided by its own natural range before being squared, or
 * the turn angle (spanning 2*pi) would drown out six colour deltas spanning 1.
 * The turn difference is wrapped first: -pi and +pi are the same turn.
 */
function tripleFeatureDistance(left, right, { scaleRange = 0.2 } = {}) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return Infinity;
    let total = (left[0] - right[0]) ** 2 / scaleRange ** 2;
    total += (wrapAngle(left[1] - right[1]) / Math.PI) ** 2;
    for (let index = 2; index < left.length; index += 1) {
        total += (left[index] - right[index]) ** 2;
    }
    return Math.sqrt(total / left.length);
}

/** The primary word of every triple — what ingestion writes. */
function primaryWords(triples) {
    return triples.map((triple) => triple.words[0]);
}

/** Every word of every triple, deduplicated — what a query asks for. */
function allWords(triples) {
    return [...new Set(triples.flatMap((triple) => triple.words))];
}

module.exports = {
    TURN_BIN,
    allWords,
    constellationWords,
    constellationWordsFromLocal,
    levelWithNeighbour,
    packWord,
    primaryWords,
    tripleDimensions,
    tripleFeatureDistance,
    tripleFeatures,
    tripleWords,
    turnLevelWithNeighbour,
};
