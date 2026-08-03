// Shared image opening with a fallback for codecs omitted from Sharp's bundled
// libvips build. Sharp remains the normal path; external converters are only
// tried for formats whose extensions commonly need an optional decoder.

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const MAX_CONVERTED_BYTES = 128 * 1024 * 1024;

// These are candidate image formats, not promises about one particular Sharp
// binary. The fallback chain lets the host's codec stack supply what libvips
// cannot (notably HEVC-backed HEIC in Sharp's prebuilt binaries).
const FALLBACK_IMAGE_EXTENSIONS = new Set([
    '.heic', '.heif', '.avif',
    '.jp2', '.j2c', '.j2k', '.jpf', '.jpm', '.jpx', '.mj2',
    '.jxl',
    '.dng', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.srf', '.sr2',
    '.orf', '.rw2', '.raf', '.pef', '.x3f',
    '.psd', '.psb', '.xcf',
    '.exr', '.hdr', '.tga', '.dds', '.ico', '.cur',
    '.pbm', '.pgm', '.pnm', '.ppm',
]);

function sourceSize(metadata) {
    return {
        width: Number(metadata?.width) || 0,
        height: Number(metadata?.height) || 0,
    };
}

function transformedPipeline(input, { autoOrient, workingMaxSide }) {
    let image = sharp(input, { failOn: 'none' });
    if (autoOrient) image = image.rotate();
    if (workingMaxSide > 0) {
        image = image.resize({
            width: workingMaxSide,
            height: workingMaxSide,
            fit: 'inside',
            withoutEnlargement: true,
        });
    }
    return image;
}

function runProcess(command, args, { maxStdout = MAX_CONVERTED_BYTES } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;

        const fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        child.stdout.on('data', (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxStdout) {
                child.kill('SIGKILL');
                fail(new Error(`${command} produced more than ${maxStdout} bytes`));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            // Converter diagnostics are useful, but do not let a noisy process
            // turn one bad input into unbounded memory use.
            if (stderrBytes >= 64 * 1024) return;
            const remaining = 64 * 1024 - stderrBytes;
            stderr.push(chunk.subarray(0, remaining));
            stderrBytes += Math.min(chunk.length, remaining);
        });
        child.once('error', fail);
        child.once('close', (code, signal) => {
            if (settled) return;
            settled = true;
            if (code === 0) {
                resolve(Buffer.concat(stdout));
                return;
            }
            const detail = Buffer.concat(stderr).toString('utf8').trim().replace(/\s+/g, ' ');
            reject(new Error(
                `${command} exited ${code ?? signal ?? 'without a status'}${detail ? `: ${detail}` : ''}`
            ));
        });
    });
}

function resizeGeometry(workingMaxSide) {
    return workingMaxSide > 0 ? `${workingMaxSide}x${workingMaxSide}>` : null;
}

async function convertWithImageMagick(imagePath, options) {
    const args = [path.resolve(imagePath), '-delete', '1--1'];
    if (options.autoOrient) args.push('-auto-orient');
    const geometry = resizeGeometry(options.workingMaxSide);
    if (geometry) args.push('-resize', geometry);
    // The first image/page is the source image for recognition. `png:-` gives
    // Sharp a boring, lossless interchange format without a temporary file.
    args.push('-strip', 'png:-');
    return runProcess('magick', args);
}

async function convertWithFfmpeg(imagePath, options) {
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (!options.autoOrient) args.push('-noautorotate');
    args.push('-i', path.resolve(imagePath), '-map', '0:v:0');
    if (options.workingMaxSide > 0) {
        const side = options.workingMaxSide;
        args.push(
            '-vf',
            `scale=${side}:${side}:force_original_aspect_ratio=decrease:force_divisible_by=2`
        );
    }
    args.push('-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1');
    return runProcess('ffmpeg', args);
}

async function convertWithSips(imagePath, options) {
    if (process.platform !== 'darwin') throw new Error('sips is only available on macOS');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'image-sign-decode-'));
    const output = path.join(temporary, 'decoded.png');
    try {
        const args = ['-s', 'format', 'png'];
        if (options.workingMaxSide > 0) args.push('-Z', String(options.workingMaxSide));
        args.push(path.resolve(imagePath), '--out', output);
        await runProcess('/usr/bin/sips', args, { maxStdout: 1024 * 1024 });
        return await fs.readFile(output);
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

const DEFAULT_CONVERTERS = Object.freeze([
    ['ImageMagick', convertWithImageMagick],
    ['macOS sips', convertWithSips],
    ['FFmpeg', convertWithFfmpeg],
]);

function conciseError(error) {
    return String(error?.message || error).trim().replace(/\s+/g, ' ');
}

/**
 * Return a Sharp pipeline for one image.
 *
 * Formats in FALLBACK_IMAGE_EXTENSIONS get a one-pixel decode probe because
 * `metadata()` alone is not proof of readability: libheif can parse an HEIC
 * container and then fail only when it sees HEVC-compressed pixels. If that
 * happens, converters are tried in order and their lossless PNG is handed back
 * to Sharp. Ordinary formats avoid the extra probe and keep the old fast path.
 */
async function openImage(imagePath, {
    autoOrient = false,
    workingMaxSide = 0,
    converters = DEFAULT_CONVERTERS,
} = {}) {
    const extension = path.extname(imagePath).toLowerCase();
    let metadata = null;
    let directError = null;

    try {
        const direct = sharp(imagePath, { failOn: 'none' });
        metadata = await direct.metadata();
        if (FALLBACK_IMAGE_EXTENSIONS.has(extension)) {
            await direct.clone().resize(1, 1, { fit: 'inside' }).raw().toBuffer();
        }
        return {
            image: transformedPipeline(imagePath, { autoOrient, workingMaxSide }),
            source: sourceSize(metadata),
            decoder: 'sharp',
        };
    } catch (error) {
        directError = error;
    }

    const failures = [];
    for (const [name, convert] of converters) {
        try {
            const converted = await convert(imagePath, { autoOrient, workingMaxSide });
            const convertedMetadata = await sharp(converted, { failOn: 'none' }).metadata();
            return {
                // Converters already apply the requested bound. Applying it a
                // second time is harmless and protects injected/custom ones.
                image: transformedPipeline(converted, { autoOrient: false, workingMaxSide }),
                source: sourceSize(metadata || convertedMetadata),
                decoder: name,
            };
        } catch (error) {
            failures.push(`${name}: ${conciseError(error)}`);
        }
    }

    const message = [
        `cannot decode image ${imagePath}`,
        `Sharp: ${conciseError(directError)}`,
        ...failures,
    ].join('\n  ');
    const error = new Error(message, { cause: directError });
    error.code = 'IMAGE_DECODE_FAILED';
    throw error;
}

module.exports = {
    DEFAULT_CONVERTERS,
    FALLBACK_IMAGE_EXTENSIONS,
    openImage,
};
