// --- LIBRARIES ---
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- INTERNAL MODULES ---
const { AUGMENTATION_ORDER } = require('./lib/augmentations');
const { generateAllFeaturesForAugmentation, generateSpecificVector } = require('./lib/vectorGenerators');
const { resolveDefaultProbeSpec } = require('./lib/vectorSpecs');
const { createDescriptorKey, serializeDescriptor } = require('./lib/descriptor');

const MAX_TRANSACTION_RETRIES = parseRetryEnv(process.env.DB_TRANSACTION_MAX_RETRIES, 3);
const TRANSACTION_RETRY_BASE_MS = parseRetryEnv(process.env.DB_TRANSACTION_RETRY_BASE_MS, 75);
const RETRYABLE_TRANSACTION_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

function parseRetryEnv(rawValue, fallback) {
    const parsed = Number.parseInt(rawValue ?? '', 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return fallback;
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

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

    async function selectExisting() {
        const [rows] = await dbConnection.execute(
            'SELECT value_type_id FROM value_types WHERE descriptor_hash = ?',
            [descriptorKey]
        );
        if (rows.length > 0) {
            cache.set(descriptorKey, rows[0].value_type_id);
            return rows[0].value_type_id;
        }
        return null;
    }

    const existingId = await selectExisting();
    if (existingId) return existingId;

    try {
        const [result] = await dbConnection.execute(
            'INSERT INTO value_types (descriptor_hash, descriptor_json) VALUES (?, ?)',
            [descriptorKey, serializeDescriptor(descriptor)]
        );
        cache.set(descriptorKey, result.insertId);
        return result.insertId;
    } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') {
            const duplicateId = await selectExisting();
            if (duplicateId) return duplicateId;
        }
        throw error;
    }
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
    let attempt = 0;
    let lastError;
    const featureCount = featureBatches.reduce((acc, batch) => acc + batch.allFeatures.length, 0);

    while (attempt < MAX_TRANSACTION_RETRIES) {
        attempt += 1;
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
            return { imageId, featureCount };
        } catch (error) {
            lastError = error;
            if (connection) {
                try {
                    await connection.rollback();
                } catch {
                    // rollback best effort
                }
            }
            if (RETRYABLE_TRANSACTION_ERRORS.has(error?.code) && attempt < MAX_TRANSACTION_RETRIES) {
                const delay = TRANSACTION_RETRY_BASE_MS * attempt;
                console.warn(
                    `   ↻ Retrying ingestion for ${path.basename(imagePath)} after ${error.code} (attempt ${attempt}/${MAX_TRANSACTION_RETRIES})`
                );
                await sleep(delay);
                continue;
            }
            throw error;
        } finally {
            if (connection) {
                try {
                    await connection.end();
                } catch {
                    // ignore end errors
                }
            }
        }
    }

    throw lastError;
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
    for (const batch of batches) {
        console.log(
            `     ↳ Augmentation '${batch.augmentation}' yielded ${batch.allFeatures.length} vectors`
        );
    }
    const { imageId, featureCount } = await storeFeatures(imagePath, batches);
    return { imageId, featureCount, totalFeatures };
}

// --- EXPORTS ---

module.exports = {
    extractFeatures,
    extractAndStoreFeatures,
    generateSpecificVector,
    resolveDefaultProbeSpec,
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
