// Training and search for the sign pipeline.
//
// Training is validation-driven: draw constellations in chunks, publish them,
// and ask fresh searches whether the image is reliably findable. Corpus-level
// rehearsal repeats that question after later images add new competition.
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
const { SignStore } = require('./lib/cheetah/signStore');
const { createRandom } = require('./lib/sign/rng');
const { loadImagePixels, sampleSigns } = require('./lib/sign/sampler');
const {
    allWords,
    constellationWords,
    tripleFeatureDistance,
    tripleFeatures,
} = require('./lib/sign/words');
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

    const { edges, maxCount } = await store.commitGraph(imageId, filename, wordCounts);
    const record = await store.markComplete(imageId, {
        constellations: signs.length,
        words: wordCounts.size,
        signature_norm: SignStore.signatureNorm(wordCounts, maxCount),
        working_width: meta.width,
        working_height: meta.height,
    });
    onProgress?.({ stage: 'complete', filename, imageId, edges });

    // `wordCounts` rides along because extending this image later needs the
    // cumulative totals its edge weights were published from, and rebuilding
    // them from storage costs a page-walk of the whole image.
    return { imageId, filename, signs: signs.length, words: wordCounts.size, edges, record, wordCounts };
}

/**
 * Ingest one image, stopping as soon as more constellations stop paying.
 *
 * The fixed-count trainer above writes the same density onto every image, which
 * is the wrong shape for two reasons that pull in opposite directions: a busy
 * photograph is still gaining discriminability at 2048 signs, and a flat one was
 * done by 512 — but both cost the same. This trains in chunks and, between them,
 * *asks the corpus the question the corpus will actually be asked*: three fresh
 * searches for this image, against every image already stored. Once a checkpoint
 * stops beating the best one so far, the remaining chunks are bought and paid
 * for nothing, so the run stops.
 *
 * Four properties this depends on, none of them incidental:
 *
 *   - **The probes never reuse trained constellations.** They redraw from the
 *     image with their own seeds, exactly as `evaluate` does. A checkpoint that
 *     replayed the training draw would measure memorisation and would always say
 *     "keep going".
 *   - **The image is readable but not complete** while it is being probed
 *     (`readWhileIncomplete`). It has to be visible to its own search or the
 *     probe measures nothing; it must not be *complete*, or an interrupted run
 *     would leave a half-trained image that every other reader trusts.
 *   - **There must be something to be confused with.** Discriminability is not
 *     defined against an empty corpus: with fewer than `minCorpus` images
 *     stored, every probe trivially reports a perfect margin and the run would
 *     stop at the first checkpoint. Below that threshold this writes one
 *     bootstrap chunk and defers the decision to corpus rehearsal
 *     (`reason: 'awaiting-review'`).
 *   - **The stop rule only fires from a state of success** (`stopMinHitRate`).
 *     A flat checkpoint on an image the probes cannot even find yet means
 *     "not there yet", not "done"; see the comment on the rule itself for the
 *     measurement that makes this the difference between working and useless.
 */
async function trainImageAdaptive(store, imagePath, {
    count = settings.sign.constellationsPerImage,
    seed = null,
    onProgress = null,
    onCheckpoint = null,
    checkEvery = settings.sign.train.checkEvery,
    probes = settings.sign.train.probes,
    minGain = settings.sign.train.minGain,
    minCorpus = settings.sign.train.minCorpus,
    probeMaxConstellations = settings.sign.train.probeMaxConstellations,
    stopMinHitRate = settings.sign.train.stopMinHitRate,
    extendTo = settings.sign.train.extendTo,
    ...overrides
} = {}) {
    const options = samplerOptions(overrides);
    const filename = path.basename(imagePath);
    const { rawPixels, meta, source } = await loadImagePixels(imagePath, options);
    const random = createRandom(seed);

    const corpusBefore = await store.listImages();
    const canProbe = corpusBefore.size >= minCorpus && checkEvery > 0 && probes > 0;

    const { imageId } = await store.putImage({
        filename,
        width: source.width,
        height: source.height,
    });
    const releaseProbeAccess = store.readWhileIncomplete(imageId);

    // Cumulative across chunks: an edge weight is a function of how often the
    // word was observed in the *whole* image, so a chunk that re-observes a word
    // must republish the running total, not its own count.
    const cumulativeWords = new Map();
    const checkpoints = [];
    let written = 0;
    let signCount = 0;
    let edgeWrites = 0;
    let best = null;
    let reason = canProbe ? 'exhausted' : 'awaiting-review';

    // `count` is the caller's nominal starting target; `extendTo` is the finite
    // automatic safety ceiling. The normal CLI deliberately supplies the latter
    // even when the user supplies no constellation count: validation decides
    // where to stop, while the cap prevents an indistinguishable pair from
    // training forever.
    //
    // Before `minCorpus` there is no meaningful validation yet. Writing the
    // whole ceiling into those first images would merely replace a measurement
    // with a fixed quota, so they receive one chunk and are marked
    // `awaiting-review`. Corpus rehearsal revisits them once real competitors
    // exist and tops them up only if fresh searches cannot find them.
    const ceiling = Math.max(1, count, extendTo || 0);
    const writeCeiling = canProbe
        ? ceiling
        : Math.min(ceiling, Math.max(1, checkEvery));

    try {
        const chunkSize = Math.min(Math.max(1, checkEvery), writeCeiling);
        while (signCount < writeCeiling) {
            const wanted = Math.min(chunkSize, writeCeiling - signCount);
            const signs = sampleSigns({ rawPixels, meta, count: wanted, random, ...options });
            if (signs.length === 0) {
                if (signCount === 0) {
                    throw new Error(
                        `no constellation could be placed on ${filename} (${meta.width}x${meta.height})`
                    );
                }
                break;
            }

            const chunk = await store.putSigns(imageId, signs, { startOrdinal: signCount });
            for (const [word, observations] of chunk.wordCounts) {
                cumulativeWords.set(word, (cumulativeWords.get(word) || 0) + observations);
            }
            // The **whole** signature is republished, not only the words this
            // chunk touched. A weight is relative to the image's most frequent
            // word, and that maximum moves as chunks arrive: republishing a
            // subset would leave the untouched words divided by a stale one.
            // Affordable only because the vocabulary is 4096 words — the
            // signature has a bounded size, so "publish the signature" is a
            // bounded operation no matter how long the image trains.
            const published = await store.commitGraph(imageId, filename, cumulativeWords);

            signCount += signs.length;
            written += chunk.written;
            edgeWrites += published.edges;
            await store.updateImage(imageId, {
                constellations: signCount,
                words: cumulativeWords.size,
                // Updated every chunk because the probes below search against
                // this record: a stale norm would measure the image the corpus
                // held one chunk ago.
                signature_norm: SignStore.signatureNorm(cumulativeWords, published.maxCount),
            });
            onProgress?.({
                stage: 'chunk',
                filename,
                signs: signCount,
                words: cumulativeWords.size,
            });

            if (!canProbe) continue;

            // The probe seeds do not depend on how much has been written, so
            // consecutive checkpoints re-ask the *same* three questions of a
            // better-trained image. Redrawing them each time would make the
            // difference between two checkpoints a mix of "we learned something"
            // and "we asked something else", and the second term is large enough
            // to keep a run alive on noise alone.
            const quality = await probeQuality(store, imagePath, {
                imageId,
                probes,
                seedPrefix: `probe:${filename}`,
                maxConstellations: probeMaxConstellations,
            });
            const checkpoint = {
                constellations: signCount,
                ...quality,
                accuracyGain: best ? quality.accuracy - best.accuracy : null,
                // Search effort is reported as a *fall* in the constellations a
                // search needed, so both numbers mean "improvement" when positive.
                effortGain: best ? (best.effort - quality.effort) : null,
            };
            checkpoints.push(checkpoint);
            onCheckpoint?.({ filename, ...checkpoint });

            // "Leave it as it is" presupposes that it is already good. Until
            // every probe finds the image, a flat checkpoint means the image is
            // not yet retrievable at all — not that more constellations would
            // not help — and stopping there is the one unrecoverable mistake
            // this loop can make.
            //
            // This is not hypothetical. Measured on a corpus of near-duplicates,
            // the margin sits at exactly -1 (the image does not appear among the
            // candidates at all) for the first ~1000 constellations and only then
            // climbs: -1.00 at 1024, -0.34 at 1536, +0.01 with two probes of
            // three hitting at 1792. A rule that only compared consecutive
            // checkpoints stopped those images at 1024, at the bottom of the
            // curve, and called it convergence.
            // The bar is *findability*, deliberately not `confidentRate`. That
            // signal reports whether the search's own early stop fired, which
            // needs `SIGN_SEARCH_SEPARATION` over the runner-up — a property of
            // the corpus, not of this image's training. Measured on the 199-image
            // sample corpus: separation falls as evidence accumulates (1.24 at 24
            // constellations, 1.03 at 192, 1.07 at 288, against a 1.35 target)
            // because by 288 constellations 198 of 199 images carry mass and the
            // runner-up is a real near-duplicate. Gating on it made the rule
            // unsatisfiable at any budget — `004.jpg` is rank 1 on 3 of 3 probes
            // at both 96 and 480 constellations and still scores `confidentRate`
            // 0 — so every image trained to the ceiling and the run never ended.
            if (best && quality.hitRate >= stopMinHitRate) {
                // Measured against the best checkpoint so far, not the previous
                // one: comparing only with the previous lets a run that dipped
                // and recovered read its recovery as progress and keep going.
                const gained = checkpoint.accuracyGain >= minGain || checkpoint.effortGain >= minGain;
                if (!gained) {
                    reason = 'converged';
                    break;
                }
            }
            best = {
                accuracy: Math.max(quality.accuracy, best?.accuracy ?? -Infinity),
                effort: Math.min(quality.effort, best?.effort ?? Infinity),
            };
        }
    } finally {
        releaseProbeAccess();
    }

    const record = await store.markComplete(imageId, {
        constellations: signCount,
        words: cumulativeWords.size,
        signature_norm: SignStore.signatureNorm(cumulativeWords),
        working_width: meta.width,
        working_height: meta.height,
        training: 'adaptive',
    });
    onProgress?.({ stage: 'complete', filename, imageId, edges: cumulativeWords.size });

    return {
        imageId,
        filename,
        signs: signCount,
        words: cumulativeWords.size,
        // One edge per distinct word, as in the one-shot trainer. `edgeWrites`
        // is the larger number: a word observed in more than one chunk has its
        // edge republished with the new running total each time.
        edges: cumulativeWords.size,
        edgeWrites,
        written,
        record,
        // As in `trainImage`: the totals a later top-up must republish from.
        wordCounts: cumulativeWords,
        reason,
        checkpoints,
        // What the run would have written without the stop rule, so a caller can
        // report the saving without re-deriving it from settings.
        budget: count,
        ceiling,
        extended: signCount > count,
        awaitingReview: !canProbe,
    };
}

/**
 * How well the corpus currently tells this image apart, from `probes` fresh
 * draws off the image itself.
 *
 * Three signals come back, because "is it improving?" has answers that do not
 * move together:
 *
 *   - **`accuracy`** — hit rate plus mean margin, in `[-1, 2]`. Hit rate alone
 *     saturates at 1 almost immediately and then reports nothing; the margin
 *     `(mine - best other) / (mine + best other)` keeps moving after that, which
 *     is what makes "still improving" measurable on a corpus of near-duplicates
 *     where the runner-up is a crop of the same photograph.
 *   - **`effort`** — the share of its ceiling a search had to spend before it
 *     was confident. More training makes a search *cheaper*, and that is a real
 *     gain even in a checkpoint where the ranking did not change.
 *   - **`confidentRate`** — the share that both ranked the target first and
 *     reached the search engine's own early-stop confidence. Rank-1 only after
 *     exhausting the probe ceiling is not the stopping state training wants.
 *
 * The probes deliberately run with the reranker off: it hydrates candidate signs
 * to compare colour fields, costs more than the rest of the search together, and
 * never reorders the ranking these numbers are read from.
 */
async function probeQuality(store, imagePath, {
    imageId,
    probes,
    seedPrefix,
    maxConstellations,
}) {
    const runs = [];
    for (let index = 0; index < probes; index += 1) {
        const result = await searchImage(store, imagePath, {
            maxConstellations,
            rerank: false,
            seed: `${seedPrefix}:${index}`,
        });
        const mine = result.candidates.find((candidate) => candidate.imageId === imageId);
        const other = result.candidates.find((candidate) => candidate.imageId !== imageId);
        const mineMass = mine?.mass ?? 0;
        const otherMass = other?.mass ?? 0;
        const total = mineMass + otherMass;
        runs.push({
            hit: result.candidates[0]?.imageId === imageId ? 1 : 0,
            confident: result.reason === 'confident' && result.candidates[0]?.imageId === imageId ? 1 : 0,
            margin: total > 0 ? (mineMass - otherMass) / total : 0,
            effort: result.constellations / Math.max(1, maxConstellations),
        });
    }
    const average = (key) => runs.reduce((sum, run) => sum + run[key], 0) / runs.length;
    const hitRate = average('hit');
    const margin = average('margin');
    return {
        probes: runs.length,
        hitRate,
        confidentRate: average('confident'),
        margin,
        accuracy: hitRate + margin,
        effort: average('effort'),
    };
}

/**
 * Rebuild an image's per-word observation counts from what is stored.
 *
 * Only ever needed to *extend* an image whose counts nobody kept: an edge weight
 * is `min(1, tf / TF_SATURATION)` over the whole image, so a top-up that
 * republished its chunk's own counts would lower the weight of every word the
 * chunk re-observed. Within one session `reviewCorpus` carries the counts in
 * memory and never calls this; a corpus reopened in a later session has nothing
 * else to read them from.
 *
 * It counts the way `putSigns` does — the primary word only, once per
 * constellation regardless of how many of its triples landed in that cell — but
 * it cannot be bit-exact and must not be assumed to be. **A stored record is
 * lossy**: deltas and links are rounded to `STORED_DECIMALS` (1e-5), so a triple
 * whose measurement sat within rounding distance of a quantisation edge comes
 * back in the neighbouring cell. Measured on a real image at 400 constellations:
 * ~0.15% of triples, each moving one observation between two words, i.e. an edge
 * weight off by at most 1/TF_SATURATION for a handful of words out of thousands.
 *
 * That drift is not this function's: **ingestion indexes an image under words
 * its own stored record does not fully reproduce**, because `putSigns` computes
 * them from the live measurement while everything that reads a record back —
 * this, and the reranker — recomputes them from the rounded form. Making the two
 * agree means computing the published words from the record as well, which
 * changes what is written and needs a re-ingest; it is worth doing and it is not
 * in scope here.
 */
async function storedWordCounts(store, imageId) {
    const counts = new Map();
    let signs = 0;
    for await (const { record } of store.listSigns(imageId)) {
        const parsed = parseConstellationRecord(record);
        const triples = constellationWords(parsed);
        const seen = new Set();
        for (const triple of triples) {
            if (seen.has(triple.words[0])) continue;
            seen.add(triple.words[0]);
            counts.set(triple.words[0], (counts.get(triple.words[0]) || 0) + 1);
        }
        signs += 1;
    }
    return { wordCounts: counts, signs };
}

/**
 * Draw more constellations onto an image that is already in the corpus.
 *
 * The commit protocol is the one every other write path uses — reopen, write,
 * publish, complete — and the two things it must not get wrong are the two the
 * chunked trainer already documents: signs are appended at `startOrdinal` so
 * they do not overwrite the image's existing ones, and the graph is republished
 * with **cumulative** word counts so an edge weight never falls.
 *
 * `wordCounts` is the running total from a caller that has it; without one the
 * totals are rebuilt from storage, which costs one page-walk of the image.
 */
async function extendImage(store, imagePath, {
    imageId,
    count,
    wordCounts = null,
    startOrdinal = null,
    seed = null,
    ...overrides
} = {}) {
    const options = samplerOptions(overrides);
    const filename = path.basename(imagePath);
    const { rawPixels, meta } = await loadImagePixels(imagePath, options);

    let cumulative = wordCounts;
    let from = startOrdinal;
    if (!cumulative || from === null) {
        const stored = await storedWordCounts(store, imageId);
        cumulative = cumulative || stored.wordCounts;
        from = from === null ? stored.signs : from;
    }

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

    const { record: reopened, release } = await store.reopenImage(imageId);
    try {
        const chunk = await store.putSigns(imageId, signs, { startOrdinal: from });
        for (const [word, observations] of chunk.wordCounts) {
            cumulative.set(word, (cumulative.get(word) || 0) + observations);
        }
        // The whole signature, for the reason the chunked trainer documents:
        // the weights are relative to a maximum this top-up has just moved.
        const published = await store.commitGraph(imageId, filename, cumulative);
        const signCount = from + signs.length;
        const record = await store.markComplete(imageId, {
            constellations: signCount,
            words: cumulative.size,
            signature_norm: SignStore.signatureNorm(cumulative, published.maxCount),
            // How the image was originally trained is not changed by extending
            // it; how often it has been extended is worth keeping, because "this
            // image has been topped up four times and is still behind" is the
            // corpus telling you something a single count cannot.
            training: reopened.training ?? 'fixed',
            topUps: (Number(reopened.topUps) || 0) + 1,
        });
        return {
            imageId,
            filename,
            added: signs.length,
            signs: signCount,
            words: cumulative.size,
            edges: published.edges,
            wordCounts: cumulative,
            record,
        };
    } finally {
        release();
    }
}

/**
 * Re-ask the corpus about images it already holds, and top up the ones it has
 * stopped being able to find.
 *
 * The failure this exists for is not a bug, it is the shape of the problem: an
 * image is trained against the corpus that existed *when it was trained*, and
 * every image added afterwards is a new competitor for the same words. An image
 * that separated cleanly at corpus size 5 can be unfindable at corpus size 50
 * without a single byte of its own having changed — the evidence did not
 * degrade, the competition arrived. A one-pass trainer never revisits it, so the
 * early images of a growing corpus quietly become the ones it cannot answer.
 *
 * So this is a rehearsal pass, not a repair pass: probe what is already there,
 * and give more constellations to whichever image the corpus can no longer pick
 * out. Four properties it depends on:
 *
 *   - **Every pass uses a fresh deterministic probe generation**
 *     (`review:<name>:<generation>`). Checkpoints within one ingest reuse probes
 *     to measure gain, but corpus rehearsal is certification: repeating the
 *     same lucky draw forever would never challenge that certificate again.
 *   - **Probing is not free and the pass is bounded.** Each probe is a search;
 *     `sample` caps how many images a pass looks at and the least-recently
 *     reviewed go first, so a large corpus is covered across passes rather than
 *     re-measured in full after every image.
 *   - **A top-up is one chunk, not a retrain.** An image that is behind gets
 *     `topUp` more constellations and is measured again on the next pass. Giving
 *     it everything at once would spend the budget on the first image that
 *     struggled, which on a near-duplicate corpus is not the image that needs it
 *     most.
 *   - **`ceiling` is what stops it.** Some images are genuinely
 *     indistinguishable from a near-duplicate, and no amount of constellations
 *     fixes that; without a per-image cap the pass would keep buying evidence
 *     for exactly those.
 */
/**
 * A deterministic fresh validation stream for one image.
 *
 * Checkpoints within one adaptive ingest intentionally reuse their questions so
 * gains are comparable. Rehearsal answers a different question — "does this
 * still work now?" — and must not certify an image forever from the same lucky
 * three draws. The generation changes after every review while remaining
 * reproducible in a report or test.
 */
function reviewProbeSeed(filename, generation = 0) {
    return `review:${filename}:${Math.max(0, Number(generation) || 0)}`;
}

/** Least-reviewed first: a bounded pass is a fair round-robin, not a sample with replacement. */
function selectReviewEntries(tracked, sample) {
    const entries = [...tracked.values()].filter((entry) => entry.imageId != null);
    const order = entries
        .slice()
        .sort((left, right) => (left.reviewedAt ?? 0) - (right.reviewedAt ?? 0));
    return sample > 0 ? order.slice(0, sample) : order;
}

async function reviewCorpus(store, tracked, {
    probes = settings.sign.train.probes,
    minHitRate = settings.sign.train.review.minHitRate,
    topUp = settings.sign.train.review.topUp,
    ceiling = settings.sign.train.review.ceiling,
    sample = settings.sign.train.review.sample,
    patience = settings.sign.train.review.patience,
    minGain = settings.sign.train.minGain,
    probeMaxConstellations = settings.sign.train.probeMaxConstellations,
    onReview = null,
    ...overrides
} = {}) {
    const selected = selectReviewEntries(tracked, sample);
    if (selected.length === 0) return { reviewed: [], toppedUp: 0, added: 0 };

    const reviewed = [];
    let toppedUp = 0;
    let added = 0;

    for (const entry of selected) {
        const generation = Math.max(0, Number(entry.reviewedAt) || 0);
        const quality = await probeQuality(store, entry.path, {
            imageId: entry.imageId,
            probes,
            seedPrefix: reviewProbeSeed(entry.filename, generation),
            maxConstellations: probeMaxConstellations,
        });
        entry.reviewedAt = generation + 1;
        entry.quality = quality;

        // The bar is findability by every required probe. It deliberately does
        // *not* also require `confidentRate` — that reports whether the search's
        // own early stop fired, which needs `SIGN_SEARCH_SEPARATION` over the
        // runner-up and is therefore a statement about how crowded the corpus
        // is, not about how well this image is trained. On the 199-image sample
        // corpus separation asymptotes near 1.05 against a 1.35 target, so that
        // conjunction was unsatisfiable at any budget: every image stayed
        // permanently `behind` and every cycle topped up all of them, which no
        // amount of waiting resolves.
        const behind = quality.hitRate < minHitRate;
        const room = ceiling <= 0 || entry.signs < ceiling;

        // Did the last top-up buy anything? Compared against the best value ever
        // measured for this image rather than the previous pass, because each
        // pass asks a fresh probe generation and two consecutive answers differ
        // by noise as well as by learning. An image that has absorbed `patience`
        // top-ups without improving on its own best is not being helped by more
        // constellations — on a near-duplicate corpus it is precisely the image
        // that would otherwise absorb the entire budget — so spending stops and
        // says why, exactly as the per-image ceiling does.
        const improved = entry.bestAccuracy === undefined
            || quality.accuracy >= entry.bestAccuracy + minGain;
        if (improved) {
            entry.bestAccuracy = Math.max(quality.accuracy, entry.bestAccuracy ?? -Infinity);
            entry.staleReviews = 0;
        } else if (entry.toppedUpLastPass) {
            entry.staleReviews = (entry.staleReviews || 0) + 1;
        }
        const stalled = patience > 0 && (entry.staleReviews || 0) >= patience;

        let extension = null;
        if (behind && room && !stalled && topUp > 0) {
            const wanted = ceiling > 0 ? Math.min(topUp, ceiling - entry.signs) : topUp;
            extension = await extendImage(store, entry.path, {
                imageId: entry.imageId,
                count: wanted,
                wordCounts: entry.wordCounts ?? null,
                startOrdinal: entry.wordCounts ? entry.signs : null,
                // A top-up must not redraw the constellations the image already
                // has: the seed moves with the ordinal it starts at.
                seed: `${entry.filename}:top-up:${entry.signs}`,
                ...overrides,
            });
            entry.wordCounts = extension.wordCounts;
            entry.signs = extension.signs;
            entry.words = extension.words;
            toppedUp += 1;
            added += extension.added;
        }
        entry.toppedUpLastPass = extension !== null;

        const outcome = {
            filename: entry.filename,
            imageId: entry.imageId,
            hitRate: quality.hitRate,
            confidentRate: quality.confidentRate,
            margin: quality.margin,
            signs: entry.signs,
            added: extension?.added ?? 0,
            generation,
            // Two ways to stop spending on an image the corpus cannot find, and
            // they are different diagnoses: `at-ceiling` is "it ran out of
            // allowance", `no-gain` is "the allowance was not the problem".
            reason: behind
                ? (extension ? 'topped-up' : (stalled ? 'no-gain' : 'at-ceiling'))
                : 'findable',
        };
        reviewed.push(outcome);
        onReview?.(outcome);
    }

    return { reviewed, toppedUp, added };
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
 * This is a tf-idf cosine, assembled from the three pieces that live in three
 * different places, and every one of them is load-bearing:
 *
 *   - **The image's term frequency** arrives as the seed's `activation`, which
 *     is the graph edge weight, which `SignStore.commitGraph` set to the word's
 *     frequency relative to that image's most frequent word.
 *   - **The query's term frequency** is counted here, per round, the same way
 *     ingestion counts: once per constellation that produced the word. Treating
 *     the query as a *set* instead is what the previous revision did, and on a
 *     dense vocabulary it is fatal — a 96-constellation query touches nearly
 *     every word at least once, so membership distinguishes nothing.
 *   - **Rarity** is `idf`, from the word's out-degree in the graph, applied to
 *     both sides of the product as in the textbook form.
 *
 * The sum is then divided by the image's own `signature_norm`. Without it an
 * image simply collects more terms for being larger. Measured on 100 images at
 * 1024 constellations, ranking by exactly these numbers:
 *
 *     membership x idf / pivoted word count   (what shipped)   10/100
 *     query tf x weight x idf, unnormalised                    19/100
 *     query tf x weight x idf / signature norm                 94/100
 *
 * `lengthSlope` survives as an escape hatch for a corpus without stored norms:
 * at slope 0 it is inert, which is the default now that the real norm exists.
 */
/**
 * How many of these matched triples are *independent* evidence.
 *
 * Consecutive triples of a chain **share a hop**: triple `i` and `i+1` are built
 * from edges `(i, i+1)` and `(i+1, i+2)`, so two of their six colour-delta
 * levels and part of their scale band are the same measurement counted twice.
 * Two adjacent triples agreeing is therefore close to one triple agreeing with
 * itself, and rewarding it rewards redundancy rather than corroboration — which
 * is not a theoretical worry: crediting every agreeing triple took rank-1 from
 * 90% to 75% with the search budget held fixed, because on a near-duplicate
 * corpus the image that matches one triple is exactly the image that matches its
 * neighbours.
 *
 * So agreement is counted over a maximal set of pairwise **non-adjacent**
 * triples, greedily along the chain: a 7-point sign can contribute 3 (indices
 * 0, 2, 4) where a 5-point sign can contribute 2 (0, 2). The longer chain is
 * still worth more, but only for the part of it that is not the same hop read
 * twice.
 */
function independentAgreement(triples) {
    const sorted = [...triples].sort((left, right) => left - right);
    let count = 0;
    let last = -Infinity;
    for (const index of sorted) {
        if (index - last < 2) continue;
        count += 1;
        last = index;
    }
    return count;
}

class Evidence {
    constructor({
        corpusSize,
        averageWords = 1,
        lengthSlope = settings.sign.search.lengthSlope,
        chainBonus = settings.sign.search.chainBonus,
    }) {
        this.corpusSize = corpusSize;
        this.averageWords = averageWords > 0 ? averageWords : 1;
        this.lengthSlope = Math.min(1, Math.max(0, lengthSlope));
        this.chainBonus = Math.max(0, Number(chainBonus) || 0);
        this.byImage = new Map();
        this.rounds = 0;
        this.constellations = 0;
        this.seeds = 0;
    }

    /**
     * The cosine denominator: the image's own signature norm, times the pivoted
     * word-count correction when one was asked for.
     *
     * `(1 - s) + s * |d| / avg|d|` is inert at s = 0, which is the default. It
     * is kept because it is the only correction available against a record
     * written before `signature_norm` existed.
     */
    lengthNorm(words, norm) {
        const stored = Number(norm);
        const base = Number.isFinite(stored) && stored > 0 ? stored : 1;
        if (this.lengthSlope === 0) return base;
        const relative = (Number(words) || 0) / this.averageWords;
        return base * Math.max(1e-6, (1 - this.lengthSlope) + this.lengthSlope * relative);
    }

    /**
     * Fold one recall's answer into the running belief.
     *
     * `origins` maps each seeded word back to the `{sign, triple}` positions
     * that produced it this round, and it is what makes a *chain* worth more
     * than the sum of its triples. Without it the fold is a bag of words: five
     * triples of one constellation agreeing on an image count exactly as much as
     * five triples scattered across five unrelated constellations, which is the
     * reason more points per constellation bought nothing measurable — a longer
     * chain only added more independent bag items, the same thing drawing more
     * constellations already does, at the same cost.
     *
     * With `chainBonus > 0` an image is credited per *constellation*: the seeds
     * it matched are grouped by the sign that asked them, and each group is
     * scaled by `1 + chainBonus * (agreeing triples - 1)`. A 7-point chain can
     * put five triples behind one image where a 5-point chain can put three, so
     * the extra points finally express themselves as *joint* evidence rather
     * than as extra samples. Coincidence does not scale that way: an unrelated
     * image matching one triple of each of five constellations gets no bonus at
     * all.
     *
     * A word produced by several signs splits its activation equally between
     * them, so at `chainBonus = 0` this is arithmetically the old sum, to the
     * last bit — the knob is off by default and turning it off is exact.
     */
    fold(results, degrees, origins = null, queryCounts = null) {
        const grouped = this.chainBonus > 0 && origins;
        for (const result of results) {
            const current = this.byImage.get(result.imageId) || {
                imageId: result.imageId,
                filename: result.filename,
                words: result.words,
                norm: result.norm,
                rawMass: 0,
                sources: 0,
                // How much of this image's evidence came from constellations
                // that agreed with themselves. Reported, not ranked on.
                chained: 0,
            };
            const perSign = grouped ? new Map() : null;
            for (const seed of result.seeds) {
                const idf = inverseDocumentFrequency(
                    degrees.get(seed.word) || 1,
                    this.corpusSize
                );
                // idf on both sides, as in the cosine of two tf-idf vectors:
                // one factor belongs to the stored term, one to the measured
                // one. The query's own norm is constant across candidates and
                // therefore left out of the ranking entirely.
                const queryTf = queryCounts ? (queryCounts.get(seed.word) || 0) : 1;
                if (queryTf === 0) continue;
                const weight = queryTf * seed.activation * idf * idf;
                const producers = grouped ? origins.get(seed.word) : null;
                if (!producers || producers.length === 0) {
                    current.rawMass += weight;
                    continue;
                }
                const share = weight / producers.length;
                for (const { sign, triple } of producers) {
                    const entry = perSign.get(sign) || { mass: 0, triples: new Set() };
                    entry.mass += share;
                    entry.triples.add(triple);
                    perSign.set(sign, entry);
                }
            }
            if (perSign) {
                for (const entry of perSign.values()) {
                    const agreement = independentAgreement(entry.triples) - 1;
                    current.rawMass += entry.mass * (1 + this.chainBonus * agreement);
                    if (agreement > 0) current.chained += entry.mass * this.chainBonus * agreement;
                }
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
                mass: entry.rawMass / this.lengthNorm(entry.words, entry.norm),
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
 * budget. What is left is ordered by how much evidence it would carry, so that
 * when the round's seed allowance runs out it is the least informative words
 * that get dropped.
 *
 * Ordering is by `query frequency x idf`, not by rarity alone. Rarity alone was
 * right when a word was a near-unique token and seeing it once was the whole
 * signal; with a vocabulary a query re-enters many times, a common word the
 * query produced nine times says more than a rare one it produced once, and
 * dropping the former to keep the latter throws away most of the round.
 *
 * The ceiling has a floor of two images: on a small corpus almost every word
 * is "common", and filtering by share alone would leave a search with nothing
 * to ask about.
 */
function selectSeeds(words, degrees, { corpusSize, stopWordImageRatio, limit, queryCounts = null }) {
    const ceiling = Math.max(2, Math.round(corpusSize * stopWordImageRatio));
    return words
        .map((word) => ({
            word,
            degree: degrees.get(word) || 0,
            value: (queryCounts ? (queryCounts.get(word) || 1) : 1)
                * inverseDocumentFrequency(degrees.get(word) || 1, corpusSize),
        }))
        .filter((entry) => entry.degree > 0 && entry.degree <= ceiling)
        .sort((left, right) => right.value - left.value)
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
/**
 * `rerank` is **off by default**, and that is a measurement rather than a
 * preference. The field scores never reorder the ranking — they ride along as
 * evidence about it — and they have never once beaten the graph they annotate:
 * 5/20, 6/20 and 8/20 against 16/20 on the old representation, 19/100, 27/100
 * and 29/100 against 87/100 on the current one. They cost 7.0 s of a 7.8 s
 * search at corpus 100, because each one hydrates candidate constellations to
 * compare colour fields. `--rerank` asks for them when the question is "what do
 * the field scores say", which is the only question they answer.
 */
async function searchImage(store, imagePath, {
    onRound = null,
    rerank = false,
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
        chainBonus: search.chainBonus,
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
        // Which constellation and which triple of it asked for each word. The
        // words themselves are still one flat bag — that is what the recall
        // takes — but the fold needs to know which of them came from the same
        // chain, or a chain is worth no more than its triples scattered.
        const origins = new Map();
        // How many of this round's constellations asked for each word — the
        // query side's term frequency. Counted once per constellation, exactly
        // as `putSigns` counts the stored side, so the two are the same
        // measurement and their product means something.
        const queryCounts = new Map();
        batch.forEach((sign, signIndex) => {
            const seenBySign = new Set();
            for (const triple of sign.triples) {
                for (const word of triple.words) {
                    const producers = origins.get(word) || [];
                    if (!producers.some((p) => p.sign === signIndex && p.triple === triple.index)) {
                        producers.push({ sign: signIndex + evidence.rounds * search.batchSize, triple: triple.index });
                    }
                    origins.set(word, producers);
                    if (seenBySign.has(word)) continue;
                    seenBySign.add(word);
                    queryCounts.set(word, (queryCounts.get(word) || 0) + 1);
                }
            }
        });
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
            queryCounts,
        });
        evidence.seeds += seeds.length;

        if (seeds.length > 0) {
            // The recall must be able to answer for the whole corpus: the
            // caller ranks the answer itself, so an image the graph left out of
            // its own top-N is an image this search can never choose.
            const results = await store.recallImages(seeds, { limit: Math.max(64, corpus.size) });
            evidence.fold(results, degreeCache, origins, queryCounts);
        }

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
    extendImage,
    inverseDocumentFrequency,
    probeQuality,
    rerankWithField,
    reviewCorpus,
    reviewProbeSeed,
    samplerOptions,
    searchImage,
    selectReviewEntries,
    selectSeeds,
    storedWordCounts,
    trainImage,
    trainImageAdaptive,
};
