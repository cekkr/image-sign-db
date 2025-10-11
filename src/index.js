// --- LIBRARIES ---
const mysql = require('mysql2/promise');
const express = require('express');
const crypto = require('crypto');
require('dotenv').config();
const { generateSpecificVector } = require('./featureExtractor.js');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const SIMILARITY_THRESHOLD = 0.1;

// --- SHARED LOGIC & DATABASE ---
let dbConnection;
const searchSessions = new Map(); // sessionId -> { candidateIds: number[], lastSpec: FeatureSpec }

async function connectToDatabase() {
    if (dbConnection && dbConnection.connection._closing) dbConnection = null;
    if (dbConnection) return dbConnection;
    dbConnection = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
        connectionLimit: 10
    });
    console.log("🗄️  Connected to MySQL database.");
    return dbConnection;
}

function euclideanDistance(buf1, buf2) {
    if (!buf1 || !buf2 || buf1.length !== buf2.length) return Infinity;
    const vec1 = new Float32Array(buf1.buffer, buf1.byteOffset, buf1.length / Float32Array.BYTES_PER_ELEMENT);
    const vec2 = new Float32Array(buf2.buffer, buf2.byteOffset, buf2.length / Float32Array.BYTES_PER_ELEMENT);
    let sum = 0;
    for (let i = 0; i < vec1.length; i++) sum += (vec1[i] - vec2[i]) ** 2;
    return Math.sqrt(sum);
}

// --- CORE SEARCH ENGINE ---

async function startSearch(probeVector) {
    const db = await connectToDatabase();
    const { vector_type, resolution_level, pos_x, pos_y, vector_data } = probeVector;
    const baseSpec = { vector_type, resolution_level, pos_x, pos_y };

    const [allSimilarFeatures] = await db.execute(
        'SELECT image_id, vector_data FROM feature_vectors WHERE vector_type = ? AND resolution_level = ? AND pos_x = ? AND pos_y = ?',
        [vector_type, resolution_level, pos_x, pos_y]
    );

    const candidateImageIds = new Set();
    for (const feature of allSimilarFeatures) {
        if (euclideanDistance(vector_data, feature.vector_data) < SIMILARITY_THRESHOLD) {
            candidateImageIds.add(feature.image_id);
        }
    }

    if (candidateImageIds.size === 0) return { status: 'NO_MATCH' };
    if (candidateImageIds.size === 1) return { status: 'MATCH_FOUND', imageId: [...candidateImageIds][0] };

    const sessionId = crypto.randomBytes(16).toString('hex');
    searchSessions.set(sessionId, {
        candidateIds: [...candidateImageIds],
        anchorSpec: baseSpec,
        lastAskedSpec: baseSpec,
    });
    return { status: 'CANDIDATES_FOUND', sessionId, candidates: [...candidateImageIds], anchorSpec: baseSpec };
}

async function findNextBestQuestion(candidateIds, anchorSpec, fallbackSpec) {
    const db = await connectToDatabase();
    if (!candidateIds || candidateIds.length === 0) return null;

    const specsToTry = [];
    if (anchorSpec) specsToTry.push(anchorSpec);
    if (fallbackSpec && (!anchorSpec || JSON.stringify(anchorSpec) !== JSON.stringify(fallbackSpec))) {
        specsToTry.push(fallbackSpec);
    }

    for (const spec of specsToTry) {
        const correlationQuery = `
            SELECT
                fgs.discriminator_vector_type AS vector_type,
                fgs.discriminator_resolution_level AS level,
                fgs.discriminator_pos_x AS x,
                fgs.discriminator_pos_y AS y,
                fgs.mean_distance,
                fgs.std_distance,
                fgs.mean_cosine,
                fgs.mean_pearson,
                fgs.sample_size
            FROM feature_group_stats fgs
            JOIN feature_vectors fv
              ON fv.vector_type = fgs.discriminator_vector_type
             AND fv.resolution_level = fgs.discriminator_resolution_level
             AND fv.pos_x = fgs.discriminator_pos_x
             AND fv.pos_y = fgs.discriminator_pos_y
            WHERE fv.image_id IN (?)
              AND fgs.start_vector_type = ?
              AND fgs.start_resolution_level = ?
              AND fgs.start_pos_x = ?
              AND fgs.start_pos_y = ?
            GROUP BY fgs.stat_id
            ORDER BY (fgs.mean_distance + fgs.std_distance + (1 - fgs.mean_cosine) + (1 - fgs.mean_pearson)) DESC,
                     fgs.sample_size DESC
            LIMIT 1;
        `;

        const params = [
            candidateIds,
            spec.vector_type,
            spec.resolution_level,
            spec.pos_x,
            spec.pos_y,
        ];
        const [correlatedRows] = await db.query(correlationQuery, params);

        if (correlatedRows.length > 0) {
            const row = correlatedRows[0];
            return {
                type: row.vector_type,
                level: row.level,
                x: row.x,
                y: row.y,
                metrics: {
                    mean_distance: row.mean_distance,
                    std_distance: row.std_distance,
                    mean_cosine: row.mean_cosine,
                    mean_pearson: row.mean_pearson,
                    sample_size: row.sample_size,
                },
            };
        }
    }

    const query = `
        SELECT kn.feature_details
        FROM knowledge_nodes kn
        JOIN feature_vectors fv ON JSON_EXTRACT(kn.feature_details, '$.type') = fv.vector_type
                               AND JSON_EXTRACT(kn.feature_details, '$.level') = fv.resolution_level
                               AND JSON_EXTRACT(kn.feature_details, '$.x') = fv.pos_x
                               AND JSON_EXTRACT(kn.feature_details, '$.y') = fv.pos_y
        WHERE kn.node_type = 'FEATURE'
          AND fv.image_id IN (?)
        GROUP BY kn.node_id
        -- Prioritize nodes with high hit rate and sufficient data
        ORDER BY (kn.hit_count / (kn.hit_count + kn.miss_count + 1e-5)) DESC, (kn.hit_count + kn.miss_count) DESC
        LIMIT 1;
    `;
    const [rows] = await db.query(query, [candidateIds]);
    
    if (rows.length === 0) return null; // No knowledge found for this set
    return rows[0].feature_details;
}

// --- EXPRESS SERVER MODE ---

function runServer() {
    const app = express();
    app.use(express.json({ limit: '10mb' }));

    app.post('/search/start', async (req, res) => {
        try {
            const { vector_type, resolution_level, pos_x, pos_y, vector_base64 } = req.body;
            const vector_data = Buffer.from(vector_base64, 'base64');
            const probeSpec = { vector_type, resolution_level, pos_x, pos_y };
            
            const result = await startSearch({ vector_type, resolution_level, pos_x, pos_y, vector_data });
            
            if (result.status === 'CANDIDATES_FOUND') {
                const nextQuestion = await findNextBestQuestion(result.candidates, probeSpec, probeSpec);
                res.json({ ...result, nextQuestion });
            } else {
                res.json(result);
            }
        } catch (error) {
            console.error("API Error on /search/start:", error);
            res.status(500).json({ error: "Internal Server Error" });
        }
    });

    app.post('/search/refine', async (req, res) => {
        try {
            const { sessionId, vector_base64, spec } = req.body;
            if (!searchSessions.has(sessionId)) {
                return res.status(404).json({ error: "Session not found or expired." });
            }

            const db = await connectToDatabase();
            const sessionState = searchSessions.get(sessionId);
            const candidateIds = sessionState.candidateIds;
            const refinedVector = Buffer.from(vector_base64, 'base64');
            
            const [features] = await db.query('SELECT image_id, vector_data FROM feature_vectors WHERE vector_type = ? AND resolution_level = ? AND pos_x = ? AND pos_y = ? AND image_id IN (?)', 
                [spec.type, spec.level, spec.x, spec.y, candidateIds]
            );

            const newCandidates = [];
            for(const feature of features) {
                if (euclideanDistance(refinedVector, feature.vector_data) < SIMILARITY_THRESHOLD) {
                    newCandidates.push(feature.image_id);
                }
            }
            
            if (newCandidates.length === 0) return res.json({ status: 'NO_MATCH' });
            if (newCandidates.length === 1) {
                searchSessions.delete(sessionId);
                return res.json({ status: 'MATCH_FOUND', imageId: newCandidates[0] });
            }

            searchSessions.set(sessionId, {
                ...sessionState,
                candidateIds: newCandidates,
                lastAskedSpec: {
                    vector_type: spec.type,
                    resolution_level: spec.level,
                    pos_x: spec.x,
                    pos_y: spec.y,
                },
            });
            const nextQuestion = await findNextBestQuestion(
                newCandidates,
                sessionState.anchorSpec,
                { vector_type: spec.type, resolution_level: spec.level, pos_x: spec.x, pos_y: spec.y }
            );
            res.json({ status: 'CANDIDATES_FOUND', candidates: newCandidates, nextQuestion });

        } catch (error) {
            console.error("API Error on /search/refine:", error);
            res.status(500).json({ error: "Internal Server Error" });
        }
    });

    app.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));
}

// --- STANDALONE CLI MODE ---

async function runCli(imagePath) {
    console.log(`🔎 Starting standalone search for: ${imagePath}`);
    // 1. Generate the initial probe vector
    const probeSpec = { vector_type: 'hsv_gradient_h', resolution_level: 2, pos_x: 0, pos_y: 0 };
    const probeVector = await generateSpecificVector(imagePath, probeSpec);

    if (!probeVector) {
        console.error("Could not generate initial probe vector.");
        return;
    }

    // 2. Start the search
    let result = await startSearch({ ...probeSpec, vector_data: probeVector });
    console.log(`  Initial probe found ${result.candidates?.length || 0} candidates.`);
    const anchorSpec = probeSpec;
    let lastAskedSpec = probeSpec;

    // 3. Iteratively refine the search
    let iterations = 0;
    while(result.status === 'CANDIDATES_FOUND' && iterations < 10) {
        iterations++;
        const nextQuestion = await findNextBestQuestion(result.candidates, anchorSpec, lastAskedSpec);
        if (!nextQuestion) {
            console.log("  Could not find a useful question in knowledge base. Match is ambiguous.");
            result = { status: 'AMBIGUOUS', candidates: result.candidates };
            break;
        }
        
        console.log(`  [Iteration ${iterations}] Server asks for: ${nextQuestion.type} at level ${nextQuestion.level} [${nextQuestion.x}, ${nextQuestion.y}]`);
        if (nextQuestion.metrics) {
            const stats = nextQuestion.metrics;
            console.log(
                `    ↳ stats: mean distance=${stats.mean_distance?.toFixed(4)}, std=${stats.std_distance?.toFixed(4)}, mean cosine=${stats.mean_cosine?.toFixed(4)}, mean pearson=${stats.mean_pearson?.toFixed(4)}, samples=${stats.sample_size}`
            );
        }
        const nextVector = await generateSpecificVector(imagePath, { vector_type: nextQuestion.type, resolution_level: nextQuestion.level, pos_x: nextQuestion.x, pos_y: nextQuestion.y });

        // This is a local simulation of the /search/refine step
        const db = await connectToDatabase();
        const [features] = await db.query('SELECT image_id, vector_data FROM feature_vectors WHERE vector_type = ? AND resolution_level = ? AND pos_x = ? AND pos_y = ? AND image_id IN (?)', 
            [nextQuestion.type, nextQuestion.level, nextQuestion.x, nextQuestion.y, result.candidates]
        );
        const newCandidates = [];
        for(const feature of features) {
            if (euclideanDistance(nextVector, feature.vector_data) < SIMILARITY_THRESHOLD) {
                newCandidates.push(feature.image_id);
            }
        }
        result = { status: newCandidates.length > 1 ? 'CANDIDATES_FOUND' : newCandidates.length === 1 ? 'MATCH_FOUND' : 'NO_MATCH', candidates: newCandidates, imageId: newCandidates[0] };
        console.log(`  Refined search to ${newCandidates.length} candidates.`);
        lastAskedSpec = { vector_type: nextQuestion.type, resolution_level: nextQuestion.level, pos_x: nextQuestion.x, pos_y: nextQuestion.y };
    }

    console.log('\n--- SEARCH COMPLETE ---');
    if (result.status === 'MATCH_FOUND') {
        const db = await connectToDatabase();
        const [rows] = await db.query('SELECT original_filename FROM images WHERE image_id = ?', [result.imageId]);
        console.log(`✅ Match Found! Image ID: ${result.imageId} (${rows[0].original_filename})`);
    } else {
        console.log(`❌ No definitive match found. Status: ${result.status}`);
        if(result.candidates) console.log('  Ambiguous candidates:', result.candidates);
    }
}

// --- MAIN EXECUTION BLOCK ---

const mode = process.argv[2];
const arg = process.argv[3];

if (mode === 'server') {
    runServer();
} else if (mode === 'find' && arg) {
    runCli(arg).finally(() => dbConnection?.end());
} else {
    console.log("Usage:");
    console.log("  node src/index.js server              - To run the web server");
    console.log("  node src/index.js find <path_to_image> - To find a match for a local image");
}
