// --- LIBRARIES ---
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- INTERNAL MODULES ---
const { GRID_SIZES } = require('./lib/constants');
const { AUGMENTATION_ORDER } = require('./lib/augmentations');
const { generateAllFeaturesForAugmentation, generateSpecificVector } = require('./lib/vectorGenerators');
const { resolveDefaultProbeSpec } = require('./lib/vectorSpecs');
const { createRandomConstellationSpec } = require('./lib/constellation');
const { createDescriptorKey, serializeDescriptor } = require('./lib/descriptor');

// --- FEATURE EXTRACTION HELPERS ---

async function collectFeaturesForAugmentations(originalImage, imagePath, augmentations = AUGMENTATION_ORDER) {
    const featureBatches = [];

    for (const augmentationName of augmentations) {
        const { gradientFeatures, allFeatures } = await generateAllFeaturesForAugmentation(
            originalImage,
            imagePath,
            augmentationName
        );
        featureBatches.push({
            augmentation: augmentationName,
            gradientFeatures,
            allFeatures,
        });
    }

    return featureBatches;
}

async function ensureValueTypeId(dbConnection, descriptor, cache) {
    const descriptorKey = createDescriptorKey(descriptor);
    if (cache.has(descriptorKey)) return cache.get(descriptorKey);
    const [rows] = await dbConnection.execute(
        'SELECT value_type_id FROM value_types WHERE descriptor_hash = ?',
        [descriptorKey]
    );
    if (rows.length > 0) {
        cache.set(descriptorKey, rows[0].value_type_id);
        return rows[0].value_type_id;
    }
    const [result] = await dbConnection.execute(
        'INSERT INTO value_types (descriptor_hash, descriptor_json) VALUES (?, ?)',
        [descriptorKey, serializeDescriptor(descriptor)]
    );
    cache.set(descriptorKey, result.insertId);
    return result.insertId;
}

async function persistFeatureBatch(dbConnection, imageId, featureBatch, valueTypeCache) {
    for (const feature of featureBatch.allFeatures) {
        const valueTypeId = await ensureValueTypeId(dbConnection, feature.descriptor, valueTypeCache);
        const [result] = await dbConnection.execute(
            `INSERT INTO feature_vectors (
                image_id,
                value_type,
                resolution_level,
                pos_x,
                pos_y,
                rel_x,
                rel_y,
                value,
                size
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                imageId,
                valueTypeId,
                feature.resolution_level,
                feature.pos_x,
                feature.pos_y,
                feature.rel_x,
                feature.rel_y,
                feature.value,
                feature.size,
            ]
        );

        const vectorId = result.insertId;
        if (vectorId) {
            await dbConnection.execute(
                `INSERT INTO feature_usage (vector_id, usage_count, last_used, last_score)
                 VALUES (?, 0, NULL, 0)
                 ON DUPLICATE KEY UPDATE vector_id = vector_id`,
                [vectorId]
            );
        }
    }
}

async function storeFeatures(imagePath, featureBatches) {
    let connection;
    try {
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

        const valueTypeCache = new Map();
        for (const batch of featureBatches) {
            await persistFeatureBatch(connection, imageId, batch, valueTypeCache);
        }

        await connection.commit();
        return { imageId, featureCount: featureBatches.reduce((acc, batch) => acc + batch.allFeatures.length, 0) };
    } catch (error) {
        if (connection) await connection.rollback();
        throw error;
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

async function extractFeatures(imagePath, augmentations = AUGMENTATION_ORDER) {
    await fs.access(imagePath);
    const originalImage = sharp(imagePath);
    const batches = await collectFeaturesForAugmentations(originalImage, imagePath, augmentations);
    return {
        batches,
        totalFeatures: batches.reduce((acc, batch) => acc + batch.allFeatures.length, 0),
    };
}

async function extractAndStoreFeatures(imagePath, options = {}) {
    const augmentations = options.augmentations ?? AUGMENTATION_ORDER;
    const { batches, totalFeatures } = await extractFeatures(imagePath, augmentations);
    const { imageId, featureCount } = await storeFeatures(imagePath, batches);
    return { imageId, featureCount, totalFeatures };
}

// --- EXPORTS ---

module.exports = {
    extractFeatures,
    extractAndStoreFeatures,
    generateSpecificVector,
    resolveDefaultProbeSpec,
    createRandomConstellationSpec,
    GRID_SIZES,
    AUGMENTATION_ORDER,
};

// --- CLI EXECUTION ---

if (require.main === module) {
    const imagePathArg = process.argv[2];
    if (!imagePathArg) {
        console.error('Usage: node src/featureExtractor.js <path_to_image>');
        process.exit(1);
    }

    extractAndStoreFeatures(imagePathArg)
        .then(({ imageId, featureCount }) => {
            console.log(`✅ Stored ${featureCount} vectors for image ID ${imageId}`);
        })
        .catch((error) => {
            console.error('❌ Extraction failed:', error);
            process.exit(1);
        });
}
