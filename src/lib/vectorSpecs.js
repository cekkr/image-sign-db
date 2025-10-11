const { GRID_SIZES, NEIGHBOR_OFFSETS } = require('./constants');

function resolveDefaultProbeSpec(override = {}) {
    const gridSize =
        override.gridSize ??
        GRID_SIZES[Math.floor(GRID_SIZES.length / 2)] ??
        GRID_SIZES[0] ??
        8;
    const offset =
        override.offset ??
        NEIGHBOR_OFFSETS.find(({ dx, dy }) => dx === 1 && dy === 0) ??
        NEIGHBOR_OFFSETS[0] ?? { dx: 1, dy: 0 };

    return {
        gridSize,
        pos_x: override.pos_x ?? 0,
        pos_y: override.pos_y ?? 0,
        dx: override.dx ?? offset.dx,
        dy: override.dy ?? offset.dy,
        augmentation: override.augmentation ?? 'original',
        channel: override.channel ?? 'h',
    };
}

module.exports = {
    resolveDefaultProbeSpec,
};
