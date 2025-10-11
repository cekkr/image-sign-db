const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- Database Connection ---
// (We will manage the connection directly in the main function for clarity)

/**
 * Converts an RGB color value to HSV.
 * @param {number} r - Red value (0-255)
 * @param {number} g - Green value (0-255)
 * @param {number} b - Blue value (0-255)
 * @returns {Array<number>} An array [h, s, v]
 */
function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    let d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max === min) {
        h = 0; // achromatic
    } else {
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h * 360, s * 100, v * 100];
}


/**
 * Generates feature vectors for an image by dividing it into a grid
 * and calculating the average color (RGB or HSV) for each cell.
 *
 * @param {string} imagePath - Path to the image file.
 * @param {number} gridSize - The number of cells per side (e.g., 4 for a 4x4 grid).
 * @param {'rgb' | 'hsv'} colorSpace - The color space to analyze.
 * @returns {Promise<Float32Array>} The generated feature vector.
 */
async function generateGridVector(imagePath, gridSize = 8, colorSpace = 'rgb') {
    const image = sharp(imagePath);
    const metadata = await image.metadata();

    // Get raw pixel data: [r1, g1, b1, r2, g2, b2, ...]
    const rawPixels = await image.raw().toBuffer();

    const blockWidth = Math.floor(metadata.width / gridSize);
    const blockHeight = Math.floor(metadata.height / gridSize);

    const vector = [];

    for (let gridY = 0; gridY < gridSize; gridY++) {
        for (let gridX = 0; gridX < gridSize; gridX++) {
            let sumR = 0, sumG = 0, sumB = 0;
            let pixelCount = 0;

            // Define the boundaries of the current block
            const startX = gridX * blockWidth;
            const startY = gridY * blockHeight;
            const endX = startX + blockWidth;
            const endY = startY + blockHeight;

            // Iterate over each pixel within the block
            for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                    const index = (y * metadata.width + x) * metadata.channels;
                    if (index + 2 < rawPixels.length) {
                        sumR += rawPixels[index];
                        sumG += rawPixels[index + 1];
                        sumB += rawPixels[index + 2];
                        pixelCount++;
                    }
                }
            }

            // Calculate the average color for the block
            const avgR = sumR / pixelCount;
            const avgG = sumG / pixelCount;
            const avgB = sumB / pixelCount;

            if (colorSpace === 'hsv') {
                const [h, s, v] = rgbToHsv(avgR, avgG, avgB);
                vector.push(h, s, v);
            } else { // 'rgb'
                vector.push(avgR, avgG, avgB);
            }
        }
    }
    
    // Normalize vector values to a consistent range (e.g., 0-1)
    return new Float32Array(vector.map(val => {
        if (colorSpace === 'hsv') {
            // Normalize H to 0-1, S to 0-1, V to 0-1
            const h = val / 360.0;
            const s = val / 100.0;
            const v = val / 100.0;
            return (vector.indexOf(val) % 3 === 0) ? h : (vector.indexOf(val) % 3 === 1) ? s : v;
        }
        return val / 255.0; // Normalize RGB
    }));
}


// --- Main Execution Logic ---
async function main() {
    const imagePath = 'test_image.jpg';
    let connection;

    try {
        await fs.access(imagePath);
        console.log(`🔎 Found image: ${imagePath}`);

        // --- Generate multiple vector definitions ---
        console.log("\n⚙️  Generating vectors...");
        const vectorsToGenerate = [
            { type: 'rgb_grid_4x4', gridSize: 4, colorSpace: 'rgb' },
            { type: 'hsv_grid_4x4', gridSize: 4, colorSpace: 'hsv' },
            { type: 'hsv_grid_8x8', gridSize: 8, colorSpace: 'hsv' }
        ];

        const generatedVectors = [];
        for (const def of vectorsToGenerate) {
            const vectorData = await generateGridVector(imagePath, def.gridSize, def.colorSpace);
            generatedVectors.push({ type: def.type, data: vectorData });
            console.log(`  ✅ Generated '${def.type}' vector with length: ${vectorData.length}`);
        }
        
        // --- Store vectors in the database ---
        console.log("\n🗄️  Connecting to database to store vectors...");
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        await connection.beginTransaction();

        // 1. Insert the main image record first
        const [imageResult] = await connection.execute(
            'INSERT INTO images (original_filename) VALUES (?)',
            [path.basename(imagePath)]
        );
        const imageId = imageResult.insertId;
        console.log(`  Saved main record to 'images' table. ID: ${imageId}`);

        // 2. Insert each generated vector
        for (const vec of generatedVectors) {
            const buffer = Buffer.from(vec.data.buffer);
            await connection.execute(
                'INSERT INTO image_vectors (image_id, vector_type, vector_data, vectorization_algorithm) VALUES (?, ?, ?, ?)',
                [imageId, vec.type, buffer, 'CustomGridAvg']
            );
            console.log(`  Saved '${vec.type}' vector to 'image_vectors' table.`);
        }
        
        await connection.commit();
        console.log("\n🎉 Transaction committed successfully!");

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("\n❌ An error occurred:", error.code === 'ENOENT' ? `File not found at ${imagePath}` : error);
    } finally {
        if (connection) {
            await connection.end();
            console.log("\n🔌 Connection closed.");
        }
    }
}

main();