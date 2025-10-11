// --- LIBRARIES ---
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- CONFIGURATION ---
// The number of training cycles to run. Each cycle picks one image and learns from it.
const TRAINING_ITERATIONS = 50; 
// How similar two vectors must be to be considered a potential match (Euclidean distance).
const SIMILARITY_THRESHOLD = 0.1; 

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
async function updateNodeStats(nodeId, outcome) {
    const field = outcome === 'hit' ? 'hit_count' : 'miss_count';
    await dbConnection.execute(
        `UPDATE knowledge_nodes SET ${field} = ${field} + 1 WHERE node_id = ?`,
        [nodeId]
    );
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
            let maxSpread = -1;

            const [targetFeatures] = await dbConnection.execute('SELECT * FROM feature_vectors WHERE image_id = ?', [targetImageId]);
            
            // Loop through all features of the target image to find the best one for discriminating.
            for (const potentialDiscriminator of targetFeatures) {
                const [candidateFeatures] = await dbConnection.execute(
                    'SELECT * FROM feature_vectors WHERE vector_type = ? AND resolution_level = ? AND pos_x = ? AND pos_y = ? AND image_id IN (?)',
                    [potentialDiscriminator.vector_type, potentialDiscriminator.resolution_level, potentialDiscriminator.pos_x, potentialDiscriminator.pos_y, [...candidateImageIds]]
                );

                if (candidateFeatures.length === 0) continue;

                // Calculate the "spread" - the average distance from the target's feature to the candidates' features.
                let totalDistance = 0;
                for (const cf of candidateFeatures) {
                    totalDistance += euclideanDistance(potentialDiscriminator.vector_data, cf.vector_data);
                }
                const avgDistance = totalDistance / candidateFeatures.length;

                if (avgDistance > maxSpread) {
                    maxSpread = avgDistance;
                    bestDiscriminator = potentialDiscriminator;
                }
            }

            if (bestDiscriminator) {
                console.log(`  Found a good discriminating feature: ${bestDiscriminator.vector_type} at [${bestDiscriminator.pos_x}, ${bestDiscriminator.pos_y}]`);
                // 5. Update the knowledge base
                const startNodeId = await getOrCreateFeatureNode(startFeature);
                const discriminatorNodeId = await getOrCreateFeatureNode(bestDiscriminator);

                await updateNodeStats(startNodeId, 'hit');
                await updateNodeStats(discriminatorNodeId, 'hit');
                // Here you would also create/update a 'GROUP' node for the pair, which is a more advanced step.
                // For now, we'll just update the individual feature stats.

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
