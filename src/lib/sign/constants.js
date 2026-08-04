// Frozen constants of the *sign* algorithm (studies/continuous_colors_function.md
// plus the constellation specification it serves).
//
// Everything here is a **wire format**, exactly like src/lib/constants.js is for
// the `delta` family. The quantisation tables below decide which word a triple
// falls into, so changing any of them re-partitions the whole vocabulary and
// makes every stored graph edge point at the wrong word. That is why none of
// them is an environment variable: change a number here and bump
// SIGN_LAYOUT_VERSION, which `SignStore.connect()` refuses to read across.
//
// Two reading decisions the specification left open are recorded here, because
// they are the ones a later reader will want to challenge:
//
//   1. "a random length of a circumference from (H+W)/2 and this one * 0.25"
//      is read as the *circumference* (perimeter) of the circle, so the radius
//      is C/2pi. Reading it as a radius makes the constellation impossible to
//      place: on a square image a radius of (H+W)/2 = W exceeds the half
//      diagonal 0.707*W, so no angle at all lands inside the frame.
//      CIRCUMFERENCE_TO_RADIUS is the whole of that decision; set it to 1 to
//      get the radius reading back.
//   2. "the absolute difference of the three values" is a circular distance for
//      hue, doubled so that all three deltas share the [0,1] range. An ordinary
//      |h1 - h2| would report two nearly identical reds as maximally different.

/**
 * Bump on any change below. Stored at `cfg:sign_layout_version`; a database
 * written by a different layout is rejected rather than silently misread.
 *
 * v2 removed the hop scale band and the turn angle from the word. See
 * "What a word is made of" below for the measurement that forced it.
 */
const SIGN_LAYOUT_VERSION = 2;

/** Points per constellation. Must be odd so that a single centre exists. */
const DEFAULT_POINT_COUNT = 5;

/** The scale reference for a drawn circumference is the mean image side. */
const CIRCUMFERENCE_MIN_FACTOR = 0.25;
const CIRCUMFERENCE_MAX_FACTOR = 1.0;
const CIRCUMFERENCE_TO_RADIUS = 1 / (2 * Math.PI);

/** Rejection sampling budget for "a random angle that lands on a real pixel". */
const MAX_ANGLE_ATTEMPTS = 24;
const MAX_RADIUS_SHRINKS = 6;
const RADIUS_SHRINK_FACTOR = 0.75;

/**
 * A point is read as the mean of a small square rather than one raw pixel.
 * The specification says "the HSV of each pixel"; a single sample is dominated
 * by sensor and JPEG noise and does not survive a re-encode, so the default is
 * a patch of 0.4% of the shorter side (1 px on anything below ~250 px, which is
 * the literal reading). Set SIGN_POINT_PATCH_REL to 0 for exactly one pixel.
 */
const POINT_PATCH_REL = 0.004;

// ---------------------------------------------------------------------------
// Vocabulary quantisation (see words.js)
// ---------------------------------------------------------------------------
//
// ## What a word is made of
//
// A *word* is a triple of consecutive constellation points reduced to one
// integer: the six quantised colour-delta magnitudes of its two hops, and
// nothing else. The level tables are deliberately non-uniform, because colour
// deltas between two points a tenth of an image apart pile up near zero and
// uniform bins would put most of the corpus in one cell.
//
// **Neither hop length nor turn angle is part of a word, and that is a
// measurement, not a preference.** `geometry.hopFrom` draws each hop's radius
// uniformly from a circumference range and each bearing uniformly from the
// circle, so the mean hop length and the turn between two hops are properties of
// the *draw*, not of the picture. Putting them in the word did not add
// information; it shattered every real observation across 18 arbitrary cells, so
// a fresh sample of an image almost never re-landed in the cell its own training
// had written. Measured on `sample_images/`, 100 images at 512 constellations,
// ranked by tf-idf cosine over exactly the same measurements:
//
//     scale3 · turn6 · delta4^6  (73728 cells)   rank-1  45/100
//     scale3 ·         delta4^6  (12288 cells)   rank-1  73/100
//               turn2 · delta4^6  (8192 cells)   rank-1  81/100
//                       delta4^6   (4096 cells)  rank-1  93/100
//
// The turn's defence in the earlier revision — that it is invariant to the
// constellation's absolute orientation — is true and beside the point: an
// invariant of a random draw is still a random draw. What survives of the
// geometry lives in `words.tripleFeatures`, which keeps scale and turn as
// *continuous* values for the reranker, where they are compared rather than
// used as a partition.

/** Upper edges of the four |dH| / |dS| / |dV| levels. */
const DELTA_LEVEL_EDGES = Object.freeze([0.035, 0.10, 0.25]);

const DELTA_LEVELS = DELTA_LEVEL_EDGES.length + 1;

/**
 * |vocabulary| = 4^6 = 4096.
 *
 * Small on purpose. A word is now a cell that a fresh draw actually re-enters,
 * which means an image's signature is a *distribution* over the vocabulary
 * rather than a sparse set of near-unique tokens — and the resolver has to
 * compare distributions. See `signPipeline.Evidence`: with the old vocabulary,
 * set membership was nearly all the information there was; with this one,
 * counts are, and a resolver that ignores them scores 10/100 where one that
 * uses them scores 94/100.
 */
const WORD_CARDINALITY = DELTA_LEVELS ** 6;

/**
 * How close to a level edge a measured value has to be before the query also
 * asks for the neighbouring level. Only the query side sweeps (soft assignment
 * is asymmetric): ingestion writes one word per triple, search asks for a few.
 */
const WORD_EDGE_TOLERANCE = Object.freeze({
    delta: 0.02,
});

/** Hard cap on the words one measured triple may ask for. */
const MAX_WORD_VARIANTS = 4;

// ---------------------------------------------------------------------------
// Continuous colour field (studies/continuous_colors_function.md)
// ---------------------------------------------------------------------------

/** Ridge added to the kernel diagonal so the solve stays conditioned. */
const FIELD_JITTER = 1e-9;
/** Fallback length scale when the points are degenerate (all coincident). */
const FIELD_MIN_LENGTH_SCALE = 1e-3;
/** Half-width of the fixed probe square, in half-diagonal units. */
const FIELD_PROBE_RADIUS = 0.35;
/** Probes per axis of the canonical descriptor (4x4 = 16 probes, 64 values). */
const FIELD_PROBE_GRID = 4;

/** Per-channel weights of the study's colour error E_j. */
const FIELD_ERROR_WEIGHTS = Object.freeze({ h: 1.0, s: 1.0, v: 1.0 });
/** The study's beta: what an answer produced by pure extrapolation costs. */
const FIELD_UNCERTAINTY_PENALTY = 0.5;

module.exports = Object.freeze({
    CIRCUMFERENCE_MAX_FACTOR,
    CIRCUMFERENCE_MIN_FACTOR,
    CIRCUMFERENCE_TO_RADIUS,
    DEFAULT_POINT_COUNT,
    DELTA_LEVELS,
    DELTA_LEVEL_EDGES,
    FIELD_ERROR_WEIGHTS,
    FIELD_JITTER,
    FIELD_MIN_LENGTH_SCALE,
    FIELD_PROBE_GRID,
    FIELD_PROBE_RADIUS,
    FIELD_UNCERTAINTY_PENALTY,
    MAX_ANGLE_ATTEMPTS,
    MAX_RADIUS_SHRINKS,
    MAX_WORD_VARIANTS,
    POINT_PATCH_REL,
    RADIUS_SHRINK_FACTOR,
    SIGN_LAYOUT_VERSION,
    WORD_CARDINALITY,
    WORD_EDGE_TOLERANCE,
});
