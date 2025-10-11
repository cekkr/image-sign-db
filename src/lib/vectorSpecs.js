const { CHANNEL_DIMENSIONS } = require('./constants');
const { createDescriptorKey } = require('./descriptor');
const { createRandomConstellationSpec, computeAverageRadius } = require('./constellation');

function resolveDefaultProbeSpec(override = {}) {
    if (override.random === false) {
        const channel = override.channel ?? CHANNEL_DIMENSIONS[0];
        const dx = override.dx ?? 1;
        const dy = override.dy ?? 0;
        const gridSize = override.gridSize ?? 10;
        const descriptor = override.descriptor ?? {
            family: 'delta',
            channel,
            neighbor_dx: dx,
            neighbor_dy: dy,
        };
        const descriptorKey = createDescriptorKey(descriptor);
        return {
            gridSize,
            pos_x: override.pos_x ?? 0,
            pos_y: override.pos_y ?? 0,
            dx,
            dy,
            augmentation: override.augmentation ?? 'original',
            descriptor,
            descriptorKey,
            rel_x: override.rel_x ?? dx / gridSize,
            rel_y: override.rel_y ?? dy / gridSize,
            size: override.size ?? 1 / gridSize,
        };
    }

    const base = createRandomConstellationSpec(override);
    const gridSize = override.gridSize ?? base.gridSize;
    const dx = override.dx ?? base.dx;
    const dy = override.dy ?? base.dy;

    const descriptor = override.descriptor ?? {
        family: 'delta',
        channel: override.channel ?? base.descriptor?.channel ?? CHANNEL_DIMENSIONS[0],
        neighbor_dx: dx,
        neighbor_dy: dy,
    };
    const descriptorKey = createDescriptorKey(descriptor);

    return {
        gridSize,
        pos_x: override.pos_x ?? base.pos_x,
        pos_y: override.pos_y ?? base.pos_y,
        dx,
        dy,
        augmentation: override.augmentation ?? 'original',
        descriptor,
        descriptorKey,
        rel_x: override.rel_x ?? dx / gridSize,
        rel_y: override.rel_y ?? dy / gridSize,
        size: override.size ?? computeAverageRadius(dx, dy, gridSize),
    };
}

module.exports = {
    resolveDefaultProbeSpec,
};
