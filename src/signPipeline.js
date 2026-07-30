// Training and search for the sign pipeline.
//
// Training is dense and one-shot: draw many constellations, write them, publish
// their vocabulary into the graph, mark the image complete.
//
// Search is the opposite shape, and deliberately so — the specification asks for
// "as much as needed for a good confidence". It draws a small batch of
// constellations, asks the graph what those words have in common, folds the
// answer into a running belief, and stops as soon as one image is both dominant
// and well separated. On an easy image that is two or three batches; on a hard
// one it keeps measuring until the ceiling.
//
// Why evidence is accumulated in Node rather than by handing every seed to one
// recall: GRAPH_RECALL scores with a noisy-OR, which saturates towards 1 once
// enough seeds agree. That is the right rule *inside* a batch, where the
// question is "did these converge", and the wrong one *across* batches, where
// the question is "how much evidence has piled up". Summing per-batch scores
// keeps growing, so it still separates two images that both saturated.

const path = require('path');
const settings = require('./settings');
const { createRandom } = require('./lib/sign/rng');
const { loadImagePixels, sampleSigns } = require('./lib/sign/sampler');
const { allWords, tripleFeatureDistance, tripleFeatures } = require('./lib/sign/words');
const {
    compareConstellations,
    constellationDescriptor,
    descriptorDistance,
    parseConstellationRecord,
} = require('./lib/sign/signature');

function samplerOptions(overrides = {}) {
    const configured = settings.sign;
    return {
        pointCount: overrides.pointCount ?? configured.pointCount,
        patchRelative: overrides.patchRelative ?? configured.pointPatchRelative,
        withCentrePosition: overrides.withCentrePosition ?? configured.withCentrePosition,
        workingMaxSide: overrides.workingMaxSide ?? configured.workingMaxSide,
    };
}

/**
 * Ingest one image: sample, persist, publish, commit.
 *
 * The image record is written incomplete first and marked complete last, so a
 * run interrupted halfway leaves rows that every reader ignores rather than an
 * image with a partial vocabulary that recall would rank on.
 */
async function trainImage(store, imagePath, {
    count = settings.sign.constellationsPerImage,
    seed = null,
    onProgress = null,
    ...overrides
} = {}) {
    const options = samplerOptions(overrides);
    const filename = path.basename(imagePath);
    const { rawPixels, meta, source } = await loadImagePixels(imagePath, options);

    const signs = sampleSigns({
        rawPixels,
        meta,
        count,
        random: createRandom(seed),
        ...options,
    });
    if (signs.length === 0) {
        throw new Error(`no constellation could be placed on ${filename} (${meta.width}x${meta.height})`);
    }
    onProgress?.({ stage: 'sampled', filename, signs: signs.length });

    const { imageId } = await store.putImage({
        filename,
        width: source.width,
        height: source.height,
    });
    const { wordCounts, written } = await store.putSigns(imageId, signs);
    onProgress?.({ stage: 'stored', filename, records: written, words: wordCounts.size });

    const { edges } = await store.commitGraph(imageId, filename, wordCounts);
    const record = await store.markComplete(imageId, {
        constellations: signs.length,
        words: wordCounts.size,
        working_width: meta.width,
        working_height: meta.height,
    });
    onProgress?.({ stage: 'complete', filename, imageId, edges });

    return { imageId, filename, signs: signs.length, words: wordCounts.size, edges, record };
}

/**
 * Inverse document frequency of a word: how surprising it is that an image
 * produced it. A word every image produces separates nothing and must not
 * count as much as one only two images ever produced.
 */
function inverseDocumentFrequency(documentFrequency, corpusSize) {
    return Math.log(1 + corpusSize / Math.max(1, documentFrequency));
}

/**
 * Running per-image evidence, folded one recall batch at a time.
 *
 * Two corrections are applied to what the graph reports, and neither is
 * something the graph could apply itself:
 *
 *   - **Rarity.** A converging seed is worth its idf, not one vote. Without it
 *     a search is decided by whichever words happen to be common.
 *   - **Length.** An image that published many distinct words is more likely to
 *     be hit by *any* query word, so its raw mass is divided by a length norm.
 *
 * The length norm is **pivoted**, not `sqrt(vocabulary)`, and that is a fix for
 * a measured failure rather than a preference. Vocabulary size across a real
 * corpus is not smooth: on `sample_images/` four flat images publish 261-280
 * words while the rest publish 788-1696, a 6.5x spread. Dividing by `sqrt` hands
 * the small end a ~2.5x advantage, and those four images were involved in six of
 * eight rank-1 failures — three of them won searches belonging to other images
 * outright. Pivoted normalisation interpolates between "no correction" and
 * "fully proportional" with a slope, which is the standard remedy for exactly
 * this over-correction.
 */
class Evidence {
    constructor({ corpusSize, averageWords = 1, lengthSlope = settings.sign.search.lengthSlope }) {
        this.corpusSize = corpusSize;
        this.averageWords = averageWords > 0 ? averageWords : 1;
        this.lengthSlope = Math.min(1, Math.max(0, lengthSlope));
        this.byImage = new Map();
        this.rounds = 0;
        this.constellations = 0;
        this.seeds = 0;
    }

    /** `(1 - s) + s * |d| / avg|d|`: s = 0 ignores length, s = 1 is proportional. */
    lengthNorm(words) {
        const relative = (Number(words) || 0) / this.averageWords;
        return Math.max(1e-6, (1 - this.lengthSlope) + this.lengthSlope * relative);
    }

    fold(results, degrees) {
        for (const result of results) {
            const current = this.byImage.get(result.imageId) || {
                imageId: result.imageId,
                filename: result.filename,
                words: result.words,
                rawMass: 0,
                sources: 0,
            };
            for (const seed of result.seeds) {
                current.rawMass += seed.activation * inverseDocumentFrequency(
                    degrees.get(seed.word) || 1,
                    this.corpusSize
                );
            }
            current.sources += result.sourceCount;
            this.byImage.set(result.imageId, current);
        }
    }

    /** Images ranked by normalised mass, each with its share of the total. */
    ranked() {
        const entries = [...this.byImage.values()]
            .map((entry) => ({
                ...entry,
                mass: entry.rawMass / this.lengthNorm(entry.words),
            }))
            .sort((left, right) => right.mass - left.mass);
        const total = entries.reduce((sum, entry) => sum + entry.mass, 0);
        return entries.map((entry) => ({
            ...entry,
            confidence: total > 0 ? entry.mass / total : 0,
        }));
    }
}

/**
 * Select the seeds worth spending a recall on.
 *
 * A word no image has ever produced has nothing to activate, and a word nearly
 * every image produces activates the whole corpus equally — both only spend
 * budget. What is left is ordered by rarity, so that when the round's seed
 * allowance runs out it is the least informative words that get dropped.
 *
 * The ceiling has a floor of two images: on a small corpus almost every word
 * is "common", and filtering by share alone would leave a search with nothing
 * to ask about.
 */
function selectSeeds(words, degrees, { corpusSize, stopWordImageRatio, limit }) {
    const ceiling = Math.max(2, Math.round(corpusSize * stopWordImageRatio));
    return words
        .map((word) => ({ word, degree: degrees.get(word) || 0 }))
        .filter((entry) => entry.degree > 0 && entry.degree <= ceiling)
        .sort((left, right) => left.degree - right.degree)
        .slice(0, limit)
        .map((entry) => entry.word);
}

function mean(values) {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Rerank candidates with the continuous colour field.
 *
 * The graph answers on vocabulary overlap, which is a statement about
 * distributions. This is the check on *individual* signs: pull the candidate's
 * own constellations that share a word with a measured one and compare the two
 * colour fields.
 *
 * **Both signs are first put in a common frame**, aligned on the triple whose
 * word matched (`alignToTriple`). Skipping that step is what made an earlier
 * version of this useless: each constellation's frame is centred on its own seed
 * pixel, so the query's points landed nowhere near the candidate's observations
 * and both scores below were reporting how far apart two unrelated draws
 * happened to fall.
 *
 * The study gives two comparison rules and both are computed, because they
 * measure different things and only measurement can say which is worth trusting
 * on a given corpus:
 *
 *   - `observationScore` — its "comparing arbitrary query points": evaluate the
 *     candidate's field at the query's point positions with the `C·E + β(1−C)`
 *     penalty.
 *   - `descriptorScore` — its "making the function searchable in a database":
 *     evaluate both fields on the same fixed probe grid and compare the vectors.
 *
 * Both are lower-is-better. Neither reorders the candidates: the ranking stays
 * the graph's, and these ride along as evidence about it.
 */
async function rerankWithField(store, evidence, querySigns, {
    rerankTop = settings.sign.search.rerankTop,
    rerankSigns = settings.sign.search.rerankSigns,
    rerankMatchesPerWord = 4,
} = {}) {
    const ranked = evidence.ranked().slice(0, rerankTop);
    const parsedQueries = querySigns.slice(-rerankSigns).map((sign) => ({
        parsed: parseConstellationRecord(sign.record),
        // Kept as triples, not as a flat word list: the comparison needs to know
        // which triple produced the word it matched on.
        triples: sign.triples,
    }));

    return Promise.all(ranked.map(async (candidate) => {
        const observationScores = [];
        const descriptorScores = [];
        const tripleScores = [];
        for (const query of parsedQueries) {
            let bestObservation = Infinity;
            let bestDescriptor = Infinity;
            let bestTriple = Infinity;
            for (const triple of query.triples) {
                const matches = await store.signsForWord(triple.words[0], candidate.imageId, {
                    limit: rerankMatchesPerWord,
                });
                const queryDescriptor = constellationDescriptor(query.parsed, triple.index);
                const queryFeatures = tripleFeatures(
                    query.parsed.edges,
                    query.parsed.edgeDeltas,
                    triple.index
                );
                for (const match of matches) {
                    if (match.tripleIndex === null) continue;
                    const parsed = parseConstellationRecord(match.record);
                    bestObservation = Math.min(bestObservation, compareConstellations(parsed, query.parsed, {
                        candidateTriple: match.tripleIndex,
                        queryTriple: triple.index,
                    }));
                    bestDescriptor = Math.min(bestDescriptor, descriptorDistance(
                        constellationDescriptor(parsed, match.tripleIndex),
                        queryDescriptor
                    ));
                    bestTriple = Math.min(bestTriple, tripleFeatureDistance(
                        tripleFeatures(parsed.edges, parsed.edgeDeltas, match.tripleIndex),
                        queryFeatures
                    ));
                }
                if (Number.isFinite(bestObservation)) break;
            }
            if (Number.isFinite(bestObservation)) observationScores.push(bestObservation);
            if (Number.isFinite(bestDescriptor)) descriptorScores.push(bestDescriptor);
            if (Number.isFinite(bestTriple)) tripleScores.push(bestTriple);
        }
        return {
            ...candidate,
            fieldScore: mean(observationScores),
            descriptorScore: mean(descriptorScores),
            tripleScore: mean(tripleScores),
            fieldSamples: observationScores.length,
        };
    }));
}

/**
 * Identify `imagePath` against the corpus.
 *
 * Returns the ranked candidates, the belief that stopped the search, and how
 * much measuring it took — the last one being the number the specification
 * actually cares about.
 */
async function searchImage(store, imagePath, {
    onRound = null,
    rerank = true,
    ...overrides
} = {}) {
    const search = { ...settings.sign.search, ...overrides };
    const options = samplerOptions(overrides);
    const { rawPixels, meta } = await loadImagePixels(imagePath, options);
    const random = createRandom(overrides.seed ?? null);

    const corpus = await store.listImages();
    if (corpus.size === 0) throw new Error('the sign corpus is empty; train some images first');

    const corpusRecords = [...corpus.values()];
    const evidence = new Evidence({
        corpusSize: corpus.size,
        averageWords: corpusRecords.reduce((sum, record) => sum + (Number(record.words) || 0), 0) /
            Math.max(1, corpusRecords.length),
        lengthSlope: search.lengthSlope,
    });
    const degreeCache = new Map();
    const querySigns = [];
    let reason = 'exhausted';

    while (evidence.constellations < search.maxConstellations) {
        const batch = sampleSigns({
            rawPixels,
            meta,
            count: search.batchSize,
            random,
            ...options,
        });
        if (batch.length === 0) break;
        querySigns.push(...batch);
        evidence.constellations += batch.length;
        evidence.rounds += 1;

        // Every word of the sweep, including the neighbouring cells a
        // measurement close to a level edge could equally have fallen in.
        // Ingestion stores only the primary word, so this is the side that
        // bridges the edge — and it is the cheap side: a variant costs one more
        // seed on a recall that is happening anyway, where at ingestion time it
        // cost a stored posting and a graph edge, permanently.
        const words = allWords(batch.flatMap((sign) => sign.triples));
        const unknown = words.filter((word) => !degreeCache.has(word));
        if (unknown.length > 0) {
            const degrees = await store.wordDegrees(unknown);
            for (const [word, degree] of degrees) degreeCache.set(word, degree);
        }
        const seeds = selectSeeds(words, degreeCache, {
            corpusSize: corpus.size,
            stopWordImageRatio: search.stopWordImageRatio,
            limit: search.seedsPerRound,
        });
        evidence.seeds += seeds.length;

        if (seeds.length > 0) evidence.fold(await store.recallImages(seeds), degreeCache);

        const ranked = evidence.ranked();
        onRound?.({
            round: evidence.rounds,
            constellations: evidence.constellations,
            seeds: seeds.length,
            top: ranked.slice(0, 3),
        });

        if (evidence.constellations < search.minConstellations) continue;
        if (ranked.length === 0) continue;
        const separation = ranked.length > 1
            ? ranked[0].mass / Math.max(ranked[1].mass, Number.EPSILON)
            : Infinity;
        // Scale-free: what matters is how far the leader is above an even split,
        // not the raw share, which shrinks as the corpus grows.
        const uniformShare = 1 / Math.max(1, corpus.size);
        const lead = ranked[0].confidence / uniformShare;
        if (lead >= search.confidenceMultiple && separation >= search.separationTarget) {
            reason = 'confident';
            break;
        }
    }

    const candidates = rerank
        ? await rerankWithField(store, evidence, querySigns, search)
        : evidence.ranked().slice(0, search.rerankTop);

    return {
        candidates,
        reason,
        rounds: evidence.rounds,
        constellations: evidence.constellations,
        seeds: evidence.seeds,
        corpusSize: corpus.size,
    };
}

module.exports = {
    Evidence,
    inverseDocumentFrequency,
    rerankWithField,
    samplerOptions,
    searchImage,
    selectSeeds,
    trainImage,
};
