'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    IMAGE_EXTENSIONS,
    isImageFile,
    partitionImageNames,
    describeSkipped,
} = require('../src/lib/imageFiles');

// The whole point of this module is that there is exactly one list. A second
// copy is what made the same directory two different corpora depending on which
// command read it, so the regression to guard is "someone wrote the set again".
test('both pipelines read the shared extension list rather than their own', () => {
    const signSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'sign.js'), 'utf8');
    const trainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'train.js'), 'utf8');

    for (const [label, source] of [['sign.js', signSource], ['train.js', trainSource]]) {
        assert.ok(
            source.includes("require('./lib/imageFiles')"),
            `${label} must take its extension list from src/lib/imageFiles.js`
        );
        assert.ok(
            !/new Set\(\[\s*'\.jpg'/.test(source),
            `${label} declares its own image-extension set again; there must be only one`
        );
    }
});

test('the shared list is what sharp can actually decode', () => {
    const sharp = require('sharp');
    const formatFor = {
        '.jpg': 'jpeg',
        '.jpeg': 'jpeg',
        '.jpe': 'jpeg',
        '.jfif': 'jpeg',
        '.png': 'png',
        '.webp': 'webp',
        '.tif': 'tiff',
        '.tiff': 'tiff',
        '.gif': 'gif',
        '.svg': 'svg',
        '.svgz': 'svg',
    };
    for (const extension of IMAGE_EXTENSIONS) {
        const format = formatFor[extension];
        // .bmp has no `sharp.format` entry of its own; it is read through the
        // magick/other loaders, so it is exempt from this check rather than
        // silently asserted.
        if (!format) continue;
        assert.ok(
            sharp.format[format] && sharp.format[format].input.file,
            `${extension} is accepted but sharp cannot read ${format} as a file`
        );
    }
});

test('HEIF-family files are candidates and unrelated extensions are reported', () => {
    const { accepted, skipped } = partitionImageNames([
        'a.jpg',
        'b.JPG',
        'c.heic',
        'd.heif',
        'e.avif',
        'notes.md',
    ]);

    assert.deepStrictEqual(
        accepted,
        ['a.jpg', 'b.JPG', 'c.heic', 'd.heif', 'e.avif'],
        'case and HEIF codec spelling must not decide candidacy'
    );

    const markdown = skipped.find((entry) => entry.extension === '.md');
    assert.ok(markdown, 'an unknown extension is still reported');
    assert.strictEqual(markdown.reason, 'not a supported image extension');
});

test('an extensionless file is not reported as a rejected image', () => {
    const { accepted, skipped } = partitionImageNames(['README', 'LICENSE', 'a.png']);
    assert.deepStrictEqual(accepted, ['a.png']);
    assert.deepStrictEqual(skipped, [], 'strays without an extension are not image candidates');
});

test('the skip notice counts per extension, not per file', () => {
    const { skipped } = partitionImageNames(['1.xyz', '2.xyz', '3.xyz', '4.md']);
    const lines = describeSkipped(skipped).split('\n');
    assert.strictEqual(lines.length, 2, 'forty photos of one kind are one line, not forty');
    assert.ok(lines.some((line) => line.startsWith('3 .xyz file(s) skipped')), lines.join(' | '));
    assert.ok(lines.some((line) => line.startsWith('1 .md file(s) skipped')), lines.join(' | '));
    assert.strictEqual(describeSkipped([]), '', 'nothing skipped says nothing');
});

test('isImageFile accepts a caller-supplied narrower set', () => {
    const onlyPng = new Set(['.png']);
    assert.ok(isImageFile('a.png', onlyPng));
    assert.ok(!isImageFile('a.jpg', onlyPng), 'a narrower set is honoured, not merged with the default');
    assert.ok(isImageFile('a.jpg'), 'and the default is still the shared list');
});

test('common fallback formats are present in the shared candidate set', () => {
    for (const extension of ['.heic', '.heif', '.avif', '.jxl', '.jp2', '.dng']) {
        assert.ok(IMAGE_EXTENSIONS.has(extension), `${extension} must reach the shared decoder`);
    }
});

// collectImages is the sign pipeline's entry point and the one benchmark.sh
// reads its image count from, so its notice must not reach stdout.
test('collectImages reports skips on stderr and returns only readable files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-files-test-'));
    try {
        for (const name of ['b.jpg', 'a.jpg', 'phone.heic', 'skip.md', '.DS_Store']) {
            fs.writeFileSync(path.join(dir, name), '');
        }
        const { collectImages } = require('../src/sign');

        const warnings = [];
        const originalWarn = console.warn;
        const originalLog = console.log;
        const logs = [];
        console.warn = (...args) => warnings.push(args.join(' '));
        console.log = (...args) => logs.push(args.join(' '));
        let files;
        try {
            files = collectImages(dir);
        } finally {
            console.warn = originalWarn;
            console.log = originalLog;
        }

        assert.deepStrictEqual(
            files.map((file) => path.basename(file)),
            ['a.jpg', 'b.jpg', 'phone.heic'],
            'the listing is sorted and holds image candidates for the decoder'
        );
        assert.strictEqual(logs.length, 0, 'the notice must not land on stdout; benchmark.sh parses it');
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /\.md/);

        const quietWarnings = [];
        console.warn = (...args) => quietWarnings.push(args.join(' '));
        try {
            collectImages(dir, { quiet: true });
        } finally {
            console.warn = originalWarn;
        }
        assert.strictEqual(quietWarnings.length, 0, 'quiet:true suppresses the notice');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
