// Drawing signs off a real image. The only module in src/lib/sign/ that needs
// an image library; everything above it works on plain numbers.

const sharp = require('sharp');
const { getRawPixels } = require('../gridStats');
const { DEFAULT_POINT_COUNT, POINT_PATCH_REL } = require('./constants');
const { sampleConstellation } = require('./geometry');
const { measureConstellation } = require('./measure');
const { buildConstellationRecord } = require('./signature');
const { constellationWords } = require('./words');
const { createRandom } = require('./rng');

/**
 * Longest side of the buffer the sampler actually reads.
 *
 * Decoding a 4000x3000 photograph raw costs 36 MB and buys nothing: every
 * measurement is relative, and a patch average over 0.4% of the short side is
 * the same colour at 1024 px as at 4000 px. Working at a fixed size also makes
 * the corpus consistent when a phone photo and a web-sized copy of it are both
 * ingested.
 */
const DEFAULT_WORKING_MAX_SIDE = 1024;

/**
 * Decode an image to raw RGB at the working size, honouring EXIF orientation.
 * `.rotate()` with no argument applies the orientation tag — without it, a
 * portrait phone photo is sampled sideways and its signs never match a copy
 * that some other tool has already straightened.
 */
async function loadImagePixels(imagePath, { workingMaxSide = DEFAULT_WORKING_MAX_SIDE } = {}) {
    let pipeline = sharp(imagePath, { failOn: 'none' }).rotate();
    const metadata = await pipeline.metadata();
    if (workingMaxSide > 0 && Math.max(metadata.width, metadata.height) > workingMaxSide) {
        pipeline = pipeline.resize({
            width: workingMaxSide,
            height: workingMaxSide,
            fit: 'inside',
            withoutEnlargement: true,
        });
    }
    const { rawPixels, meta } = await getRawPixels(pipeline);
    return { rawPixels, meta, source: { width: metadata.width, height: metadata.height } };
}

/**
 * Draw `count` signs. Constellations whose chain could not be placed inside the
 * frame are discarded and redrawn, up to a bounded number of attempts, so a
 * caller always knows whether it got what it asked for.
 */
function sampleSigns({
    rawPixels,
    meta,
    count,
    random = Math.random,
    pointCount = DEFAULT_POINT_COUNT,
    patchRelative = POINT_PATCH_REL,
    withCentrePosition = false,
    maxAttemptsFactor = 4,
} = {}) {
    const signs = [];
    const maxAttempts = Math.max(count, Math.ceil(count * maxAttemptsFactor));
    for (let attempt = 0; attempt < maxAttempts && signs.length < count; attempt += 1) {
        const layout = sampleConstellation({
            width: meta.width,
            height: meta.height,
            pointCount,
            random,
            withCentrePosition,
        });
        if (layout === null) continue;
        const measurement = measureConstellation({ rawPixels, meta, layout, patchRelative });
        signs.push({
            layout,
            measurement,
            record: buildConstellationRecord(layout, measurement),
            triples: constellationWords({
                edges: layout.edges,
                edgeDeltas: measurement.edgeDeltas,
            }),
        });
    }
    return signs;
}

/** `loadImagePixels` + `sampleSigns`, the shape both the trainer and the search use. */
async function sampleImageSigns(imagePath, { count, seed = null, ...options } = {}) {
    const { rawPixels, meta, source } = await loadImagePixels(imagePath, options);
    const signs = sampleSigns({
        rawPixels,
        meta,
        count,
        random: createRandom(seed),
        ...options,
    });
    return { signs, meta, source };
}

module.exports = {
    DEFAULT_WORKING_MAX_SIDE,
    loadImagePixels,
    sampleImageSigns,
    sampleSigns,
};
