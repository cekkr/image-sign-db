// --- LIBRARIES ---
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- INTERNAL MODULES ---
const { AUGMENTATION_ORDER } = require('./lib/augmentations');
const { generateAllFeaturesForAugmentation, generateSpecificVector, generateFeaturesForAugmentationOrdinals } = require('./lib/vectorGenerators');
const { resolveDefaultProbeSpec } = require('./lib/vectorSpecs');
const { createDescriptorKey, serializeDescriptor } = require('./lib/descriptor');
const { SAMPLES_PER_AUGMENTATION } = require('./lib/constellation');
const settings = require('./settings');
const { selectTopDescriptors } = require('./lib/knowledge');

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

async function resolveValueTypesBulk(dbConnection, features, cache) {
    if (!Array.isArray(features) || features.length === 0) return new Map();
    const map = new Map();
    for (const feature of features) {
        const key = createDescriptorKey(feature.descriptor);
        if (cache.has(key)) map.set(key, cache.get(key));
    }
    const missing = [];
    for (const feature of features) {
        const key = createDescriptorKey(feature.descriptor);
        if (!map.has(key)) missing.push({ key, payload: serializeDescriptor(feature.descriptor) });
    }
    if (missing.length === 0) return map;
    const CHUNK = 500;
    for (let i = 0; i < missing.length; i += CHUNK) {
        const slice = missing.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        const [rows] = await dbConnection.execute(
            `SELECT descriptor_hash, value_type_id FROM value_types WHERE descriptor_hash IN (${placeholders})`,
            slice.map((x) => x.key)
        );
        for (const row of rows) {
            map.set(row.descriptor_hash, row.value_type_id);
            cache.set(row.descriptor_hash, row.value_type_id);
        }
    }
    const stillMissing = missing.filter((x) => !map.has(x.key));
    if (stillMissing.length > 0) {
        for (let i = 0; i < stillMissing.length; i += CHUNK) {
            const slice = stillMissing.slice(i, i + CHUNK);
            const values = slice.map(() => '(?, ?)').join(',');
            const params = [];
            slice.forEach((x) => { params.push(x.key, x.payload); });
            await dbConnection.execute(
                `INSERT IGNORE INTO value_types (descriptor_hash, descriptor_json) VALUES ${values}`,
                params
            );
        }
        for (let i = 0; i < stillMissing.length; i += CHUNK) {
            const slice = stillMissing.slice(i, i + CHUNK);
            const placeholders = slice.map(() => '?').join(',');
            const [rows] = await dbConnection.execute(
                `SELECT descriptor_hash, value_type_id FROM value_types WHERE descriptor_hash IN (${placeholders})`,
                slice.map((x) => x.key)
            );
            for (const row of rows) {
                map.set(row.descriptor_hash, row.value_type_id);
                cache.set(row.descriptor_hash, row.value_type_id);
            }
        }
    }
    return map;
}

async function persistFeaturesBatched(dbConnection, imageId, features, valueTypeCache, batchSize = 400) {
    if (!Array.isArray(features) || features.length === 0) return 0;
    const idMap = await resolveValueTypesBulk(dbConnection, features, valueTypeCache);
    let inserted = 0;
    for (let i = 0; i < features.length; i += batchSize) {
        const slice = features.slice(i, i + batchSize);
        const values = slice.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
        const params = [];
        for (const feature of slice) {
            const key = createDescriptorKey(feature.descriptor);
            const valueTypeId = idMap.get(key) ?? valueTypeCache.get(key);
            if (!valueTypeId) {
                const resolved = await ensureValueTypeId(dbConnection, feature.descriptor, valueTypeCache);
                params.push(
                    imageId,
                    resolved,
                    feature.resolution_level,
                    feature.pos_x,
                    feature.pos_y,
                    feature.rel_x,
                    feature.rel_y,
                    feature.value,
                    feature.size,
                );
            } else {
                params.push(
                    imageId,
                    valueTypeId,
                    feature.resolution_level,
                    feature.pos_x,
                    feature.pos_y,
                    feature.rel_x,
                    feature.rel_y,
                    feature.value,
                    feature.size,
                );
            }
        }
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
            ) VALUES ${values}`,
            params
        );
        inserted += Number(result.affectedRows || 0);
        const firstId = Number(result.insertId || 0);
        const count = Number(result.affectedRows || 0);
        if (firstId > 0 && count > 0) {
            const placeholders = new Array(count).fill('(?, 0, NULL, 0)').join(',');
            const idParams = [];
            for (let off = 0; off < count; off += 1) idParams.push(firstId + off);
            try {
                await dbConnection.execute(
                    `INSERT INTO feature_usage (vector_id, usage_count, last_used, last_score) VALUES ${placeholders}
                     ON DUPLICATE KEY UPDATE vector_id = vector_id`,
                    idParams
                );
            } catch {}
        }
    }
    return inserted;
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
            await persistFeaturesBatched(connection, imageId, batch.allFeatures, valueTypeCache);
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

// Progressive multi-cycle ingestion that avoids generating a fixed, large sample
async function extractAndStoreFeaturesProgressive(imagePath, options = {}) {
    const augmentations = options.augmentations ?? AUGMENTATION_ORDER;
    await fs.access(imagePath);
    const originalImage = sharp(imagePath);

    const cycles = Math.max(1, Number(settings?.training?.progressive?.cycles ?? 3));
    const randomPerAug = Math.max(0, Number(settings?.training?.progressive?.randomPerAug ?? 300));
    const guidedPerCycle = Math.max(0, Number(settings?.training?.progressive?.guidedPerCycle ?? 300));
    const storeBlob = Boolean(settings?.training?.storeImageBlob ?? false);

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    try {
        try { await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED'); } catch {}

        const [imageResult] = await connection.execute(
            'INSERT INTO images (original_filename, ingestion_complete) VALUES (?, 0)',
            [path.basename(imagePath)]
        );
        const imageId = imageResult.insertId;

        if (storeBlob) {
            await ensureImageBlobTable(connection);
            try {
                const data = await fs.readFile(imagePath);
                const mime = guessMimeType(imagePath) || 'application/octet-stream';
                await connection.execute(
                    `INSERT INTO image_blobs (image_id, mime_type, data) VALUES (?, ?, ?)`,
                    [imageId, mime, data]
                );
            } catch {}
        }

        const valueTypeCache = new Map();
        let totalInserted = 0;

        // Cycle 1: random sparse sampling per augmentation
        for (const augmentationName of augmentations) {
            const ordinals = chooseUniqueOrdinals(randomPerAug, SAMPLES_PER_AUGMENTATION, `${imagePath}:${augmentationName}`);
            const { allFeatures } = await generateFeaturesForAugmentationOrdinals(originalImage, imagePath, augmentationName, ordinals);
            if (allFeatures.length > 0) {
                totalInserted += await persistFeaturesBatched(connection, imageId, allFeatures, valueTypeCache);
                console.log(`     [32m[1mAug '${augmentationName}' random sample stored: ${allFeatures.length}`);
            }
        }

        // Subsequent cycles: guided descriptors from knowledge base
        for (let cycle = 2; cycle <= cycles; cycle += 1) {
            if (guidedPerCycle <= 0) continue;
            const candidates = await selectTopDescriptors(connection, { limit: guidedPerCycle * 3 });
            const guided = [];
            for (const entry of candidates) {
                const spec = entry?.spec;
                if (!spec || !augmentations.includes(spec.augmentation)) continue;
                const vector = await generateSpecificVector(imagePath, spec);
                if (!vector) continue;
                const anchorBucketX = Math.round((spec.anchor_u ?? 0.5) * 10000);
                const anchorBucketY = Math.round((spec.anchor_v ?? 0.5) * 10000);
                const spanBucket = Math.max(0, Math.min(255, Math.round((spec.span ?? 0.05) * 255)));
                guided.push({
                    descriptor: vector.descriptor ?? spec.descriptor ?? spec,
                    resolution_level: spanBucket,
                    pos_x: anchorBucketX,
                    pos_y: anchorBucketY,
                    rel_x: vector.rel_x,
                    rel_y: vector.rel_y,
                    value: vector.value,
                    size: vector.size,
                });
                if (guided.length >= guidedPerCycle) break;
            }
            if (guided.length > 0) {
                totalInserted += await persistFeaturesBatched(connection, imageId, guided, valueTypeCache);
                console.log(`     [32m[1mCycle ${cycle} guided insert(s): ${guided.length}`);
            }
        }

        try {
            await connection.execute('UPDATE images SET ingestion_complete = 1 WHERE image_id = ?', [imageId]);
        } catch {}

        return { imageId, featureCount: totalInserted, totalFeatures: totalInserted };
    } finally {
        try { await connection.end(); } catch {}
    }
}

function chooseUniqueOrdinals(count, max, seedKey) {
    const n = Math.max(0, Math.min(count, max));
    if (n === 0) return [];
    let seed = 2166136261;
    const str = String(seedKey || '');
    for (let i = 0; i < str.length; i += 1) {
        seed ^= str.charCodeAt(i);
        seed = Math.imul(seed, 16777619);
    }
    function rng() {
        seed += 0x6d2b79f5;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), 1 | t);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const ordinals = new Set();
    while (ordinals.size < n) ordinals.add(Math.floor(rng() * max));
    return [...ordinals];
}

async function ensureImageBlobTable(connection) {
    await connection.execute(
        `CREATE TABLE IF NOT EXISTS image_blobs (
            image_id INT PRIMARY KEY,
            mime_type VARCHAR(64) NOT NULL,
            data LONGBLOB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (image_id) REFERENCES images(image_id) ON DELETE CASCADE
        ) ENGINE=InnoDB`
    );
}

function guessMimeType(imagePath) {
    const ext = path.extname(String(imagePath)).toLowerCase();
    switch (ext) {
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.png':
            return 'image/png';
        case '.webp':
            return 'image/webp';
        case '.bmp':
            return 'image/bmp';
        default:
            return null;
    }
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
    extractAndStoreFeaturesProgressive,
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
