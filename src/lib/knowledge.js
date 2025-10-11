const mysql = require('mysql2/promise');
require('dotenv').config();
const { scoreCandidateFeature, euclideanDistance } = require('./correlationMetrics');
const { extractAugmentationFromType } = require('./vectorSpecs');

async function createDbConnection() {
    return mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
}

async function getOrCreateFeatureNode(dbConnection, feature) {
    const details = JSON.stringify({
        type: feature.vector_type,
        augmentation: extractAugmentationFromType(feature.vector_type),
        level: feature.resolution_level,
        x: feature.pos_x,
        y: feature.pos_y,
    });

    const [rows] = await dbConnection.execute(
        `SELECT node_id FROM knowledge_nodes WHERE node_type = 'FEATURE' AND feature_details = ?`,
        [details]
    );
    if (rows.length > 0) return rows[0].node_id;

    const [result] = await dbConnection.execute(
        `INSERT INTO knowledge_nodes (node_type, feature_details) VALUES ('FEATURE', ?);`,
        [details]
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

async function getOrCreateFeatureGroupNode(dbConnection, parentNodeId, startFeature, discriminatorFeature) {
    const details = JSON.stringify({
        type: 'PAIR',
        discriminator: {
            vector_type: discriminatorFeature.vector_type,
            level: discriminatorFeature.resolution_level,
            x: discriminatorFeature.pos_x,
            y: discriminatorFeature.pos_y,
        },
    });

    const [rows] = await dbConnection.execute(
        `SELECT node_id FROM knowledge_nodes WHERE node_type = 'GROUP' AND parent_node_id = ? AND feature_details = ?`,
        [parentNodeId, details]
    );
    if (rows.length > 0) return rows[0].node_id;

    const [result] = await dbConnection.execute(
        `INSERT INTO knowledge_nodes (parent_node_id, node_type, feature_details) VALUES (?, 'GROUP', ?)`,
        [parentNodeId, details]
    );
    return result.insertId;
}

async function upsertFeatureGroupStats(dbConnection, startFeature, discriminatorFeature, metrics) {
    const sql = `
        INSERT INTO feature_group_stats (
            start_vector_type, start_resolution_level, start_pos_x, start_pos_y,
            discriminator_vector_type, discriminator_resolution_level, discriminator_pos_x, discriminator_pos_y,
            sample_size, mean_distance, std_distance, mean_cosine, mean_pearson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            mean_distance = ((mean_distance * sample_size) + (VALUES(mean_distance) * VALUES(sample_size))) / GREATEST(sample_size + VALUES(sample_size), 1),
            std_distance = ((std_distance * sample_size) + (VALUES(std_distance) * VALUES(sample_size))) / GREATEST(sample_size + VALUES(sample_size), 1),
            mean_cosine = ((mean_cosine * sample_size) + (VALUES(mean_cosine) * VALUES(sample_size))) / GREATEST(sample_size + VALUES(sample_size), 1),
            mean_pearson = ((mean_pearson * sample_size) + (VALUES(mean_pearson) * VALUES(sample_size))) / GREATEST(sample_size + VALUES(sample_size), 1),
            sample_size = sample_size + VALUES(sample_size)
    `;

    await dbConnection.execute(sql, [
        startFeature.vector_type,
        startFeature.resolution_level,
        startFeature.pos_x,
        startFeature.pos_y,
        discriminatorFeature.vector_type,
        discriminatorFeature.resolution_level,
        discriminatorFeature.pos_x,
        discriminatorFeature.pos_y,
        metrics.sampleSize,
        metrics.meanDistance ?? 0,
        metrics.stdDistance ?? 0,
        metrics.meanCosine ?? 0,
        metrics.meanPearson ?? 0,
    ]);
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
            const [startFeatures] = await dbConnection.execute(
                'SELECT * FROM feature_vectors WHERE image_id = ? ORDER BY RAND() LIMIT 1',
                [targetImageId]
            );
            const startFeature = startFeatures[0];
            if (!startFeature) continue;

            const [allSimilarFeatures] = await dbConnection.execute(
                'SELECT * FROM feature_vectors WHERE vector_type = ? AND resolution_level = ? AND pos_x = ? AND pos_y = ? AND image_id != ?',
                [startFeature.vector_type, startFeature.resolution_level, startFeature.pos_x, startFeature.pos_y, targetImageId]
            );

            const candidateImageIds = new Set();
            for (const feature of allSimilarFeatures) {
                if (euclideanDistance(startFeature.vector_data, feature.vector_data) < similarityThreshold) {
                    candidateImageIds.add(feature.image_id);
                }
            }

            if (candidateImageIds.size === 0) {
                continue;
            }

            let bestDiscriminator = null;
            let bestMetrics = null;
            let bestScore = -Infinity;

            const [targetFeatures] = await dbConnection.execute(
                'SELECT * FROM feature_vectors WHERE image_id = ?',
                [targetImageId]
            );

            for (const candidate of targetFeatures) {
                const [candidateFeatures] = await dbConnection.execute(
                    'SELECT * FROM feature_vectors WHERE vector_type = ? AND resolution_level = ? AND pos_x = ? AND pos_y = ? AND image_id IN (?)',
                    [candidate.vector_type, candidate.resolution_level, candidate.pos_x, candidate.pos_y, [...candidateImageIds]]
                );

                const evaluation = scoreCandidateFeature(candidate, candidateFeatures);
                if (!evaluation) continue;

                if (evaluation.score > bestScore) {
                    bestScore = evaluation.score;
                    bestDiscriminator = candidate;
                    bestMetrics = evaluation.metrics;
                }
            }

            if (!bestDiscriminator) continue;

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

            const groupNodeId = await getOrCreateFeatureGroupNode(dbConnection, startNodeId, startFeature, bestDiscriminator);
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
