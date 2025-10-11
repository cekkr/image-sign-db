const sharp = require('sharp');
const { GRID_SIZES, NEIGHBOR_OFFSETS, TREE_DEPTHS } = require('./constants');
const { applyAugmentation } = require('./augmentations');
const { getBlockRange, calculateStatsForRegion, getRawPixels } = require('./gridStats');
const {
    buildVectorType,
    buildRelativeGradientType,
    parseRelativeGradientType,
    extractAugmentationFromType,
} = require('./vectorSpecs');

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

function generateRelativeGradientFeatures(rawPixels, meta, augmentationName) {
    const features = [];

    for (const gridSize of GRID_SIZES) {
        if (meta.width < gridSize || meta.height < gridSize) continue;

        const blockCache = collectBlockStats(rawPixels, meta, gridSize);

        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                const currentBlock = blockCache[y * gridSize + x];
                for (const offset of NEIGHBOR_OFFSETS) {
                    const targetX = x + offset.dx;
                    const targetY = y + offset.dy;
                    if (targetX >= gridSize || targetY >= gridSize) continue;
                    const neighborBlock = blockCache[targetY * gridSize + targetX];
                    if (!neighborBlock) continue;

                    const vector = new Float32Array([
                        (neighborBlock.h - currentBlock.h) / 360,
                        (neighborBlock.s - currentBlock.s) / 100,
                        (neighborBlock.v - currentBlock.v) / 100,
                        (neighborBlock.luminance - currentBlock.luminance) / 255,
                        offset.dx / gridSize,
                        offset.dy / gridSize,
                    ]);

                    features.push({
                        vector_type: buildVectorType(buildRelativeGradientType(gridSize, offset.key), augmentationName),
                        resolution_level: gridSize,
                        pos_x: x,
                        pos_y: y,
                        vector_data: Buffer.from(vector.buffer),
                    });
                }
            }
        }
    }

    return features;
}

function generateTreeFeatures(rawPixels, meta, augmentationName) {
    const features = [];
    const statsCache = new Map();

    for (const depth of TREE_DEPTHS) {
        const gridSize = Math.pow(2, depth);
        if (gridSize > meta.width || gridSize > meta.height) break;

        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                const [startX, endX] = getBlockRange(gridSize, meta.width, x);
                const [startY, endY] = getBlockRange(gridSize, meta.height, y);
                if (endX <= startX || endY <= startY) continue;

                const stats = calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY);
                const cacheKey = `${depth}_${x}_${y}`;
                statsCache.set(cacheKey, stats);

                const meanVector = new Float32Array([
                    stats.h / 360,
                    stats.s / 100,
                    stats.v / 100,
                    stats.luminance / 255,
                    stats.stdDev / 255,
                ]);

                features.push({
                    vector_type: buildVectorType('hsv_tree_mean', augmentationName),
                    resolution_level: depth,
                    pos_x: x,
                    pos_y: y,
                    vector_data: Buffer.from(meanVector.buffer),
                });

                if (depth > 0) {
                    const parentKey = `${depth - 1}_${Math.floor(x / 2)}_${Math.floor(y / 2)}`;
                    const parentStats = statsCache.get(parentKey);
                    if (parentStats) {
                        const deltaVector = new Float32Array([
                            (stats.h - parentStats.h) / 360,
                            (stats.s - parentStats.s) / 100,
                            (stats.v - parentStats.v) / 100,
                            (stats.luminance - parentStats.luminance) / 255,
                            (stats.stdDev - parentStats.stdDev) / 255,
                        ]);

                        features.push({
                            vector_type: buildVectorType('hsv_tree_delta', augmentationName),
                            resolution_level: depth,
                            pos_x: x,
                            pos_y: y,
                            vector_data: Buffer.from(deltaVector.buffer),
                        });
                    }
                }
            }
        }
    }

    return features;
}

async function generateAllFeaturesForAugmentation(originalImage, imagePath, augmentationName) {
    const baseMeta = await originalImage.metadata();
    const augmentedImage = applyAugmentation(originalImage, augmentationName, baseMeta, imagePath);
    const { rawPixels, meta } = await getRawPixels(augmentedImage.clone());

    const gradientFeatures = generateRelativeGradientFeatures(rawPixels, meta, augmentationName);
    const treeFeatures = generateTreeFeatures(rawPixels, meta, augmentationName);

    return {
        gradientFeatures,
        treeFeatures,
        allFeatures: [...gradientFeatures, ...treeFeatures],
    };
}

async function generateSpecificVector(imagePath, spec) {
    const { vector_type, resolution_level, pos_x, pos_y } = spec;
    const baseType = vector_type.split('#')[0];
    const effectiveAugmentation = spec.augmentation || extractAugmentationFromType(vector_type);

    const originalImage = sharp(imagePath);
    const baseMeta = await originalImage.metadata();
    const augmentedImage = applyAugmentation(originalImage, effectiveAugmentation, baseMeta, imagePath);
    const { rawPixels, meta } = await getRawPixels(augmentedImage.clone());

    const gradientDescriptor = parseRelativeGradientType(baseType);
    if (gradientDescriptor) {
        const { gridSize, dx, dy } = gradientDescriptor;
        if (pos_x >= gridSize || pos_y >= gridSize) return null;

        const [startX, endX] = getBlockRange(gridSize, meta.width, pos_x);
        const [startY, endY] = getBlockRange(gridSize, meta.height, pos_y);
        const currentStats = calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY);

        const targetX = pos_x + dx;
        const targetY = pos_y + dy;
        if (targetX >= gridSize || targetY >= gridSize) return null;
        const [targetStartX, targetEndX] = getBlockRange(gridSize, meta.width, targetX);
        const [targetStartY, targetEndY] = getBlockRange(gridSize, meta.height, targetY);
        const targetStats = calculateStatsForRegion(rawPixels, meta, targetStartX, targetStartY, targetEndX, targetEndY);

        const vec = new Float32Array([
            (targetStats.h - currentStats.h) / 360,
            (targetStats.s - currentStats.s) / 100,
            (targetStats.v - currentStats.v) / 100,
            (targetStats.luminance - currentStats.luminance) / 255,
            dx / gridSize,
            dy / gridSize,
        ]);
        return Buffer.from(vec.buffer);
    }

    if (baseType === 'hsv_tree_mean' || baseType === 'hsv_tree_delta') {
        const gridSize = Math.pow(2, resolution_level);
        const [startX, endX] = getBlockRange(gridSize, meta.width, pos_x);
        const [startY, endY] = getBlockRange(gridSize, meta.height, pos_y);
        const currentStats = calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY);

        if (baseType === 'hsv_tree_mean') {
            const vec = new Float32Array([
                currentStats.h / 360,
                currentStats.s / 100,
                currentStats.v / 100,
                currentStats.luminance / 255,
                currentStats.stdDev / 255,
            ]);
            return Buffer.from(vec.buffer);
        }

        if (resolution_level === 0) return null;
        const parentGridSize = Math.pow(2, resolution_level - 1);
        const parentX = Math.floor(pos_x / 2);
        const parentY = Math.floor(pos_y / 2);
        const [parentStartX, parentEndX] = getBlockRange(parentGridSize, meta.width, parentX);
        const [parentStartY, parentEndY] = getBlockRange(parentGridSize, meta.height, parentY);
        const parentStats = calculateStatsForRegion(rawPixels, meta, parentStartX, parentStartY, parentEndX, parentEndY);

        const vec = new Float32Array([
            (currentStats.h - parentStats.h) / 360,
            (currentStats.s - parentStats.s) / 100,
            (currentStats.v - parentStats.v) / 100,
            (currentStats.luminance - parentStats.luminance) / 255,
            (currentStats.stdDev - parentStats.stdDev) / 255,
        ]);
        return Buffer.from(vec.buffer);
    }

    return null;
}

module.exports = {
    generateRelativeGradientFeatures,
    generateTreeFeatures,
    generateAllFeaturesForAugmentation,
    generateSpecificVector,
};
