const { CHANNEL_DIMENSIONS, CONSTELLATION_CONSTANTS } = require('./constants');
const { AUGMENTATION_ORDER } = require('./augmentations');
const { createDescriptorKey } = require('./descriptor');

const SAMPLES_PER_AUGMENTATION = CONSTELLATION_CONSTANTS.SAMPLES_PER_AUGMENTATION;
const AUGMENTATION_TO_INDEX = new Map(AUGMENTATION_ORDER.map((name, index) => [name, index]));

function hashToSeed(...parts) {
    const str = parts.join(':');
    let hash = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function mulberry32(seed) {
    return function rng() {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), 1 | t);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function getAugmentationIndex(name) {
    if (!AUGMENTATION_TO_INDEX.has(name)) {
        throw new Error(`Unknown augmentation '${name}'.`);
    }
    return AUGMENTATION_TO_INDEX.get(name);
}

function getSampleId(augmentationName, ordinal) {
    const index = getAugmentationIndex(augmentationName);
    return index * SAMPLES_PER_AUGMENTATION + ordinal;
}

function getOrdinalFromSampleId(sampleId) {
    return sampleId % SAMPLES_PER_AUGMENTATION;
}

function getAugmentationFromSampleId(sampleId) {
    const index = Math.floor(sampleId / SAMPLES_PER_AUGMENTATION);
    return AUGMENTATION_ORDER[index % AUGMENTATION_ORDER.length];
}

function generateBaseParameters(sampleId) {
    const augmentationName = getAugmentationFromSampleId(sampleId);
    const ordinal = getOrdinalFromSampleId(sampleId);
    const seed = hashToSeed('constellation', augmentationName, ordinal);
    const rng = mulberry32(seed);

    const span = CONSTELLATION_CONSTANTS.MIN_RELATIVE_SPAN +
        rng() * (CONSTELLATION_CONSTANTS.MAX_RELATIVE_SPAN - CONSTELLATION_CONSTANTS.MIN_RELATIVE_SPAN);

    // Anchor is expressed as a value in [0,1] that will later be mapped inside the valid area.
    const anchorU = rng();
    const anchorV = rng();

    // Offset expressed as multiples of the span (so >1 pushes the neighbour farther away).
    const angle = rng() * Math.PI * 2;
    const magnitude = rng() * CONSTELLATION_CONSTANTS.MAX_OFFSET_MAGNITUDE;
    const offsetX = Math.cos(angle) * magnitude;
    const offsetY = Math.sin(angle) * magnitude;

    const channelIndex = Math.floor(rng() * CHANNEL_DIMENSIONS.length);
    const channel = CHANNEL_DIMENSIONS[channelIndex];

    return {
        sampleId,
        augmentation: augmentationName,
        anchorU,
        anchorV,
        span,
        offsetX,
        offsetY,
        channel,
    };
}

function mapAnchorToImage(meta, anchorU, anchorV, span) {
    const minDim = Math.min(meta.width, meta.height);
    const spanXRel = span * (minDim / meta.width);
    const spanYRel = span * (minDim / meta.height);

    const marginX = Math.min(0.49, spanXRel);
    const marginY = Math.min(0.49, spanYRel);

    const anchorX = marginX + anchorU * (1 - 2 * marginX);
    const anchorY = marginY + anchorV * (1 - 2 * marginY);

    return { anchorX, anchorY, spanXRel, spanYRel };
}

function ensureTargetWithinBounds(anchorX, anchorY, offsetX, offsetY, spanXRel, spanYRel) {
    const targetX = anchorX + offsetX * spanXRel;
    const targetY = anchorY + offsetY * spanYRel;

    const marginX = Math.min(0.49, spanXRel);
    const marginY = Math.min(0.49, spanYRel);

    const clampedX = Math.min(1 - marginX, Math.max(marginX, targetX));
    const clampedY = Math.min(1 - marginY, Math.max(marginY, targetY));

    const adjustedOffsetX = (clampedX - anchorX) / spanXRel;
    const adjustedOffsetY = (clampedY - anchorY) / spanYRel;

    return {
        targetX: clampedX,
        targetY: clampedY,
        offsetX: adjustedOffsetX,
        offsetY: adjustedOffsetY,
    };
}

function realiseSampleOnImage(meta, baseParams) {
    const { anchorX, anchorY, spanXRel, spanYRel } = mapAnchorToImage(
        meta,
        baseParams.anchorU,
        baseParams.anchorV,
        baseParams.span,
    );
    const adjusted = ensureTargetWithinBounds(
        anchorX,
        anchorY,
        baseParams.offsetX,
        baseParams.offsetY,
        spanXRel,
        spanYRel,
    );

    return {
        anchorX,
        anchorY,
        targetX: adjusted.targetX,
        targetY: adjusted.targetY,
        offsetX: adjusted.offsetX,
        offsetY: adjusted.offsetY,
        spanXRel,
        spanYRel,
    };
}

function descriptorFromBase(base, overrides = {}) {
    const descriptor = {
        family: 'delta',
        channel: overrides.channel ?? base.channel,
        augmentation: overrides.augmentation ?? base.augmentation,
        sample_id: base.sampleId,
        anchor_u: Number((overrides.anchorU ?? base.anchorU).toFixed(6)),
        anchor_v: Number((overrides.anchorV ?? base.anchorV).toFixed(6)),
        span: Number((overrides.span ?? base.span).toFixed(6)),
        offset_x: Number((overrides.offsetX ?? base.offsetX).toFixed(6)),
        offset_y: Number((overrides.offsetY ?? base.offsetY).toFixed(6)),
    };
    return descriptor;
}

function createRandomConstellationSpec(options = {}) {
    const augmentation = options.augmentation ?? AUGMENTATION_ORDER[Math.floor(Math.random() * AUGMENTATION_ORDER.length)];
    const ordinal = Number.isFinite(options.ordinal)
        ? Math.max(0, Math.floor(options.ordinal))
        : Math.floor(Math.random() * SAMPLES_PER_AUGMENTATION);
    const sampleId = Number.isFinite(options.sampleId)
        ? Math.max(0, Math.floor(options.sampleId))
        : getSampleId(augmentation, ordinal);

    const base = generateBaseParameters(sampleId);
    const descriptor = descriptorFromBase(base, { channel: options.channel, augmentation });
    const descriptorKey = createDescriptorKey(descriptor);

    return {
        sampleId,
        augmentation: descriptor.augmentation,
        channel: descriptor.channel,
        anchor_u: descriptor.anchor_u,
        anchor_v: descriptor.anchor_v,
        span: descriptor.span,
        offset_x: descriptor.offset_x,
        offset_y: descriptor.offset_y,
        descriptor,
        descriptorKey,
    };
}

function descriptorToSpec(descriptor) {
    if (!descriptor || descriptor.family !== 'delta') return null;
    const sampleId = Number(descriptor.sample_id);
    if (!Number.isFinite(sampleId)) return null;
    const base = generateBaseParameters(sampleId);
    const augmentedBase = {
        ...base,
        channel: descriptor.channel ?? base.channel,
        augmentation: descriptor.augmentation ?? base.augmentation,
        anchorU: descriptor.anchor_u ?? base.anchorU,
        anchorV: descriptor.anchor_v ?? base.anchorV,
        span: descriptor.span ?? base.span,
        offsetX: descriptor.offset_x ?? base.offsetX,
        offsetY: descriptor.offset_y ?? base.offsetY,
    };
    const normalizedDescriptor = descriptorFromBase(augmentedBase);
    const descriptorKey = createDescriptorKey(normalizedDescriptor);
    return {
        sampleId,
        augmentation: normalizedDescriptor.augmentation,
        channel: normalizedDescriptor.channel,
        anchor_u: normalizedDescriptor.anchor_u,
        anchor_v: normalizedDescriptor.anchor_v,
        span: normalizedDescriptor.span,
        offset_x: normalizedDescriptor.offset_x,
        offset_y: normalizedDescriptor.offset_y,
        descriptor: normalizedDescriptor,
        descriptorKey,
    };
}

function extendConstellationPath(path = [], stepInput = {}) {
    const step = {
        descriptorKey: stepInput.descriptorKey,
        candidateCount: stepInput.candidateCount ?? 0,
        rel_x: stepInput.rel_x ?? 0,
        rel_y: stepInput.rel_y ?? 0,
        size: stepInput.size ?? 0,
    };
    const accuracyScore = step.candidateCount > 0 ? 1 / step.candidateCount : 0;
    const previousCumulative = path.length > 0 ? path[path.length - 1].cumulativeAccuracy ?? 1 : 1;
    step.accuracyScore = Number(accuracyScore.toFixed(6));
    step.cumulativeAccuracy = Number((previousCumulative * (step.accuracyScore || 1)).toFixed(6));
    return [...path, step];
}

module.exports = {
    createRandomConstellationSpec,
    descriptorToSpec,
    extendConstellationPath,
    getSampleId,
    getOrdinalFromSampleId,
    generateBaseParameters,
    realiseSampleOnImage,
    SAMPLES_PER_AUGMENTATION,
};
