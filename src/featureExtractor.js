// --- LIBRARIES ---
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- CONFIGURATION ---
const RESOLUTION_LEVELS = [0, 1, 2];
const GRID_SIZE = 8;
const TREE_DEPTHS = [0, 1, 2, 3];
const AUGMENTATION_ORDER = ['original', 'mirror_horizontal', 'mirror_vertical', 'gaussian_blur'];

const AUGMENTATIONS = {
    original(image) {
        return image.clone();
    },
    mirror_horizontal(image) {
        return image.clone().flop();
    },
    mirror_vertical(image) {
        return image.clone().flip();
    },
    gaussian_blur(image) {
        return image.clone().blur(1.2);
    },
};

// --- HELPER FUNCTIONS (Exported) ---

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    const d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max === min) {
        h = 0;
    } else {
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h * 360, s * 100, v * 100];
}

function buildVectorType(baseType, augmentationName) {
    return augmentationName === 'original' ? baseType : `${baseType}#${augmentationName}`;
}

function applyAugmentation(baseImage, augmentationName) {
    const operator = AUGMENTATIONS[augmentationName];
    if (!operator) {
        throw new Error(`Unknown augmentation '${augmentationName}'`);
    }
    return operator(baseImage);
}

function getBlockRange(gridSize, dimension, index) {
    if (gridSize <= 0 || dimension <= 0) return [0, 0];
    const start = Math.floor((index * dimension) / gridSize);
    let end = index === gridSize - 1 ? dimension : Math.floor(((index + 1) * dimension) / gridSize);
    if (end <= start) end = Math.min(dimension, start + 1);
    return [start, end];
}

function calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY) {
    let sumR = 0, sumG = 0, sumB = 0, sumR2 = 0, sumG2 = 0, sumB2 = 0;
    let pixelCount = 0;

    const channels = meta.channels;
    const maxX = Math.min(endX, meta.width);
    const maxY = Math.min(endY, meta.height);

    for (let y = startY; y < maxY; y++) {
        for (let x = startX; x < maxX; x++) {
            const index = (y * meta.width + x) * channels;
            if (index + 2 < rawPixels.length) {
                const r = rawPixels[index];
                const g = rawPixels[index + 1];
                const b = rawPixels[index + 2];
                sumR += r; sumG += g; sumB += b;
                sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
                pixelCount++;
            }
        }
    }

    if (pixelCount === 0) {
        return { r: 0, g: 0, b: 0, h: 0, s: 0, v: 0, luminance: 0, stdDev: 0 };
    }

    const avgR = sumR / pixelCount;
    const avgG = sumG / pixelCount;
    const avgB = sumB / pixelCount;
    const varianceR = Math.max(0, sumR2 / pixelCount - avgR * avgR);
    const varianceG = Math.max(0, sumG2 / pixelCount - avgG * avgG);
    const varianceB = Math.max(0, sumB2 / pixelCount - avgB * avgB);
    const combinedStdDev = Math.sqrt((varianceR + varianceG + varianceB) / 3);
    const luminance = 0.2126 * avgR + 0.7152 * avgG + 0.0722 * avgB;
    const [h, s, v] = rgbToHsv(avgR, avgG, avgB);

    return { r: avgR, g: avgG, b: avgB, h, s, v, luminance, stdDev: combinedStdDev };
}

async function getRawPixels(sharpInstance) {
    const { data, info } = await sharpInstance.raw().toBuffer({ resolveWithObject: true });
    return { rawPixels: data, meta: info };
}

async function extractGridGradientFeatures(augmentedImage, baseMeta, augmentationName) {
    const features = [];

    for (const level of RESOLUTION_LEVELS) {
        const scale = 1 / Math.pow(2, level);
        const width = Math.max(1, Math.floor(baseMeta.width * scale));
        const height = Math.max(1, Math.floor(baseMeta.height * scale));

        if (width < GRID_SIZE || height < GRID_SIZE) {
            continue;
        }

        const resized = augmentedImage.clone().resize(width, height, { fit: 'fill' });
        const { rawPixels, meta } = await getRawPixels(resized);

        const blockCache = [];
        for (let y = 0; y < GRID_SIZE; y++) {
            for (let x = 0; x < GRID_SIZE; x++) {
                const [startX, endX] = getBlockRange(GRID_SIZE, meta.width, x);
                const [startY, endY] = getBlockRange(GRID_SIZE, meta.height, y);
                blockCache[y * GRID_SIZE + x] = calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY);
            }
        }

        for (let y = 0; y < GRID_SIZE; y++) {
            for (let x = 0; x < GRID_SIZE; x++) {
                const currentBlock = blockCache[y * GRID_SIZE + x];
                if (x < GRID_SIZE - 1) {
                    const rightBlock = blockCache[y * GRID_SIZE + (x + 1)];
                    const gradH = new Float32Array([
                        (rightBlock.h - currentBlock.h) / 360,
                        (rightBlock.s - currentBlock.s) / 100,
                        (rightBlock.v - currentBlock.v) / 100,
                        (rightBlock.luminance - currentBlock.luminance) / 255,
                    ]);
                    features.push({
                        vector_type: buildVectorType('hsv_gradient_h', augmentationName),
                        resolution_level: level,
                        pos_x: x,
                        pos_y: y,
                        vector_data: Buffer.from(gradH.buffer),
                    });
                }
                if (y < GRID_SIZE - 1) {
                    const bottomBlock = blockCache[(y + 1) * GRID_SIZE + x];
                    const gradV = new Float32Array([
                        (bottomBlock.h - currentBlock.h) / 360,
                        (bottomBlock.s - currentBlock.s) / 100,
                        (bottomBlock.v - currentBlock.v) / 100,
                        (bottomBlock.luminance - currentBlock.luminance) / 255,
                    ]);
                    features.push({
                        vector_type: buildVectorType('hsv_gradient_v', augmentationName),
                        resolution_level: level,
                        pos_x: x,
                        pos_y: y,
                        vector_data: Buffer.from(gradV.buffer),
                    });
                }
            }
        }
    }

    return features;
}

function extractTreeFeatures(baseRawPixels, baseMeta, augmentationName) {
    const features = [];
    const statsCache = new Map();

    for (const depth of TREE_DEPTHS) {
        const gridSize = Math.pow(2, depth);
        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                const [startX, endX] = getBlockRange(gridSize, baseMeta.width, x);
                const [startY, endY] = getBlockRange(gridSize, baseMeta.height, y);
                if (endX <= startX || endY <= startY) continue;

                const stats = calculateStatsForRegion(baseRawPixels, baseMeta, startX, startY, endX, endY);
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

/**
 * Generates a specific vector on-demand for a given image and vector spec.
 * Supports both gradient grid vectors and hierarchical tree vectors.
 * @param {string} imagePath - Path to the image.
 * @param {object} spec - The specification of the required vector.
 * @param {string} [spec.augmentation] - Optional augmentation name.
 * @returns {Buffer|null} The calculated vector as a Buffer, or null if not applicable.
 */
async function generateSpecificVector(imagePath, spec) {
    const { vector_type, resolution_level, pos_x, pos_y, augmentation = 'original' } = spec;
    const baseType = vector_type.split('#')[0];

    const originalImage = sharp(imagePath);
    const augmentedImage = applyAugmentation(originalImage, augmentation);

    if (baseType === 'hsv_gradient_h' || baseType === 'hsv_gradient_v') {
        const metadata = await augmentedImage.metadata();
        const scale = 1 / Math.pow(2, resolution_level);
        const width = Math.max(1, Math.floor(metadata.width * scale));
        const height = Math.max(1, Math.floor(metadata.height * scale));

        if (width < GRID_SIZE || height < GRID_SIZE) return null;

        const resized = augmentedImage.clone().resize(width, height, { fit: 'fill' });
        const { rawPixels, meta } = await getRawPixels(resized);

        const [startX, endX] = getBlockRange(GRID_SIZE, meta.width, pos_x);
        const [startY, endY] = getBlockRange(GRID_SIZE, meta.height, pos_y);
        const currentBlock = calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY);

        if (baseType === 'hsv_gradient_h') {
            if (pos_x >= GRID_SIZE - 1) return null;
            const [rightStartX, rightEndX] = getBlockRange(GRID_SIZE, meta.width, pos_x + 1);
            const rightBlock = calculateStatsForRegion(rawPixels, meta, rightStartX, startY, rightEndX, endY);
            const grad = new Float32Array([
                (rightBlock.h - currentBlock.h) / 360,
                (rightBlock.s - currentBlock.s) / 100,
                (rightBlock.v - currentBlock.v) / 100,
                (rightBlock.luminance - currentBlock.luminance) / 255,
            ]);
            return Buffer.from(grad.buffer);
        }

        if (pos_y >= GRID_SIZE - 1) return null;
        const [bottomStartY, bottomEndY] = getBlockRange(GRID_SIZE, meta.height, pos_y + 1);
        const bottomBlock = calculateStatsForRegion(rawPixels, meta, startX, bottomStartY, endX, bottomEndY);
        const grad = new Float32Array([
            (bottomBlock.h - currentBlock.h) / 360,
            (bottomBlock.s - currentBlock.s) / 100,
            (bottomBlock.v - currentBlock.v) / 100,
            (bottomBlock.luminance - currentBlock.luminance) / 255,
        ]);
        return Buffer.from(grad.buffer);
    }

    if (baseType === 'hsv_tree_mean' || baseType === 'hsv_tree_delta') {
        const { rawPixels, meta } = await getRawPixels(augmentedImage.clone());
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

// --- MAIN LOGIC FOR STANDALONE EXECUTION ---

async function extractAndStoreFeatures(imagePath) {
    let connection;
    try {
        await fs.access(imagePath);
        console.log(`🔎 Processing image: ${imagePath}`);

        const originalImage = sharp(imagePath);
        const allFeatures = [];

        for (const augmentationName of AUGMENTATION_ORDER) {
            console.log(`\n-- Augmentation: ${augmentationName} --`);
            const augmentedImage = applyAugmentation(originalImage, augmentationName);
            const { rawPixels, meta } = await getRawPixels(augmentedImage.clone());
            const gridFeatures = await extractGridGradientFeatures(augmentedImage, meta, augmentationName);
            const treeFeatures = extractTreeFeatures(rawPixels, meta, augmentationName);
            allFeatures.push(...gridFeatures, ...treeFeatures);
            console.log(`  Extracted ${gridFeatures.length} grid gradients and ${treeFeatures.length} tree features.`);
        }

        console.log(`\n🗄️  Connecting to database to store ${allFeatures.length} features...`);
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });
        await connection.beginTransaction();

        const [imageResult] = await connection.execute(
            'INSERT INTO images (original_filename) VALUES (?)',
            [path.basename(imagePath)]
        );
        const imageId = imageResult.insertId;
        console.log(`  Saved main record to 'images' table. ID: ${imageId}`);

        for (const feature of allFeatures) {
            await connection.execute(
                `INSERT INTO feature_vectors (image_id, vector_type, resolution_level, pos_x, pos_y, vector_data)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [imageId, feature.vector_type, feature.resolution_level, feature.pos_x, feature.pos_y, feature.vector_data]
            );
        }

        await connection.commit();
        console.log("\n🎉 Transaction committed successfully!");
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("\n❌ An error occurred:", error.code === 'ENOENT' ? `File not found at ${imagePath}` : error);
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
            console.log("\n🔌 Connection closed.");
        }
    }
}

// --- EXPORTS & EXECUTION ---

module.exports = {
    generateSpecificVector,
    RESOLUTION_LEVELS,
    GRID_SIZE,
    TREE_DEPTHS,
    AUGMENTATION_ORDER,
};

if (require.main === module) {
    const imagePathArg = process.argv[2];
    if (!imagePathArg) {
        console.error("Usage: node src/featureExtractor.js <path_to_image>");
        process.exit(1);
    }
    extractAndStoreFeatures(imagePathArg);
}
