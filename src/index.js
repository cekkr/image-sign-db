// --- LIBRARIES ---
const mysql = require('mysql2/promise');
const express = require('express');
const crypto = require('crypto');
require('dotenv').config();
const settings = require('./settings');
const { generateSpecificVector } = require('./featureExtractor');
const { collectElasticMatches } = require('./lib/elasticMatcher');
const { createDescriptorKey, parseDescriptor } = require('./lib/descriptor');
const { CHANNEL_DIMENSIONS, CONSTELLATION_CONSTANTS } = require('./lib/constants');
const { ingestImage, removeImage, bootstrapCorrelations } = require('./insert');
const { recordVectorUsage, saveSkipPattern } = require('./lib/storageManager');
const { extendConstellationPath, createRandomConstellationSpec, descriptorToSpec } = require('./lib/constellation');
const { normalizeProbeSpec, ensureValueTypeRecord: ensureValueTypeRecordBase } = require('./evaluate');

// --- CONFIGURATION ---
const SERVER_PORT = settings.server.port;
const VALUE_THRESHOLD = settings.search.valueThreshold;
const SKIP_THRESHOLD = settings.search.skipThreshold;
const MAX_CLI_ITERATIONS = settings.search.maxCliIterations;

// --- DATABASE / CACHE ---
let dbConnection;
const descriptorCache = new Map(); // descriptorKey -> { id, descriptor }
const skipCache = new Map(); // descriptorKey -> skip count
const searchSessions = new Map(); // sessionId -> { phase, candidateIds, askedDescriptorKeys, probeSpec, constellationPath }

const SESSION_PHASE = Object.freeze({
    AWAITING_INITIAL_PROBE: 'AWAITING_INITIAL_PROBE',
    ACTIVE: 'ACTIVE',
});

function bumpSkipCache(descriptorKey, amount = 1) {
    const next = (skipCache.get(descriptorKey) || 0) + amount;
    skipCache.set(descriptorKey, next);
}

function getSkipCount(descriptorKey) {
    return skipCache.get(descriptorKey) || 0;
}

let skipCacheLoaded = false;

async function warmSkipCache(db) {
    if (skipCacheLoaded) return;
    const [rows] = await db.execute('SELECT descriptor_hash, skip_count FROM skip_patterns');
    for (const row of rows) {
        const count = Number(row.skip_count) || 0;
        skipCache.set(row.descriptor_hash, count);
    }
    skipCacheLoaded = true;
}

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
    await warmSkipCache(dbConnection);
    return dbConnection;
}

async function ensureValueTypeRecord(db, descriptor) {
    const descriptorKey = createDescriptorKey(descriptor);
    if (descriptorCache.has(descriptorKey)) return descriptorCache.get(descriptorKey);

    const record = await ensureValueTypeRecordBase(db, descriptor);
    const enriched = {
        id: record.id,
        descriptor,
        descriptorKey: record.descriptorKey ?? descriptorKey,
    };
    descriptorCache.set(enriched.descriptorKey, enriched);
    return enriched;
}

function rowToFeature(row) {
    const descriptor = parseDescriptor(row.descriptor_json);
    const spec = descriptorToSpec(descriptor);
    const descriptorKey = spec?.descriptorKey ?? (descriptor ? createDescriptorKey(descriptor) : null);
    return {
        ...row,
        value_type: row.value_type,
        resolution_level: row.resolution_level,
        rel_x: row.rel_x,
        rel_y: row.rel_y,
        value: row.value,
        size: row.size,
        descriptor,
        descriptorKey,
        spec,
    };
}

async function requestInitialProbe() {
    const db = await connectToDatabase();
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const [rows] = await db.execute(
            `SELECT fv.vector_id, fv.image_id, fv.value_type, fv.resolution_level, fv.pos_x, fv.pos_y, fv.rel_x, fv.rel_y, fv.value, fv.size, vt.descriptor_json
             FROM feature_vectors fv
             JOIN value_types vt ON vt.value_type_id = fv.value_type
             ORDER BY RAND()
             LIMIT 1`
        );
        if (rows.length === 0) break;
        const feature = rowToFeature(rows[0]);
        const baseSpec = feature.spec ?? descriptorToSpec(feature.descriptor);
        if (!baseSpec) continue;
        const normalized = normalizeProbeSpec({
            ...baseSpec,
            descriptor: feature.descriptor ?? baseSpec.descriptor,
            descriptorKey: feature.descriptorKey ?? baseSpec.descriptorKey,
        });
        if (getSkipCount(normalized.descriptorKey) >= SKIP_THRESHOLD) continue;
        return { probe: normalized, feature };
    }
    return null;
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
           AND ABS(fv.rel_x - ?) <= ?
           AND ABS(fv.rel_y - ?) <= ?`,
        [
            valueTypeId,
            probe.resolution_level,
            probe.pos_x,
            probe.pos_y,
            probe.rel_x,
            CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
            probe.rel_y,
            CONSTELLATION_CONSTANTS.OFFSET_TOLERANCE,
        ]
    );

    const targetFeature = {
        value_type: valueTypeId,
        resolution_level: probe.resolution_level,
        value: probe.value ?? 0,
        rel_x: probe.rel_x,
        rel_y: probe.rel_y,
        size: probe.size,
    };
    const selection = collectElasticMatches(rows, targetFeature, {
        baseThreshold: VALUE_THRESHOLD,
        minUniqueImages: 1,
        maxEntries: rows.length,
    });

    const matchingVectorIds = selection.selectedEntries
        .map((entry) => entry.vectorId)
        .filter((vectorId) => Number.isFinite(vectorId) && vectorId > 0);
    if (matchingVectorIds.length > 0) {
        await recordVectorUsage(db, matchingVectorIds, 1, 0);
    }

    return {
        candidates: [...selection.grouped.keys()],
        valueTypeId,
        descriptorKey: valueTypeRecord.descriptorKey,
        relaxations: selection.relaxations,
        thresholdUsed: selection.thresholdUsed,
    };
}

async function startSearch(probeSpec, existingSessionId = null) {
    const normalizedProbe = normalizeProbeSpec(probeSpec);
    const db = await connectToDatabase();
    let probeToUse = { ...normalizedProbe };
    if (getSkipCount(probeToUse.descriptorKey) >= SKIP_THRESHOLD) {
        for (const channel of CHANNEL_DIMENSIONS) {
            if (channel === probeToUse.channel) continue;
            const candidate = normalizeProbeSpec({
                ...probeToUse,
                channel,
                descriptor: { ...probeToUse.descriptor, channel },
                random: false,
            });
            if (!candidate) continue;
            if (getSkipCount(candidate.descriptorKey) >= SKIP_THRESHOLD) continue;
            probeToUse = candidate;
            break;
        }
    }
    const { candidates, valueTypeId, descriptorKey } = await findCandidateImages(db, probeToUse);

    const initialPath = extendConstellationPath([], {
        descriptorKey,
        candidateCount: candidates.length,
        rel_x: probeToUse.rel_x,
        rel_y: probeToUse.rel_y,
        size: probeToUse.size,
    });
    if (candidates.length === 0) {
        await saveSkipPattern(db, probeToUse.descriptor);
        bumpSkipCache(probeToUse.descriptorKey);
        if (existingSessionId) searchSessions.delete(existingSessionId);
        return { status: 'NO_MATCH', constellationPath: initialPath };
    }
    if (candidates.length === 1) {
        if (existingSessionId) searchSessions.delete(existingSessionId);
        return {
            status: 'MATCH_FOUND',
            imageId: candidates[0],
            constellationPath: initialPath,
        };
    }

    const sessionId = existingSessionId ?? crypto.randomBytes(16).toString('hex');
    const askedKeys = new Set([descriptorKey]);
    searchSessions.set(sessionId, {
        phase: SESSION_PHASE.ACTIVE,
        candidateIds: candidates,
        probeSpec: { ...probeToUse, valueTypeId, descriptorKey },
        askedDescriptorKeys: askedKeys,
        constellationPath: initialPath,
    });
    return { status: 'CANDIDATES_FOUND', sessionId, candidates, constellationPath: initialPath };
}

async function refineSearch(sessionId, probeSpec) {
    const session = searchSessions.get(sessionId);
    if (!session || session.phase !== SESSION_PHASE.ACTIVE) {
        return { error: 'Session not found or expired.' };
    }

    const normalizedProbe = normalizeProbeSpec(probeSpec);
    const db = await connectToDatabase();
    if (getSkipCount(normalizedProbe.descriptorKey) >= SKIP_THRESHOLD) {
        await saveSkipPattern(db, normalizedProbe.descriptor);
        bumpSkipCache(normalizedProbe.descriptorKey);
        session.askedDescriptorKeys.add(normalizedProbe.descriptorKey);
        return { status: 'NO_MATCH' };
    }
    const { candidates, valueTypeId, descriptorKey } = await findCandidateImages(db, normalizedProbe);
    const remaining = candidates.filter((id) => session.candidateIds.includes(id));

    if (remaining.length === 0) {
        searchSessions.delete(sessionId);
        await saveSkipPattern(db, normalizedProbe.descriptor);
        bumpSkipCache(normalizedProbe.descriptorKey);
        const updatedPath = extendConstellationPath(session.constellationPath, {
            descriptorKey,
            candidateCount: 0,
            rel_x: normalizedProbe.rel_x,
            rel_y: normalizedProbe.rel_y,
            size: normalizedProbe.size,
        });
        session.constellationPath = updatedPath;
        return { status: 'NO_MATCH', constellationPath: updatedPath };
    }
    if (remaining.length === 1) {
        searchSessions.delete(sessionId);
        const updatedPath = extendConstellationPath(session.constellationPath, {
            descriptorKey,
            candidateCount: remaining.length,
            rel_x: normalizedProbe.rel_x,
            rel_y: normalizedProbe.rel_y,
            size: normalizedProbe.size,
        });
        return { status: 'MATCH_FOUND', imageId: remaining[0], constellationPath: updatedPath };
    }

    session.candidateIds = remaining;
    session.askedDescriptorKeys.add(descriptorKey);
    session.probeSpec = { ...normalizedProbe, valueTypeId, descriptorKey };
    session.constellationPath = extendConstellationPath(session.constellationPath, {
        descriptorKey,
        candidateCount: remaining.length,
        rel_x: normalizedProbe.rel_x,
        rel_y: normalizedProbe.rel_y,
        size: normalizedProbe.size,
    });
    searchSessions.set(sessionId, session);

    return { status: 'CANDIDATES_FOUND', candidates: remaining, constellationPath: session.constellationPath };
}

async function buildNextQuestion(session) {
    if (!session || session.phase !== SESSION_PHASE.ACTIVE) return null;
    const maxAttempts = 64;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const candidateSpec = createRandomConstellationSpec({
            augmentation: session.probeSpec.augmentation,
        });
        const normalized = normalizeProbeSpec(candidateSpec);
        if (!normalized) continue;
        if (session.askedDescriptorKeys.has(normalized.descriptorKey)) continue;
        if (getSkipCount(normalized.descriptorKey) >= SKIP_THRESHOLD) continue;
        return normalized;
    }
    return null;
}

// --- EXPRESS SERVER ---

function runServer() {
    const app = express();
    app.use(express.json({ limit: '2mb' }));

    app.post('/search/start', async (req, res) => {
        try {
            const { requestProbe, sessionId, probe } = req.body || {};

            if (requestProbe) {
                const initial = await requestInitialProbe();
                if (!initial) {
                    return res.json({ status: 'NO_PROBE_AVAILABLE' });
                }
                const newSessionId = crypto.randomBytes(16).toString('hex');
                searchSessions.set(newSessionId, {
                    phase: SESSION_PHASE.AWAITING_INITIAL_PROBE,
                    pendingProbe: initial.probe,
                    askedDescriptorKeys: new Set([initial.probe.descriptorKey]),
                    constellationPath: [],
                    candidateIds: [],
                    probeSpec: initial.probe,
                });
                return res.json({
                    status: 'REQUEST_PROBE',
                    sessionId: newSessionId,
                    probeSpec: initial.probe,
                });
            }

            if (!probe || typeof probe.value !== 'number') {
                return res.status(400).json({ error: 'Probe payload missing.' });
            }

            const normalizedProbe = normalizeProbeSpec(probe);
            const pendingSession = sessionId ? searchSessions.get(sessionId) : null;
            if (pendingSession && pendingSession.phase === SESSION_PHASE.AWAITING_INITIAL_PROBE) {
                if (pendingSession.pendingProbe?.descriptorKey !== normalizedProbe.descriptorKey) {
                    return res.status(400).json({ error: 'Probe descriptor mismatch for session.' });
                }
                searchSessions.delete(sessionId);
            }

            const result = await startSearch(normalizedProbe, sessionId);
            if (result.status === 'CANDIDATES_FOUND') {
                const activeSession = searchSessions.get(result.sessionId);
                const nextQuestion = await buildNextQuestion(activeSession);
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
                const nextQuestion = await buildNextQuestion(session);
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

    app.post('/settings/max-db-size', async (req, res) => {
        try {
            const rawValue = req.body?.value;
            const numeric = Number(rawValue);
            if (!rawValue || Number.isNaN(numeric) || numeric <= 0) {
                return res.status(400).json({ error: 'Invalid value. Provide a positive number in gigabytes.' });
            }

            const db = await connectToDatabase();
            await db.execute(
                `INSERT INTO system_settings (setting_key, setting_value)
                 VALUES ('max_db_size_gb', ?)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                [String(numeric)]
            );
            res.json({ status: 'OK', value: numeric });
        } catch (error) {
            console.error('API Error on POST /settings/max-db-size:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    });

    app.listen(SERVER_PORT, () => {
        console.log(`🚀 Server listening on http://localhost:${SERVER_PORT}`);
    });
}

// --- CLI MODE ---

async function runCli(imagePath) {
    const initial = await requestInitialProbe();
    if (!initial) {
        console.error('Unable to select a probe descriptor from the database.');
        return;
    }
    const probeSpec = initial.probe;
    const vector = await generateSpecificVector(imagePath, probeSpec);
    if (!vector) {
        console.error('Unable to generate probe vector.');
        return;
    }

    const probe = {
        ...probeSpec,
        value: vector.value,
        size: vector.size,
        descriptor: probeSpec.descriptor,
        descriptorKey: probeSpec.descriptorKey,
    };

    const result = await startSearch(probe);
    console.log('Initial candidates:', result.candidates ?? []);
    if (result.constellationPath?.length) {
        const last = result.constellationPath[result.constellationPath.length - 1];
        console.log(
            `Constellation accuracy after ${result.constellationPath.length} step(s): ${(last?.cumulativeAccuracy ?? 0).toFixed(6)}`
        );
    }

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
    let nextQuestion = await buildNextQuestion(session);
    let iteration = 0;

    while (nextQuestion && iteration < MAX_CLI_ITERATIONS) {
        iteration += 1;
        console.log(
            `  [Iteration ${iteration}] Requesting descriptor ${nextQuestion.descriptorKey} (channel ${nextQuestion.descriptor?.channel ?? '?'})`
        );
        const nextVector = await generateSpecificVector(imagePath, nextQuestion);
        const probeUpdate = {
            ...nextQuestion,
            value: nextVector.value,
            size: nextVector.size,
            descriptor: nextVector.descriptor ?? nextQuestion.descriptor,
            descriptorKey: nextVector.descriptorKey ?? nextQuestion.descriptorKey,
        };

        const refinement = await refineSearch(sessionId, probeUpdate);
        console.log(`Refinement ${iteration}:`, refinement.candidates ?? []);
        if (refinement.constellationPath?.length) {
            const last = refinement.constellationPath[refinement.constellationPath.length - 1];
            console.log(
                `  ↳ Constellation accuracy: ${(last?.cumulativeAccuracy ?? 0).toFixed(6)}`
            );
        }

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

        nextQuestion = await buildNextQuestion(searchSessions.get(sessionId));
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
