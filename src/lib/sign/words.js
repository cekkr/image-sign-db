// The vocabulary: one integer per triple of consecutive constellation points.
//
// Why a triple and not a whole constellation, and not a single hop:
//
//   - A whole 5-point sign is a dozen quantised dimensions. Two independently
//     sampled constellations would essentially never land in the same cell, so
//     the vocabulary would never collide and nothing would ever be recalled.
//   - A single hop is three colour deltas and 64 cells. Every image covers all
//     of them at almost the same rate, so nothing would be *discriminated*.
//   - A triple is the two hops that meet at a point: six colour deltas, 4096
//     cells. A fresh sample of an image reproduces that image's *distribution*
//     over those cells far more closely than another image's. Recall is
//     statistical, not a geometric correspondence — the query never re-finds
//     the pixels the training used.
//
// The triple is still what makes this relative rather than a colour histogram:
// the six values are two colour changes that share a point, so a word says
// "here, a change of this size was followed by a change of that size", which a
// per-pixel or per-patch statistic cannot express.
//
// **Neither the hop lengths nor the turn angle enter the word.** Both are drawn
// by the sampler rather than read off the image, and including them cost more
// than half the recall — see `constants.js`, "What a word is made of", for the
// numbers. They survive as continuous values in `tripleFeatures`, for a
// comparison rather than a partition.

const {
    DELTA_LEVELS,
    DELTA_LEVEL_EDGES,
    MAX_WORD_VARIANTS,
    WORD_CARDINALITY,
    WORD_EDGE_TOLERANCE,
} = require('./constants');
const { edgesFromLocal, wrapAngle } = require('./geometry');

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

/**
 * The six quantised dimensions of one triple, in word order: the colour deltas
 * of its two hops, chain-forward.
 *
 * The two edges stay in the signature because a triple *is* the pair of hops —
 * a caller that had only the deltas could not tell which pair it held — but
 * their geometry no longer reaches the word. See the module header.
 */
function tripleDimensions(firstEdge, secondEdge, firstDelta, secondDelta) {
    return [firstDelta[0], firstDelta[1], firstDelta[2], secondDelta[0], secondDelta[1], secondDelta[2]]
        .map((value) => ({
            ...levelWithNeighbour(value, DELTA_LEVEL_EDGES, WORD_EDGE_TOLERANCE.delta),
            radix: DELTA_LEVELS,
        }));
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
 * The first two — mean hop length and turn angle — are here and *only* here.
 * They are drawn by the sampler, so quantising them into the vocabulary buys
 * nothing and costs a great deal (see the module header); comparing two
 * measured values of them is a different question and a legitimate one.
 * The remaining six line up with `tripleDimensions` in order.
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
};
