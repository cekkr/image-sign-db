const GRID_SIZES = Object.freeze([6, 10, 14]);

const NEIGHBOR_OFFSETS = Object.freeze([
    { dx: 1, dy: 0, key: 'dx1dy0' },
    { dx: 0, dy: 1, key: 'dx0dy1' },
    { dx: 1, dy: 1, key: 'dx1dy1' },
    { dx: 2, dy: 0, key: 'dx2dy0' },
    { dx: 0, dy: 2, key: 'dx0dy2' },
]);

const TREE_DEPTHS = Object.freeze([0, 1, 2, 3]);

const STOCHASTIC_AUGMENTATIONS = Object.freeze(['random_combo_0', 'random_combo_1', 'random_combo_2']);

const CHANNEL_DIMENSIONS = Object.freeze(['h', 's', 'v', 'luminance', 'stddev']);

module.exports = {
    GRID_SIZES,
    NEIGHBOR_OFFSETS,
    TREE_DEPTHS,
    STOCHASTIC_AUGMENTATIONS,
    CHANNEL_DIMENSIONS,
};
