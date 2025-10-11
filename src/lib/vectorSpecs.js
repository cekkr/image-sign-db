const { GRID_SIZES, NEIGHBOR_OFFSETS } = require('./constants');

function buildRelativeGradientType(gridSize, offsetKey) {
    return `hsv_rel_gradient_g${gridSize}_${offsetKey}`;
}

function buildVectorType(baseType, augmentationName) {
    return augmentationName === 'original' ? baseType : `${baseType}#${augmentationName}`;
}

function extractAugmentationFromType(type) {
    if (!type) return 'original';
    const idx = type.indexOf('#');
    return idx === -1 ? 'original' : type.slice(idx + 1);
}

function parseRelativeGradientType(baseType) {
    const match = baseType.match(/^hsv_rel_gradient_g(\d+)_dx(\d+)dy(\d+)$/);
    if (!match) return null;
    return {
        gridSize: parseInt(match[1], 10),
        dx: parseInt(match[2], 10),
        dy: parseInt(match[3], 10),
    };
}

function resolveDefaultProbeSpec(override = {}) {
    const grid = override.gridSize ?? GRID_SIZES[Math.floor(GRID_SIZES.length / 2)] ?? GRID_SIZES[0] ?? 8;
    const offset =
        override.offset ??
        NEIGHBOR_OFFSETS.find(({ dx, dy }) => dx === 1 && dy === 0) ??
        NEIGHBOR_OFFSETS[0] ?? { dx: 1, dy: 0, key: 'dx1dy0' };
    const vector_type = buildRelativeGradientType(grid, offset.key);
    return {
        vector_type,
        augmentation: 'original',
        resolution_level: grid,
        pos_x: override.pos_x ?? 0,
        pos_y: override.pos_y ?? 0,
    };
}

module.exports = {
    buildRelativeGradientType,
    buildVectorType,
    extractAugmentationFromType,
    parseRelativeGradientType,
    resolveDefaultProbeSpec,
};
