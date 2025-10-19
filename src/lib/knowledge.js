const mysql = require('mysql2/promise');
require('dotenv').config();
const settings = require('../settings');
const { scoreCandidateFeature, euclideanDistance } = require('./correlationMetrics');
const { collectElasticMatches } = require('./elasticMatcher');
const { CONSTELLATION_CONSTANTS } = require('./constants');
const { parseDescriptor, createDescriptorKey } = require('./descriptor');
const { descriptorToSpec } = require('./constellation');
const { recordVectorUsage } = require('./storageManager');
const { normalizeResolutionLevel, RESOLUTION_LEVEL_TOLERANCE } = require('./resolutionLevel');

async function createDbConnection() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    try {
        await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
    } catch {
        // best effort
    }
    return conn;
}

function hydrateFeatureRow(row) {
    const descriptor = parseDescriptor(row.descriptor_json);
    return {
        ...row,
        resolution_level: normalizeResolutionLevel(Number(row.resolution_level)),
        descriptor,
    };
}

async function getOrCreateFeatureNode(dbConnection, feature) {
    const [rows] = await dbConnection.execute(
        `SELECT node_id FROM knowledge_nodes
         WHERE node_type = 'FEATURE' AND vector_1_id = ?`,
        [feature.vector_id]
    );
    if (rows.length > 0) return rows[0].node_id;

    const [result] = await dbConnection.execute(
        `INSERT INTO knowledge_nodes (
            parent_node_id,
            node_type,
            vector_1_id,
            vector_2_id,
            vector_length,
            vector_angle,
            vector_value
        ) VALUES (NULL, 'FEATURE', ?, NULL, 0, 0, ?);`,
        [feature.vector_id, feature.value]
    );
    return result.insertId;
}

async function updateNodeStats(dbConnection, nodeId, outcome, amount = 1) {
    const field = outcome === 'hit' ? 'hit_count' : 'miss_count';
    await dbConnection.execute(
        `UPDATE knowledge_nodes SET ${field} = ${field} + ? WHERE node_id = ?`,
        [amount, nodeId]
    );
}

function deriveVectorGeometry(baseFeature, relatedFeature) {
    const baseDescriptor = baseFeature.descriptor ?? parseDescriptor(baseFeature.descriptor_json) ?? {};
    const relatedDescriptor = relatedFeature.descriptor ?? parseDescriptor(relatedFeature.descriptor_json) ?? {};

    const baseX = Number(baseDescriptor.anchor_u ?? (baseFeature.pos_x / CONSTELLATION_CONSTANTS.ANCHOR_SCALE) ?? 0);
    const baseY = Number(baseDescriptor.anchor_v ?? (baseFeature.pos_y / CONSTELLATION_CONSTANTS.ANCHOR_SCALE) ?? 0);
    const relatedX = Number(relatedDescriptor.anchor_u ?? (relatedFeature.pos_x / CONSTELLATION_CONSTANTS.ANCHOR_SCALE) ?? 0);
    const relatedY = Number(relatedDescriptor.anchor_v ?? (relatedFeature.pos_y / CONSTELLATION_CONSTANTS.ANCHOR_SCALE) ?? 0);

    const dx = relatedX - baseX;
    const dy = relatedY - baseY;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    const valueDelta = relatedFeature.value - baseFeature.value;
    return { length, angle, valueDelta };
}

async function getOrCreateFeatureGroupNode(dbConnection, parentNodeId, startFeature, discriminatorFeature) {
    const { length, angle, valueDelta } = deriveVectorGeometry(startFeature, discriminatorFeature);

    const [rows] = await dbConnection.execute(
        `SELECT node_id FROM knowledge_nodes
         WHERE node_type = 'GROUP'
           AND parent_node_id = ?
           AND vector_1_id = ?
           AND vector_2_id = ?
           AND ABS(vector_length - ?) < 1e-6
           AND ABS(vector_angle - ?) < 1e-6`,
        [parentNodeId, startFeature.vector_id, discriminatorFeature.vector_id, length, angle]
    );
    if (rows.length > 0) return rows[0].node_id;

    const [result] = await dbConnection.execute(
        `INSERT INTO knowledge_nodes (
            parent_node_id,
            node_type,
            vector_1_id,
            vector_2_id,
            vector_length,
            vector_angle,
            vector_value
        ) VALUES (?, 'GROUP', ?, ?, ?, ?, ?)`,
        [parentNodeId, startFeature.vector_id, discriminatorFeature.vector_id, length, angle, valueDelta]
    );
    return result.insertId;
}

async function upsertFeatureGroupStats(dbConnection, startFeature, discriminatorFeature, metrics) {
    const { length, angle } = deriveVectorGeometry(startFeature, discriminatorFeature);

    await dbConnection.execute(
        `INSERT INTO feature_group_stats (
            value_type,
            resolution_level,
            avg_length,
            avg_angle,
            sample_size,
            mean_distance,
            std_distance,
            mean_cosine,
            mean_pearson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            avg_length = ((avg_length * sample_size) + (VALUES(avg_length) * VALUES(sample_size))) / GREATEST(sample_size + VALUES(sample_size), 1),
            avg_angle = ((avg_angle * sample_size) + (VALUES(avg_angle) * VALUES(sample_size))) / GREATEST(sample_size + VALUES(sample_size), 1),
            mean_distance = ((mean_distance * sample_size) + (VALUES(mean_distance) * VALUES(sample_size))) / GREATEST(sample_size + VALUES(sample_size), 1),
            std_distance = ((std_distance * sample_size) + (VALUES(std_distance) * VALUES(sample_size))) / GREATEST(sample_size + VALUES(sample_size), 1),
            mean_cosine = ((mean_cosine * sample_size) + (VALUES(mean_cosine) * VALUES(sample_size))) / GREATEST(sample_size + VALUES(sample_size), 1),
            mean_pearson = ((mean_pearson * sample_size) + (VALUES(mean_pearson) * VALUES(sample_size))) / GREATEST(sample_size + VALUES(sample_size), 1),
            sample_size = sample_size + VALUES(sample_size)
        `,
        [
            startFeature.value_type,
            startFeature.resolution_level,
            length,
            angle,
            metrics.sampleSize,
            metrics.meanDistance ?? 0,
            metrics.stdDistance ?? 0,
            metrics.meanCosine ?? 0,
            metrics.meanPearson ?? 0,
        ]
    );
}

async function fetchConstellationGraph(dbConnection, options = {}) {
    const limit = Math.max(1, Number(options.limit ?? 80));
    const minHits = Math.max(0, Number(options.minHits ?? 1));

    const [rows] = await dbConnection.execute(
        `SELECT
            kn.node_id,
            kn.parent_node_id,
            kn.vector_length,
            kn.vector_angle,
            kn.vector_value,
            kn.hit_count,
            kn.miss_count,
            fv1.vector_id AS anchor_vector_id,
            fv1.value_type AS anchor_value_type,
            fv2.vector_id AS related_vector_id,
            fv2.value_type AS related_value_type,
            vt1.descriptor_json AS anchor_descriptor_json,
            vt2.descriptor_json AS related_descriptor_json
         FROM knowledge_nodes kn
         JOIN feature_vectors fv1 ON fv1.vector_id = kn.vector_1_id
         JOIN value_types vt1 ON vt1.value_type_id = fv1.value_type
         JOIN feature_vectors fv2 ON fv2.vector_id = kn.vector_2_id
         JOIN value_types vt2 ON vt2.value_type_id = fv2.value_type
         WHERE kn.node_type = 'GROUP'
           AND kn.vector_2_id IS NOT NULL
           AND kn.hit_count >= ?
         ORDER BY kn.hit_count DESC, kn.miss_count ASC, kn.node_id ASC
         LIMIT ?`,
        [minHits, limit]
    );

    const results = [];
    for (const row of rows) {
        const anchorDescriptor = parseDescriptor(row.anchor_descriptor_json);
        const relatedDescriptor = parseDescriptor(row.related_descriptor_json);
        if (!relatedDescriptor) continue;
        results.push({
            nodeId: row.node_id,
            parentNodeId: row.parent_node_id,
            anchorVectorId: Number(row.anchor_vector_id) || null,
            relatedVectorId: Number(row.related_vector_id) || null,
            anchorValueType: Number(row.anchor_value_type) || null,
            relatedValueType: Number(row.related_value_type) || null,
            hit_count: Number(row.hit_count) || 0,
            miss_count: Number(row.miss_count) || 0,
            vector_length: Number(row.vector_length) || 0,
            vector_angle: Number(row.vector_angle) || 0,
            vector_value: Number(row.vector_value) || 0,
            anchorDescriptor,
            relatedDescriptor,
        });
    }

    return results;
}

async function discoverCorrelations({
    iterations,
    similarityThreshold,
    onIterationStart,
    onDiscriminatorSelected,
}) {
    const dbConnection = await createDbConnection();

    try {
        const minAge = Number(settings?.training?.minCompletedImageAgeMinutes || 0);
        const ageClause = minAge > 0 ? 'AND created_at <= (NOW() - INTERVAL ? MINUTE)' : '';
        const params = [];
        if (minAge > 0) params.push(minAge);
        const [images] = await dbConnection.execute(
            `SELECT image_id FROM images WHERE ingestion_complete = 1 ${ageClause}`,
            params
        );
        const imageIds = images.map((row) => row.image_id);
        if (imageIds.length < 2) {
            throw new Error('Correlation discovery requires at least two images in the database.');
        }

        for (let i = 0; i < iterations; i++) {
            const iterationNumber = i + 1;
            onIterationStart?.(iterationNumber, iterations);

            const targetImageId = imageIds[Math.floor(Math.random() * imageIds.length)];
            const [startRows] = await dbConnection.execute(
                `SELECT fv.*, vt.descriptor_json
                 FROM feature_vectors fv
                 JOIN value_types vt ON vt.value_type_id = fv.value_type
                 WHERE fv.image_id = ?
                 ORDER BY RAND()
                 LIMIT 1`,
                [targetImageId]
            );
            if (startRows.length === 0) continue;
            const startFeature = hydrateFeatureRow(startRows[0]);
            await recordVectorUsage(dbConnection, [startFeature.vector_id], 1, 0);

            const [similarRows] = await dbConnection.execute(
                `SELECT fv.*, vt.descriptor_json
                 FROM feature_vectors fv
                 JOIN value_types vt ON vt.value_type_id = fv.value_type
                 JOIN images im ON im.image_id = fv.image_id
                 WHERE fv.value_type = ?
                   AND ABS(fv.resolution_level - ?) <= ?
                   AND fv.pos_x = ?
                   AND fv.pos_y = ?
                   AND ABS(fv.rel_x - ?) <= ?
                   AND ABS(fv.rel_y - ?) <= ?
                   AND fv.image_id != ?
                   AND im.ingestion_complete = 1` ,
                [
                    startFeature.value_type,
                    startFeature.resolution_level,
                    RESOLUTION_LEVEL_TOLERANCE,
                    startFeature.pos_x,
                    startFeature.pos_y,
                    startFeature.rel_x,
                    CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
                    startFeature.rel_y,
                    CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
                    targetImageId,
                ]
            );

            const candidateImageIds = new Set();
            const similarVectorIds = [];
            for (const row of similarRows) {
                const feature = hydrateFeatureRow(row);
                if (euclideanDistance(startFeature, feature) < similarityThreshold) {
                    candidateImageIds.add(feature.image_id);
                    similarVectorIds.push(feature.vector_id);
                }
            }
            if (similarVectorIds.length) {
                await recordVectorUsage(dbConnection, similarVectorIds, 1, 0);
            }

            if (candidateImageIds.size === 0) continue;

            const candidateImageList = Array.from(candidateImageIds);
            if (candidateImageList.length === 0) continue;

            let bestDiscriminator = null;
            let bestMetrics = null;
            let bestScore = -Infinity;

            const [targetRows] = await dbConnection.execute(
                `SELECT fv.*, vt.descriptor_json
                 FROM feature_vectors fv
                 JOIN value_types vt ON vt.value_type_id = fv.value_type
                 WHERE fv.image_id = ?`,
                [targetImageId]
            );

            const candidatePlaceholders = candidateImageList.map(() => '?').join(', ');
            const candidateQuery = `SELECT fv.*, vt.descriptor_json
                 FROM feature_vectors fv
                 JOIN value_types vt ON vt.value_type_id = fv.value_type
                 JOIN images im ON im.image_id = fv.image_id
                 WHERE fv.value_type = ?
                   AND ABS(fv.resolution_level - ?) <= ?
                   AND fv.pos_x = ?
                   AND fv.pos_y = ?
                   AND ABS(fv.rel_x - ?) <= ?
                   AND ABS(fv.rel_y - ?) <= ?
                   AND im.ingestion_complete = 1
                   AND fv.image_id IN (${candidatePlaceholders})`;

            for (const row of targetRows) {
                const candidate = hydrateFeatureRow(row);

                const [candidateRows] = await dbConnection.execute(
                    candidateQuery,
                    [
                        candidate.value_type,
                        candidate.resolution_level,
                        RESOLUTION_LEVEL_TOLERANCE,
                        candidate.pos_x,
                        candidate.pos_y,
                        candidate.rel_x,
                        CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
                        candidate.rel_y,
                        CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
                        ...candidateImageList,
                    ]
                );

                const hydratedCandidates = candidateRows.map(hydrateFeatureRow);
                const evaluation = scoreCandidateFeature(candidate, hydratedCandidates);
                if (!evaluation) continue;

                if (evaluation.score > bestScore) {
                    bestScore = evaluation.score;
                    bestDiscriminator = candidate;
                    bestMetrics = evaluation.metrics;
                }
            }

            if (!bestDiscriminator) continue;

            const metricsWithScore = bestMetrics
                ? { ...bestMetrics, score: bestScore }
                : null;

            await recordVectorUsage(dbConnection, [bestDiscriminator.vector_id], 2, metricsWithScore?.score ?? 0);

            // Optionally compute and report top correlated images for this discriminator.
            let topMatches = [];
            const topK = Math.max(0, Number(settings?.training?.correlationTopLogK ?? 0));
            if (topK > 0 && candidateImageList.length > 0) {
                try {
                    const [rows] = await dbConnection.execute(
                        `SELECT fv.image_id, fv.value, fv.rel_x, fv.rel_y, fv.size, fv.value_type, fv.resolution_level, fv.pos_x, fv.pos_y, img.original_filename
                         FROM feature_vectors fv
                         JOIN images img ON img.image_id = fv.image_id
                         WHERE fv.value_type = ?
                           AND ABS(fv.resolution_level - ?) <= ?
                           AND fv.pos_x = ?
                           AND fv.pos_y = ?
                           AND ABS(fv.rel_x - ?) <= ?
                           AND ABS(fv.rel_y - ?) <= ?
                           AND img.ingestion_complete = 1
                           AND fv.image_id IN (${candidateImageList.map(() => '?').join(',')})`,
                        [
                            bestDiscriminator.value_type,
                            bestDiscriminator.resolution_level,
                            RESOLUTION_LEVEL_TOLERANCE,
                            bestDiscriminator.pos_x,
                            bestDiscriminator.pos_y,
                            bestDiscriminator.rel_x,
                            CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
                            bestDiscriminator.rel_y,
                            CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
                            ...candidateImageList,
                        ]
                    );

                    // Form a target feature compatible with scoring helpers
                    const targetFeature = {
                        value_type: bestDiscriminator.value_type,
                        resolution_level: bestDiscriminator.resolution_level,
                        pos_x: bestDiscriminator.pos_x,
                        pos_y: bestDiscriminator.pos_y,
                        rel_x: bestDiscriminator.rel_x,
                        rel_y: bestDiscriminator.rel_y,
                        size: bestDiscriminator.size,
                        value: bestDiscriminator.value,
                    };

                    // Use elastic grouping to keep consistency with evaluation
                    const selection = collectElasticMatches(rows, targetFeature, {
                        baseThreshold: settings.search.valueThreshold,
                        minUniqueImages: Math.max(1, Math.min(topK, rows.length || 0)),
                        maxEntries: Math.max(32, topK * 12),
                    });

                    const scored = [];
                    for (const group of selection.grouped.values()) {
                        const evaluation = scoreCandidateFeature(targetFeature, group.features);
                        if (!evaluation) continue;
                        const distances = group.distances || [];
                        const distanceMean = distances.length
                            ? distances.reduce((acc, v) => acc + v, 0) / distances.length
                            : null;
                        scored.push({
                            imageId: group.imageId,
                            filename: group.label,
                            score: Number(evaluation.score) || 0,
                            affinity: Number(evaluation.metrics?.affinity) || 0,
                            cohesion: Number(evaluation.metrics?.cohesion) || 0,
                            sampleSize: Number(evaluation.metrics?.sampleSize ?? evaluation.metrics?.originalCandidateCount ?? 0) || 0,
                            distanceMean,
                        });
                    }

                    scored.sort((a, b) => b.score - a.score);
                    topMatches = scored.slice(0, topK);
                } catch {
                    // non-fatal: skip detailed match reporting
                    topMatches = [];
                }
            }

            onDiscriminatorSelected?.({
                iterationNumber,
                startFeature,
                discriminatorFeature: bestDiscriminator,
                metrics: metricsWithScore,
                ambiguousCandidates: candidateImageIds.size,
                topMatches,
            });

            const startNodeId = await getOrCreateFeatureNode(dbConnection, startFeature);
            const discriminatorNodeId = await getOrCreateFeatureNode(dbConnection, bestDiscriminator);

            const affinityFactor = bestMetrics ? Math.max(0.5, Math.min(bestMetrics.affinity, 2)) : 1;
            const costNormalizer = bestMetrics
                ? Math.max(1, Math.log1p(bestMetrics.originalCandidateCount || bestMetrics.sampleSize || 1))
                : 1;
            const increment = bestMetrics
                ? Math.max(1, Math.round((bestMetrics.sampleSize * affinityFactor) / costNormalizer))
                : 1;

            await updateNodeStats(dbConnection, startNodeId, 'hit', increment);
            await updateNodeStats(dbConnection, discriminatorNodeId, 'hit', increment);

            const groupNodeId = await getOrCreateFeatureGroupNode(
                dbConnection,
                startNodeId,
                startFeature,
                bestDiscriminator
            );
            await updateNodeStats(dbConnection, groupNodeId, 'hit', increment);

            if (metricsWithScore && metricsWithScore.sampleSize > 0) {
                await upsertFeatureGroupStats(dbConnection, startFeature, bestDiscriminator, metricsWithScore);
            }
        }
    } finally {
        await dbConnection.end();
    }
}

async function fetchRelatedConstellations(dbConnection, options = {}) {
    const limit = Math.max(1, Number(options.limit ?? 12));
    const minHits = Math.max(0, Number(options.minHits ?? 1));
    const baseDescriptorKey = options.descriptorKey;
    let valueTypeId = Number(options.valueTypeId);

    if (!valueTypeId) {
        if (!baseDescriptorKey) return [];
        const [valueTypeRows] = await dbConnection.execute(
            'SELECT value_type_id FROM value_types WHERE descriptor_hash = ? LIMIT 1',
            [baseDescriptorKey]
        );
        if (valueTypeRows.length === 0) return [];
        valueTypeId = Number(valueTypeRows[0].value_type_id);
    }

    const whereClauses = [`kn.node_type = 'GROUP'`, `kn.vector_2_id IS NOT NULL`, `fv1.value_type = ?`];
    const params = [valueTypeId];

    if (Number.isFinite(options.resolutionLevel)) {
        const normalizedResolution = normalizeResolutionLevel(Number(options.resolutionLevel));
        whereClauses.push('ABS(fv1.resolution_level - ?) <= ?');
        params.push(normalizedResolution, RESOLUTION_LEVEL_TOLERANCE);
    }

    whereClauses.push('kn.hit_count >= ?');
    params.push(minHits);

    const [rows] = await dbConnection.execute(
        `SELECT kn.node_id,
                kn.hit_count,
                kn.miss_count,
                fv2.value_type AS related_value_type,
                fv2.resolution_level AS related_resolution_level,
                vt2.descriptor_json AS related_descriptor_json
         FROM knowledge_nodes kn
         JOIN feature_vectors fv1 ON fv1.vector_id = kn.vector_1_id
         JOIN feature_vectors fv2 ON fv2.vector_id = kn.vector_2_id
         JOIN value_types vt2 ON vt2.value_type_id = fv2.value_type
         WHERE ${whereClauses.join(' AND ')}
         ORDER BY kn.hit_count DESC, kn.miss_count ASC, kn.node_id ASC
         LIMIT ?`,
        [...params, limit]
    );

    const seen = new Map();
    for (const row of rows) {
        const descriptor = parseDescriptor(row.related_descriptor_json);
        if (!descriptor) continue;
        const spec = descriptorToSpec(descriptor);
        if (!spec) continue;
        const descriptorKey = spec.descriptorKey ?? createDescriptorKey(descriptor);
        if (descriptorKey === baseDescriptorKey) continue;
        const hits = Number(row.hit_count) || 0;
        const misses = Number(row.miss_count) || 0;
        const total = Math.max(0, hits + misses);
        const confidence = total > 0 ? hits / total : hits > 0 ? 1 : 0;
        const existing = seen.get(descriptorKey);
        if (!existing || existing.confidence < confidence) {
            seen.set(descriptorKey, {
                descriptor,
                spec,
                descriptorKey,
                confidence: Math.max(0, Math.min(1, confidence)),
                hits,
                misses,
                knowledgeNodeId: Number(row.node_id) || null,
            });
        }
    }

    return Array.from(seen.values());
}

module.exports = {
    createDbConnection,
    discoverCorrelations,
    getOrCreateFeatureNode,
    updateNodeStats,
    getOrCreateFeatureGroupNode,
    upsertFeatureGroupStats,
    fetchConstellationGraph,
    selectTopDescriptors,
    fetchRelatedConstellations,
};

async function selectTopDescriptors(db, options = {}) {
    const limit = Math.max(1, Number(options.limit ?? 200));
    const minSampleSize = Math.max(0, Number(options.minSampleSize ?? 0));
    const [rows] = await db.execute(
        `SELECT fgs.value_type, fgs.resolution_level, fgs.sample_size, fgs.mean_distance, fgs.std_distance,
                fgs.mean_cosine, fgs.mean_pearson, vt.descriptor_json
         FROM feature_group_stats fgs
         JOIN value_types vt ON vt.value_type_id = fgs.value_type
         ORDER BY fgs.sample_size DESC
         LIMIT ?`,
        [limit]
    );
    const results = [];
    for (const row of rows) {
        if (minSampleSize > 0 && Number(row.sample_size || 0) < minSampleSize) continue;
        const descriptor = parseDescriptor(row.descriptor_json);
        const spec = descriptorToSpec(descriptor);
        if (!spec) continue;
        results.push({
            value_type: row.value_type,
            resolution_level: normalizeResolutionLevel(Number(row.resolution_level)),
            sample_size: Number(row.sample_size),
            mean_distance: Number(row.mean_distance),
            std_distance: Number(row.std_distance),
            mean_cosine: Number(row.mean_cosine),
            mean_pearson: Number(row.mean_pearson),
            spec,
        });
    }
    return results;
}
