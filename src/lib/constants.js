const TREE_DEPTHS = Object.freeze([0, 1, 2, 3]);

const STOCHASTIC_AUGMENTATIONS = Object.freeze(['random_combo_0', 'random_combo_1', 'random_combo_2']);

const CHANNEL_DIMENSIONS = Object.freeze(['h', 's', 'v', 'luminance', 'stddev']);

const CONSTELLATION_CONSTANTS = Object.freeze({
    SAMPLES_PER_AUGMENTATION: 10000,
    MIN_RELATIVE_SPAN: 0.02,
    MAX_RELATIVE_SPAN: 0.45,
    MAX_OFFSET_MAGNITUDE: 1.5,
    ANCHOR_SCALE: 10000,
    SPAN_SCALE: 255,
    OFFSET_TOLERANCE: 1e-3,
});

module.exports = {
    TREE_DEPTHS,
    STOCHASTIC_AUGMENTATIONS,
    CHANNEL_DIMENSIONS,
    CONSTELLATION_CONSTANTS,
};
