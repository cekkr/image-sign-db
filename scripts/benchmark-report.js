#!/usr/bin/env node
/**
 * Turn `node src/sign.js evaluate --report` documents into benchmark data.
 *
 *   node scripts/benchmark-report.js csv   <csv-file> <report.json>…
 *   node scripts/benchmark-report.js table <report.json>…
 *
 * `csv` appends one row per report, writing the header when the file is new, so
 * scores accumulate across sessions and a regression is visible as a diff.
 * `table` renders the reports side by side for the run that just happened.
 *
 * This lives in a file rather than inside benchmark.sh because JSON handling in
 * shell means either depending on `jq` or parsing the pretty console output —
 * and the console output is meant for people, so scraping it would make every
 * cosmetic change a silent benchmark break.
 */

const fs = require('fs');
const path = require('path');

/**
 * The CSV schema. Order is part of the file format: appending to an existing
 * CSV must not shift columns, so new fields go at the **end** of this list.
 */
const COLUMNS = [
    ['run', (report, file) => report.label || path.basename(file, '.json')],
    ['finished_at', (report) => report.finished_at],
    ['corpus', (report) => report.scores.corpus],
    ['images', (report) => report.scores.images],
    ['constellations_per_image', (report) => report.config.constellations_per_image],
    ['max_constellations', (report) => report.config.search.maxConstellations],
    ['point_count', (report) => report.config.point_count],
    ['working_max_side', (report) => report.config.working_max_side],
    ['layout_version', (report) => report.config.sign_layout_version],
    ['rank1', (report) => report.scores.rank1],
    ['rank1_rate', (report) => report.scores.rank1Rate],
    ['recall_at_k', (report) => report.scores.inCandidatesRate],
    ['mrr', (report) => report.scores.meanReciprocalRank],
    ['rank1_field_observations', (report) => report.scores.rank1ByFieldObservations],
    ['rank1_field_descriptor', (report) => report.scores.rank1ByFieldDescriptor],
    ['median_constellations', (report) => report.scores.medianConstellations],
    ['mean_constellations', (report) => report.scores.meanConstellations],
    ['mean_seeds', (report) => report.scores.meanSeeds],
    ['early_stop_rate', (report) => report.scores.earlyStopRate],
    ['mean_top_confidence', (report) => report.scores.meanTopConfidence],
    ['mean_separation', (report) => report.scores.meanSeparation],
    ['mean_search_seconds', (report) => report.scores.meanSearchSeconds],
    ['train_seconds_per_image', (report) => report.scores.trainSecondsPerImage],
    ['mean_words_per_image', (report) => report.scores.meanWordsPerImage],
    // Appended, not inserted: scores.csv is added to across sessions, so a new
    // column in the middle would shift every historical row.
    ['rank1_triple_features', (report) => report.scores.rank1ByTripleFeatures],
];

function readReport(file) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!report || !report.scores) {
        throw new Error(`${file} is not an evaluation report (no "scores")`);
    }
    return report;
}

/** CSV field escaping. Values are numbers and timestamps, but filenames are not. */
function csvField(value) {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'number' ? String(Number(value.toFixed(6))) : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Split one CSV line, honouring the quoting `csvField` produces. */
function splitCsvLine(line) {
    const fields = [];
    let current = '';
    let quoted = false;
    for (let at = 0; at < line.length; at += 1) {
        const character = line[at];
        if (quoted) {
            if (character === '"' && line[at + 1] === '"') { current += '"'; at += 1; continue; }
            if (character === '"') { quoted = false; continue; }
            current += character;
            continue;
        }
        if (character === '"') { quoted = true; continue; }
        if (character === ',') { fields.push(current); current = ''; continue; }
        current += character;
    }
    fields.push(current);
    return fields;
}

/**
 * Bring an existing `scores.csv` up to the current column list.
 *
 * Appending a column leaves the **header** describing fewer fields than the new
 * rows carry, and a reader that maps by header then silently drops or misreads
 * the new one. Since columns may only ever be appended, the old header must be a
 * prefix of the current one — if it is, the file is rewritten with the new header
 * and every historical row padded, which is lossless. If it is not, something was
 * renamed or reordered and the right answer is to say so rather than to guess
 * which column is which.
 */
function migrateCsv(resolved, names) {
    const existing = fs.readFileSync(resolved, 'utf8').replace(/\n$/, '');
    if (existing === '') return;
    const rows = existing.split('\n');
    const header = splitCsvLine(rows[0]);
    const headerMatches = header.length === names.length &&
        header.every((name, index) => name === names[index]);
    // A matching header is not on its own enough to skip the pass: rows can be
    // the wrong width underneath it, which is exactly what a bad earlier
    // migration leaves behind.
    if (headerMatches && rows.slice(1).every((row) => (
        row === '' || splitCsvLine(row).length === names.length
    ))) {
        return;
    }

    const isPrefix = header.length <= names.length &&
        header.every((name, index) => name === names[index]);
    if (!isPrefix) {
        throw new Error(
            `${path.basename(resolved)} has columns this reporter cannot extend ` +
            `(found ${header.length}, expected the first ${header.length} of ${names.length} to match). ` +
            'Columns may only be appended — move the old file aside rather than mixing layouts.'
        );
    }
    // Pad each row to the full width **individually**. A fixed delta looks
    // right and is wrong: a file can already hold rows of more than one width
    // (rows written after a column was added, before the header caught up), and
    // widening those again pushes them past the header. Splitting and re-emitting
    // is lossless because `splitCsvLine` and `csvField` round-trip.
    const migrated = [names.join(',')];
    for (const row of rows.slice(1)) {
        if (row === '') continue;
        const fields = splitCsvLine(row);
        // Trailing blanks on an over-wide row are padding, not data — drop them.
        // Anything else would lose a measurement, so refuse instead of guessing.
        while (fields.length > names.length && fields[fields.length - 1] === '') fields.pop();
        if (fields.length > names.length) {
            throw new Error(
                `${path.basename(resolved)} has a row of ${fields.length} populated fields against ` +
                `${names.length} columns; it was not written by this reporter. Move it aside.`
            );
        }
        while (fields.length < names.length) fields.push('');
        migrated.push(fields.map(csvField).join(','));
    }
    fs.writeFileSync(resolved, `${migrated.join('\n')}\n`);
}

function appendCsv(csvFile, files) {
    const resolved = path.resolve(csvFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const names = COLUMNS.map(([name]) => name);
    const lines = [];
    if (fs.existsSync(resolved)) {
        migrateCsv(resolved, names);
    } else {
        lines.push(names.join(','));
    }
    for (const file of files) {
        const report = readReport(file);
        lines.push(COLUMNS.map(([, read]) => csvField(read(report, file))).join(','));
    }
    fs.appendFileSync(resolved, `${lines.join('\n')}\n`);
    return resolved;
}

/**
 * `null` is rendered as `-`, never as `0`.
 *
 * A `--skip-train` run has no training time at all, which is not the same
 * measurement as training that took no time, and a benchmark that prints `0.0`
 * for both invites exactly the wrong conclusion.
 */
function fixed(value, digits, scale = 1) {
    return Number.isFinite(value) ? (value * scale).toFixed(digits) : '-';
}

const TABLE = [
    ['run', (report, file) => report.label || path.basename(file, '.json'), 'left'],
    ['corpus', (report) => report.scores.corpus],
    ['queried', (report) => report.scores.images],
    ['train/img', (report) => report.config.constellations_per_image ?? '-'],
    ['ceiling', (report) => report.config.search.maxConstellations],
    ['rank-1', (report) => `${report.scores.rank1}/${report.scores.images}`],
    ['rank-1 %', (report) => fixed(report.scores.rank1Rate, 1, 100)],
    ['recall@k', (report) => fixed(report.scores.inCandidatesRate, 1, 100)],
    ['MRR', (report) => fixed(report.scores.meanReciprocalRank, 3)],
    ['med.const', (report) => report.scores.medianConstellations ?? '-'],
    ['early %', (report) => fixed(report.scores.earlyStopRate, 1, 100)],
    ['sep', (report) => fixed(report.scores.meanSeparation, 2)],
    ['search s', (report) => fixed(report.scores.meanSearchSeconds, 2)],
    ['train s/img', (report) => fixed(report.scores.trainSecondsPerImage, 1)],
];

function renderTable(files) {
    const rows = files.map((file) => {
        const report = readReport(file);
        return TABLE.map(([, read]) => String(read(report, file)));
    });
    const headers = TABLE.map(([name]) => name);
    const widths = headers.map((header, column) => Math.max(
        header.length,
        ...rows.map((row) => row[column].length)
    ));
    const pad = (text, column) => (
        TABLE[column][2] === 'left' ? text.padEnd(widths[column]) : text.padStart(widths[column])
    );

    const out = [headers.map(pad).join('  ')];
    out.push(widths.map((width) => '-'.repeat(width)).join('  '));
    for (const row of rows) out.push(row.map(pad).join('  '));
    return out.join('\n');
}

function main() {
    const [command, ...rest] = process.argv.slice(2);
    if (command === 'csv') {
        const [csvFile, ...files] = rest;
        if (!csvFile || files.length === 0) throw new Error('usage: benchmark-report.js csv <csv> <report…>');
        console.log(appendCsv(csvFile, files));
        return;
    }
    if (command === 'table') {
        if (rest.length === 0) throw new Error('usage: benchmark-report.js table <report…>');
        console.log(renderTable(rest));
        return;
    }
    console.error('usage: benchmark-report.js csv <csv> <report…> | table <report…>');
    process.exitCode = 1;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`✗ ${error.message}`);
        process.exit(1);
    }
}

module.exports = { COLUMNS, appendCsv, csvField, migrateCsv, renderTable, splitCsvLine };
