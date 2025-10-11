// --- LIBRARIES ---
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- CONFIGURATION ---
// The number of training cycles to run. Each cycle picks one image and learns from it.
const TRAINING_ITERATIONS = 50; 
// How similar two vectors must be to be considered a potential match (Euclidean distance).
const SIMILARITY_THRESHOLD = 0.1; 
const MAX_CANDIDATE_SAMPLE = 256;
const MIN_AFFINITY = 0.12;
const MIN_SPREAD = 0.008;

// --- DATABASE & HELPER FUNCTIONS ---

let dbConnection;

/**
 * Calculates the Euclidean distance between two vectors (as Buffers).
 */
function euclideanDistance(buf1, buf2) {
    if (!buf1 || !buf2 || buf1.length !== buf2.length) {
        return Infinity;
    }
    const vec1 = new Float32Array(buf1.buffer, buf1.byteOffset, buf1.length / Float32Array.BYTES_PER_ELEMENT);
    const vec2 = new Float32Array(buf2.buffer, buf2.byteOffset, buf2.length / Float32Array.BYTES_PER_ELEMENT);
    
    let sum = 0;
    for (let i = 0; i < vec1.length; i++) {
        sum += (vec1[i] - vec2[i]) ** 2;
    }
    return Math.sqrt(sum);
}

function bufferToFloat32Array(buffer) {
    if (!buffer) return null;
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / Float32Array.BYTES_PER_ELEMENT);
}

function cosineSimilarity(buf1, buf2) {
    if (!buf1 || !buf2 || buf1.length !== buf2.length) return 0;
    const vec1 = bufferToFloat32Array(buf1);
    const vec2 = bufferToFloat32Array(buf2);
    let dot = 0, norm1 = 0, norm2 = 0;
    for (let i = 0; i < vec1.length; i++) {
        dot += vec1[i] * vec2[i];
        norm1 += vec1[i] * vec1[i];
        norm2 += vec2[i] * vec2[i];
    }
    if (norm1 === 0 || norm2 === 0) return 0;
    return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

function pearsonCorrelation(buf1, buf2) {
    if (!buf1 || !buf2 || buf1.length !== buf2.length) return 0;
    const vec1 = bufferToFloat32Array(buf1);
    const vec2 = bufferToFloat32Array(buf2);
    const n = vec1.length;
    if (n === 0) return 0;

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
        const x = vec1[i];
        const y = vec2[i];
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
        sumY2 += y * y;
    }
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (!isFinite(denominator) || denominator === 0) return 0;
    return numerator / denominator;
}

function meanAndStd(values) {
    if (!values || values.length === 0) return { mean: 0, std: 0 };
    const mean = values.reduce((acc, val) => acc + val, 0) / values.length;
    const variance = values.reduce((acc, val) => acc + (val - mean) * (val - mean), 0) / values.length;
    return { mean, std: Math.sqrt(Math.max(variance, 0)) };
}

function scoreCandidateFeature(targetFeature, candidateFeatures) {
    if (!candidateFeatures || candidateFeatures.length === 0) {
        return null;
    }

    const sampledCandidates = candidateFeatures.slice(0, MAX_CANDIDATE_SAMPLE);
    const distances = [];
    const cosineValues = [];
    const pearsonValues = [];

    for (const candidate of sampledCandidates) {
        distances.push(euclideanDistance(targetFeature.vector_data, candidate.vector_data));
        cosineValues.push(cosineSimilarity(targetFeature.vector_data, candidate.vector_data));
        pearsonValues.push(pearsonCorrelation(targetFeature.vector_data, candidate.vector_data));
    }

    const { mean: meanDistance, std: stdDistance } = meanAndStd(distances);
    const meanCosine = cosineValues.reduce((acc, val) => acc + val, 0) / cosineValues.length;
    const meanPearson = pearsonValues.reduce((acc, val) => acc + val, 0) / pearsonValues.length;

    const affinity = Math.max(0, (1 - (meanCosine || 0)) + (1 - (meanPearson || 0)));
    const spread = Math.max(0, (meanDistance || 0) + (stdDistance || 0));
    if (affinity < MIN_AFFINITY || spread < MIN_SPREAD) {
        return null;
    }

    const costPenalty = Math.log1p(sampledCandidates.length);
    const separationScore = (spread * affinity) / Math.max(costPenalty, 1);

    return {
        score: separationScore,
        metrics: {
            meanDistance,
            stdDistance,
            meanCosine,
            meanPearson,
            sampleSize: sampledCandidates.length,
            originalCandidateCount: candidateFeatures.length,
            affinity,
            spread,
        },
    };
}

/**
 * Gets or creates a 'FEATURE' node in the knowledge base.
 * Returns the node_id.
 */
async function getOrCreateFeatureNode(feature) {
    const details = JSON.stringify({
        type: feature.vector_type,
        level: feature.resolution_level,
        x: feature.pos_x,
        y: feature.pos_y
    });

    // Check if it already exists
    const [rows] = await dbConnection.execute(
        `SELECT node_id FROM knowledge_nodes WHERE node_type = 'FEATURE' AND feature_details = ?`,
        [details]
    );
    if (rows.length > 0) return rows[0].node_id;

    // If not, create it
    const [result] = await dbConnection.execute(
        `INSERT INTO knowledge_nodes (node_type, feature_details) VALUES ('FEATURE', ?);`,
        [details]
    );
    return result.insertId;
}

/**
 * Increments the hit or miss count for a given knowledge node.
 */
async function updateNodeStats(nodeId, outcome, amount = 1) {
    const field = outcome === 'hit' ? 'hit_count' : 'miss_count';
    await dbConnection.execute(
        `UPDATE knowledge_nodes SET ${field} = ${field} + ? WHERE node_id = ?`,
        [amount, nodeId]
    );
}

async function getOrCreateFeatureGroupNode(parentNodeId, startFeature, discriminatorFeature) {
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

async function upsertFeatureGroupStats(startFeature, discriminatorFeature, metrics) {
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


// --- MAIN TRAINING LOGIC ---

async function runTraining() {
    try {
        dbConnection = await mysql.createConnection({
            host: process.env.DB_HOST, user: process.env.DB_USER,
            password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
        });
        console.log("🗄️  Connected to database for training session.");

        // Get all image IDs from the database to use as our training set.
        const [images] = await dbConnection.query('SELECT image_id FROM images;');
        const imageIds = images.map(i => i.image_id);
        if (imageIds.length < 2) {
            throw new Error("Training requires at least 2 images in the database. Please run featureExtractor.js on multiple images.");
        }

        console.log(`🧠 Starting training with ${imageIds.length} images for ${TRAINING_ITERATIONS} iterations.`);

        for (let i = 0; i < TRAINING_ITERATIONS; i++) {
            console.log(`\n--- Iteration ${i + 1} / ${TRAINING_ITERATIONS} ---`);
            
            // 1. Pick a random image to be the "query".
            const targetImageId = imageIds[Math.floor(Math.random() * imageIds.length)];
            console.log(`  🎯 Target image ID: ${targetImageId}`);

            // 2. Select a random feature from this image to start the "search".
            const [startFeatures] = await dbConnection.execute(
                'SELECT * FROM feature_vectors WHERE image_id = ? ORDER BY RAND() LIMIT 1', [targetImageId]
            );
            const startFeature = startFeatures[0];
            
            // 3. Find all candidate images that have a similar starting feature.
            const [allSimilarFeatures] = await dbConnection.execute(
                'SELECT * FROM feature_vectors WHERE vector_type = ? AND resolution_level = ? AND pos_x = ? AND pos_y = ? AND image_id != ?',
                [startFeature.vector_type, startFeature.resolution_level, startFeature.pos_x, startFeature.pos_y, targetImageId]
            );
            
            let candidateImageIds = new Set();
            for (const feature of allSimilarFeatures) {
                if (euclideanDistance(startFeature.vector_data, feature.vector_data) < SIMILARITY_THRESHOLD) {
                    candidateImageIds.add(feature.image_id);
                }
            }
            
            if (candidateImageIds.size === 0) {
                console.log("  ✅ Lucky find! The first feature was unique. No learning needed for this case.");
                continue;
            }
            console.log(`  Initial search found ${candidateImageIds.size} potential false positives.`);

            // 4. THE LEARNING STEP: Find a second feature that best discriminates the target from the candidates.
            let bestDiscriminator = null;
            let bestMetrics = null;
            let bestScore = -Infinity;

            const [targetFeatures] = await dbConnection.execute('SELECT * FROM feature_vectors WHERE image_id = ?', [targetImageId]);
            
            // Loop through all features of the target image to find the best one for discriminating.
            for (const potentialDiscriminator of targetFeatures) {
                const [candidateFeatures] = await dbConnection.execute(
                    'SELECT * FROM feature_vectors WHERE vector_type = ? AND resolution_level = ? AND pos_x = ? AND pos_y = ? AND image_id IN (?)',
                    [potentialDiscriminator.vector_type, potentialDiscriminator.resolution_level, potentialDiscriminator.pos_x, potentialDiscriminator.pos_y, [...candidateImageIds]]
                );

                const evaluation = scoreCandidateFeature(potentialDiscriminator, candidateFeatures);
                if (!evaluation) continue;

                if (evaluation.score > bestScore) {
                    bestScore = evaluation.score;
                    bestDiscriminator = potentialDiscriminator;
                    bestMetrics = evaluation.metrics;
                }
            }

            if (bestDiscriminator) {
                console.log(`  Found a good discriminating feature: ${bestDiscriminator.vector_type} at [${bestDiscriminator.pos_x}, ${bestDiscriminator.pos_y}]`);
                if (bestMetrics) {
                    console.log(
                        `    -> Metrics: spread=${bestMetrics.spread.toFixed(4)}, affinity=${bestMetrics.affinity.toFixed(4)}, mean distance=${bestMetrics.meanDistance.toFixed(4)}, std=${bestMetrics.stdDistance.toFixed(4)}, mean cosine=${bestMetrics.meanCosine.toFixed(4)}, mean pearson=${bestMetrics.meanPearson.toFixed(4)}, samples=${bestMetrics.sampleSize}/${bestMetrics.originalCandidateCount}`
                    );
                }
                // 5. Update the knowledge base
                const startNodeId = await getOrCreateFeatureNode(startFeature);
                const discriminatorNodeId = await getOrCreateFeatureNode(bestDiscriminator);

                const affinityFactor = bestMetrics ? Math.max(0.5, Math.min(bestMetrics.affinity, 2)) : 1;
                const costNormalizer = bestMetrics ? Math.max(1, Math.log1p(bestMetrics.originalCandidateCount || bestMetrics.sampleSize || 1)) : 1;
                const increment = bestMetrics
                    ? Math.max(1, Math.round((bestMetrics.sampleSize * affinityFactor) / costNormalizer))
                    : 1;
                await updateNodeStats(startNodeId, 'hit', increment);
                await updateNodeStats(discriminatorNodeId, 'hit', increment);

                const groupNodeId = await getOrCreateFeatureGroupNode(startNodeId, startFeature, bestDiscriminator);
                await updateNodeStats(groupNodeId, 'hit', increment);

                if (bestMetrics && bestMetrics.sampleSize > 0) {
                    await upsertFeatureGroupStats(startFeature, bestDiscriminator, bestMetrics);
                }

                console.log(`  📈 Updated knowledge base for the useful feature combination.`);
            } else {
                 console.log("  Could not find a clear discriminating feature for this set.");
            }
        }

        console.log("\n🎉 Training session completed!");

    } catch (error) {
        console.error("\n❌ An error occurred during training:", error);
        process.exit(1);
    } finally {
        if (dbConnection) {
            await dbConnection.end();
            console.log("\n🔌 Connection closed.");
        }
    }
}

runTraining();
