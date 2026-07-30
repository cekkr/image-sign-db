// Image Sign DB storage interface for Cheetah — ROADMAP Phase 2.
//
// This is the only module above the wire/key layer that knows how Image Sign
// records map onto Cheetah namespaces. Pixel measurement remains in
// vectorGenerators.js; callers pass the same feature objects the MySQL path
// persists today.
//
// It extends `CheetahDatabase` from the submodule's Node binder
// (cheetah/binders/nodejs/lib/database.js), which owns everything that is not
// about this schema: pool construction, the layout-version guard on connect,
// `close` that only closes a pool it owns, the per-key mutation chain,
// collision-checked id allocation and namespace payload accounting. What is
// left here is what only this project knows.
//
// Consistency is deliberately the same completion protocol as MySQL:
//
//   putImage(complete:false) -> putFeatures(...) -> markComplete()
//
// Readers hydrate only complete image records. Cheetah has no transaction
// spanning these writes, so `complete` is the commit marker.

const settings = require('../../settings');
const { serializeDescriptor, createDescriptorKey } = require('../descriptor');
const { RESOLUTION_LEVEL_TOLERANCE, normalizeResolutionLevel } = require('../resolutionLevel');
const { CONSTELLATION_CONSTANTS } = require('../constants');
const binder = require('./binder');
const { CheetahError } = require('./client');
const { TokenVocabulary } = require('./vocabulary');
const keys = require('./keys');

const { CheetahDatabase, hydrateJson } = binder.database;
const { OFFSET_TOLERANCE } = CONSTELLATION_CONSTANTS;
const LAYOUT_KEY = keys.configKey('key_layout_version');
const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_PRUNE_BATCH_SIZE = 5000;
const BYTES_PER_GIB = 1024 ** 3;

function finiteNumber(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new TypeError(`${name} must be finite, got ${value}`);
    }
    return number;
}

function percentile(sortedValues, fraction) {
    if (sortedValues.length === 0) return 0;
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)
    );
    return sortedValues[index];
}

class CheetahStore extends CheetahDatabase {
    constructor(options = {}) {
        const configured = settings.cheetah;
        super({
            pool: options.pool,
            database: options.database ?? configured.database,
            databaseOptions: {
                pair_bytes: options.pairIndexBytes ?? configured.pairIndexBytes,
            },
            poolSize: options.poolSize ?? configured.poolSize,
            host: options.host ?? configured.host,
            port: options.port ?? configured.port,
            connectTimeoutMs: options.connectTimeoutMs ?? configured.connectTimeoutMs,
            commandTimeoutMs: options.commandTimeoutMs ?? configured.commandTimeoutMs,
            maxInFlight: options.maxInFlight ?? configured.maxInFlight,
            // A mismatch fails loudly on connect: the key layout is not
            // self-describing, so an older database would otherwise read as a
            // set of keys that simply match nothing.
            layout: { key: LAYOUT_KEY, version: keys.KEY_LAYOUT_VERSION, label: 'key layout' },
            now: options.now,
            randomInt: options.randomInt,
            writeBatchSize: options.writeBatchSize,
            scanLimit: DEFAULT_SCAN_LIMIT,
        });
        this.vocabulary = options.vocabulary || new TokenVocabulary(this.pool);
        this.ensuredDescriptors = new Set();
        this.pendingDescriptors = new Map();
        this.imageRecords = new Map();
        // Per image and fully-bucketed cell, allocate the trailing seqHex4.
        // This state only lives until markComplete; interrupted ingests remain
        // incomplete and are intentionally not resumed in place.
        this.featureSequences = new Map();
    }

    clearCaches() {
        this.ensuredDescriptors.clear();
        this.imageRecords.clear();
        this.featureSequences.clear();
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
                pending = this.putValue(
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

    /**
     * Random allocation is process-independent. A sequential `cfg:` counter
     * would race across the worker-thread stores.
     */
    async allocateImageId() {
        return this.allocateRandomId((imageId) => keys.imageKey(imageId));
    }

    async putImage({ filename, imageId = null, createdAt = null } = {}) {
        if (typeof filename !== 'string' || filename.length === 0) {
            throw new TypeError('filename must be a non-empty string');
        }
        const resolvedId = imageId === null ? await this.allocateImageId() : Number(imageId);
        if (imageId !== null && await this.getJson(keys.imageKey(resolvedId)) !== null) {
            throw new CheetahError(`image id ${resolvedId} already exists`);
        }
        const record = {
            filename,
            created_at: createdAt || this.timestamp(),
            complete: false,
        };
        await this.putJson(keys.imageKey(resolvedId), record, { upsert: true });
        await this.putValue(
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
            await Promise.all(batch.map(({ key, payload }) => this.putJson(key, payload)));
        }
        return prepared.length;
    }

    async markComplete(imageId) {
        const key = keys.imageKey(imageId);
        const current = this.imageRecords.get(imageId) || await this.getJson(key);
        if (!current) throw new CheetahError(`cannot complete missing image ${imageId}`);
        const record = { ...current, complete: true };
        await this.putJson(key, record, { upsert: true });
        this.imageRecords.set(imageId, record);
        this.featureSequences.delete(imageId);
        return record;
    }

    async getImage(imageId) {
        if (this.imageRecords.has(imageId)) return this.imageRecords.get(imageId);
        const record = await this.getJson(keys.imageKey(imageId));
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
            for await (const item of this.scan(prefix, {
                limit: pageSize,
                maxItems: remaining,
                reducer: 'continuations',
            })) {
                const parsedKey = keys.parseFeatureKey(item.key);
                const feature = hydrateJson(item);
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

    async recordUsage(featureKeys, increment = 1, scoreDelta = 0) {
        if (!Array.isArray(featureKeys) || featureKeys.length === 0) return;
        await Promise.all(featureKeys.map((featureKey) => {
            const key = keys.usageKey(featureKey);
            return this.mutateJson(key, { count: 0, last_used: null, last_score: 0 }, (record) => ({
                feature_key: featureKey,
                count: Number(record.count || 0) + Number(increment || 0),
                last_used: this.timestamp(),
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
                last_used: this.timestamp(),
                descriptor,
            })
        );
    }

    async getSetting(name, defaultValue = null) {
        const key = keys.configKey(name);
        const raw = await this.getValue(key);
        if (raw !== null) {
            const numeric = Number(raw);
            return Number.isNaN(numeric) ? raw : numeric;
        }
        if (defaultValue !== null) await this.setSetting(name, defaultValue);
        return defaultValue;
    }

    async setSetting(name, value) {
        await this.putValue(keys.configKey(name), String(value), { upsert: true });
        return value;
    }

    async featureSummary(depth = 1) {
        const summary = await this.pairSummary(keys.NAMESPACES.feature, depth);
        return {
            count: summary.count,
            totalPayloadBytes: summary.payloadBytes,
            response: summary.response,
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
        return this.namespaceSummary(Object.values(keys.NAMESPACES));
    }

    /**
     * Distribution of the exact prefixes Phase 3 will scan:
     * f:<token>/<resolution>/<anchor-x>/<anchor-y>/.
     */
    async measureFeaturePages({ pageSize = DEFAULT_SCAN_LIMIT, maxRows = Infinity } = {}) {
        const counts = new Map();
        let rowCount = 0;
        for await (const item of this.scan(keys.NAMESPACES.feature, {
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
        // The `use:` key is a sha1 of the feature key and therefore not
        // invertible, so the payload carries `feature_key` and this map is
        // keyed from it.
        for await (const { value } of this.scanJson(keys.NAMESPACES.usage, {
            limit: DEFAULT_SCAN_LIMIT,
        })) {
            if (typeof value.feature_key === 'string') usage.set(value.feature_key, value);
        }
        return usage;
    }

    async prunableFeatures() {
        const usage = await this.usageByFeatureKey();
        const candidates = [];
        for await (const item of this.scan(keys.NAMESPACES.feature, {
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
