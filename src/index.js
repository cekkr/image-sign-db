// --- LIBRARIES ---
const mysql = require('mysql2/promise');
const express = require('express');
const crypto = require('crypto');
require('dotenv').config();
const { generateSpecificVector, resolveDefaultProbeSpec } = require('./featureExtractor');
const { euclideanDistance } = require('./lib/correlationMetrics');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const VALUE_THRESHOLD = 0.08;
const CHANNEL_ROTATION = ['h', 's', 'v', 'luminance', 'stddev'];

// --- DATABASE / CACHE ---
let dbConnection;
const valueTypeCache = new Map(); // channel -> id
const searchSessions = new Map(); // sessionId -> { candidateIds, askedChannels, probeSpec }

async function connectToDatabase() {
    if (dbConnection && dbConnection.connection && !dbConnection.connection._closing) {
        return dbConnection;
    }
    dbConnection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    console.log('🗄️  Connected to MySQL database.');
    return dbConnection;
}

async function resolveValueTypeId(db, channel) {
    if (valueTypeCache.has(channel)) return valueTypeCache.get(channel);
    const [rows] = await db.execute('SELECT value_type_id FROM value_types WHERE channel_name = ?', [channel]);
    if (rows.length === 0) {
        throw new Error(`Unknown channel '${channel}'. Please ensure value_types is seeded.`);
    }
    const id = rows[0].value_type_id;
    valueTypeCache.set(channel, id);
    return id;
}

function rowToFeature(row) {
    return {
        ...row,
        value_type: row.value_type,
        resolution_level: row.resolution_level,
        pos_x: row.pos_x,
        pos_y: row.pos_y,
        rel_x: row.rel_x,
        rel_y: row.rel_y,
        value: row.value,
        size: row.size,
    };
}

async function findCandidateImages(db, probe) {
    const valueTypeId = await resolveValueTypeId(db, probe.channel);
    const [rows] = await db.execute(
        `SELECT vector_id, image_id, value_type, resolution_level, pos_x, pos_y, rel_x, rel_y, value, size
         FROM feature_vectors
         WHERE value_type = ?
           AND resolution_level = ?
           AND pos_x = ?
           AND pos_y = ?
           AND ABS(rel_x - ?) < 1e-6
           AND ABS(rel_y - ?) < 1e-6`,
        [
            valueTypeId,
            probe.gridSize,
            probe.pos_x,
            probe.pos_y,
            probe.rel_x,
            probe.rel_y,
        ]
    );

    const candidates = new Set();
    for (const row of rows) {
        const feature = rowToFeature(row);
        const distance = euclideanDistance(
            { ...probe, value_type: valueTypeId, resolution_level: probe.gridSize, size: probe.size },
            feature
        );
        if (distance <= VALUE_THRESHOLD) {
            candidates.add(row.image_id);
        }
    }
    return { candidates: [...candidates], valueTypeId };
}

function chooseNextChannel(session) {
    for (const channel of CHANNEL_ROTATION) {
        if (!session.askedChannels.has(channel)) {
            return channel;
        }
    }
    return null;
}

async function startSearch(probeSpec) {
    const db = await connectToDatabase();
    const { candidates, valueTypeId } = await findCandidateImages(db, probeSpec);

    if (candidates.length === 0) return { status: 'NO_MATCH' };
    if (candidates.length === 1) return { status: 'MATCH_FOUND', imageId: candidates[0] };

    const sessionId = crypto.randomBytes(16).toString('hex');
    searchSessions.set(sessionId, {
        candidateIds: candidates,
        probeSpec: { ...probeSpec, valueTypeId },
        askedChannels: new Set([probeSpec.channel]),
    });
    return { status: 'CANDIDATES_FOUND', sessionId, candidates };
}

async function refineSearch(sessionId, probeSpec) {
    const session = searchSessions.get(sessionId);
    if (!session) {
        return { error: 'Session not found or expired.' };
    }

    const db = await connectToDatabase();
    const { candidates, valueTypeId } = await findCandidateImages(db, probeSpec);
    const remaining = candidates.filter((id) => session.candidateIds.includes(id));

    if (remaining.length === 0) {
        searchSessions.delete(sessionId);
        return { status: 'NO_MATCH' };
    }
    if (remaining.length === 1) {
        searchSessions.delete(sessionId);
        return { status: 'MATCH_FOUND', imageId: remaining[0] };
    }

    session.candidateIds = remaining;
    session.askedChannels.add(probeSpec.channel);
    session.probeSpec = { ...probeSpec, valueTypeId };
    searchSessions.set(sessionId, session);

    return { status: 'CANDIDATES_FOUND', candidates: remaining };
}

function buildNextQuestion(session) {
    const nextChannel = chooseNextChannel(session);
    if (!nextChannel) return null;

    return {
        channel: nextChannel,
        gridSize: session.probeSpec.gridSize,
        pos_x: session.probeSpec.pos_x,
        pos_y: session.probeSpec.pos_y,
        dx: session.probeSpec.dx,
        dy: session.probeSpec.dy,
        augmentation: session.probeSpec.augmentation,
    };
}

// --- EXPRESS SERVER ---

function runServer() {
    const app = express();
    app.use(express.json({ limit: '2mb' }));

    app.post('/search/start', async (req, res) => {
        try {
            const probeSpec = req.body;
            const result = await startSearch(probeSpec);
            if (result.status === 'CANDIDATES_FOUND') {
                const session = searchSessions.get(result.sessionId);
                const nextQuestion = buildNextQuestion(session);
                return res.json({ ...result, nextQuestion });
            }
            return res.json(result);
        } catch (error) {
            console.error('API Error on /search/start:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.post('/search/refine', async (req, res) => {
        try {
            const { sessionId, probe } = req.body;
            const result = await refineSearch(sessionId, probe);
            if (result.error) {
                return res.status(404).json({ error: result.error });
            }
            if (result.status === 'CANDIDATES_FOUND') {
                const session = searchSessions.get(sessionId);
                const nextQuestion = buildNextQuestion(session);
                return res.json({ ...result, nextQuestion });
            }
            return res.json(result);
        } catch (error) {
            console.error('API Error on /search/refine:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.listen(PORT, () => {
        console.log(`🚀 Server listening on http://localhost:${PORT}`);
    });
}

// --- CLI MODE ---

async function runCli(imagePath) {
    const probeSpec = resolveDefaultProbeSpec();
    const vector = await generateSpecificVector(imagePath, probeSpec);
    if (!vector) {
        console.error('Unable to generate probe vector.');
        return;
    }

    const probe = {
        ...probeSpec,
        rel_x: probeSpec.dx / probeSpec.gridSize,
        rel_y: probeSpec.dy / probeSpec.gridSize,
        value: vector[probeSpec.channel],
        size: vector.size,
    };

    const result = await startSearch(probe);
    console.log('Initial candidates:', result.candidates ?? []);

    if (result.status !== 'CANDIDATES_FOUND') {
        console.log(`Status: ${result.status}`);
        if (result.imageId) {
            const db = await connectToDatabase();
            const [rows] = await db.execute('SELECT original_filename FROM images WHERE image_id = ?', [result.imageId]);
            console.log(`✅ Match Found! Image ID: ${result.imageId} (${rows[0]?.original_filename || 'unknown'})`);
        }
        return;
    }

    const sessionId = result.sessionId;
    const session = searchSessions.get(sessionId);
    let nextQuestion = buildNextQuestion(session);
    let iteration = 0;

    while (nextQuestion && iteration < CHANNEL_ROTATION.length) {
        iteration += 1;
        const nextVector = await generateSpecificVector(imagePath, nextQuestion);
        const probeUpdate = {
            ...nextQuestion,
            rel_x: nextQuestion.dx / nextQuestion.gridSize,
            rel_y: nextQuestion.dy / nextQuestion.gridSize,
            value: nextVector[nextQuestion.channel],
            size: nextVector.size,
        };

        const refinement = await refineSearch(sessionId, probeUpdate);
        console.log(`Refinement ${iteration}:`, refinement.candidates ?? []);

        if (refinement.status !== 'CANDIDATES_FOUND') {
            if (refinement.status === 'MATCH_FOUND') {
                const db = await connectToDatabase();
                const [rows] = await db.execute('SELECT original_filename FROM images WHERE image_id = ?', [refinement.imageId]);
                console.log(`✅ Match Found! Image ID: ${refinement.imageId} (${rows[0]?.original_filename || 'unknown'})`);
            } else {
                console.log(`Status: ${refinement.status}`);
            }
            return;
        }

        nextQuestion = buildNextQuestion(searchSessions.get(sessionId));
    }

    console.log('❌ No definitive match found after probing multiple channels.');
}

// --- ENTRYPOINT ---

const mode = process.argv[2];
const arg = process.argv[3];

if (mode === 'server') {
    runServer();
} else if (mode === 'find' && arg) {
    runCli(arg).finally(() => dbConnection?.end());
} else {
    console.log('Usage:');
    console.log('  node src/index.js server');
    console.log('  node src/index.js find <path_to_image>');
}
