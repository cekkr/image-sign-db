'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { openImage } = require('../src/lib/imageLoader');

test('openImage keeps ordinary images on the Sharp fast path', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-loader-direct-'));
    const filename = path.join(directory, 'ordinary.png');
    try {
        await sharp({
            create: {
                width: 8,
                height: 4,
                channels: 3,
                background: { r: 20, g: 40, b: 60 },
            },
        }).png().toFile(filename);

        const opened = await openImage(filename, { workingMaxSide: 4 });
        const result = await opened.image.raw().toBuffer({ resolveWithObject: true });
        assert.strictEqual(opened.decoder, 'sharp');
        assert.deepStrictEqual(opened.source, { width: 8, height: 4 });
        assert.strictEqual(result.info.width, 4);
        assert.strictEqual(result.info.height, 2);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('openImage falls back when a HEIF-family pixel decoder is unavailable', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-loader-fallback-'));
    const filename = path.join(directory, 'phone.heic');
    try {
        fs.writeFileSync(filename, 'a container the test Sharp cannot decode');
        const converted = await sharp({
            create: {
                width: 6,
                height: 3,
                channels: 3,
                background: { r: 90, g: 80, b: 70 },
            },
        }).png().toBuffer();
        const calls = [];
        const opened = await openImage(filename, {
            workingMaxSide: 3,
            converters: [[
                'test converter',
                async (input, options) => {
                    calls.push({ input, options });
                    return converted;
                },
            ]],
        });
        const result = await opened.image.raw().toBuffer({ resolveWithObject: true });

        assert.strictEqual(opened.decoder, 'test converter');
        assert.deepStrictEqual(opened.source, { width: 6, height: 3 });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].input, filename);
        assert.strictEqual(calls[0].options.workingMaxSide, 3);
        assert.strictEqual(result.info.width, 3);
        assert.strictEqual(result.info.height, 2);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('openImage reports every attempted decoder when none can read the image', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-loader-error-'));
    const filename = path.join(directory, 'broken.jxl');
    try {
        fs.writeFileSync(filename, 'not an image');
        await assert.rejects(
            openImage(filename, {
                converters: [
                    ['first decoder', async () => { throw new Error('missing codec'); }],
                    ['second decoder', async () => { throw new Error('also failed'); }],
                ],
            }),
            (error) => {
                assert.strictEqual(error.code, 'IMAGE_DECODE_FAILED');
                assert.match(error.message, /Sharp:/);
                assert.match(error.message, /first decoder: missing codec/);
                assert.match(error.message, /second decoder: also failed/);
                return true;
            }
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
