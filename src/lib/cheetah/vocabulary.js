// Descriptor → token id vocabulary — ROADMAP Phase 1.2.
//
// The n-gram store (§3.4) and every feature key (§3.1) address a descriptor by
// a uint32 token, not by its 40-character sha1: a 4-byte segment keeps feature
// keys short and n-gram contexts fixed-width.
//
// The allocator itself is generic and now lives in the submodule's Node binder
// (cheetah/binders/nodejs/lib/vocabulary.js) — interning free-form names into
// small integers is something every Cheetah client needs, and the concurrency
// rule it has to obey is the server's, not ours. This subclass supplies the two
// things that *are* ours: the `t:`/`r:` key layout and the `cfg:next_token`
// counter, both owned by keys.js.
//
// **Concurrency.** Cheetah has no compare-and-swap, so the counter is guarded
// by a single-flight promise chain in Node. That makes allocation safe within
// one process. Two processes (including two worker threads, whose CommonJS
// module state is isolated) ingesting into the same database concurrently would
// race and can hand the same id to two descriptors. `train.js` therefore forces
// one worker for the Cheetah backend. If that restriction changes, allocation
// must move server-side.

const { configKey, reverseTokenKey, tokenKey } = require('./keys');
const { TokenVocabulary: BaseTokenVocabulary, FIRST_TOKEN, MAX_TOKEN } = require('./binder').vocabulary;

const COUNTER_KEY = configKey('next_token');

class TokenVocabulary extends BaseTokenVocabulary {
    /**
     * @param {object} conn a CheetahClient or CheetahPool
     * @param {object} [options] `cacheLimit`, and anything the base accepts
     */
    constructor(conn, options = {}) {
        super(conn, {
            counterKey: COUNTER_KEY,
            tokenKey,
            reverseTokenKey,
            ...options,
        });
    }

    /** The descriptor hash behind a token, or null when unknown. */
    async descriptorFor(token) {
        return this.nameFor(token);
    }
}

module.exports = {
    COUNTER_KEY,
    FIRST_TOKEN,
    MAX_TOKEN,
    TokenVocabulary,
};
