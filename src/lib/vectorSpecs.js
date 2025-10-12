const { createDescriptorKey } = require('./descriptor');
const { createRandomConstellationSpec, descriptorToSpec } = require('./constellation');

function resolveDefaultProbeSpec(override = {}) {
    if (override.random === false) {
        if (override.descriptor) {
            const resolved = descriptorToSpec(override.descriptor);
            if (!resolved) return null;
            return {
                ...resolved,
                descriptorKey: resolved.descriptorKey,
                augmentation: override.augmentation ?? resolved.augmentation,
                channel: override.channel ?? resolved.channel,
                rel_x: override.rel_x ?? resolved.offset_x ?? 0,
                rel_y: override.rel_y ?? resolved.offset_y ?? 0,
                size: override.size ?? resolved.span ?? 0,
            };
        }

        const descriptor = {
            family: 'delta',
            channel: override.channel ?? 'h',
            augmentation: override.augmentation ?? 'original',
            sample_id: override.sampleId ?? 0,
            anchor_u: override.anchor_u ?? 0.5,
            anchor_v: override.anchor_v ?? 0.5,
            span: override.span ?? 0.05,
            offset_x: override.offset_x ?? 0,
            offset_y: override.offset_y ?? 0,
        };
        const descriptorKey = createDescriptorKey(descriptor);
        return {
            descriptor,
            descriptorKey,
            sampleId: descriptor.sample_id,
            augmentation: descriptor.augmentation,
            channel: descriptor.channel,
            anchor_u: descriptor.anchor_u,
            anchor_v: descriptor.anchor_v,
            span: descriptor.span,
            offset_x: descriptor.offset_x,
            offset_y: descriptor.offset_y,
            rel_x: descriptor.offset_x,
            rel_y: descriptor.offset_y,
            size: descriptor.span,
        };
    }

    const base = createRandomConstellationSpec(override);
    return {
        ...base,
        rel_x: base.offset_x,
        rel_y: base.offset_y,
        size: base.span,
    };
}

module.exports = {
    resolveDefaultProbeSpec,
};
