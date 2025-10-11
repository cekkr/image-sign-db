// --- LIBRARIES ---
const fs = require('fs/promises');
const { generateSpecificVector, GRID_SIZES, NEIGHBOR_OFFSETS } = require('./featureExtractor.js');

// --- CONFIGURATION ---
const API_BASE_URL = 'http://localhost:3000';
const DEFAULT_GRID = GRID_SIZES[Math.floor(GRID_SIZES.length / 2)] || GRID_SIZES[0] || 8;
const DEFAULT_OFFSET = NEIGHBOR_OFFSETS.find(({ dx, dy }) => dx === 1 && dy === 0) || NEIGHBOR_OFFSETS[0] || { dx: 1, dy: 0, key: 'dx1dy0' };
const DEFAULT_VECTOR_TYPE = `hsv_rel_gradient_g${DEFAULT_GRID}_${DEFAULT_OFFSET.key}`;

// --- MAIN LOGIC ---

async function findImageRemotely(imagePath) {
    try {
        await fs.access(imagePath);
    } catch (error) {
        console.error(`❌ Error: Image not found at ${imagePath}`);
        return;
    }

    console.log(`🔎 Starting remote search for: ${imagePath}`);
    
    // 1. Generate the initial probe vector and start the session
    const probeSpec = {
        vector_type: DEFAULT_VECTOR_TYPE,
        augmentation: 'original',
        resolution_level: DEFAULT_GRID,
        pos_x: 0,
        pos_y: 0,
    };
    const probeVector = await generateSpecificVector(imagePath, probeSpec);

    if (!probeVector) {
        console.error("Could not generate initial probe vector.");
        return;
    }

    let response = await fetch(`${API_BASE_URL}/search/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...probeSpec,
            augmentation: probeSpec.augmentation,
            vector_base64: probeVector.toString('base64')
        })
    });
    
    let result = await response.json();
    console.log(`  Initial probe found ${result.candidates?.length || 0} candidates.`);
    
    // 2. Iteratively refine the search based on server requests
    let iterations = 0;
    while (result.status === 'CANDIDATES_FOUND' && result.nextQuestion && iterations < 10) {
        iterations++;
        const nextQuestion = result.nextQuestion;
        
        console.log(`  [Iteration ${iterations}] Server asks for: ${nextQuestion.type} (${nextQuestion.augmentation}) at level ${nextQuestion.level} [${nextQuestion.x}, ${nextQuestion.y}]`);
        if (nextQuestion.metrics) {
            const stats = nextQuestion.metrics;
            console.log(
                `    ↳ stats: mean distance=${stats.mean_distance?.toFixed(4)}, std=${stats.std_distance?.toFixed(4)}, mean cosine=${stats.mean_cosine?.toFixed(4)}, mean pearson=${stats.mean_pearson?.toFixed(4)}, samples=${stats.sample_size}`
            );
        }
        const nextVector = await generateSpecificVector(imagePath, {
            vector_type: nextQuestion.type,
            augmentation: nextQuestion.augmentation,
            resolution_level: nextQuestion.level,
            pos_x: nextQuestion.x,
            pos_y: nextQuestion.y
        });

        if (!nextVector) {
            console.log("  Could not generate requested vector. Aborting.");
            break;
        }

        response = await fetch(`${API_BASE_URL}/search/refine`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: result.sessionId,
                spec: nextQuestion,
                vector_base64: nextVector.toString('base64')
            })
        });
        result = await response.json();
        console.log(`  Refined search to ${result.candidates?.length || 0} candidates.`);
    }

    console.log('\n--- SEARCH COMPLETE ---');
    if (result.status === 'MATCH_FOUND') {
        console.log(`✅ Match Found! The server identified the image as ID: ${result.imageId}`);
    } else {
        console.log(`❌ No definitive match found. Final status: ${result.status}`);
        if(result.candidates) console.log('  Ambiguous candidates:', result.candidates);
    }
}

// --- EXECUTION ---
const imagePathArg = process.argv[2];
if (!imagePathArg) {
    console.error("Usage: node src/clientAPI.js <path_to_image>");
    process.exit(1);
}
findImageRemotely(imagePathArg);
