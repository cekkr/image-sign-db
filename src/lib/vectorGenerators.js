const sharp = require('sharp');
const { CONSTELLATION_CONSTANTS } = require('./constants');
const { applyAugmentation } = require('./augmentations');
const { calculateStatsForRegion, getRawPixels } = require('./gridStats');
const { createDescriptorKey } = require('./descriptor');
const {
    generateBaseParameters,
    realiseSampleOnImage,
    getSampleId,
    SAMPLES_PER_AUGMENTATION,
} = require('./constellation');

const CHANNEL_NORMALISERS = Object.freeze({
    h: 360,
    s: 100,
    v: 100,
    luminance: 255,
    stddev: 255,
});

function calculateRelativeRegionStats(rawPixels, meta, centerXRel, centerYRel, spanXRel, spanYRel) {
    const width = meta.width;
    const height = meta.height;

    const halfWidth = Math.max(1, Math.round((spanXRel * width) / 2));
    const halfHeight = Math.max(1, Math.round((spanYRel * height) / 2));
    const centerX = Math.round(centerXRel * width);
    const centerY = Math.round(centerYRel * height);

    const startX = Math.max(0, centerX - halfWidth);
    const endX = Math.min(width, centerX + halfWidth);
    const startY = Math.max(0, centerY - halfHeight);
    const endY = Math.min(height, centerY + halfHeight);

    if (endX <= startX || endY <= startY) return null;
    return calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY);
}

function computeChannelDeltas(anchorStats, targetStats) {
    if (!anchorStats || !targetStats) return null;
    return {
        h: (targetStats.h - anchorStats.h) / CHANNEL_NORMALISERS.h,
        s: (targetStats.s - anchorStats.s) / CHANNEL_NORMALISERS.s,
        v: (targetStats.v - anchorStats.v) / CHANNEL_NORMALISERS.v,
        luminance: (targetStats.luminance - anchorStats.luminance) / CHANNEL_NORMALISERS.luminance,
        stddev: (targetStats.stdDev - anchorStats.stdDev) / CHANNEL_NORMALISERS.stddev,
    };
}

function descriptorFromSample(baseParams, realised) {
    return {
        family: 'delta',
        channel: baseParams.channel,
        augmentation: baseParams.augmentation,
        sample_id: baseParams.sampleId,
        anchor_u: Number(baseParams.anchorU.toFixed(6)),
        anchor_v: Number(baseParams.anchorV.toFixed(6)),
        span: Number(baseParams.span.toFixed(6)),
        offset_x: Number(realised.offsetX.toFixed(6)),
        offset_y: Number(realised.offsetY.toFixed(6)),
    };
}

function buildFeatureFromSample(rawPixels, meta, baseParams) {
    const realised = realiseSampleOnImage(meta, baseParams);
    const anchorStats = calculateRelativeRegionStats(
        rawPixels,
        meta,
        realised.anchorX,
        realised.anchorY,
        realised.spanXRel,
        realised.spanYRel,
    );
    const neighbourStats = calculateRelativeRegionStats(
        rawPixels,
        meta,
        realised.targetX,
        realised.targetY,
        realised.spanXRel,
        realised.spanYRel,
    );

    const deltas = computeChannelDeltas(anchorStats, neighbourStats);
    if (!deltas) return null;

    const descriptor = descriptorFromSample(baseParams, realised);
    const descriptorKey = createDescriptorKey(descriptor);

    const anchorBucketX = Math.round(descriptor.anchor_u * CONSTELLATION_CONSTANTS.ANCHOR_SCALE);
    const anchorBucketY = Math.round(descriptor.anchor_v * CONSTELLATION_CONSTANTS.ANCHOR_SCALE);
    const spanBucket = Math.max(
        0,
        Math.min(255, Math.round(descriptor.span * CONSTELLATION_CONSTANTS.SPAN_SCALE)),
    );

    return {
        descriptor,
        descriptorKey,
        channel: descriptor.channel,
        sampleId: baseParams.sampleId,
        augmentation: descriptor.augmentation,
        resolution_level: spanBucket,
        pos_x: anchorBucketX,
        pos_y: anchorBucketY,
        rel_x: descriptor.offset_x,
        rel_y: descriptor.offset_y,
        value: deltas[descriptor.channel],
        size: descriptor.span,
    };
}

async function generateAllFeaturesForAugmentation(originalImage, imagePath, augmentationName) {
    const baseMeta = await originalImage.metadata();
    const augmentedImage = applyAugmentation(originalImage, augmentationName, baseMeta, imagePath);
    const { rawPixels, meta } = await getRawPixels(augmentedImage.clone());

    const gradientFeatures = [];

    // Optional coarse progress logging (disabled by default)
    const progressEnabled = /^(1|true|yes|on)$/i.test(String(process.env.TRAINING_VERBOSE_AUGMENT_LOGS || ''));
    const progressStepsEnv = Number.parseInt(String(process.env.AUG_PROGRESS_STEPS || ''), 10);
    const progressSteps = Number.isFinite(progressStepsEnv) && progressStepsEnv > 0 ? progressStepsEnv : 0;
    const progressInterval = progressSteps > 0 ? Math.max(1, Math.floor(SAMPLES_PER_AUGMENTATION / progressSteps)) : Infinity;

    const startedAt = Date.now();

    for (let ordinal = 0; ordinal < SAMPLES_PER_AUGMENTATION; ordinal += 1) {
        const sampleId = getSampleId(augmentationName, ordinal);
        const baseParams = generateBaseParameters(sampleId);
        const feature = buildFeatureFromSample(rawPixels, meta, baseParams);
        if (feature) {
            gradientFeatures.push(feature);
        }

        if (progressEnabled && progressInterval !== Infinity) {
            const done = ordinal + 1;
            if (done % progressInterval === 0 || done === SAMPLES_PER_AUGMENTATION) {
                const pct = Math.min(100, Math.round((done / SAMPLES_PER_AUGMENTATION) * 100));
                const elapsed = (Date.now() - startedAt) / 1000;
                // Use a simple, short line to avoid log spam
                console.log(`       ↺ ${augmentationName}: ${pct}% (${done}/${SAMPLES_PER_AUGMENTATION}) in ${elapsed.toFixed(1)}s`);
            }
        }
    }

    return {
        gradientFeatures,
        allFeatures: [...gradientFeatures],
    };
}

async function generateSpecificVector(imagePath, spec, options = {}) {
    const {
        augmentation = 'original',
        descriptor,
        channel: specChannel,
        anchor_u,
        anchor_v,
        span,
        offset_x,
        offset_y,
        sampleId,
    } = spec;

    const channel = specChannel ?? descriptor?.channel;
    if (!channel) return null;

    let workingImage = sharp(imagePath);
    if (options && typeof options.imageTransform === 'function') {
        const transformed = await options.imageTransform(workingImage.clone());
        if (transformed && typeof transformed.metadata === 'function') {
            workingImage = transformed;
        }
    }

    const baseMeta = await workingImage.metadata();
    const augmentedImage = applyAugmentation(workingImage, augmentation, baseMeta, imagePath);
    const { rawPixels, meta } = await getRawPixels(augmentedImage.clone());

    const baseParams = {
        ...generateBaseParameters(Number.isFinite(sampleId) ? sampleId : 0),
        augmentation,
        channel,
        anchorU: anchor_u ?? descriptor?.anchor_u ?? 0.5,
        anchorV: anchor_v ?? descriptor?.anchor_v ?? 0.5,
        span: span ?? descriptor?.span ?? CONSTELLATION_CONSTANTS.MIN_RELATIVE_SPAN,
        offsetX: offset_x ?? descriptor?.offset_x ?? 0,
        offsetY: offset_y ?? descriptor?.offset_y ?? 0,
        sampleId: sampleId ?? descriptor?.sample_id ?? 0,
    };

    const realised = realiseSampleOnImage(meta, baseParams);
    const anchorStats = calculateRelativeRegionStats(
        rawPixels,
        meta,
        realised.anchorX,
        realised.anchorY,
        realised.spanXRel,
        realised.spanYRel,
    );
    const neighbourStats = calculateRelativeRegionStats(
        rawPixels,
        meta,
        realised.targetX,
        realised.targetY,
        realised.spanXRel,
        realised.spanYRel,
    );
    const deltas = computeChannelDeltas(anchorStats, neighbourStats);
    if (!deltas) return null;

    const normalizedDescriptor = descriptorFromSample(baseParams, realised);
    const descriptorKey = createDescriptorKey(normalizedDescriptor);

    return {
        descriptor: normalizedDescriptor,
        descriptorKey,
        channelValues: deltas,
        value: deltas[channel],
        rel_x: normalizedDescriptor.offset_x,
        rel_y: normalizedDescriptor.offset_y,
        size: normalizedDescriptor.span,
    };
}

async function generateFeaturesForAugmentationOrdinals(originalImage, imagePath, augmentationName, ordinals) {
    if (!Array.isArray(ordinals) || ordinals.length === 0) {
        return { gradientFeatures: [], allFeatures: [] };
    }
    const baseMeta = await originalImage.metadata();
    const augmentedImage = applyAugmentation(originalImage, augmentationName, baseMeta, imagePath);
    const { rawPixels, meta } = await getRawPixels(augmentedImage.clone());

    const gradientFeatures = [];
    const startedAt = Date.now();

    for (let i = 0; i < ordinals.length; i += 1) {
        const ordinal = ordinals[i];
        const sampleId = getSampleId(augmentationName, Math.max(0, Math.floor(ordinal)));
        const baseParams = generateBaseParameters(sampleId);
        const feature = buildFeatureFromSample(rawPixels, meta, baseParams);
        if (feature) {
            gradientFeatures.push(feature);
        }
    }

    return {
        gradientFeatures,
        allFeatures: [...gradientFeatures],
    };
}

module.exports = {
    generateAllFeaturesForAugmentation,
    generateSpecificVector,
    generateFeaturesForAugmentationOrdinals,
};
