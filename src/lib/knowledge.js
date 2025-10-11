const mysql = require('mysql2/promise');
require('dotenv').config();
const { scoreCandidateFeature, euclideanDistance } = require('./correlationMetrics');
const { parseDescriptor } = require('./descriptor');
const { recordVectorUsage } = require('./storageManager');

async function createDbConnection() {
    return mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
}

function hydrateFeatureRow(row) {
    const descriptor = parseDescriptor(row.descriptor_json);
    return {
        ...row,
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
    const baseScale = baseFeature.resolution_level || 1;
    const relatedScale = relatedFeature.resolution_level || 1;
    const baseX = (baseFeature.pos_x + 0.5) / baseScale;
    const baseY = (baseFeature.pos_y + 0.5) / baseScale;
    const relatedX = (relatedFeature.pos_x + 0.5) / relatedScale;
    const relatedY = (relatedFeature.pos_y + 0.5) / relatedScale;
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

async function discoverCorrelations({
    iterations,
    similarityThreshold,
    onIterationStart,
    onDiscriminatorSelected,
}) {
    const dbConnection = await createDbConnection();

    try {
        const [images] = await dbConnection.query('SELECT image_id FROM images;');
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
                 WHERE fv.value_type = ?
                   AND fv.resolution_level = ?
                   AND fv.pos_x = ?
                   AND fv.pos_y = ?
                   AND ABS(fv.rel_x - ?) < 1e-6
                   AND ABS(fv.rel_y - ?) < 1e-6
                   AND fv.image_id != ?`,
                [
                    startFeature.value_type,
                    startFeature.resolution_level,
                    startFeature.pos_x,
                    startFeature.pos_y,
                    startFeature.rel_x,
                    startFeature.rel_y,
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

            for (const row of targetRows) {
                const candidate = hydrateFeatureRow(row);
                const [candidateRows] = await dbConnection.execute(
                    `SELECT fv.*, vt.descriptor_json
                     FROM feature_vectors fv
                     JOIN value_types vt ON vt.value_type_id = fv.value_type
                     WHERE fv.value_type = ?
                       AND fv.resolution_level = ?
                       AND fv.pos_x = ?
                       AND fv.pos_y = ?
                       AND ABS(fv.rel_x - ?) < 1e-6
                       AND ABS(fv.rel_y - ?) < 1e-6
                       AND fv.image_id IN (?)`,
                    [
                        candidate.value_type,
                        candidate.resolution_level,
                        candidate.pos_x,
                        candidate.pos_y,
                        candidate.rel_x,
                        candidate.rel_y,
                        [...candidateImageIds],
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
            await recordVectorUsage(dbConnection, [bestDiscriminator.vector_id], 2, bestMetrics?.score ?? 0);

            onDiscriminatorSelected?.({
                iterationNumber,
                startFeature,
                discriminatorFeature: bestDiscriminator,
                metrics: bestMetrics,
                ambiguousCandidates: candidateImageIds.size,
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

            if (bestMetrics && bestMetrics.sampleSize > 0) {
                await upsertFeatureGroupStats(dbConnection, startFeature, bestDiscriminator, bestMetrics);
            }
        }
    } finally {
        await dbConnection.end();
    }
}

module.exports = {
    createDbConnection,
    discoverCorrelations,
    getOrCreateFeatureNode,
    updateNodeStats,
    getOrCreateFeatureGroupNode,
    upsertFeatureGroupStats,
};
