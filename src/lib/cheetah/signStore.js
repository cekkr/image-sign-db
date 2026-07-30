// Cheetah storage and retrieval for the sign pipeline.
//
// Two indexes, each doing what it is actually good at:
//
//   - **The property graph resolves the image.** Every vocabulary word is a
//     node, every image is a node, and an edge says "this word was observed in
//     this image, this strongly". A search hands its measured words to
//     GRAPH_RECALL as seeds; activation spreads from all of them at once and
//     the answer is ranked by how many seeds converged on the same image and
//     how strongly. That is the "which image do these constellations have in
//     common?" question asked in one round trip instead of reconstructed from
//     postings in Node.
//   - **The pair trie drills down.** `sw:<word>/<image>/` names the individual
//     signs of a candidate that carry a word, which is what the reranker needs
//     in order to compare continuous colour fields. The graph knows *that* an
//     image matched; only the trie knows *which of its signs* did.
//
// The completion protocol is the same as CheetahStore's, and for the same
// reason: Cheetah has no transaction spanning these writes, so `complete` on the
// image record is the commit marker and readers ignore anything without it.

const crypto = require('crypto');
const settings = require('../../settings');
const { SIGN_LAYOUT_VERSION } = require('../sign/constants');
const { CheetahPool, CheetahError } = require('./client');
const { decodeItemPayload } = require('./protocol');
const graph = require('./graph');
const { getJson, getValue, putJson, putValue, scanPrefix } = require('./kv');
const keys = require('./keys');

const LAYOUT_KEY = keys.configKey('sign_layout_version');
const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_WRITE_BATCH_SIZE = 256;
const EDGE_BATCH_SIZE = 250;

/**
 * Observations of a word inside one image at which its edge weight saturates.
 *
 * Cheetah clamps an edge weight into [0,1] before using it as activation
 * (graph_recall.go → graphRecallAffinity), so a raw count would be flattened to
 * 1 the moment it exceeded one. Saturating explicitly keeps the difference
 * between "seen once, possibly noise" and "seen repeatedly" visible.
 */
const TF_SATURATION = 3;

const EDGE_TYPE = 'sign';

function timestamp(now) {
    const value = now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseHydratedJson(item) {
    const bytes = decodeItemPayload(item);
    if (!bytes) throw new CheetahError(`cheetah scan did not hydrate ${item?.key || '(unknown)'}`);
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new CheetahError(`cheetah payload at ${item.key} is not JSON: ${error.message}`);
    }
}

class SignStore {
    constructor(options = {}) {
        const configured = settings.cheetah;
        this.pool = options.pool || new CheetahPool({
            size: options.poolSize ?? configured.poolSize,
            host: options.host ?? configured.host,
            port: options.port ?? configured.port,
            database: options.database ?? configured.database,
            databaseOptions: { pair_bytes: options.pairIndexBytes ?? configured.pairIndexBytes },
            connectTimeoutMs: options.connectTimeoutMs ?? configured.connectTimeoutMs,
            commandTimeoutMs: options.commandTimeoutMs ?? configured.commandTimeoutMs,
            maxInFlight: options.maxInFlight ?? configured.maxInFlight,
        });
        this.ownsPool = !options.pool;
        this.now = options.now || (() => new Date());
        this.randomInt = options.randomInt || crypto.randomInt;
        this.writeBatchSize = Math.max(1, Number(options.writeBatchSize) || DEFAULT_WRITE_BATCH_SIZE);
        this.tfSaturation = Math.max(1, Number(options.tfSaturation) || TF_SATURATION);
        this.connected = false;
        this.imageRecords = new Map();
    }

    async withConnection(fn) {
        if (typeof this.pool.withConnection === 'function') return this.pool.withConnection(fn);
        return fn(this.pool);
    }

    async connect() {
        if (this.connected) return this;
        if (typeof this.pool.connect === 'function') await this.pool.connect();
        await this.withConnection(async (conn) => {
            const stored = await getValue(conn, LAYOUT_KEY);
            if (stored === null) {
                await putValue(conn, LAYOUT_KEY, String(SIGN_LAYOUT_VERSION), { upsert: true });
                return;
            }
            if (Number.parseInt(stored, 10) !== SIGN_LAYOUT_VERSION) {
                throw new CheetahError(
                    `cheetah sign layout ${stored} is incompatible with codec ${SIGN_LAYOUT_VERSION}; ` +
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

    // -- images -------------------------------------------------------------

    async allocateImageId() {
        for (let attempt = 0; attempt < 64; attempt += 1) {
            const imageId = this.randomInt(1, 0x100000000);
            if (await getJson(this.pool, keys.signImageKey(imageId)) === null) return imageId;
        }
        throw new CheetahError('unable to allocate a collision-free uint32 image id');
    }

    async getImage(imageId) {
        if (this.imageRecords.has(imageId)) return this.imageRecords.get(imageId);
        const record = await getJson(this.pool, keys.signImageKey(imageId));
        if (record) this.imageRecords.set(imageId, record);
        return record;
    }

    async findImageIdByFilename(filename) {
        const stored = await getValue(this.pool, keys.signFilenameKey(filename));
        return stored === null ? null : keys.parseImageId(stored);
    }

    /** Create (or reopen) an incomplete image record. */
    async putImage({ filename, width = null, height = null, imageId = null } = {}) {
        if (typeof filename !== 'string' || filename.length === 0) {
            throw new TypeError('filename must be a non-empty string');
        }
        const resolvedId = imageId === null ? await this.allocateImageId() : Number(imageId);
        const record = {
            filename,
            width,
            height,
            created_at: timestamp(this.now),
            complete: false,
            constellations: 0,
            words: 0,
        };
        await putJson(this.pool, keys.signImageKey(resolvedId), record, { upsert: true });
        await putValue(
            this.pool,
            keys.signFilenameKey(filename),
            keys.formatImageId(resolvedId),
            { upsert: true }
        );
        this.imageRecords.set(resolvedId, record);
        return { imageId: resolvedId, record };
    }

    async markComplete(imageId, extra = {}) {
        const key = keys.signImageKey(imageId);
        const current = this.imageRecords.get(imageId) || await getJson(this.pool, key);
        if (!current) throw new CheetahError(`cannot complete missing sign image ${imageId}`);
        const record = { ...current, ...extra, complete: true };
        await putJson(this.pool, key, record, { upsert: true });
        this.imageRecords.set(imageId, record);
        return record;
    }

    /** Every complete image record, keyed by image id. */
    async listImages({ includeIncomplete = false } = {}) {
        const images = new Map();
        for await (const item of scanPrefix(this.pool, keys.NAMESPACES.signImage, {
            limit: DEFAULT_SCAN_LIMIT,
            reducer: 'continuations',
        })) {
            const imageId = keys.parseImageId(item.key.slice(keys.NAMESPACES.signImage.length));
            const record = parseHydratedJson(item);
            if (!includeIncomplete && !record.complete) continue;
            this.imageRecords.set(imageId, record);
            images.set(imageId, record);
        }
        return images;
    }

    // -- ingestion ----------------------------------------------------------

    /**
     * Persist a batch of signs and return the per-word observation counts.
     *
     * Words are deduplicated per constellation before writing: two triples of
     * the same sign landing in the same cell is one observation of that word by
     * that sign, and writing it twice would only rebind the same posting key and
     * orphan the first payload.
     */
    async putSigns(imageId, signs, { startOrdinal = 0 } = {}) {
        const image = await this.getImage(imageId);
        if (!image) throw new CheetahError(`cannot attach signs to missing image ${imageId}`);
        if (image.complete) throw new CheetahError(`cannot attach signs to completed image ${imageId}`);

        const wordCounts = new Map();
        const writes = [];
        signs.forEach((sign, index) => {
            const ordinal = startOrdinal + index;
            writes.push({
                key: keys.signConstellationKey(imageId, ordinal),
                payload: sign.record,
            });
            // Soft assignment is applied here, on the ingestion side: a triple
            // is written under every word of its sweep, so a measurement that
            // later lands a thousandth across a level edge still finds it. The
            // query then only has to ask for the cell it actually fell in,
            // which keeps a search's seed count — and its recall budget — small.
            const seen = new Map();
            sign.triples.forEach((triple) => {
                for (const word of triple.words) {
                    if (!seen.has(word)) seen.set(word, triple.index);
                }
            });
            for (const [word, tripleIndex] of seen) {
                wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
                writes.push({
                    key: keys.signWordPostingKey(word, imageId, ordinal),
                    payload: { t: tripleIndex },
                });
            }
        });

        for (let at = 0; at < writes.length; at += this.writeBatchSize) {
            const batch = writes.slice(at, at + this.writeBatchSize);
            await Promise.all(batch.map(({ key, payload }) => putJson(this.pool, key, payload)));
        }
        return { wordCounts, written: writes.length, nextOrdinal: startOrdinal + signs.length };
    }

    /**
     * Publish an image's vocabulary into the graph.
     *
     * Edges are word -> image so that a search seeds words and spreads *out* to
     * images in a single hop. The reverse direction would make every recall walk
     * an image node's thousands of edges.
     */
    async commitGraph(imageId, filename, wordCounts) {
        const imageNode = keys.imageNodeId(imageId);
        await graph.setNode(this.pool, {
            id: imageNode,
            labels: ['sign_image'],
            props: { filename },
        });

        const items = [...wordCounts.entries()].map(([word, count]) => ({
            from: keys.wordNodeId(word),
            to: imageNode,
            weight: Math.min(1, count / this.tfSaturation),
        }));

        let applied = 0;
        for (let at = 0; at < items.length; at += EDGE_BATCH_SIZE) {
            const batch = items.slice(at, at + EDGE_BATCH_SIZE);
            const result = await graph.setEdgeBatch(this.pool, batch, {
                type: EDGE_TYPE,
                directed: 1,
            });
            if (result.failed > 0) {
                throw new CheetahError(
                    `cheetah edge batch dropped ${result.failed} of ${result.requested} sign edges ` +
                    `for image ${imageId}; the word index would have holes in it`
                );
            }
            applied += result.applied;
        }
        return { edges: items.length, applied };
    }

    // -- retrieval ----------------------------------------------------------

    /**
     * How many images each word appears in.
     *
     * This is the document frequency, and it is what makes a search selective:
     * a word carried by most of the corpus says nothing about which image is in
     * front of us, and seeding a recall with it only spends budget.
     */
    async wordDegrees(words) {
        const unique = [...new Set(words)];
        const degrees = await Promise.all(unique.map((word) =>
            graph.degree(this.pool, { id: keys.wordNodeId(word), direction: 'out', type: EDGE_TYPE })
        ));
        return new Map(unique.map((word, index) => [word, degrees[index].degree]));
    }

    /**
     * Ask the graph which images these words have in common.
     *
     * `hops: 1` and `decay: 1` because the walk is exactly one edge long — word
     * to image — so there is no distance to discount; the ranking that matters
     * is the server's noisy-OR over how many seeds converged.
     */
    async recallImages(words, { limit = 32, minSources = 1, precision = 0.05 } = {}) {
        const associations = await graph.recallBatched(this.pool, {
            seeds: words.map((word) => keys.wordNodeId(word)),
            hops: 1,
            decay: 1,
            precision,
            direction: 'out',
            type: EDGE_TYPE,
            limit,
            minSources,
        });
        const results = [];
        for (const association of associations) {
            let imageId;
            try {
                const parsed = keys.parseNodeId(association.id);
                if (parsed.kind !== 'image') continue;
                imageId = parsed.id;
            } catch {
                continue;
            }
            const image = await this.getImage(imageId);
            if (!image?.complete) continue;
            const seeds = [];
            for (const [nodeId, activation] of association.sources) {
                try {
                    seeds.push({ word: keys.parseWordNodeId(nodeId), activation });
                } catch { /* a seed that is not one of our words cannot weigh in */ }
            }
            results.push({
                imageId,
                filename: image.filename,
                words: Number(image.words) || 0,
                score: association.score,
                sourceCount: association.sourceCount,
                seeds,
            });
        }
        return results;
    }

    /** The signs of one image that carry one word, hydrated. */
    async signsForWord(word, imageId, { limit = 8 } = {}) {
        const found = [];
        for await (const item of scanPrefix(this.pool, keys.signWordImagePrefix(word, imageId), {
            limit: Math.min(DEFAULT_SCAN_LIMIT, Math.max(1, limit)),
            maxItems: limit,
        })) {
            found.push(keys.parseSignWordPostingKey(item.key).ordinal);
        }
        const records = await Promise.all(found.map((ordinal) =>
            getJson(this.pool, keys.signConstellationKey(imageId, ordinal))
        ));
        return found
            .map((ordinal, index) => ({ ordinal, record: records[index] }))
            .filter((entry) => entry.record !== null);
    }

    /** One constellation record by address. */
    async getSign(imageId, ordinal) {
        return getJson(this.pool, keys.signConstellationKey(imageId, ordinal));
    }
}

async function createSignStore(options) {
    const store = new SignStore(options);
    try {
        await store.connect();
        return store;
    } catch (error) {
        await store.close();
        throw error;
    }
}

module.exports = {
    EDGE_TYPE,
    LAYOUT_KEY,
    SignStore,
    TF_SATURATION,
    createSignStore,
};
