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

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    Evidence,
    inverseDocumentFrequency,
    reviewProbeSeed,
    selectSeeds,
    selectReviewEntries,
} = require('../src/signPipeline');

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
