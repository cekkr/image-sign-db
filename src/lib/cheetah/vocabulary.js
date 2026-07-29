// Descriptor → token id vocabulary — ROADMAP Phase 1.2.
//
// The n-gram store (§3.4) and every feature key (§3.1) address a descriptor by
// a uint32 token, not by its 40-character sha1: a 4-byte segment keeps feature
// keys short and n-gram contexts fixed-width. This module owns the allocation
// of those ids and both directions of the mapping (`t:` and `r:`).
//
// **Concurrency.** Cheetah has no compare-and-swap, so the counter at
// `cfg:next_token` is guarded by a single-flight promise chain in Node. That
// makes allocation safe within one process — including across the ingest worker
// pool only if the pool shares this instance. Two *processes* ingesting into
// the same database concurrently would race and can hand the same id to two
// descriptors; today's pipeline runs one parent process, and the workers reach
// storage through it. If that ever changes, allocation must move server-side.

const { configKey, reverseTokenKey, tokenKey } = require('./keys');
const { getValue, putValue } = require('./kv');
const { CheetahError } = require('./client');

const COUNTER_KEY = configKey('next_token');
/** 0 is reserved as "no token", so ids start at 1. */
const FIRST_TOKEN = 1;
const MAX_TOKEN = 0xffffffff;

class TokenVocabulary {
    /**
     * @param {object} conn a CheetahClient or CheetahPool
     * @param {object} [options]
     * @param {number} [options.cacheLimit] in-memory descriptor→token entries
     */
    constructor(conn, { cacheLimit = 200000 } = {}) {
        this.conn = conn;
        this.cacheLimit = cacheLimit;
        this.forward = new Map();
        this.reverse = new Map();
        // Serializes every read-modify-write of the counter.
        this.allocationChain = Promise.resolve();
        this.pendingLookups = new Map();
    }

    #remember(descriptorHash, token) {
        if (this.forward.size >= this.cacheLimit) {
            // Cheapest bounded policy that cannot thrash: drop the oldest insert.
            const oldest = this.forward.keys().next().value;
            const staleToken = this.forward.get(oldest);
            this.forward.delete(oldest);
            this.reverse.delete(staleToken);
        }
        this.forward.set(descriptorHash, token);
        this.reverse.set(token, descriptorHash);
        return token;
    }

    async #readCounter() {
        const raw = await getValue(this.conn, COUNTER_KEY);
        if (raw === null) return FIRST_TOKEN;
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value) || value < FIRST_TOKEN) {
            throw new CheetahError(`cheetah ${COUNTER_KEY} holds a non-token value: ${raw}`);
        }
        return value;
    }

    /**
     * Reserve `count` consecutive ids. Serialized against every other caller on
     * this instance; the counter is advanced *before* any mapping is written,
     * so a crash mid-allocation loses ids rather than reusing them.
     */
    async allocate(count = 1) {
        const amount = Math.max(1, Math.trunc(count));
        const run = this.allocationChain.then(async () => {
            const next = await this.#readCounter();
            if (next + amount - 1 > MAX_TOKEN) {
                throw new CheetahError('cheetah token vocabulary exhausted (uint32)');
            }
            await putValue(this.conn, COUNTER_KEY, String(next + amount), { upsert: true });
            return next;
        });
        // Keep the chain alive even when this allocation rejects.
        this.allocationChain = run.then(() => undefined, () => undefined);
        return run;
    }

    /** The token for a descriptor hash, allocating and persisting on first sight. */
    async tokenFor(descriptorHash) {
        const cached = this.forward.get(descriptorHash);
        if (cached !== undefined) return cached;

        const inFlight = this.pendingLookups.get(descriptorHash);
        if (inFlight) return inFlight;

        const lookup = (async () => {
            const stored = await getValue(this.conn, tokenKey(descriptorHash));
            if (stored !== null) {
                const token = Number.parseInt(stored, 10);
                if (!Number.isFinite(token)) {
                    throw new CheetahError(`cheetah token for ${descriptorHash} is not numeric: ${stored}`);
                }
                return this.#remember(descriptorHash, token);
            }
            const token = await this.allocate(1);
            // Reverse first: an `r:` without a `t:` is a readable orphan, while a
            // `t:` without an `r:` breaks every key→descriptor explanation.
            await putValue(this.conn, reverseTokenKey(token), descriptorHash, { upsert: true });
            await putValue(this.conn, tokenKey(descriptorHash), String(token), { upsert: true });
            return this.#remember(descriptorHash, token);
        })().finally(() => {
            this.pendingLookups.delete(descriptorHash);
        });

        this.pendingLookups.set(descriptorHash, lookup);
        return lookup;
    }

    /** The descriptor hash behind a token, or null when unknown. */
    async descriptorFor(token) {
        const cached = this.reverse.get(token);
        if (cached !== undefined) return cached;
        const stored = await getValue(this.conn, reverseTokenKey(token));
        if (stored === null) return null;
        this.#remember(stored, token);
        return stored;
    }

    /** Resolve many descriptors, preserving input order. */
    async tokensFor(descriptorHashes) {
        const out = [];
        for (const hash of descriptorHashes) {
            out.push(await this.tokenFor(hash));
        }
        return out;
    }
}

module.exports = {
    COUNTER_KEY,
    FIRST_TOKEN,
    MAX_TOKEN,
    TokenVocabulary,
};
