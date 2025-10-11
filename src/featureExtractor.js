// --- LIBRARIES ---
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- CONFIGURATION ---
const GRID_SIZES = [6, 10, 14];
const NEIGHBOR_OFFSETS = [
    { dx: 1, dy: 0, key: 'dx1dy0' },
    { dx: 0, dy: 1, key: 'dx0dy1' },
    { dx: 1, dy: 1, key: 'dx1dy1' },
    { dx: 2, dy: 0, key: 'dx2dy0' },
    { dx: 0, dy: 2, key: 'dx0dy2' },
];
const TREE_DEPTHS = [0, 1, 2, 3];
const STOCHASTIC_AUGMENTATIONS = ['random_combo_0', 'random_combo_1', 'random_combo_2'];
const AUGMENTATION_ORDER = ['original', 'mirror_horizontal', 'mirror_vertical', 'gaussian_blur', ...STOCHASTIC_AUGMENTATIONS];

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
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h;
    const v = max;
    const d = max - min;
    const s = max === 0 ? 0 : d / max;
    if (max === min) {
        h = 0;
    } else {
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
            default: h = 0;
        }
        h /= 6;
    }
    return [h * 360, s * 100, v * 100];
}

function buildVectorType(baseType, augmentationName) {
    return augmentationName === 'original' ? baseType : `${baseType}#${augmentationName}`;
}

function extractAugmentationFromType(type) {
    if (!type) return 'original';
    const idx = type.indexOf('#');
    return idx === -1 ? 'original' : type.slice(idx + 1);
}

function createSeededRandom(seed) {
    const buffer = crypto.createHash('sha1').update(seed).digest();
    let state = buffer.readUInt32BE(0);
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function applyRandomCombo(baseImage, baseMeta, imagePath, augmentationName) {
    const rand = createSeededRandom(`${imagePath}:${augmentationName}:${baseMeta.width}x${baseMeta.height}`);
    const cropRatio = 0.82 + rand() * 0.15; // 0.82 - 0.97
    const rotation = (rand() * 12) - 6; // -6 to +6 degrees
    const saturation = 0.85 + rand() * 0.3; // 0.85 - 1.15
    const brightness = 0.9 + rand() * 0.2; // 0.9 - 1.1
    const hueShift = (rand() * 36) - 18; // -18 to +18 degrees
    const blurSigma = 0.4 + rand() * 0.6; // optional blur

    const cropWidth = Math.max(1, Math.floor(baseMeta.width * cropRatio));
    const cropHeight = Math.max(1, Math.floor(baseMeta.height * cropRatio));
    const maxLeft = Math.max(0, baseMeta.width - cropWidth);
    const maxTop = Math.max(0, baseMeta.height - cropHeight);
    const left = Math.floor(rand() * (maxLeft + 1));
    const top = Math.floor(rand() * (maxTop + 1));

    let transformed = baseImage.clone();

    if (cropWidth < baseMeta.width || cropHeight < baseMeta.height) {
        transformed = transformed.extract({ left, top, width: cropWidth, height: cropHeight });
    }

    transformed = transformed
        .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .resize(baseMeta.width, baseMeta.height, { fit: 'cover' })
        .modulate({
            saturation,
            brightness,
            hue: hueShift,
        });

    if (rand() > 0.5) {
        transformed = transformed.blur(blurSigma);
    }

    return transformed;
}

function applyAugmentation(baseImage, augmentationName, baseMeta, imagePath) {
    if (AUGMENTATIONS[augmentationName]) {
        return AUGMENTATIONS[augmentationName](baseImage);
    }
    if (augmentationName.startsWith('random_combo_')) {
        return applyRandomCombo(baseImage, baseMeta, imagePath, augmentationName);
    }
    throw new Error(`Unknown augmentation '${augmentationName}'`);
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

function buildRelativeGradientType(gridSize, offsetKey) {
    return `hsv_rel_gradient_g${gridSize}_${offsetKey}`;
}

function extractRelativeGradientFeatures(rawPixels, meta, augmentationName) {
    const features = [];

    for (const gridSize of GRID_SIZES) {
        if (meta.width < gridSize || meta.height < gridSize) {
            continue;
        }

        const blockCache = new Array(gridSize * gridSize);
        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                const [startX, endX] = getBlockRange(gridSize, meta.width, x);
                const [startY, endY] = getBlockRange(gridSize, meta.height, y);
                blockCache[y * gridSize + x] = calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY);
            }
        }

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

function extractTreeFeatures(rawPixels, meta, augmentationName) {
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

function parseRelativeGradientType(baseType) {
    const match = baseType.match(/^hsv_rel_gradient_g(\d+)_dx(\d+)dy(\d+)$/);
    if (!match) return null;
    return {
        gridSize: parseInt(match[1], 10),
        dx: parseInt(match[2], 10),
        dy: parseInt(match[3], 10),
    };
}

/**
 * Generates a specific vector on-demand for a given image and vector spec.
 * Supports relative gradient vectors and hierarchical tree vectors.
 * @param {string} imagePath - Path to the image.
 * @param {object} spec - The specification of the required vector.
 * @param {string} [spec.augmentation] - Optional augmentation name.
 * @returns {Buffer|null} The calculated vector as a Buffer, or null if not applicable.
 */
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

// --- MAIN LOGIC FOR STANDALONE EXECUTION ---

async function extractAndStoreFeatures(imagePath) {
    let connection;
    try {
        await fs.access(imagePath);
        console.log(`🔎 Processing image: ${imagePath}`);

        const originalImage = sharp(imagePath);
        const baseMeta = await originalImage.metadata();
        const allFeatures = [];

        for (const augmentationName of AUGMENTATION_ORDER) {
            console.log(`\n-- Augmentation: ${augmentationName} --`);
            const augmentedImage = applyAugmentation(originalImage, augmentationName, baseMeta, imagePath);
            const { rawPixels, meta } = await getRawPixels(augmentedImage.clone());

            const gradientFeatures = extractRelativeGradientFeatures(rawPixels, meta, augmentationName);
            const treeFeatures = extractTreeFeatures(rawPixels, meta, augmentationName);
            allFeatures.push(...gradientFeatures, ...treeFeatures);

            console.log(`  Extracted ${gradientFeatures.length} relative gradients and ${treeFeatures.length} quadtree vectors.`);
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
    GRID_SIZES,
    NEIGHBOR_OFFSETS,
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
