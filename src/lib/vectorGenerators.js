const sharp = require('sharp');
const { GRID_SIZES, CHANNEL_DIMENSIONS } = require('./constants');
const { applyAugmentation } = require('./augmentations');
const { getBlockRange, calculateStatsForRegion, getRawPixels } = require('./gridStats');
const { createDescriptorKey } = require('./descriptor');
const { computeAverageRadius } = require('./constellation');

const DEFAULT_SAMPLING_RATIO = 0.4;
const MIN_FEATURES_PER_GRID = 64;
const MAX_OFFSET_FRACTION = 0.45;

function shuffleInPlace(list) {
    for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
}

function collectBlockStats(rawPixels, meta, gridSize) {
    const cache = new Array(gridSize * gridSize);
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            const [startX, endX] = getBlockRange(gridSize, meta.width, x);
            const [startY, endY] = getBlockRange(gridSize, meta.height, y);
            cache[y * gridSize + x] = calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY);
        }
    }
    return cache;
}

function buildOffsetCandidates(gridSize) {
    const offsets = [];
    const maxOffset = Math.max(1, Math.floor(gridSize * MAX_OFFSET_FRACTION));
    for (let dx = -maxOffset; dx <= maxOffset; dx += 1) {
        for (let dy = -maxOffset; dy <= maxOffset; dy += 1) {
            if (dx === 0 && dy === 0) continue;
            offsets.push({ dx, dy });
        }
    }
    return offsets;
}

function generateRelativeGradientFeatures(rawPixels, meta) {
    const features = [];

    for (const gridSize of GRID_SIZES) {
        if (meta.width < gridSize || meta.height < gridSize) continue;

        const blockCache = collectBlockStats(rawPixels, meta, gridSize);
        const offsets = buildOffsetCandidates(gridSize);
        const candidates = [];

        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                for (const offset of offsets) {
                    const targetX = x + offset.dx;
                    const targetY = y + offset.dy;
                    if (targetX < 0 || targetY < 0) continue;
                    if (targetX >= gridSize || targetY >= gridSize) continue;
                    candidates.push({ pos_x: x, pos_y: y, dx: offset.dx, dy: offset.dy });
                }
            }
        }

        if (candidates.length === 0) continue;

        shuffleInPlace(candidates);
        const targetCount = Math.min(
            candidates.length,
            Math.max(
                MIN_FEATURES_PER_GRID,
                Math.round(candidates.length * DEFAULT_SAMPLING_RATIO),
            ),
        );

        let picked = 0;
        for (let idx = 0; idx < candidates.length && picked < targetCount; idx += 1) {
            const { pos_x, pos_y, dx, dy } = candidates[idx];
            const currentBlock = blockCache[pos_y * gridSize + pos_x];
            const neighborBlock = blockCache[(pos_y + dy) * gridSize + (pos_x + dx)];
            if (!currentBlock || !neighborBlock) continue;

            const channelValues = {
                h: (neighborBlock.h - currentBlock.h) / 360,
                s: (neighborBlock.s - currentBlock.s) / 100,
                v: (neighborBlock.v - currentBlock.v) / 100,
                luminance: (neighborBlock.luminance - currentBlock.luminance) / 255,
                stddev: (neighborBlock.stdDev - currentBlock.stdDev) / 255,
            };

            const channelOrder = [...CHANNEL_DIMENSIONS];
            shuffleInPlace(channelOrder);

            for (const channel of channelOrder) {
                const descriptor = {
                    family: 'delta',
                    channel,
                    neighbor_dx: dx,
                    neighbor_dy: dy,
                };
                const descriptorKey = createDescriptorKey(descriptor);
                const value = channelValues[channel];

                features.push({
                    descriptor,
                    descriptorKey,
                    channel,
                    resolution_level: gridSize,
                    pos_x,
                    pos_y,
                    rel_x: dx / gridSize,
                    rel_y: dy / gridSize,
                    value,
                    size: computeAverageRadius(dx, dy, gridSize),
                });

                picked += 1;
                if (picked >= targetCount) break;
                if (Math.random() < 0.55) break;
            }
        }
    }

    return features;
}

async function generateAllFeaturesForAugmentation(originalImage, imagePath, augmentationName) {
    const baseMeta = await originalImage.metadata();
    const augmentedImage = applyAugmentation(originalImage, augmentationName, baseMeta, imagePath);
    const { rawPixels, meta } = await getRawPixels(augmentedImage.clone());

    const gradientFeatures = generateRelativeGradientFeatures(rawPixels, meta);

    return {
        gradientFeatures,
        allFeatures: [...gradientFeatures],
    };
}

async function generateSpecificVector(imagePath, spec) {
    const {
        gridSize,
        pos_x,
        pos_y,
        dx,
        dy,
        augmentation = 'original',
        descriptor,
        descriptorKey,
    } = spec;

    if (pos_x >= gridSize || pos_y >= gridSize) return null;

    const originalImage = sharp(imagePath);
    const baseMeta = await originalImage.metadata();
    const augmentedImage = applyAugmentation(originalImage, augmentation, baseMeta, imagePath);
    const { rawPixels, meta } = await getRawPixels(augmentedImage.clone());

    const [startX, endX] = getBlockRange(gridSize, meta.width, pos_x);
    const [startY, endY] = getBlockRange(gridSize, meta.height, pos_y);
    const currentStats = calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY);

    const targetX = pos_x + dx;
    const targetY = pos_y + dy;
    if (targetX < 0 || targetY < 0) return null;
    if (targetX >= gridSize || targetY >= gridSize) return null;
    const [targetStartX, targetEndX] = getBlockRange(gridSize, meta.width, targetX);
    const [targetStartY, targetEndY] = getBlockRange(gridSize, meta.height, targetY);
    const targetStats = calculateStatsForRegion(rawPixels, meta, targetStartX, targetStartY, targetEndX, targetEndY);

    const channelValues = {
        h: (targetStats.h - currentStats.h) / 360,
        s: (targetStats.s - currentStats.s) / 100,
        v: (targetStats.v - currentStats.v) / 100,
        luminance: (targetStats.luminance - currentStats.luminance) / 255,
        stddev: (targetStats.stdDev - currentStats.stdDev) / 255,
    };

    return {
        descriptor,
        descriptorKey: descriptorKey ?? (descriptor ? createDescriptorKey(descriptor) : null),
        channelValues,
        value: descriptor ? channelValues[descriptor.channel] : null,
        rel_x: dx / gridSize,
        rel_y: dy / gridSize,
        size: computeAverageRadius(dx, dy, gridSize),
    };
}

module.exports = {
    generateRelativeGradientFeatures,
    generateAllFeaturesForAugmentation,
    generateSpecificVector,
};
