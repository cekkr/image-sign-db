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

const MAX_OPERATION_RETRIES = parseRetryEnv(process.env.DB_OPERATION_MAX_RETRIES, 4);
const OPERATION_RETRY_BASE_MS = parseRetryEnv(process.env.DB_OPERATION_RETRY_BASE_MS, 40);
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
    const total = augmentations.length;

    for (let i = 0; i < total; i += 1) {
        const augmentationName = augmentations[i];
        const label = `${augmentationName}`;
        const startedAt = Date.now();
        console.log(`     ↳ Starting augmentation '${label}' (${i + 1}/${total})`);
        const { gradientFeatures, allFeatures } = await generateAllFeaturesForAugmentation(
            originalImage,
            imagePath,
            augmentationName
        );
        const elapsed = (Date.now() - startedAt) / 1000;
        console.log(`       ✓ Completed '${label}' in ${elapsed.toFixed(1)}s`);
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

    const payload = serializeDescriptor(descriptor);
    // First try a non-locking read to avoid unnecessary writes under contention.
    const [preRows] = await dbConnection.execute(
        'SELECT value_type_id FROM value_types WHERE descriptor_hash = ? LIMIT 1',
        [descriptorKey]
    );
    if (preRows.length > 0) {
        const existingId = preRows[0].value_type_id;
        cache.set(descriptorKey, existingId);
        return existingId;
    }

    // Not found: attempt INSERT (idempotent) with bounded retries on lock conflicts.
    let attempt = 0;
    let lastError;
    while (attempt < MAX_OPERATION_RETRIES) {
        attempt += 1;
        try {
            await dbConnection.execute(
                `INSERT IGNORE INTO value_types (descriptor_hash, descriptor_json) VALUES (?, ?)`,
                [descriptorKey, payload]
            );
            // Resolve ID (works whether we inserted or another concurrent worker won the race).
            const [rows] = await dbConnection.execute(
                'SELECT value_type_id FROM value_types WHERE descriptor_hash = ? LIMIT 1',
                [descriptorKey]
            );
            if (rows.length > 0) {
                const id = rows[0].value_type_id;
                cache.set(descriptorKey, id);
                return id;
            }
        } catch (error) {
            lastError = error;
            if (RETRYABLE_TRANSACTION_ERRORS.has(error?.code) && attempt < MAX_OPERATION_RETRIES) {
                const jitter = Math.floor(Math.random() * OPERATION_RETRY_BASE_MS);
                const delay = OPERATION_RETRY_BASE_MS * attempt + jitter;
                await sleep(delay);
                continue;
            }
            throw error;
        }
        break;
    }

    if (lastError) {
        throw lastError;
    }

    throw new Error(`Unable to resolve value type for descriptor hash ${descriptorKey}`);
}

async function persistFeatureBatch(dbConnection, imageId, featureBatch, valueTypeCache) {
    for (const feature of featureBatch.allFeatures) {
        const valueTypeId = await ensureValueTypeId(dbConnection, feature.descriptor, valueTypeCache);

        // Insert vector with bounded, focused retry on lock timeouts (rare for inserts).
        let attempt = 0;
        while (true) {
            try {
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
                break; // success
            } catch (error) {
                if (RETRYABLE_TRANSACTION_ERRORS.has(error?.code) && attempt < MAX_OPERATION_RETRIES) {
                    attempt += 1;
                    const jitter = Math.floor(Math.random() * OPERATION_RETRY_BASE_MS);
                    const delay = OPERATION_RETRY_BASE_MS * attempt + jitter;
                    await sleep(delay);
                    continue;
                }
                throw error;
            }
        }
    }
}

async function storeFeatures(imagePath, featureBatches) {
    const featureCount = featureBatches.reduce((acc, batch) => acc + batch.allFeatures.length, 0);
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    try {
        // Prefer lighter-weight, autocommit operations to avoid holding locks for long.
        // Optional: keep reads lean and reduce gap locking behavior.
        try {
            await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
        } catch {
            // best effort; not critical
        }

        const [imageResult] = await connection.execute(
            'INSERT INTO images (original_filename, ingestion_complete) VALUES (?, 0)',
            [path.basename(imagePath)]
        );
        const imageId = imageResult.insertId;

        const valueTypeCache = new Map();
        for (const batch of featureBatches) {
            await persistFeatureBatch(connection, imageId, batch, valueTypeCache);
        }

        // Mark ingestion complete only after all vectors/aux rows are inserted
        try {
            await connection.execute(
                'UPDATE images SET ingestion_complete = 1 WHERE image_id = ?',
                [imageId]
            );
        } catch {
            // best effort; not critical for correctness
        }

        return { imageId, featureCount };
    } finally {
        try { await connection.end(); } catch { /* ignore */ }
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
