#!/usr/bin/env node

// --- LIBRARIES ---
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- INTERNAL MODULES ---
const { extractAndStoreFeatures } = require('./featureExtractor');
const { discoverCorrelations, createDbConnection } = require('./lib/knowledge');

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

async function removeImageSign(identifier) {
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
        similarityThreshold: 0.1,
        onIterationStart(iteration, total) {
            if (iteration === 1) {
                console.log(`\n🔁 Starting correlation sweep for ${total} iteration(s)`);
            }
        },
        onDiscriminatorSelected({ iterationNumber, startFeature, discriminatorFeature, metrics, ambiguousCandidates }) {
            console.log(
                `  [${iterationNumber}] Learned correlation ${startFeature.vector_type} ↦ ${discriminatorFeature.vector_type} ` +
                `(spread=${metrics.spread.toFixed(4)}, affinity=${metrics.affinity.toFixed(4)}, candidates=${ambiguousCandidates})`
            );
        },
    });
}

async function handleAddCommand(positional, options) {
    const imagePath = positional[0];
    if (!imagePath) {
        throw new Error('Missing image path. Usage: node src/insert.js add <path_to_image> [--discover=25]');
    }

    const resolvedPath = path.resolve(process.cwd(), imagePath);
    console.log(`\n📥 Ingesting image: ${resolvedPath}`);
    const { imageId, featureCount } = await extractAndStoreFeatures(resolvedPath);
    console.log(`   → Stored ${featureCount} feature vectors (image_id=${imageId})`);

    const discoverIterations = Number.parseInt(options.discover ?? '0', 10);
    if (discoverIterations > 0) {
        await runCorrelationDiscovery(discoverIterations);
    }
}

async function handleRemoveCommand(positional) {
    const identifier = positional[0];
    if (!identifier) {
        throw new Error('Missing image identifier. Usage: node src/insert.js remove <image_id|original_filename>');
    }

    const result = await removeImageSign(identifier);
    if (!result.removed) {
        console.log(`⚠️  Nothing removed: ${result.reason}`);
    } else {
        console.log(`🗑️  Removed image ID ${result.imageId} and associated vectors.`);
    }
}

async function handleBootstrapCommand(positional, options) {
    const iterations = Number.parseInt(positional[0] ?? options.iterations ?? '75', 10);
    if (Number.isNaN(iterations) || iterations <= 0) {
        throw new Error('Bootstrap requires a positive number of iterations.');
    }

    console.log(`\n🧠 Bootstrapping correlations for ${iterations} iteration(s)`);
    await runCorrelationDiscovery(iterations);
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
