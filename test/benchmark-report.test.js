// The benchmark reporter.
//
// Small, but it owns a file format: `benchmarks/scores.csv` is appended to
// across sessions, so column *order* is a contract — a new field inserted in
// the middle silently shifts every historical row one column to the right and
// every past score becomes a lie. That is the property worth a test.
//
// The other one is that `null` never renders as `0`. A --skip-train run has no
// training time at all, which is a different fact from training that took no
// time, and a table that prints 0.0 for both invites the wrong conclusion.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
    COLUMNS,
    appendCsv,
    csvField,
    renderTable,
    splitCsvLine,
} = require('../scripts/benchmark-report');

function makeReport(overrides = {}) {
    // `scores` is merged, not replaced: a test that wants one null score should
    // not have to restate every other one.
    const { scores: scoreOverrides, ...rest } = overrides;
    return {
        label: 'run-a',
        started_at: '2026-07-30T08:00:00.000Z',
        finished_at: '2026-07-30T08:10:00.000Z',
        images_dir: ['/tmp/images'],
        config: {
            sign_layout_version: 1,
            word_cardinality: 73728,
            database: 'bench',
            constellations_per_image: 600,
            trained_this_run: true,
            point_count: 5,
            point_patch_relative: 0.004,
            working_max_side: 1024,
            with_centre_position: false,
            search: { maxConstellations: 240, rerankTop: 5 },
        },
        training: null,
        search: [],
        ...rest,
        scores: {
            corpus: 11,
            images: 11,
            rank1: 11,
            rank1Rate: 1,
            inCandidates: 11,
            inCandidatesRate: 1,
            meanReciprocalRank: 1,
            rank1ByFieldObservations: 3,
            rank1ByFieldDescriptor: 1,
            rank1ByTripleFeatures: 8,
            meanConstellations: 120,
            medianConstellations: 96,
            meanSeeds: 300,
            earlyStops: 5,
            earlyStopRate: 5 / 11,
            meanTopConfidence: 0.21,
            meanSeparation: 1.7,
            meanSearchSeconds: 1.25,
            trainSecondsPerImage: 94.5,
            meanWordsPerImage: 3900,
            ...(scoreOverrides || {}),
        },
    };
}

function withTempDir(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-report-'));
    try {
        return run(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function writeReport(dir, name, report) {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(report));
    return file;
}

test('the CSV header is written once and rows append under it', () => {
    withTempDir((dir) => {
        const csv = path.join(dir, 'nested', 'scores.csv');
        appendCsv(csv, [writeReport(dir, 'a', makeReport())]);
        appendCsv(csv, [writeReport(dir, 'b', makeReport({ label: 'run-b' }))]);

        const lines = fs.readFileSync(csv, 'utf8').trim().split('\n');
        assert.equal(lines.length, 3, 'header plus one row per report');
        assert.equal(lines[0], COLUMNS.map(([name]) => name).join(','));
        assert.equal(lines[1].split(',')[0], 'run-a');
        assert.equal(lines[2].split(',')[0], 'run-b');
        // Every row must have exactly as many fields as the header claims.
        for (const line of lines) {
            assert.equal(line.split(',').length, COLUMNS.length, line);
        }
    });
});

test('the run id falls back to the file name when the report has no label', () => {
    withTempDir((dir) => {
        const csv = path.join(dir, 'scores.csv');
        appendCsv(csv, [writeReport(dir, 'c600-m240', makeReport({ label: null }))]);
        assert.equal(fs.readFileSync(csv, 'utf8').trim().split('\n')[1].split(',')[0], 'c600-m240');
    });
});

test('a missing score is an empty field, never a zero', () => {
    withTempDir((dir) => {
        const csv = path.join(dir, 'scores.csv');
        const report = makeReport({ scores: { trainSecondsPerImage: null, meanSeparation: null } });
        appendCsv(csv, [writeReport(dir, 'skip', report)]);

        const header = COLUMNS.map(([name]) => name);
        const fields = fs.readFileSync(csv, 'utf8').trim().split('\n')[1].split(',');
        assert.equal(fields[header.indexOf('train_seconds_per_image')], '');
        assert.equal(fields[header.indexOf('mean_separation')], '');
        assert.equal(fields[header.indexOf('rank1_rate')], '1');
    });
});

test('appending a column migrates the header and pads history', () => {
    withTempDir((dir) => {
        const csv = path.join(dir, 'scores.csv');
        const names = COLUMNS.map(([name]) => name);

        // A file written across a column addition: a stale header, one row of
        // the old width, and one row already carrying the newer column. Rows of
        // mixed width in one file is the case a fixed padding delta gets wrong.
        const oldNames = names.slice(0, names.length - 2);
        const shortRow = oldNames.map((_, index) => (index === 0 ? '"run,one"' : String(index)));
        const widerRow = names.slice(0, names.length - 1).map((_, index) => (
            index === 0 ? 'run-two' : String(index)
        ));
        fs.writeFileSync(csv, [oldNames.join(','), shortRow.join(','), widerRow.join(',')].join('\n') + '\n');

        appendCsv(csv, [writeReport(dir, 'new', makeReport({ label: 'new' }))]);
        const lines = fs.readFileSync(csv, 'utf8').trim().split('\n');

        assert.equal(lines[0], names.join(','), 'the header must describe the current columns');
        for (const line of lines) {
            assert.equal(splitCsvLine(line).length, names.length, line);
        }
        // Both historical rows keep their values, quoting intact, and gain blanks.
        const historical = splitCsvLine(lines[1]);
        assert.equal(historical[0], 'run,one');
        assert.equal(historical[1], '1');
        assert.equal(historical[names.length - 1], '');
        assert.equal(splitCsvLine(lines[2])[0], 'run-two');
        assert.equal(splitCsvLine(lines[2])[names.length - 1], '');
        assert.equal(splitCsvLine(lines[3])[0], 'new');
    });
});

test('an over-wide row is trimmed when the extra field is blank, refused when it is not', () => {
    withTempDir((dir) => {
        const names = COLUMNS.map(([name]) => name);
        const row = (extra) => [...names.map((_, index) => String(index)), extra].join(',');

        // Trailing blank: padding written by a bad migration, safe to drop.
        const trimmable = path.join(dir, 'trimmable.csv');
        fs.writeFileSync(trimmable, `${names.join(',')}\n${row('')}\n`);
        appendCsv(trimmable, [writeReport(dir, 'ok', makeReport())]);
        for (const line of fs.readFileSync(trimmable, 'utf8').trim().split('\n')) {
            assert.equal(splitCsvLine(line).length, names.length, line);
        }

        // Trailing value: dropping it would lose a measurement.
        const corrupt = path.join(dir, 'corrupt.csv');
        fs.writeFileSync(corrupt, `${names.join(',')}\n${row('99')}\n`);
        assert.throws(
            () => appendCsv(corrupt, [writeReport(dir, 'bad', makeReport())]),
            /populated fields against/
        );
    });
});

test('a reordered or renamed column is refused, not guessed at', () => {
    withTempDir((dir) => {
        const csv = path.join(dir, 'scores.csv');
        const names = COLUMNS.map(([name]) => name);
        const scrambled = [names[1], names[0], ...names.slice(2)];
        fs.writeFileSync(csv, `${scrambled.join(',')}\n`);

        assert.throws(
            () => appendCsv(csv, [writeReport(dir, 'x', makeReport())]),
            /columns this reporter cannot extend/
        );
    });
});

test('splitCsvLine round-trips what csvField produces', () => {
    const values = ['plain', 'a,b', 'say "hi"', 'two\nlines', '', '0.5'];
    assert.deepEqual(splitCsvLine(values.map(csvField).join(',')), values);
});

test('csvField escapes anything that would break the row', () => {
    assert.equal(csvField('plain'), 'plain');
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
    assert.equal(csvField('two\nlines'), '"two\nlines"');
    assert.equal(csvField(null), '');
    assert.equal(csvField(undefined), '');
    // Floats are trimmed to six decimals so a rerun does not diff on noise.
    assert.equal(csvField(1 / 3), '0.333333');
    assert.equal(csvField(0), '0');
});

test('the table renders a missing measurement as a dash', () => {
    withTempDir((dir) => {
        const trained = writeReport(dir, 'trained', makeReport({ label: 'trained' }));
        const skipped = writeReport(dir, 'skipped', makeReport({
            label: 'skipped',
            scores: { trainSecondsPerImage: null, meanSeparation: null },
        }));
        const lines = renderTable([trained, skipped]).split('\n');

        assert.equal(lines.length, 4, 'header, rule, one row per report');
        assert.match(lines[0], /run\s+corpus\s+queried/);
        assert.match(lines[2], /94\.5/);
        assert.match(lines[3], /\s-\s*$/, 'the untrained run must end in a dash, not 0.0');
        assert.doesNotMatch(lines[3], /0\.00\s+-?$/);
        // Columns line up: every row is the same width as the rule.
        assert.equal(lines[2].length, lines[1].length);
        assert.equal(lines[3].length, lines[1].length);
    });
});

test('a document without scores is refused rather than half-read', () => {
    withTempDir((dir) => {
        const file = path.join(dir, 'not-a-report.json');
        fs.writeFileSync(file, JSON.stringify({ hello: 'world' }));
        assert.throws(() => renderTable([file]), /not an evaluation report/);
        assert.throws(() => appendCsv(path.join(dir, 'scores.csv'), [file]), /not an evaluation report/);
    });
});
