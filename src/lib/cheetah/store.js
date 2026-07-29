// Image Sign DB storage interface for Cheetah — ROADMAP Phase 2.
//
// This is the only module above the wire/key layer that knows how Image Sign
// records map onto Cheetah namespaces. Pixel measurement remains in
// vectorGenerators.js; callers pass the same feature objects the MySQL path
// persists today.
//
// Consistency is deliberately the same completion protocol as MySQL:
//
//   putImage(complete:false) -> putFeatures(...) -> markComplete()
//
// Readers hydrate only complete image records. Cheetah has no transaction
// spanning these writes, so `complete` is the commit marker.

const crypto = require('crypto');
const settings = require('../../settings');
const { serializeDescriptor, createDescriptorKey } = require('../descriptor');
const { RESOLUTION_LEVEL_TOLERANCE, normalizeResolutionLevel } = require('../resolutionLevel');
const { CONSTELLATION_CONSTANTS } = require('../constants');
const { CheetahPool, CheetahError } = require('./client');
const {
    decodeItemPayload,
    encodeArgument,
    numericField,
} = require('./protocol');
const {
    getJson,
    getValue,
    putJson,
    putValue,
    scanPrefix,
} = require('./kv');
const { TokenVocabulary } = require('./vocabulary');
const keys = require('./keys');

const { OFFSET_TOLERANCE } = CONSTELLATION_CONSTANTS;
const LAYOUT_KEY = keys.configKey('key_layout_version');
const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_WRITE_BATCH_SIZE = 256;
const DEFAULT_PRUNE_BATCH_SIZE = 5000;
const BYTES_PER_GIB = 1024 ** 3;

function finiteNumber(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new TypeError(`${name} must be finite, got ${value}`);
    }
    return number;
}

function timestamp(now) {
    const value = now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseHydratedJson(item) {
    const bytes = decodeItemPayload(item);
    if (!bytes) {
        throw new CheetahError(`cheetah feature scan did not hydrate ${item?.key || '(unknown key)'}`);
    }
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new CheetahError(`cheetah feature payload at ${item.key} is not JSON: ${error.message}`);
    }
}

function percentile(sortedValues, fraction) {
    if (sortedValues.length === 0) return 0;
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)
    );
    return sortedValues[index];
}

class CheetahStore {
    constructor(options = {}) {
        const configured = settings.cheetah;
        this.pool = options.pool || new CheetahPool({
            size: options.poolSize ?? configured.poolSize,
            host: options.host ?? configured.host,
            port: options.port ?? configured.port,
            database: options.database ?? configured.database,
            databaseOptions: {
                pair_bytes: options.pairIndexBytes ?? configured.pairIndexBytes,
            },
            connectTimeoutMs: options.connectTimeoutMs ?? configured.connectTimeoutMs,
            commandTimeoutMs: options.commandTimeoutMs ?? configured.commandTimeoutMs,
            maxInFlight: options.maxInFlight ?? configured.maxInFlight,
        });
        this.ownsPool = !options.pool;
        this.vocabulary = options.vocabulary || new TokenVocabulary(this.pool);
        this.now = options.now || (() => new Date());
        this.randomInt = options.randomInt || crypto.randomInt;
        this.writeBatchSize = Math.max(
            1,
            Number(options.writeBatchSize) || DEFAULT_WRITE_BATCH_SIZE
        );
        this.connected = false;
        this.ensuredDescriptors = new Set();
        this.pendingDescriptors = new Map();
        this.imageRecords = new Map();
        // Per image and fully-bucketed cell, allocate the trailing seqHex4.
        // This state only lives until markComplete; interrupted ingests remain
        // incomplete and are intentionally not resumed in place.
        this.featureSequences = new Map();
        this.mutationChains = new Map();
    }

    async withConnection(fn) {
        if (typeof this.pool.withConnection === 'function') {
            return this.pool.withConnection(fn);
        }
        return fn(this.pool);
    }

    async connect() {
        if (this.connected) return this;
        if (typeof this.pool.connect === 'function') await this.pool.connect();
        await this.withConnection(async (conn) => {
            const stored = await getValue(conn, LAYOUT_KEY);
            if (stored === null) {
                await putValue(conn, LAYOUT_KEY, String(keys.KEY_LAYOUT_VERSION), { upsert: true });
                return;
            }
            const version = Number.parseInt(stored, 10);
            if (version !== keys.KEY_LAYOUT_VERSION) {
                throw new CheetahError(
                    `cheetah key layout ${version} is incompatible with codec ${keys.KEY_LAYOUT_VERSION}; ` +
                    're-ingest into a fresh database'
                );
            }
        });
        this.connected = true;
        return this;
    }

    async close() {
        if (!this.ownsPool || typeof this.pool.close !== 'function') return;
        await this.pool.close();
        this.connected = false;
    }

    async ensureDescriptor(descriptor) {
        if (!descriptor || typeof descriptor !== 'object') {
            throw new TypeError('descriptor must be an object');
        }
        const descriptorHash = createDescriptorKey(descriptor);
        const token = await this.vocabulary.tokenFor(descriptorHash);
        if (!this.ensuredDescriptors.has(descriptorHash)) {
            let pending = this.pendingDescriptors.get(descriptorHash);
            if (!pending) {
                pending = putValue(
                    this.pool,
                    keys.descriptorKey(descriptorHash),
                    serializeDescriptor(descriptor),
                    { upsert: true }
                ).then(() => {
                    this.ensuredDescriptors.add(descriptorHash);
                }).finally(() => {
                    this.pendingDescriptors.delete(descriptorHash);
                });
                this.pendingDescriptors.set(descriptorHash, pending);
            }
            await pending;
        }
        return { descriptorKey: descriptorHash, token };
    }

    async allocateImageId() {
        for (let attempt = 0; attempt < 64; attempt += 1) {
            // Random allocation is process-independent. A sequential cfg:
            // counter would race across the worker-thread stores.
            const imageId = this.randomInt(1, 0x100000000);
            if (await getJson(this.pool, keys.imageKey(imageId)) === null) return imageId;
        }
        throw new CheetahError('unable to allocate a collision-free uint32 image id');
    }

    async putImage({ filename, imageId = null, createdAt = null } = {}) {
        if (typeof filename !== 'string' || filename.length === 0) {
            throw new TypeError('filename must be a non-empty string');
        }
        const resolvedId = imageId === null ? await this.allocateImageId() : Number(imageId);
        if (imageId !== null && await getJson(this.pool, keys.imageKey(resolvedId)) !== null) {
            throw new CheetahError(`image id ${resolvedId} already exists`);
        }
        const record = {
            filename,
            created_at: createdAt || timestamp(this.now),
            complete: false,
        };
        await putJson(this.pool, keys.imageKey(resolvedId), record, { upsert: true });
        await putValue(
            this.pool,
            keys.filenameKey(filename),
            keys.formatImageId(resolvedId),
            { upsert: true }
        );
        this.imageRecords.set(resolvedId, record);
        this.featureSequences.set(resolvedId, new Map());
        return { imageId: resolvedId, record };
    }

    sequenceFor(imageId, feature) {
        let sequences = this.featureSequences.get(imageId);
        if (!sequences) {
            sequences = new Map();
            this.featureSequences.set(imageId, sequences);
        }
        const baseKey = keys.featureKey({ ...feature, imageId, sequence: 0 });
        const sequence = sequences.get(baseKey) || 0;
        if (sequence > 0xffff) {
            throw new RangeError(`too many duplicate feature rows in one key cell for image ${imageId}`);
        }
        sequences.set(baseKey, sequence + 1);
        return sequence;
    }

    async putFeatures(imageId, features) {
        if (!Array.isArray(features) || features.length === 0) return 0;
        const image = await this.getImage(imageId);
        if (!image) throw new CheetahError(`cannot attach features to missing image ${imageId}`);
        if (image.complete) {
            throw new CheetahError(`cannot attach features to completed image ${imageId}`);
        }
        const descriptors = new Map();
        for (const feature of features) {
            const descriptorHash = createDescriptorKey(feature.descriptor);
            if (!descriptors.has(descriptorHash)) descriptors.set(descriptorHash, feature.descriptor);
        }
        const descriptorHashes = [...descriptors.keys()];
        const tokens = await this.vocabulary.tokensFor(descriptorHashes);
        const tokenByDescriptor = new Map(
            descriptorHashes.map((descriptorHash, index) => [descriptorHash, tokens[index]])
        );
        await Promise.all([...descriptors.values()].map((descriptor) =>
            this.ensureDescriptor(descriptor)
        ));

        const prepared = features.map((feature) => {
            const descriptorHash = createDescriptorKey(feature.descriptor);
            const token = tokenByDescriptor.get(descriptorHash);
            const resolutionLevel = normalizeResolutionLevel(
                feature.resolution_level ?? feature.size
            );
            const keyParts = {
                token,
                resolutionLevel,
                anchorXBucket: finiteNumber(feature.pos_x, 'feature.pos_x'),
                anchorYBucket: finiteNumber(feature.pos_y, 'feature.pos_y'),
                offsetX: finiteNumber(feature.rel_x, 'feature.rel_x'),
                offsetY: finiteNumber(feature.rel_y, 'feature.rel_y'),
            };
            const sequence = this.sequenceFor(imageId, keyParts);
            return {
                key: keys.featureKey({ ...keyParts, imageId, sequence }),
                payload: {
                    value: finiteNumber(feature.value, 'feature.value'),
                    size: finiteNumber(feature.size ?? resolutionLevel, 'feature.size'),
                    rel_x: keyParts.offsetX,
                    rel_y: keyParts.offsetY,
                },
            };
        });

        for (let at = 0; at < prepared.length; at += this.writeBatchSize) {
            const batch = prepared.slice(at, at + this.writeBatchSize);
            // Each put is INSERT -> PAIR_SET, but all rows in this batch enter
            // the pool together so its bounded FIFO queues keep the sockets full.
            await Promise.all(batch.map(({ key, payload }) => putJson(this.pool, key, payload)));
        }
        return prepared.length;
    }

    async markComplete(imageId) {
        const key = keys.imageKey(imageId);
        const current = this.imageRecords.get(imageId) || await getJson(this.pool, key);
        if (!current) throw new CheetahError(`cannot complete missing image ${imageId}`);
        const record = { ...current, complete: true };
        await putJson(this.pool, key, record, { upsert: true });
        this.imageRecords.set(imageId, record);
        this.featureSequences.delete(imageId);
        return record;
    }

    async getImage(imageId) {
        if (this.imageRecords.has(imageId)) return this.imageRecords.get(imageId);
        const record = await getJson(this.pool, keys.imageKey(imageId));
        if (record) this.imageRecords.set(imageId, record);
        return record;
    }

    async findCandidates(probe, { pageSize = DEFAULT_SCAN_LIMIT, maxRows = Infinity } = {}) {
        const descriptor = probe?.descriptor;
        const resolved = descriptor
            ? await this.ensureDescriptor(descriptor)
            : {
                descriptorKey: probe?.descriptorKey,
                token: probe?.token,
            };
        if (!Number.isInteger(resolved.token)) return [];

        const resolutionLevel = normalizeResolutionLevel(
            probe.resolution_level ?? probe.size ?? descriptor?.span
        );
        const relX = finiteNumber(probe.rel_x ?? descriptor?.offset_x, 'probe.rel_x');
        const relY = finiteNumber(probe.rel_y ?? descriptor?.offset_y, 'probe.rel_y');
        const prefixArgs = {
            token: resolved.token,
            resolutionLevel,
            anchorXBucket: finiteNumber(
                probe.pos_x ?? Math.round(descriptor.anchor_u * keys.ANCHOR_SCALE),
                'probe.pos_x'
            ),
            anchorYBucket: finiteNumber(
                probe.pos_y ?? Math.round(descriptor.anchor_v * keys.ANCHOR_SCALE),
                'probe.pos_y'
            ),
        };

        const rows = [];
        for (const prefix of keys.featureScanPrefixes(prefixArgs)) {
            const remaining = Number.isFinite(maxRows) ? Math.max(0, maxRows - rows.length) : Infinity;
            if (remaining === 0) break;
            for await (const item of scanPrefix(this.pool, prefix, {
                limit: pageSize,
                maxItems: remaining,
                reducer: 'continuations',
            })) {
                const parsedKey = keys.parseFeatureKey(item.key);
                const feature = parseHydratedJson(item);
                const size = normalizeResolutionLevel(feature.size);
                if (Math.abs(size - resolutionLevel) > RESOLUTION_LEVEL_TOLERANCE) continue;
                if (Math.abs(Number(feature.rel_x) - relX) > OFFSET_TOLERANCE) continue;
                if (Math.abs(Number(feature.rel_y) - relY) > OFFSET_TOLERANCE) continue;

                const image = await this.getImage(parsedKey.imageId);
                if (!image?.complete) continue;
                rows.push({
                    vector_id: item.absKey,
                    feature_key: item.key,
                    image_id: parsedKey.imageId,
                    original_filename: image.filename,
                    value_type: resolved.token,
                    resolution_level: size,
                    pos_x: parsedKey.anchorXBucket,
                    pos_y: parsedKey.anchorYBucket,
                    rel_x: Number(feature.rel_x),
                    rel_y: Number(feature.rel_y),
                    value: Number(feature.value),
                    size: Number(feature.size),
                    descriptor_key: resolved.descriptorKey,
                });
            }
        }
        return rows;
    }

    async mutateJson(key, fallback, mutate) {
        const previous = this.mutationChains.get(key) || Promise.resolve();
        const run = previous.then(() => this.withConnection(async (conn) => {
            const current = await getJson(conn, key);
            const next = mutate(current || { ...fallback });
            await putJson(conn, key, next, { upsert: true });
            return next;
        }));
        const tail = run.then(() => undefined, () => undefined);
        this.mutationChains.set(key, tail);
        void tail.then(() => {
            if (this.mutationChains.get(key) === tail) this.mutationChains.delete(key);
        });
        return run;
    }

    async recordUsage(featureKeys, increment = 1, scoreDelta = 0) {
        if (!Array.isArray(featureKeys) || featureKeys.length === 0) return;
        await Promise.all(featureKeys.map((featureKey) => {
            const key = keys.usageKey(featureKey);
            return this.mutateJson(key, { count: 0, last_used: null, last_score: 0 }, (record) => ({
                feature_key: featureKey,
                count: Number(record.count || 0) + Number(increment || 0),
                last_used: timestamp(this.now),
                last_score: Number(record.last_score || 0) + Number(scoreDelta || 0),
            }));
        }));
    }

    async saveSkip(descriptor) {
        if (!descriptor) return null;
        const descriptorHash = createDescriptorKey(descriptor);
        return this.mutateJson(
            keys.skipKey(descriptorHash),
            { count: 0, last_used: null, descriptor: null },
            (record) => ({
                count: Number(record.count || 0) + 1,
                last_used: timestamp(this.now),
                descriptor,
            })
        );
    }

    async getSetting(name, defaultValue = null) {
        const key = keys.configKey(name);
        const raw = await getValue(this.pool, key);
        if (raw !== null) {
            const numeric = Number(raw);
            return Number.isNaN(numeric) ? raw : numeric;
        }
        if (defaultValue !== null) await this.setSetting(name, defaultValue);
        return defaultValue;
    }

    async setSetting(name, value) {
        await putValue(this.pool, keys.configKey(name), String(value), { upsert: true });
        return value;
    }

    async featureSummary(depth = 1) {
        const response = await this.pool.command('PAIR_SUMMARY', keys.NAMESPACES.feature, depth);
        if (!response.ok) {
            throw new CheetahError(`cheetah feature summary failed: ${response.error || response.raw}`, {
                response,
            });
        }
        return {
            count: numericField(response.fields, 'count'),
            totalPayloadBytes: numericField(response.fields, 'total_payload_bytes'),
            response,
        };
    }

    /**
     * Payload accounting for every Image Sign namespace.
     *
     * Cheetah's PAIR_SUMMARY intentionally reports payload bytes without
     * hydrating them. It does not include pair-trie/table overhead, so this is
     * a stable pruning signal rather than an on-disk directory-size claim.
     */
    async storageSummary() {
        const namespaces = [...new Set(Object.values(keys.NAMESPACES))];
        const responses = await Promise.all(namespaces.map(async (prefix) => {
            const response = await this.pool.command('PAIR_SUMMARY', prefix, 1);
            if (!response.ok) {
                throw new CheetahError(
                    `cheetah storage summary for ${prefix} failed: ${response.error || response.raw}`,
                    { response }
                );
            }
            return {
                prefix,
                count: numericField(response.fields, 'count', 0),
                payloadBytes: numericField(response.fields, 'total_payload_bytes', 0),
            };
        }));
        return {
            totalRecords: responses.reduce((sum, entry) => sum + entry.count, 0),
            totalPayloadBytes: responses.reduce((sum, entry) => sum + entry.payloadBytes, 0),
            namespaces: Object.fromEntries(responses.map((entry) => [entry.prefix, entry])),
        };
    }

    /**
     * Distribution of the exact prefixes Phase 3 will scan:
     * f:<token>/<resolution>/<anchor-x>/<anchor-y>/.
     */
    async measureFeaturePages({ pageSize = DEFAULT_SCAN_LIMIT, maxRows = Infinity } = {}) {
        const counts = new Map();
        let rowCount = 0;
        for await (const item of scanPrefix(this.pool, keys.NAMESPACES.feature, {
            limit: pageSize,
            maxItems: maxRows,
        })) {
            const parsed = keys.parseFeatureKey(item.key);
            const prefix = keys.featureScanPrefix({
                token: parsed.token,
                resolutionBucket: parsed.resolutionBucket,
                anchorXBucket: parsed.anchorXBucket,
                anchorYBucket: parsed.anchorYBucket,
            });
            counts.set(prefix, (counts.get(prefix) || 0) + 1);
            rowCount += 1;
        }
        const sizes = [...counts.values()].sort((a, b) => a - b);
        const total = sizes.reduce((sum, value) => sum + value, 0);
        return {
            rowCount,
            prefixCount: sizes.length,
            min: sizes[0] || 0,
            max: sizes[sizes.length - 1] || 0,
            mean: sizes.length > 0 ? total / sizes.length : 0,
            p50: percentile(sizes, 0.5),
            p90: percentile(sizes, 0.9),
            p95: percentile(sizes, 0.95),
            p99: percentile(sizes, 0.99),
            over500: sizes.filter((value) => value > 500).length,
        };
    }

    async usageByFeatureKey() {
        const usage = new Map();
        for await (const item of scanPrefix(this.pool, keys.NAMESPACES.usage, {
            limit: DEFAULT_SCAN_LIMIT,
            reducer: 'continuations',
        })) {
            const record = parseHydratedJson(item);
            if (typeof record.feature_key === 'string') {
                usage.set(record.feature_key, record);
            }
        }
        return usage;
    }

    async prunableFeatures() {
        const usage = await this.usageByFeatureKey();
        const candidates = [];
        for await (const item of scanPrefix(this.pool, keys.NAMESPACES.feature, {
            limit: DEFAULT_SCAN_LIMIT,
        })) {
            const parsed = keys.parseFeatureKey(item.key);
            const image = await this.getImage(parsed.imageId);
            // Never erase a feature batch that another ingest has not committed.
            if (!image?.complete) continue;
            const record = usage.get(item.key);
            candidates.push({
                key: item.key,
                usageCount: Number(record?.count || 0),
                lastUsed: record?.last_used ? Date.parse(record.last_used) || 0 : 0,
                hasUsageRecord: Boolean(record),
            });
        }
        candidates.sort((left, right) =>
            left.usageCount - right.usageCount ||
            left.lastUsed - right.lastUsed ||
            left.key.localeCompare(right.key)
        );
        return candidates;
    }

    async deletePair(key) {
        const response = await this.pool.send(`DEL pairs key=${encodeArgument(key)}`);
        if (response.ok) return numericField(response.fields, 'deleted', 1);
        if (response.error && /not_found/.test(response.error)) return 0;
        throw new CheetahError(`cheetah DEL pairs ${key} failed: ${response.error || response.raw}`, {
            response,
        });
    }

    async pruneLowValueFeatures(targetPayloadBytes, {
        maxBatchSize = DEFAULT_PRUNE_BATCH_SIZE,
        deleteConcurrency = 128,
    } = {}) {
        const before = await this.storageSummary();
        const target = Math.max(0, Number(targetPayloadBytes) || 0);
        if (before.totalPayloadBytes <= target) {
            return { pruned: 0, before, after: before };
        }

        const featureStats = before.namespaces[keys.NAMESPACES.feature] || {
            count: 0,
            payloadBytes: 0,
        };
        if (featureStats.count === 0) {
            return { pruned: 0, before, after: before };
        }

        const averageFeatureBytes = Math.max(
            1,
            featureStats.payloadBytes / featureStats.count
        );
        const estimatedRows = Math.max(
            1,
            Math.ceil((before.totalPayloadBytes - target) / averageFeatureBytes)
        );
        const batchLimit = Math.max(
            1,
            Number(maxBatchSize) || DEFAULT_PRUNE_BATCH_SIZE
        );
        const candidates = await this.prunableFeatures();
        const selected = candidates.slice(
            0,
            Math.min(candidates.length, batchLimit, estimatedRows)
        );

        let pruned = 0;
        const concurrency = Math.max(1, Number(deleteConcurrency) || 1);
        for (let at = 0; at < selected.length; at += concurrency) {
            const batch = selected.slice(at, at + concurrency);
            const deleted = await Promise.all(batch.map(async (candidate) => {
                const featureDeleted = await this.deletePair(candidate.key);
                if (candidate.hasUsageRecord) {
                    await this.deletePair(keys.usageKey(candidate.key));
                }
                return featureDeleted;
            }));
            pruned += deleted.reduce((sum, count) => sum + count, 0);
        }

        return {
            pruned,
            before,
            after: await this.storageSummary(),
        };
    }

    async ensureStorageCapacity({
        maxBytes = null,
        maxGb = null,
        maxBatchSize = DEFAULT_PRUNE_BATCH_SIZE,
    } = {}) {
        let targetPayloadBytes;
        if (
            maxBytes !== null &&
            maxBytes !== undefined &&
            Number.isFinite(Number(maxBytes)) &&
            Number(maxBytes) >= 0
        ) {
            targetPayloadBytes = Number(maxBytes);
        } else {
            const configuredGb = maxGb ?? await this.getSetting(
                'max_db_size_gb',
                settings.database.defaultMaxSizeGb
            );
            const numericGb = Number(configuredGb);
            targetPayloadBytes = (
                Number.isFinite(numericGb) && numericGb > 0
                    ? numericGb
                    : settings.database.defaultMaxSizeGb
            ) * BYTES_PER_GIB;
        }

        const result = await this.pruneLowValueFeatures(targetPayloadBytes, { maxBatchSize });
        return {
            ...result,
            targetPayloadBytes,
            overLimit: result.after.totalPayloadBytes > targetPayloadBytes,
        };
    }
}

async function createCheetahStore(options) {
    const store = new CheetahStore(options);
    try {
        await store.connect();
        return store;
    } catch (error) {
        await store.close();
        throw error;
    }
}

module.exports = {
    BYTES_PER_GIB,
    CheetahStore,
    LAYOUT_KEY,
    createCheetahStore,
};
