// One answer to "is this file an image we can read", shared by both pipelines.
//
// It used to be two answers. `src/sign.js` accepted tif/tiff/gif and
// `src/train.js` did not, which meant the same directory was a different corpus
// depending on which command you pointed at it — silently, because both simply
// filtered and moved on. Nothing chose that divergence; it is what happens when
// a list is written twice.
//
// The list is the union, because there is no property of either pipeline that
// makes a TIFF readable by one and not the other: both decode through the
// shared image loader. Sharp is the fast path; optional host converters cover
// formats such as HEVC-backed HEIC that Sharp's prebuilt codec stack omits.
// If a pipeline ever does need a narrower set, it should pass one explicitly
// rather than keep a second copy of the default.
//
// The other half of this module is that a skipped file gets *said*. A corpus
// that quietly drops `IMG_4965.heic` is a validation run scoring itself on a
// dataset nobody agreed to, and the first place that shows up is a benchmark
// row whose image count nobody can reproduce.

const path = require('path');
const { FALLBACK_IMAGE_EXTENSIONS } = require('./imageLoader');

// Image candidates both pipelines accept. Lowercase, with the dot, because
// that is what `path.extname` returns. Some use the fallback codec chain rather
// than the bundled Sharp decoder.
const IMAGE_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.jpe',
    '.jfif',
    '.png',
    '.webp',
    '.tif',
    '.tiff',
    '.bmp',
    '.gif',
    '.svg',
    '.svgz',
    ...FALLBACK_IMAGE_EXTENSIONS,
]);

function isImageFile(name, extensions = IMAGE_EXTENSIONS) {
    return extensions.has(path.extname(name).toLowerCase());
}

// partitionImageNames splits a flat list of names into what will be read and
// what will not, keeping the reason for each rejection. Callers decide how
// loudly to report; this module does not print.
function partitionImageNames(names, extensions = IMAGE_EXTENSIONS) {
    const accepted = [];
    const skipped = [];
    for (const name of names) {
        if (isImageFile(name, extensions)) {
            accepted.push(name);
            continue;
        }
        const extension = path.extname(name).toLowerCase();
        // A file with no extension is far more likely to be a stray (.DS_Store,
        // a README) than an image, so it is not worth a reason of its own.
        if (extension === '') continue;
        skipped.push({
            name,
            extension,
            reason: 'not a supported image extension',
        });
    }
    return { accepted, skipped };
}

// describeSkipped renders one line per distinct extension, not per file: a
// directory holding forty `.heic` photos should say so once.
function describeSkipped(skipped) {
    if (!skipped || skipped.length === 0) return '';
    const byExtension = new Map();
    for (const entry of skipped) {
        const bucket = byExtension.get(entry.extension);
        if (bucket) { bucket.count += 1; continue; }
        byExtension.set(entry.extension, { count: 1, reason: entry.reason });
    }
    return [...byExtension.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([extension, { count, reason }]) => `${count} ${extension} file(s) skipped — ${reason}`)
        .join('\n');
}

module.exports = {
    IMAGE_EXTENSIONS,
    isImageFile,
    partitionImageNames,
    describeSkipped,
};
