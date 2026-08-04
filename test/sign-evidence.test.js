// The search's belief accumulator.
//
// This is where a graph answer becomes a ranking, and every part of it is a
// correction the graph cannot apply itself. Two of them were got wrong first
// time and cost real accuracy, so they are pinned here:
//
//   1. **Length normalisation over-corrects.** Dividing by `sqrt(vocabulary)`
//      handed a 6.5x advantage to four flat images on `sample_images/` and they
//      won other images' searches. The pivoted form has to be able to express
//      "no correction" (slope 0, the measured default) as well as "fully
//      proportional".
//   2. **Rarity has to beat quantity.** A single rare seed must be able to
//      outweigh several common ones, or the ranking is decided by whichever
//      words happen to be everywhere.
//   3. **Both term frequencies have to be there.** The vocabulary is 4096 cells
//      and a query re-enters them many times, so "did this image ever produce
//      this word" is true of nearly every pair and decides nothing. What
//      separates images is how often each side produced it, divided by the
//      image's own norm. Measured on 100 images at 1024 constellations:
//      membership 10/100, both frequencies unnormalised 19/100, both
//      frequencies over the signature norm 94/100.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    Evidence,
    inverseDocumentFrequency,
    reviewProbeSeed,
    selectSeeds,
    selectReviewEntries,
} = require('../src/signPipeline');
const { SignStore, relativeFrequency } = require('../src/lib/cheetah/signStore');

function hit(imageId, filename, words, seeds) {
    return {
        imageId,
        filename,
        words,
        score: seeds.reduce((sum, seed) => sum + seed.activation, 0),
        sourceCount: seeds.length,
        seeds,
    };
}

test('idf falls as a word spreads across the corpus', () => {
    const rare = inverseDocumentFrequency(1, 20);
    const common = inverseDocumentFrequency(20, 20);
    assert.ok(rare > common, 'a word in one image must outweigh a word in all of them');
    assert.ok(common > 0, 'even a universal word carries a little');
    // Monotone, and never a division by zero when a degree is missing.
    let previous = Infinity;
    for (let df = 1; df <= 20; df += 1) {
        const value = inverseDocumentFrequency(df, 20);
        assert.ok(value < previous);
        previous = value;
    }
    assert.ok(Number.isFinite(inverseDocumentFrequency(0, 20)));
});

test('a rare seed outweighs several common ones', () => {
    const degrees = new Map([[1, 1], [2, 20], [3, 20], [4, 20]]);
    const evidence = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0 });
    evidence.fold([
        hit(10, 'rare.jpg', 1000, [{ word: 1, activation: 1 }]),
        hit(11, 'common.jpg', 1000, [
            { word: 2, activation: 1 },
            { word: 3, activation: 1 },
            { word: 4, activation: 1 },
        ]),
    ], degrees);

    const ranked = evidence.ranked();
    assert.equal(ranked[0].filename, 'rare.jpg');
    assert.ok(ranked[0].confidence > ranked[1].confidence);
    assert.ok(Math.abs(ranked.reduce((sum, e) => sum + e.confidence, 0) - 1) < 1e-12);
});

test('the length slope spans no correction to fully proportional', () => {
    const degrees = new Map([[1, 1], [2, 1]]);
    // Same evidence, wildly different vocabulary sizes: 275 words against 1600
    // is the real spread measured on sample_images/.
    const build = (lengthSlope) => {
        const evidence = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope });
        evidence.fold([
            hit(1, 'flat.jpg', 275, [{ word: 1, activation: 1 }]),
            hit(2, 'busy.jpg', 1600, [{ word: 2, activation: 1 }]),
        ], degrees);
        return evidence;
    };

    // Slope 0: equal evidence ranks equally, whatever the vocabulary sizes.
    const none = build(0).ranked();
    assert.ok(Math.abs(none[0].mass - none[1].mass) < 1e-12);
    assert.equal(build(0).lengthNorm(275), 1);
    assert.equal(build(0).lengthNorm(1600), 1);

    // Slope 1: the correction is proportional, so the small vocabulary wins —
    // which is exactly the over-correction that lost accuracy in practice.
    const full = build(1).ranked();
    assert.equal(full[0].filename, 'flat.jpg');
    assert.ok(full[0].mass / full[1].mass > 5);
    assert.ok(Math.abs(build(1).lengthNorm(1000) - 1) < 1e-12);

    // And in between, monotonically.
    const ratios = [0, 0.25, 0.5, 0.75, 1].map((slope) => {
        const ranked = build(slope).ranked();
        const flat = ranked.find((entry) => entry.filename === 'flat.jpg');
        const busy = ranked.find((entry) => entry.filename === 'busy.jpg');
        return flat.mass / busy.mass;
    });
    for (let index = 1; index < ratios.length; index += 1) {
        assert.ok(ratios[index] > ratios[index - 1], `slope step ${index} was not monotone`);
    }
});

test('an out-of-range slope is clamped rather than trusted', () => {
    assert.equal(new Evidence({ corpusSize: 2, lengthSlope: -5 }).lengthSlope, 0);
    assert.equal(new Evidence({ corpusSize: 2, lengthSlope: 9 }).lengthSlope, 1);
    // A zero or missing average would otherwise divide by zero.
    assert.ok(Number.isFinite(new Evidence({ corpusSize: 2, averageWords: 0 }).lengthNorm(100)));
});

test('evidence accumulates across rounds instead of saturating', () => {
    const degrees = new Map([[1, 2]]);
    const evidence = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0 });
    const one = hit(1, 'a.jpg', 1000, [{ word: 1, activation: 0.9 }]);

    evidence.fold([one], degrees);
    const first = evidence.ranked()[0].mass;
    evidence.fold([one], degrees);
    const second = evidence.ranked()[0].mass;

    // A noisy-OR would have saturated towards 1 here; summing keeps growing,
    // which is what lets two images that both "converged" still be separated.
    assert.ok(Math.abs(second - 2 * first) < 1e-12, `${second} is not twice ${first}`);
    assert.equal(evidence.ranked()[0].sources, 2);
});

test('seed selection drops the unknown and the ubiquitous, rarest first', () => {
    const degrees = new Map([[1, 0], [2, 1], [3, 2], [4, 3], [5, 18]]);
    const seeds = selectSeeds([1, 2, 3, 4, 5], degrees, {
        corpusSize: 20,
        stopWordImageRatio: 0.6,
        limit: 10,
    });
    assert.ok(!seeds.includes(1), 'a word no image published has nothing to activate');
    assert.deepEqual(seeds, [2, 3, 4], 'and the rest come rarest first');

    // The ceiling has a floor of two images, or a small corpus would filter away
    // every word it has.
    const tiny = selectSeeds([2, 3], new Map([[2, 1], [3, 2]]), {
        corpusSize: 2,
        stopWordImageRatio: 0.6,
        limit: 10,
    });
    assert.deepEqual(tiny, [2, 3]);

    // The limit keeps the rarest, not an arbitrary prefix.
    assert.deepEqual(
        selectSeeds([5, 4, 3, 2], degrees, { corpusSize: 20, stopWordImageRatio: 0.6, limit: 2 }),
        [2, 3]
    );
});

test('bounded rehearsal is fair and changes its random draw every generation', () => {
    const tracked = new Map([
        [1, { imageId: 1, filename: 'first.jpg', reviewedAt: 0 }],
        [2, { imageId: 2, filename: 'second.jpg', reviewedAt: 0 }],
        [3, { imageId: 3, filename: 'third.jpg', reviewedAt: 0 }],
        [4, { imageId: 4, filename: 'fourth.jpg', reviewedAt: 0 }],
    ]);

    const seen = [];
    for (let pass = 0; pass < 4; pass += 1) {
        const selected = selectReviewEntries(tracked, 2);
        seen.push(...selected.map((entry) => entry.imageId));
        for (const entry of selected) entry.reviewedAt += 1;
    }

    assert.deepEqual(seen.slice(0, 4).sort(), [1, 2, 3, 4], 'the first cycle must cover every image');
    assert.deepEqual(
        [...tracked.values()].map((entry) => entry.reviewedAt),
        [2, 2, 2, 2],
        'no image may receive a third review before every image receives its second'
    );
    assert.notEqual(reviewProbeSeed('first.jpg', 0), reviewProbeSeed('first.jpg', 1));
    assert.equal(reviewProbeSeed('first.jpg', 1), 'review:first.jpg:1');
});

// A constellation is a *chain*, and until `chainBonus` it was folded as a bag:
// five triples of one sign agreeing on an image counted exactly as much as five
// triples of five unrelated signs. That is why a longer chain behaved like a
// higher sampling rate instead of like a richer feature — the extra triples were
// indistinguishable from extra constellations. Both halves are pinned here: that
// the knob is arithmetically inert when off, and that when on it rewards
// agreement *within* a sign and not coincidence across signs.
test('chain agreement is worth more than the same triples scattered', () => {
    const degrees = new Map([[1, 1], [2, 1], [3, 1]]);
    // One image matched by three triples of one constellation; the other by one
    // triple each of three different constellations. Identical seeds, identical
    // activations — only the origin differs.
    // Non-adjacent, so all three are independent evidence: consecutive triples
    // share a hop and would be the same measurement counted twice.
    const origins = new Map([
        [1, [{ sign: 0, triple: 0 }]],
        [2, [{ sign: 0, triple: 2 }]],
        [3, [{ sign: 0, triple: 4 }]],
    ]);
    const scattered = new Map([
        [1, [{ sign: 0, triple: 0 }]],
        [2, [{ sign: 1, triple: 0 }]],
        [3, [{ sign: 2, triple: 0 }]],
    ]);
    const seeds = [
        { word: 1, activation: 1 },
        { word: 2, activation: 1 },
        { word: 3, activation: 1 },
    ];

    const chained = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0, chainBonus: 1 });
    chained.fold([hit(10, 'chain.jpg', 1000, seeds)], degrees, origins);
    const loose = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0, chainBonus: 1 });
    loose.fold([hit(11, 'loose.jpg', 1000, seeds)], degrees, scattered);

    const chainedMass = chained.ranked()[0].mass;
    const looseMass = loose.ranked()[0].mass;
    // Three independent triples of one chain: 1 + bonus * (3 - 1) = 3x.
    assert.ok(Math.abs(chainedMass - 3 * looseMass) < 1e-12, `${chainedMass} vs ${looseMass}`);

    // Adjacent triples share a hop, so 0,1,2 is worth two independent
    // agreements, not three. Crediting all three is what took rank-1 from 90%
    // to 75% with the search budget held fixed: on a near-duplicate corpus the
    // image matching one triple is the image matching its neighbours, so the
    // redundant credit lands on exactly the wrong candidate.
    const adjacent = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0, chainBonus: 1 });
    adjacent.fold([hit(16, 'adjacent.jpg', 1000, seeds)], degrees, new Map([
        [1, [{ sign: 0, triple: 0 }]],
        [2, [{ sign: 0, triple: 1 }]],
        [3, [{ sign: 0, triple: 2 }]],
    ]));
    assert.ok(
        Math.abs(adjacent.ranked()[0].mass - 2 * looseMass) < 1e-12,
        `adjacent triples must count once per shared hop: ${adjacent.ranked()[0].mass} vs ${looseMass}`
    );
    assert.ok(chained.ranked()[0].chained > 0, 'the chained share is reported');
    assert.equal(loose.ranked()[0].chained, 0, 'coincidence across signs earns no bonus');

    // Off is exactly off: same seeds, same origins, the old arithmetic.
    const off = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0, chainBonus: 0 });
    off.fold([hit(12, 'off.jpg', 1000, seeds)], degrees, origins);
    const bare = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0, chainBonus: 0 });
    bare.fold([hit(13, 'bare.jpg', 1000, seeds)], degrees);
    assert.equal(off.ranked()[0].mass, bare.ranked()[0].mass);

    // A word two signs both asked for splits its activation rather than paying
    // twice, so turning the knob on cannot inflate total mass by double counting.
    const shared = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0, chainBonus: 0 });
    shared.fold([hit(14, 'shared.jpg', 1000, [{ word: 1, activation: 1 }])], degrees, new Map([
        [1, [{ sign: 0, triple: 0 }, { sign: 1, triple: 0 }]],
    ]));
    const single = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0, chainBonus: 0 });
    single.fold([hit(15, 'single.jpg', 1000, [{ word: 1, activation: 1 }])], degrees);
    assert.ok(Math.abs(shared.ranked()[0].mass - single.ranked()[0].mass) < 1e-12);
});

// The query is a distribution, not a set. Two images that both published a word
// are separated by how often each of them did and by how often the query asked
// — and an image that published more of everything must not win for that alone.
test('both term frequencies count, and the image norm divides them out', () => {
    const degrees = new Map([[1, 2], [2, 2]]);
    const build = (queryCounts, norms) => {
        const evidence = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0 });
        evidence.fold([
            { imageId: 1, filename: 'often.jpg', words: 1000, norm: norms[0], sourceCount: 1, seeds: [{ word: 1, activation: 0.8 }] },
            { imageId: 2, filename: 'rarely.jpg', words: 1000, norm: norms[1], sourceCount: 1, seeds: [{ word: 2, activation: 0.1 }] },
        ], degrees, null, queryCounts);
        return evidence.ranked();
    };

    // Equal query frequency: the image that produced its word more often wins,
    // because that is the whole of what the edge weight carries.
    const equal = build(new Map([[1, 4], [2, 4]]), [1, 1]);
    assert.equal(equal[0].filename, 'often.jpg');
    assert.ok(Math.abs(equal[0].mass / equal[1].mass - 8) < 1e-9);

    // The query's own frequency is the other half of the product: asking for
    // the weak word forty times against the strong word once flips the answer.
    const skewed = build(new Map([[1, 1], [2, 40]]), [1, 1]);
    assert.equal(skewed[0].filename, 'rarely.jpg');

    // And the norm is a real divisor, not a tie-break: an image with eight
    // times the norm needs eight times the evidence to stay level.
    const normed = build(new Map([[1, 4], [2, 4]]), [8, 1]);
    assert.ok(Math.abs(normed[0].mass - normed[1].mass) < 1e-9);

    // A record written before the norm existed must not evaluate to zero mass.
    const legacy = build(new Map([[1, 1], [2, 1]]), [undefined, null]);
    assert.ok(legacy.every((entry) => Number.isFinite(entry.mass) && entry.mass > 0));
});

// A word the query never asked for cannot weigh in even if the graph returns
// it: the recall is seeded per round, and a stale seed would be counted with a
// frequency it does not have.
test('a seed the round did not ask for contributes nothing', () => {
    const evidence = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0 });
    evidence.fold([
        { imageId: 1, filename: 'a.jpg', words: 1000, norm: 1, sourceCount: 2, seeds: [
            { word: 1, activation: 1 },
            { word: 99, activation: 1 },
        ] },
    ], new Map([[1, 1], [99, 1]]), null, new Map([[1, 1]]));
    const only = new Evidence({ corpusSize: 20, averageWords: 1000, lengthSlope: 0 });
    only.fold([
        { imageId: 1, filename: 'a.jpg', words: 1000, norm: 1, sourceCount: 2, seeds: [{ word: 1, activation: 1 }] },
    ], new Map([[1, 1]]), null, new Map([[1, 1]]));
    assert.equal(evidence.ranked()[0].mass, only.ranked()[0].mass);
});

// Ordering by rarity alone was right while a word was a near-unique token. On a
// vocabulary a query re-enters, a common word asked for nine times carries more
// than a rare one asked for once, and the seed budget has to spend on it.
test('seeds are ordered by what they would contribute, not by rarity alone', () => {
    const degrees = new Map([[1, 1], [2, 15]]);
    const byRarity = selectSeeds([1, 2], degrees, {
        corpusSize: 20, stopWordImageRatio: 1, limit: 1,
    });
    assert.deepEqual(byRarity, [1], 'with nothing to weigh them, the rarest still wins');

    const byValue = selectSeeds([1, 2], degrees, {
        corpusSize: 20, stopWordImageRatio: 1, limit: 1, queryCounts: new Map([[1, 1], [2, 9]]),
    });
    assert.deepEqual(byValue, [2], 'nine observations of a common word beat one of a rare word');
});

// The edge weight is the only channel a term frequency has: Cheetah clamps a
// weight into [0,1] before using it as activation.
test('relative frequency stays inside the activation range and keeps its order', () => {
    assert.equal(relativeFrequency(7, 7), 1);
    assert.ok(relativeFrequency(1, 100) > 0);
    assert.ok(relativeFrequency(4, 10) > relativeFrequency(3, 10));
    // A count above the declared maximum cannot exceed 1 in practice because the
    // maximum is taken over the same map; a zero maximum must not divide by zero.
    assert.ok(Number.isFinite(relativeFrequency(3, 0)));

    // The norm is the L2 length of exactly those weights.
    const counts = new Map([[1, 10], [2, 5], [3, 1]]);
    const expected = Math.sqrt(1 + 0.5 ** 2 + 0.1 ** 2);
    assert.ok(Math.abs(SignStore.signatureNorm(counts) - expected) < 1e-12);

    // A top-up publishes only the words it touched but must divide by the whole
    // image's maximum, so the maximum is a parameter rather than a re-derivation.
    assert.ok(Math.abs(SignStore.signatureNorm(new Map([[1, 5]]), 10) - 0.5) < 1e-12);
    assert.equal(SignStore.signatureNorm(new Map()), 1, 'an empty signature must not be zero');
});

// The degree table is the search's other half and it is worth caching: a degree
// is one `GRAPH_DEGREE` per word, answered by counting that word's adjacency, so
// asking costs more as the corpus grows and a search asks for hundreds per
// round. Measured at corpus 100, an uncached table was 1.86 s of a 3.68 s
// search. What makes caching safe is that exactly one thing changes a degree.
test('the degree cache is refilled once and evicted only by a new edge', async () => {
    const asked = [];
    const store = Object.create(SignStore.prototype);
    store.degreeCache = new Map();
    store.imageRecords = new Map();
    store.degree = async ({ id }) => { asked.push(id); return { degree: 7 }; };

    assert.deepEqual([...(await store.wordDegrees([1, 2, 1]))], [[1, 7], [2, 7]]);
    assert.equal(asked.length, 2, 'a repeated word in one call is asked once');
    await store.wordDegrees([1, 2]);
    assert.equal(asked.length, 2, 'and never again while nothing has changed');

    // A batch that only updated existing edges cannot have moved a degree.
    store.setEdgeBatch = async (batch) => ({
        requested: batch.length, applied: batch.length, created: 0, updated: batch.length, failed: 0,
    });
    store.setNode = async () => {};
    await store.commitGraph(1, 'a.jpg', new Map([[1, 3], [2, 1]]));
    await store.wordDegrees([1, 2]);
    assert.equal(asked.length, 2, 'an update-only commit must not invalidate anything');

    // A created edge does move it, and the words of that batch are refetched.
    store.setEdgeBatch = async (batch) => ({
        requested: batch.length, applied: batch.length, created: 1, updated: 0, failed: 0,
    });
    await store.commitGraph(1, 'a.jpg', new Map([[1, 3], [2, 1]]));
    await store.wordDegrees([1, 2]);
    assert.equal(asked.length, 4, 'a created edge must invalidate its batch');

    store.clearCaches();
    await store.wordDegrees([1]);
    assert.equal(asked.length, 5);
});
