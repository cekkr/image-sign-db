#!/usr/bin/env node

// --- LIBRARIES ---
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- INTERNAL MODULES ---
const { extractAndStoreFeatures } = require('./featureExtractor');
const settings = require('./settings');
const { discoverCorrelations, createDbConnection } = require('./lib/knowledge');
const { ensureStorageCapacity } = require('./lib/storageManager');
const { ensureValueTypeCapacity } = require('./lib/schema');

const DB_SCHEMA = settings.database.schema;

// --- HELPERS ---

function parseArgs(argv) {
    const args = argv.slice(2);
    const command = args[0];
    const rest = args.slice(1);

    const options = {};
    const positional = [];

    for (const token of rest) {
        if (token.startsWith('--')) {
            const [key, rawValue] = token.slice(2).split('=');
            const value = rawValue ?? true;
            options[key] = value;
        } else {
            positional.push(token);
        }
    }

    return { command, positional, options };
}

async function removeImage(identifier) {
    const connection = await createDbConnection();
    try {
        let imageId = null;
        if (/^\d+$/.test(identifier)) {
            imageId = Number.parseInt(identifier, 10);
        } else {
            const [rows] = await connection.execute(
                'SELECT image_id FROM images WHERE original_filename = ?',
                [identifier]
            );
            if (rows.length === 0) {
                return { removed: false, reason: `No image found with filename '${identifier}'` };
            }
            imageId = rows[0].image_id;
        }

        const [result] = await connection.execute('DELETE FROM images WHERE image_id = ?', [imageId]);
        if (result.affectedRows === 0) {
            return { removed: false, reason: `Image ID ${imageId} not found.` };
        }
        return { removed: true, imageId };
    } finally {
        await connection.end();
    }
}

async function runCorrelationDiscovery(iterations) {
    if (!iterations || iterations <= 0) return;
    await discoverCorrelations({
        iterations,
        similarityThreshold: settings.correlation.similarityThreshold,
        onIterationStart(iteration, total) {
            if (iteration === 1) {
                console.log(`\n🔁 Starting correlation sweep for ${total} iteration(s)`);
            }
        },
        onDiscriminatorSelected({ iterationNumber, startFeature, discriminatorFeature, metrics, ambiguousCandidates }) {
            const startChannel = startFeature.descriptor?.channel ?? `#${startFeature.value_type}`;
            const discChannel = discriminatorFeature.descriptor?.channel ?? `#${discriminatorFeature.value_type}`;
            console.log(
                `  [${iterationNumber}] Learned correlation ${startChannel} (res=${startFeature.resolution_level}) ` +
                `→ ${discChannel} (res=${discriminatorFeature.resolution_level}) ` +
                `(cohesion=${Number(metrics?.cohesion ?? 0).toFixed(4)}, affinity=${Number(metrics?.affinity ?? 0).toFixed(4)}, candidates=${ambiguousCandidates})`
            );
        },
    });

    const db = await createDbConnection();
    try {
        await ensureStorageCapacity(db, DB_SCHEMA);
    } finally {
        await db.end();
    }
}

async function ingestImage(imagePath, discoverIterations = 0) {
    const resolvedPath = path.resolve(process.cwd(), imagePath);
    console.log(`\n📥 Ingesting image: ${resolvedPath}`);
    const { imageId, featureCount } = await extractAndStoreFeatures(resolvedPath);
    console.log(`   → Stored ${featureCount} feature vectors (image_id=${imageId})`);

    if (discoverIterations > 0) {
        await runCorrelationDiscovery(discoverIterations);
    } else {
        const db = await createDbConnection();
        try {
            await ensureStorageCapacity(db, DB_SCHEMA);
        } finally {
            await db.end();
        }
    }

    return { imageId, featureCount };
}

async function handleAddCommand(positional, options) {
    const imagePath = positional[0];
    if (!imagePath) {
        throw new Error('Missing image path. Usage: node src/insert.js add <path_to_image> [--discover=25]');
    }

    const discoverIterations = Number.parseInt(options.discover ?? '0', 10);
    await ensureValueTypeCapacity();
    await ingestImage(imagePath, discoverIterations);
}

async function handleRemoveCommand(positional) {
    const identifier = positional[0];
    if (!identifier) {
        throw new Error('Missing image identifier. Usage: node src/insert.js remove <image_id|original_filename>');
    }

    const result = await removeImage(identifier);
    if (!result.removed) {
        console.log(`⚠️  Nothing removed: ${result.reason}`);
    } else {
        console.log(`🗑️  Removed image ID ${result.imageId} and associated vectors.`);
        const db = await createDbConnection();
        try {
            await ensureStorageCapacity(db, DB_SCHEMA);
        } finally {
            await db.end();
        }
    }
}

async function bootstrapCorrelations(iterations) {
    const total = Number.parseInt(iterations, 10);
    if (Number.isNaN(total) || total <= 0) {
        throw new Error('Bootstrap requires a positive number of iterations.');
    }

    console.log(`\n🧠 Bootstrapping correlations for ${total} iteration(s)`);
    await runCorrelationDiscovery(total);
}

async function handleBootstrapCommand(positional, options) {
    const iterations = positional[0] ?? options.iterations ?? settings.training.bootstrapCommandDefaultIterations;
    await bootstrapCorrelations(iterations);
}

async function main() {
    const { command, positional, options } = parseArgs(process.argv);

    try {
        switch (command) {
            case 'add':
                await handleAddCommand(positional, options);
                break;
            case 'remove':
                await handleRemoveCommand(positional);
                break;
            case 'bootstrap':
                await handleBootstrapCommand(positional, options);
                break;
            default:
                console.log('Usage:');
                console.log('  node src/insert.js add <path_to_image> [--discover=25]');
                console.log('  node src/insert.js remove <image_id|original_filename>');
                console.log('  node src/insert.js bootstrap [iterations]');
                process.exit(command ? 1 : 0);
        }
    } catch (error) {
        console.error(`\n❌ ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    ingestImage,
    removeImage,
    bootstrapCorrelations,
};
