// --- LIBRARIES ---
const fs = require('fs/promises');
const {
    generateSpecificVector,
} = require('./featureExtractor.js');

// --- CONFIGURATION ---
const API_BASE_URL = 'http://localhost:3000';

// --- MAIN LOGIC ---

async function findImageRemotely(imagePath) {
    try {
        await fs.access(imagePath);
    } catch (error) {
        console.error(`❌ Error: Image not found at ${imagePath}`);
        return;
    }

    console.log(`🔎 Starting remote search for: ${imagePath}`);
    // 1. Request the initial probe from the server
    let response = await fetch(`${API_BASE_URL}/search/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestProbe: true })
    });
    
    let result = await response.json();
    if (result.status !== 'REQUEST_PROBE' || !result.probeSpec) {
        console.error('❌ Server did not return an initial probe.');
        console.error(result);
        return;
    }
    let sessionId = result.sessionId;
    const probeSpec = result.probeSpec;
    console.log(`  Server selected descriptor ${probeSpec.descriptorKey} (grid ${probeSpec.gridSize})`);

    const probeVector = await generateSpecificVector(imagePath, probeSpec);
    if (!probeVector) {
        console.error("Could not generate initial probe vector from server request.");
        return;
    }

    const probe = {
        ...probeSpec,
        value: probeVector.value,
        size: probeVector.size,
    };

    response = await fetch(`${API_BASE_URL}/search/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, probe })
    });
    
    result = await response.json();
    sessionId = result.sessionId ?? sessionId;
    console.log(`  Initial probe found ${result.candidates?.length || 0} candidates.`);
    if (result.constellationPath?.length) {
        const last = result.constellationPath[result.constellationPath.length - 1];
        console.log(
            `  ✨ Constellation accuracy after ${result.constellationPath.length} step(s): ${(last?.cumulativeAccuracy ?? 0).toFixed(6)}`
        );
    }
    
    // 2. Iteratively refine the search based on server requests
    let iterations = 0;
    while (result.status === 'CANDIDATES_FOUND' && result.nextQuestion && iterations < 10) {
        iterations++;
        const nextQuestion = result.nextQuestion;
        if (!nextQuestion) break;

        console.log(`  [Iteration ${iterations}] Server requests descriptor ${nextQuestion.descriptorKey} (channel: ${nextQuestion.descriptor?.channel ?? '?'}) at grid ${nextQuestion.gridSize} [${nextQuestion.pos_x}, ${nextQuestion.pos_y}] Δ(${nextQuestion.dx},${nextQuestion.dy})`);

        const nextVector = await generateSpecificVector(imagePath, nextQuestion);
        if (!nextVector) {
            console.log("  Could not generate requested vector. Aborting.");
            break;
        }

        const probeUpdate = {
            ...nextQuestion,
            rel_x: nextQuestion.dx / nextQuestion.gridSize,
            rel_y: nextQuestion.dy / nextQuestion.gridSize,
            value: nextVector.value,
            size: nextVector.size,
            descriptor: nextQuestion.descriptor,
            descriptorKey: nextQuestion.descriptorKey,
        };

        response = await fetch(`${API_BASE_URL}/search/refine`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId,
                probe: probeUpdate,
            })
        });
        result = await response.json();
        if (result.sessionId) {
            sessionId = result.sessionId;
        }
        console.log(`  Refined search to ${result.candidates?.length || 0} candidates.`);
        if (result.constellationPath?.length) {
            const last = result.constellationPath[result.constellationPath.length - 1];
            console.log(
                `  ✨ Constellation accuracy after ${result.constellationPath.length} step(s): ${(last?.cumulativeAccuracy ?? 0).toFixed(6)}`
            );
        }
    }

    console.log('\n--- SEARCH COMPLETE ---');
    if (result.status === 'MATCH_FOUND') {
        console.log(`✅ Match Found! The server identified the image as ID: ${result.imageId}`);
    } else {
        console.log(`❌ No definitive match found. Final status: ${result.status}`);
        if(result.candidates) console.log('  Ambiguous candidates:', result.candidates);
    }
    if (result.constellationPath?.length) {
        const last = result.constellationPath[result.constellationPath.length - 1];
        console.log(
            `✨ Final constellation accuracy: ${(last?.cumulativeAccuracy ?? 0).toFixed(6)} across ${result.constellationPath.length} step(s)`
        );
    }
}

// --- EXECUTION ---
const imagePathArg = process.argv[2];
if (!imagePathArg) {
    console.error("Usage: node src/clientAPI.js <path_to_image>");
    process.exit(1);
}
findImageRemotely(imagePathArg);
