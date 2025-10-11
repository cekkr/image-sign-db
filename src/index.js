// --- LIBRARIES ---
const mysql = require('mysql2/promise');
const express = require('express');
const crypto = require('crypto');
require('dotenv').config();
const { generateSpecificVector, resolveDefaultProbeSpec } = require('./featureExtractor');
const { euclideanDistance } = require('./lib/correlationMetrics');
const { createDescriptorKey, serializeDescriptor, parseDescriptor } = require('./lib/descriptor');
const { CHANNEL_DIMENSIONS, GRID_SIZES } = require('./lib/constants');
const { ingestImage, removeImage, bootstrapCorrelations } = require('./insert');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const VALUE_THRESHOLD = 0.08;

// --- DATABASE / CACHE ---
let dbConnection;
const descriptorCache = new Map(); // descriptorKey -> { id, descriptor }
const searchSessions = new Map(); // sessionId -> { candidateIds, askedDescriptorKeys, probeSpec }

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

function normalizeProbeSpec(spec) {
    const normalized = { ...spec };
    const defaultGrid = GRID_SIZES[Math.floor(GRID_SIZES.length / 2)] ?? GRID_SIZES[0] ?? 10;
    normalized.gridSize = normalized.gridSize ?? normalized.resolution_level ?? defaultGrid;
    normalized.dx = normalized.dx ?? 1;
    normalized.dy = normalized.dy ?? 0;
    normalized.pos_x = normalized.pos_x ?? 0;
    normalized.pos_y = normalized.pos_y ?? 0;
    normalized.augmentation = normalized.augmentation ?? 'original';
    normalized.rel_x = normalized.rel_x ?? normalized.dx / normalized.gridSize;
    normalized.rel_y = normalized.rel_y ?? normalized.dy / normalized.gridSize;
    normalized.size = normalized.size ?? 1 / normalized.gridSize;

    if (!normalized.descriptor) {
        const channel = normalized.channel ?? CHANNEL_DIMENSIONS[0];
        normalized.descriptor = {
            family: 'delta',
            channel,
            neighbor_dx: normalized.dx,
            neighbor_dy: normalized.dy,
        };
    }
    normalized.descriptorKey = normalized.descriptorKey ?? createDescriptorKey(normalized.descriptor);
    return normalized;
}

async function ensureValueTypeRecord(db, descriptor) {
    const descriptorKey = createDescriptorKey(descriptor);
    if (descriptorCache.has(descriptorKey)) return descriptorCache.get(descriptorKey);

    const [rows] = await db.execute(
        'SELECT value_type_id, descriptor_json FROM value_types WHERE descriptor_hash = ?',
        [descriptorKey]
    );
    if (rows.length > 0) {
        const parsed = parseDescriptor(rows[0].descriptor_json) || descriptor;
        const record = { id: rows[0].value_type_id, descriptor: parsed, descriptorKey };
        descriptorCache.set(descriptorKey, record);
        return record;
    }

    const [result] = await db.execute(
        'INSERT INTO value_types (descriptor_hash, descriptor_json) VALUES (?, ?)',
        [descriptorKey, serializeDescriptor(descriptor)]
    );
    const record = { id: result.insertId, descriptor, descriptorKey };
    descriptorCache.set(descriptorKey, record);
    return record;
}

function rowToFeature(row) {
    const descriptor = parseDescriptor(row.descriptor_json);
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
        descriptor,
        descriptorKey: descriptor ? createDescriptorKey(descriptor) : null,
    };
}

async function findCandidateImages(db, probe) {
    const valueTypeRecord = await ensureValueTypeRecord(db, probe.descriptor);
    const valueTypeId = valueTypeRecord.id;

    const [rows] = await db.execute(
        `SELECT fv.vector_id, fv.image_id, fv.value_type, fv.resolution_level, fv.pos_x, fv.pos_y, fv.rel_x, fv.rel_y, fv.value, fv.size, vt.descriptor_json
         FROM feature_vectors fv
         JOIN value_types vt ON vt.value_type_id = fv.value_type
         WHERE fv.value_type = ?
           AND fv.resolution_level = ?
           AND fv.pos_x = ?
           AND fv.pos_y = ?
           AND ABS(fv.rel_x - ?) < 1e-6
           AND ABS(fv.rel_y - ?) < 1e-6`,
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
            {
                ...probe,
                value_type: valueTypeId,
                resolution_level: probe.gridSize,
                size: probe.size,
            },
            feature
        );
        if (distance <= VALUE_THRESHOLD) {
            candidates.add(row.image_id);
        }
    }
    return { candidates: [...candidates], valueTypeId, descriptorKey: valueTypeRecord.descriptorKey };
}

async function startSearch(probeSpec) {
    const normalizedProbe = normalizeProbeSpec(probeSpec);
    const db = await connectToDatabase();
    const { candidates, valueTypeId, descriptorKey } = await findCandidateImages(db, normalizedProbe);

    if (candidates.length === 0) return { status: 'NO_MATCH' };
    if (candidates.length === 1) return { status: 'MATCH_FOUND', imageId: candidates[0] };

    const sessionId = crypto.randomBytes(16).toString('hex');
    searchSessions.set(sessionId, {
        candidateIds: candidates,
        probeSpec: { ...normalizedProbe, valueTypeId, descriptorKey },
        askedDescriptorKeys: new Set([descriptorKey]),
    });
    return { status: 'CANDIDATES_FOUND', sessionId, candidates };
}

async function refineSearch(sessionId, probeSpec) {
    const session = searchSessions.get(sessionId);
    if (!session) {
        return { error: 'Session not found or expired.' };
    }

    const db = await connectToDatabase();
    const normalizedProbe = normalizeProbeSpec(probeSpec);
    const { candidates, valueTypeId, descriptorKey } = await findCandidateImages(db, normalizedProbe);
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
    session.askedDescriptorKeys.add(descriptorKey);
    session.probeSpec = { ...normalizedProbe, valueTypeId, descriptorKey };
    searchSessions.set(sessionId, session);

    return { status: 'CANDIDATES_FOUND', candidates: remaining };
}

function buildNextQuestion(session) {
    const baseDescriptor = session.probeSpec.descriptor;
    const template = baseDescriptor ? { ...baseDescriptor } : null;

    for (const channel of CHANNEL_DIMENSIONS) {
        const descriptor = template ? { ...template, channel } : {
            family: 'delta',
            channel,
            neighbor_dx: session.probeSpec.dx,
            neighbor_dy: session.probeSpec.dy,
        };
        const descriptorKey = createDescriptorKey(descriptor);
        if (!session.askedDescriptorKeys.has(descriptorKey)) {
            return {
                gridSize: session.probeSpec.gridSize,
                pos_x: session.probeSpec.pos_x,
                pos_y: session.probeSpec.pos_y,
                dx: session.probeSpec.dx,
                dy: session.probeSpec.dy,
                augmentation: session.probeSpec.augmentation,
                descriptor,
                descriptorKey,
                rel_x: session.probeSpec.rel_x,
                rel_y: session.probeSpec.rel_y,
                size: session.probeSpec.size,
            };
        }
    }
    return null;
}

// --- EXPRESS SERVER ---

function runServer() {
    const app = express();
    app.use(express.json({ limit: '2mb' }));

    app.post('/search/start', async (req, res) => {
        try {
            const probeSpec = normalizeProbeSpec(req.body);
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
            const result = await refineSearch(sessionId, normalizeProbeSpec(probe));
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

    app.post('/images', async (req, res) => {
        try {
            const { path: imagePath, discover = 0 } = req.body || {};
            if (!imagePath) {
                return res.status(400).json({ error: 'Missing image path.' });
            }
            const { imageId, featureCount } = await ingestImage(imagePath, Number(discover));
            res.json({ status: 'OK', imageId, featureCount });
        } catch (error) {
            console.error('API Error on POST /images:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    });

    app.delete('/images/:identifier', async (req, res) => {
        try {
            const identifier = req.params.identifier;
            if (!identifier) {
                return res.status(400).json({ error: 'Missing image identifier.' });
            }
            const result = await removeImage(identifier);
            if (!result.removed) {
                return res.status(404).json({ error: result.reason || 'Image not found.' });
            }
            res.json({ status: 'OK', imageId: result.imageId });
        } catch (error) {
            console.error('API Error on DELETE /images:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    });

    app.post('/discover', async (req, res) => {
        try {
            const iterations = req.body?.iterations ?? req.query?.iterations ?? 50;
            await bootstrapCorrelations(iterations);
            res.json({ status: 'OK', iterations: Number(iterations) });
        } catch (error) {
            console.error('API Error on POST /discover:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
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
        value: vector.value,
        size: vector.size,
        descriptor: probeSpec.descriptor,
        descriptorKey: probeSpec.descriptorKey,
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

    while (nextQuestion && iteration < CHANNEL_DIMENSIONS.length) {
        iteration += 1;
        console.log(
            `  [Iteration ${iteration}] Requesting descriptor ${nextQuestion.descriptorKey} (channel ${nextQuestion.descriptor?.channel ?? '?'})`
        );
        const nextVector = await generateSpecificVector(imagePath, nextQuestion);
        const probeUpdate = {
            ...nextQuestion,
            rel_x: nextQuestion.dx / nextQuestion.gridSize,
            rel_y: nextQuestion.dy / nextQuestion.gridSize,
            value: nextVector.value,
            size: nextVector.size,
            descriptor: nextQuestion.descriptor,
            descriptorKey: nextQuestion.descriptorKey,
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
