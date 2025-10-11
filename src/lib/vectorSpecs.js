const { GRID_SIZES, NEIGHBOR_OFFSETS, CHANNEL_DIMENSIONS } = require('./constants');
const { createDescriptorKey } = require('./descriptor');

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

    const channel = override.channel ?? CHANNEL_DIMENSIONS[0];
    const descriptor = override.descriptor ?? {
        family: 'delta',
        channel,
        neighbor_dx: override.dx ?? offset.dx,
        neighbor_dy: override.dy ?? offset.dy,
    };
    const descriptorKey = createDescriptorKey(descriptor);

    return {
        gridSize,
        pos_x: override.pos_x ?? 0,
        pos_y: override.pos_y ?? 0,
        dx: override.dx ?? offset.dx,
        dy: override.dy ?? offset.dy,
        augmentation: override.augmentation ?? 'original',
        descriptor,
        descriptorKey,
    };
}

module.exports = {
    resolveDefaultProbeSpec,
};
