// Deterministic RNG for constellation sampling.
//
// Deliberately *not* src/lib/augmentations.js `createSeededRandom`: that one
// backs a determinism contract (the same sample_id must produce the same
// descriptor forever) and lives in a module that pulls in sharp. Constellations
// are the opposite — they are meant to be freshly random on every run — so the
// default here is Math.random and a seed is a testing affordance, and the pure
// layer of src/lib/sign/ stays importable without an image library.

const crypto = require('crypto');

/** mulberry32: 32-bit state, uniform in [0,1), identical across Node versions. */
function mulberry32(seed) {
    let state = seed >>> 0;
    return function next() {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** First 4 bytes of SHA-1(text) as a uint32 seed. */
function hashToSeed(text) {
    return crypto.createHash('sha1').update(String(text)).digest().readUInt32BE(0);
}

/**
 * `createRandom()` → Math.random. `createRandom(seed)` → a reproducible stream,
 * seeded from a number directly or from any string through SHA-1.
 */
function createRandom(seed) {
    if (seed === undefined || seed === null) return Math.random;
    return mulberry32(typeof seed === 'number' ? seed >>> 0 : hashToSeed(seed));
}

module.exports = { createRandom, hashToSeed, mulberry32 };
