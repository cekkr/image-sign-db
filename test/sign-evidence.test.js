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
    selectSeeds,
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
