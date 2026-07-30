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
 */
const SIGN_LAYOUT_VERSION = 1;

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
// A *word* is a triple of consecutive constellation points reduced to one
// integer. The level tables are deliberately non-uniform: colour deltas between
// two points a tenth of an image apart pile up near zero, so uniform bins would
// put most of the corpus in one cell and the vocabulary would not separate
// anything.
//
// Distances are NOT part of a word. The radius of every hop is drawn at
// sampling time, so a distance describes the sampler, not the image; only the
// coarse SCALE band survives, and only because it conditions how large a colour
// delta means something.

/** Upper edges of the four |dH| / |dS| / |dV| levels. */
const DELTA_LEVEL_EDGES = Object.freeze([0.035, 0.10, 0.25]);
/** Upper edges of the three mean-hop-length bands, in half-diagonal units. */
const SCALE_LEVEL_EDGES = Object.freeze([0.11, 0.17]);
/** Uniform bins of the turn angle between the two hops of a triple. */
const TURN_LEVELS = 6;

const DELTA_LEVELS = DELTA_LEVEL_EDGES.length + 1;
const SCALE_LEVELS = SCALE_LEVEL_EDGES.length + 1;

/** |vocabulary| = 3 * 6 * 4^6 = 73728, comfortably inside 5 hex digits. */
const WORD_CARDINALITY = SCALE_LEVELS * TURN_LEVELS * DELTA_LEVELS ** 6;

/**
 * How close to a level edge a measured value has to be before the query also
 * asks for the neighbouring level. Only the query side sweeps (soft assignment
 * is asymmetric): ingestion writes one word per triple, search asks for a few.
 */
const WORD_EDGE_TOLERANCE = Object.freeze({
    delta: 0.02,
    scale: 0.012,
    turn: 0.13,
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
    SCALE_LEVELS,
    SCALE_LEVEL_EDGES,
    SIGN_LAYOUT_VERSION,
    TURN_LEVELS,
    WORD_CARDINALITY,
    WORD_EDGE_TOLERANCE,
});
