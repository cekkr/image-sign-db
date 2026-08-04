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
// Like CheetahStore it extends `CheetahDatabase` from the submodule's Node
// binder, which owns the connection plumbing, the layout guard, `reset`, and id
// allocation. The two stores share none of *this* file: the namespaces, the
// posting layout and the graph publishing below are the sign pipeline's alone.
//
// The completion protocol is the same as CheetahStore's, and for the same
// reason: Cheetah has no transaction spanning these writes, so `complete` on the
// image record is the commit marker and readers ignore anything without it.

const settings = require('../../settings');
const { SIGN_LAYOUT_VERSION } = require('../sign/constants');
const binder = require('./binder');
const { CheetahError } = require('./client');
const keys = require('./keys');

const { CheetahDatabase, hydrateJson } = binder.database;
const LAYOUT_KEY = keys.configKey('sign_layout_version');
const DEFAULT_SCAN_LIMIT = 500;
const EDGE_BATCH_SIZE = 250;

/**
 * An edge weight is the word's **relative** frequency inside the image:
 * `count / max(count)`, so the most frequent word of an image weighs 1 and
 * everything else sits below it in proportion.
 *
 * Cheetah clamps an edge weight into [0,1] before using it as activation
 * (graph_recall.go → graphRecallAffinity), so a raw count cannot travel; the
 * question is only what to divide by. It used to be a constant 3 — anything
 * seen three times or more weighed the same as anything seen a thousand times —
 * and that is the whole of the term frequency, thrown away. At the densities
 * this pipeline trains at, nearly every word of an image clears 3, so nearly
 * every edge weighed exactly 1 and the graph could only answer "does this image
 * contain this word", which on a 4096-word vocabulary is true of almost every
 * pair. Measured on `sample_images/`, 100 images at 1024 constellations: a
 * resolver reading membership scores 10/100, one reading these weights 94/100.
 *
 * Dividing by the image's own maximum, rather than by its total, is what makes
 * the scale comparable between an image trained at 512 constellations and one
 * topped up to 4096. The per-image scale factor it leaves behind is divided out
 * by `signature_norm` at query time.
 */
function relativeFrequency(count, maxCount) {
    return count / Math.max(1, maxCount);
}

const EDGE_TYPE = 'sign';

class SignStore extends CheetahDatabase {
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
            binary: options.binary ?? configured.binary,
            connectTimeoutMs: options.connectTimeoutMs ?? configured.connectTimeoutMs,
            commandTimeoutMs: options.commandTimeoutMs ?? configured.commandTimeoutMs,
            maxInFlight: options.maxInFlight ?? configured.maxInFlight,
            // Validated separately from the delta family's
            // `cfg:key_layout_version`: the two layouts version independently
            // because the namespaces are disjoint.
            layout: { key: LAYOUT_KEY, version: SIGN_LAYOUT_VERSION, label: 'sign layout' },
            now: options.now,
            randomInt: options.randomInt,
            writeBatchSize: options.writeBatchSize,
            scanLimit: DEFAULT_SCAN_LIMIT,
        });
        this.imageRecords = new Map();
        // word -> how many images publish it. See `wordDegrees`.
        this.degreeCache = new Map();
        // Images the read path surfaces even though their record is still
        // incomplete. See `readWhileIncomplete`.
        this.incompleteReadable = new Set();
    }

    clearCaches() {
        this.imageRecords.clear();
        this.degreeCache.clear();
    }

    /**
     * Let the read path see one image that has not been completed yet.
     *
     * The completion marker exists because Cheetah has no transaction spanning
     * an image's writes, so a reader must ignore anything half-written. Adaptive
     * training is the one caller for which that rule is wrong about itself: it
     * interrogates the image it is in the middle of writing, to decide whether
     * writing more of it is still buying anything.
     *
     * Scoped to an explicit id rather than an `includeIncomplete` flag, so a
     * concurrent ingest's half-written image stays invisible — the exemption is
     * "this image, which I am writing", not "incomplete images in general". The
     * completion marker itself is untouched: it still flips once, at the end, so
     * an interrupted run leaves nothing that any other reader will rank on.
     */
    readWhileIncomplete(imageId) {
        this.incompleteReadable.add(imageId);
        return () => this.incompleteReadable.delete(imageId);
    }

    /** Is this image's record readable — complete, or exempted above? */
    isReadable(imageId, record) {
        return Boolean(record?.complete) || this.incompleteReadable.has(imageId);
    }

    // -- images -------------------------------------------------------------

    async allocateImageId() {
        return this.allocateRandomId((imageId) => keys.signImageKey(imageId));
    }

    async getImage(imageId) {
        if (this.imageRecords.has(imageId)) return this.imageRecords.get(imageId);
        const record = await this.getJson(keys.signImageKey(imageId));
        if (record) this.imageRecords.set(imageId, record);
        return record;
    }

    async findImageIdByFilename(filename) {
        const stored = await this.getValue(keys.signFilenameKey(filename));
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
            created_at: this.timestamp(),
            complete: false,
            constellations: 0,
            words: 0,
        };
        await this.putJson(keys.signImageKey(resolvedId), record, { upsert: true });
        await this.putValue(
            keys.signFilenameKey(filename),
            keys.formatImageId(resolvedId),
            { upsert: true }
        );
        this.imageRecords.set(resolvedId, record);
        return { imageId: resolvedId, record };
    }

    /**
     * Merge fields into an image record without touching its completion state.
     *
     * Adaptive training uses it to keep `constellations`/`words` truthful at
     * every checkpoint: the probe searches read those counts back, and a record
     * still claiming zero would misreport the corpus it is being measured
     * against.
     */
    async updateImage(imageId, extra = {}, { verb = 'update' } = {}) {
        const key = keys.signImageKey(imageId);
        const current = this.imageRecords.get(imageId) || await this.getJson(key);
        if (!current) throw new CheetahError(`cannot ${verb} missing sign image ${imageId}`);
        const record = { ...current, ...extra };
        await this.putJson(key, record, { upsert: true });
        this.imageRecords.set(imageId, record);
        return record;
    }

    async markComplete(imageId, extra = {}) {
        return this.updateImage(imageId, { ...extra, complete: true }, { verb: 'complete' });
    }

    /**
     * Take a completed image back off the shelf so more signs can be attached.
     *
     * `putSigns` refuses a completed image on purpose — an image that readers
     * already rank on must not grow rows underneath them — so extending one is
     * an explicit act with the same commit protocol as a first ingest: clear the
     * marker, write, `markComplete` again. Between those two points the image is
     * invisible to every *other* reader and visible to this process only, which
     * is the same exemption adaptive training already uses within one ingest.
     *
     * The window is a real cost and the caller owns it: a corpus-wide review that
     * reopened every image at once would empty the corpus it is measuring
     * against. Reopen one image, extend it, complete it, move on.
     *
     * Returns the reopened record plus the `release` for that read exemption;
     * `markComplete` does not call it, because the caller may still want to probe
     * the image after completing it.
     */
    async reopenImage(imageId) {
        const release = this.readWhileIncomplete(imageId);
        try {
            const record = await this.updateImage(imageId, { complete: false }, { verb: 'reopen' });
            return { record, release };
        } catch (error) {
            release();
            throw error;
        }
    }

    /** Every complete image record, keyed by image id. */
    async listImages({ includeIncomplete = false } = {}) {
        const images = new Map();
        for await (const { item, value } of this.scanJson(keys.NAMESPACES.signImage)) {
            const imageId = keys.parseImageId(item.key.slice(keys.NAMESPACES.signImage.length));
            if (!includeIncomplete && !this.isReadable(imageId, value)) continue;
            this.imageRecords.set(imageId, value);
            images.set(imageId, value);
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
            // Only the cell each triple actually fell in.
            //
            // Soft assignment is symmetric — sweeping the stored triple or the
            // measured one bridges the same level edge — so it belongs on
            // whichever side is cheaper, and that was measured, not assumed.
            // Writing all four words of a sweep put ~6 900 postings and ~5 400
            // graph edges behind one image against ~2 400 postings and ~1 700
            // edges for the primary word alone; the sweep is essentially free on
            // the query side, where it only adds seeds to a recall that was
            // already being issued.
            const seen = new Map();
            sign.triples.forEach((triple) => {
                if (!seen.has(triple.words[0])) seen.set(triple.words[0], triple.index);
            });
            for (const [word, tripleIndex] of seen) {
                wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
                writes.push({
                    key: keys.signWordPostingKey(word, imageId, ordinal),
                    payload: { t: tripleIndex },
                });
            }
        });

        // One request per page instead of two per record. Ingestion is the only
        // place in this codebase where the round-trip count, not the payload
        // size, decides how long the work takes.
        await this.putJsonBatched(writes);
        return { wordCounts, written: writes.length, nextOrdinal: startOrdinal + signs.length };
    }

    /**
     * Publish an image's vocabulary into the graph.
     *
     * Edges are word -> image so that a search seeds words and spreads *out* to
     * images in a single hop. The reverse direction would make every recall walk
     * an image node's thousands of edges.
     *
     * `wordCounts` must be the image's **cumulative** counts, not one chunk's:
     * a weight is relative to the image's most frequent word, so republishing a
     * chunk's own counts would rescale every word the chunk touched against the
     * wrong maximum. Both callers already carry the running totals for the
     * separate reason that a weight must never fall; this is the second.
     *
     * `maxCount` is the maximum over the **whole** image, which is why it is a
     * parameter: a top-up publishes only the words it touched and cannot see the
     * others' counts, but it must still divide by the same number they did.
     */
    async commitGraph(imageId, filename, wordCounts, { maxCount = null } = {}) {
        const imageNode = keys.imageNodeId(imageId);
        await this.setNode({
            id: imageNode,
            labels: ['sign_image'],
            props: { filename },
        });

        const peak = maxCount === null
            ? Math.max(1, ...wordCounts.values())
            : Math.max(1, maxCount);
        const items = [...wordCounts.entries()].map(([word, count]) => ({
            from: keys.wordNodeId(word),
            to: imageNode,
            weight: relativeFrequency(count, peak),
        }));

        let applied = 0;
        for (let at = 0; at < items.length; at += EDGE_BATCH_SIZE) {
            const batch = items.slice(at, at + EDGE_BATCH_SIZE);
            const result = await this.setEdgeBatch(batch, {
                type: EDGE_TYPE,
                directed: 1,
            });
            if (result.failed > 0) {
                throw new CheetahError(
                    `cheetah edge batch dropped ${result.failed} of ${result.requested} sign edges ` +
                    `for image ${imageId}; the word index would have holes in it`
                );
            }
            // A degree changes only when an edge is *created*: re-publishing a
            // word this image already had moves its weight, not the number of
            // images that carry it. The batch reports how many it created but
            // not which, so a batch that created any evicts all of its words —
            // conservative, and still exact. This is what keeps the degree
            // table warm through the later chunks of a long ingest, where every
            // edge is an update and nothing needs evicting at all.
            if (result.created > 0) {
                for (const item of batch) this.degreeCache.delete(keys.parseWordNodeId(item.from));
            }
            applied += result.applied;
        }
        return { edges: items.length, applied, maxCount: peak };
    }

    /**
     * The L2 norm of an image's published weight vector.
     *
     * A search sums `query tf x edge weight x idf` over the words it measured,
     * and an image that published more words — because it is busier, or because
     * rehearsal topped it up — collects more of those terms for no reason other
     * than its own size. Dividing by this is the cosine denominator, and it is
     * the difference between 19/100 and 93/100 on the measured corpus; the
     * pivoted word-count norm it replaces was a proxy for it that only worked
     * while the vocabulary was sparse enough for membership to be the signal.
     *
     * Computed here, from the same cumulative counts the edges were published
     * from, so it always describes the vector the graph actually holds.
     */
    static signatureNorm(wordCounts, maxCount = null) {
        const peak = maxCount === null
            ? Math.max(1, ...wordCounts.values())
            : Math.max(1, maxCount);
        let total = 0;
        for (const count of wordCounts.values()) {
            total += relativeFrequency(count, peak) ** 2;
        }
        return Math.sqrt(total) || 1;
    }

    // -- retrieval ----------------------------------------------------------

    /**
     * How many images each word appears in.
     *
     * This is the document frequency, and it is what makes a search selective:
     * a word carried by most of the corpus says nothing about which image is in
     * front of us, and seeding a recall with it only spends budget.
     *
     * **Cached across searches, and it has to be.** A degree is one
     * `GRAPH_DEGREE` per word, and the server answers it by counting that
     * word's adjacency — so the cost of asking is proportional to the corpus,
     * and a search asks for ~250 of them per round. Measured at corpus 100 with
     * an uncached table, `wordDegrees` was **1.86 s of a 3.68 s search**: half
     * the search spent re-deriving numbers that had not changed since the last
     * one. The vocabulary is 4 096 words, so the whole table is 4 096 integers
     * and holding it is not a trade-off.
     *
     * Correctness comes from `commitGraph` being the only thing that can change
     * a degree, and from it evicting exactly the words it published. A word no
     * commit has touched keeps its count for as long as the process runs.
     */
    async wordDegrees(words) {
        const unique = [...new Set(words)];
        const missing = unique.filter((word) => !this.degreeCache.has(word));
        if (missing.length > 0) {
            const degrees = await Promise.all(missing.map((word) =>
                this.degree({ id: keys.wordNodeId(word), direction: 'out', type: EDGE_TYPE })
            ));
            missing.forEach((word, index) => this.degreeCache.set(word, degrees[index].degree));
        }
        return new Map(unique.map((word) => [word, this.degreeCache.get(word)]));
    }

    /**
     * Ask the graph which images these words have in common.
     *
     * `hops: 1` and `decay: 1` because the walk is exactly one edge long — word
     * to image — so there is no distance to discount. The server's own noisy-OR
     * ranking is *not* what is read back: the caller re-weights every `sources`
     * entry by rarity, query frequency and image norm, so what this needs from
     * the graph is the posting lists, complete.
     *
     * "Complete" is why `limit` defaults high and `precision` low. A cut-off
     * here is invisible downstream — the image simply never appears — and with
     * a vocabulary this dense every corpus member is legitimately touched by
     * almost every seed, so a `limit` of 32 silently answered a different
     * question on any corpus larger than that. Pass the corpus size.
     */
    async recallImages(words, { limit = 512, minSources = 1, precision = 0.0005 } = {}) {
        const associations = await this.recall({
            seeds: words.map((word) => keys.wordNodeId(word)),
            hops: 1,
            decay: 1,
            precision,
            direction: 'out',
            type: EDGE_TYPE,
            limit,
            minSources,
            // Exact ids only. A seed here is `w<hex3>`, built by `wordNodeId`
            // from an integer — there is no free text to resolve, no synonym to
            // follow, and (ROADMAP §3.3) no lexical term index to resolve
            // against, because hex ids sharing a token cross-match at score
            // 0.33 and the index is switched off for that reason.
            //
            // `GRAPH_RECALL` expands lexically and through synonyms by default,
            // which is right for a caller typing a word and wrong for every
            // seed this pipeline sends: it tokenises the id, reads document
            // frequencies, scans candidates, and falls through to trigram fuzzy
            // matching when that finds nothing — which, with the index off, is
            // always. Measured against a 12-image corpus, per recall of 32
            // seeds: 20.1 ms with the default expansion, 2.7 ms with this.
            expand: 'none',
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
            if (!this.isReadable(imageId, image)) continue;
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
                // The cosine denominator, written by whichever path last
                // published this image's edges. A record without one predates
                // the norm and falls back to 1 in `Evidence.lengthNorm`.
                norm: Number(image.signature_norm) || 1,
                score: association.score,
                sourceCount: association.sourceCount,
                seeds,
            });
        }
        return results;
    }

    /**
     * The signs of one image that carry one word, hydrated.
     *
     * The posting payload carries **which triple** of that sign produced the
     * word, and it has to come back with the record: it is what lets a caller
     * put the two constellations in a common frame before comparing their colour
     * fields. Hydrating the payload during the scan (rather than reading each
     * posting back) is why the sweep uses the `continuations` reducer.
     */
    async signsForWord(word, imageId, { limit = 8 } = {}) {
        const found = [];
        for await (const item of this.scan(keys.signWordImagePrefix(word, imageId), {
            limit: Math.min(DEFAULT_SCAN_LIMIT, Math.max(1, limit)),
            maxItems: limit,
            reducer: 'continuations',
        })) {
            const posting = hydrateJson(item);
            found.push({
                ordinal: keys.parseSignWordPostingKey(item.key).ordinal,
                tripleIndex: Number.isInteger(posting?.t) ? posting.t : null,
            });
        }
        const records = await Promise.all(found.map((entry) =>
            this.getSign(imageId, entry.ordinal)
        ));
        return found
            .map((entry, index) => ({ ...entry, record: records[index] }))
            .filter((entry) => entry.record !== null);
    }

    /** One constellation record by address. */
    async getSign(imageId, ordinal) {
        return this.getJson(keys.signConstellationKey(imageId, ordinal));
    }

    /**
     * Every stored constellation of one image, in ordinal order.
     *
     * This exists for the one caller that has to know what an image already
     * *contains* rather than what it matched: extending an image trained in an
     * earlier session, whose per-word observation counts nobody is holding in
     * memory any more. An edge weight is a function of the whole image's count,
     * so republishing a chunk's own count would lower the weight of every word
     * the chunk re-observed — the counts have to be rebuilt from the corpus, and
     * the signs are the only place they survive.
     *
     * It hydrates through the scan reducer, so a whole image is one page-walk
     * rather than a `READ` per constellation, and it yields rather than
     * collecting: an image is thousands of records and the caller only ever
     * folds them.
     */
    async *listSigns(imageId) {
        for await (const { item, value } of this.scanJson(keys.signConstellationPrefix(imageId))) {
            if (!value) continue;
            yield { ordinal: keys.parseSignConstellationKey(item.key).ordinal, record: value };
        }
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
    createSignStore,
    relativeFrequency,
};
