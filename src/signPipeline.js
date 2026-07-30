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
const { primaryWords } = require('./lib/sign/words');
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
 *     be hit by *any* query word, so its raw mass is divided by the square root
 *     of its vocabulary size. This is the document-norm half of a cosine, using
 *     the vocabulary count as the stand-in for the true norm — the exact norm
 *     would cost a full scan of the image's postings on every search.
 */
class Evidence {
    constructor({ corpusSize }) {
        this.corpusSize = corpusSize;
        this.byImage = new Map();
        this.rounds = 0;
        this.constellations = 0;
        this.seeds = 0;
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
                mass: entry.rawMass / Math.sqrt(Math.max(1, entry.words)),
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
 * The study gives two comparison rules and both are computed, because they
 * measure genuinely different things and only measurement can say which is
 * worth trusting on a given corpus:
 *
 *   - `observationScore` — its "comparing arbitrary query points": evaluate the
 *     candidate's field at the query's own point positions with the
 *     `C·E + β(1−C)` penalty. Frame-dependent: the two constellations were
 *     sampled at unrelated places, so most query points fall where the
 *     candidate has no observation and the uncertainty term dominates.
 *   - `descriptorScore` — its "making the function searchable in a database":
 *     evaluate both fields on the same **fixed** probe grid and compare the
 *     resulting vectors. Frame-independent, which is exactly the property the
 *     first one lacks.
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
    const parsedQueries = querySigns.slice(-rerankSigns).map((sign) => {
        const parsed = parseConstellationRecord(sign.record);
        return { parsed, descriptor: constellationDescriptor(parsed), words: primaryWords(sign.triples) };
    });

    return Promise.all(ranked.map(async (candidate) => {
        const observationScores = [];
        const descriptorScores = [];
        for (const query of parsedQueries) {
            let bestObservation = Infinity;
            let bestDescriptor = Infinity;
            for (const word of query.words) {
                const matches = await store.signsForWord(word, candidate.imageId, {
                    limit: rerankMatchesPerWord,
                });
                for (const match of matches) {
                    const parsed = parseConstellationRecord(match.record);
                    bestObservation = Math.min(bestObservation, compareConstellations(parsed, query.parsed));
                    bestDescriptor = Math.min(bestDescriptor, descriptorDistance(
                        constellationDescriptor(parsed),
                        query.descriptor
                    ));
                }
                if (Number.isFinite(bestObservation)) break;
            }
            if (Number.isFinite(bestObservation)) observationScores.push(bestObservation);
            if (Number.isFinite(bestDescriptor)) descriptorScores.push(bestDescriptor);
        }
        return {
            ...candidate,
            fieldScore: mean(observationScores),
            descriptorScore: mean(descriptorScores),
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

    const evidence = new Evidence({ corpusSize: corpus.size });
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

        // Only the cell each triple actually fell in. The sweep to neighbouring
        // cells was already spent at ingestion time, so asking for it again
        // here would widen the match by two cells instead of one.
        const words = [...new Set(batch.flatMap((sign) => primaryWords(sign.triples)))];
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
        if (ranked[0].confidence >= search.confidenceTarget && separation >= search.separationTarget) {
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
