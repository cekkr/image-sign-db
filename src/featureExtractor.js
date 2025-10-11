// --- LIBRARIES ---
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- CONFIGURATION ---
// Define the scales and grid size for feature extraction.
// Resolution levels: 0=full, 1=half, 2=quarter.
const RESOLUTION_LEVELS = [0, 1, 2]; 
const GRID_SIZE = 8; // We'll use an 8x8 grid at each resolution.

// --- HELPER FUNCTIONS ---

/**
 * Converts an RGB color value (0-255) to HSV (H:0-360, S:0-100, V:0-100).
 * This is crucial for creating features robust to lighting changes.
 */
function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    let d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max === min) {
        h = 0; // Achromatic (grey)
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
 * Calculates the average color of a specified block within raw pixel data.
 * @returns {object} An object containing average { r, g, b, h, s, v }.
 */
function getAverageColorOfBlock(rawPixels, meta, startX, startY, blockWidth, blockHeight) {
    let sumR = 0, sumG = 0, sumB = 0, pixelCount = 0;
    const endX = startX + blockWidth;
    const endY = startY + blockHeight;

    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const index = (y * meta.width + x) * meta.channels;
            if (index + 2 < rawPixels.length) {
                sumR += rawPixels[index];
                sumG += rawPixels[index + 1];
                sumB += rawPixels[index + 2];
                pixelCount++;
            }
        }
    }
    
    if (pixelCount === 0) return { r: 0, g: 0, b: 0, h: 0, s: 0, v: 0 };

    const avgR = sumR / pixelCount;
    const avgG = sumG / pixelCount;
    const avgB = sumB / pixelCount;
    const [h, s, v] = rgbToHsv(avgR, avgG, avgB);
    
    return { r: avgR, g: avgG, b: avgB, h, s, v };
}


// --- MAIN LOGIC ---

async function extractAndStoreFeatures(imagePath) {
    let connection;
    try {
        await fs.access(imagePath);
        console.log(`🔎 Processing image: ${imagePath}`);

        // 1. EXTRACT FEATURES
        // This array will hold all the feature objects before they are inserted.
        const allFeatures = [];
        const originalImage = sharp(imagePath);
        const originalMetadata = await originalImage.metadata();

        for (const level of RESOLUTION_LEVELS) {
            const scale = 1 / Math.pow(2, level);
            const width = Math.floor(originalMetadata.width * scale);
            const height = Math.floor(originalMetadata.height * scale);
            console.log(`\n-- Analyzing Resolution Level ${level} (${width}x${height}) --`);

            const resizedImage = originalImage.clone().resize(width, height);
            const meta = await resizedImage.metadata();
            const rawPixels = await resizedImage.raw().toBuffer();

            const blockWidth = Math.floor(width / GRID_SIZE);
            const blockHeight = Math.floor(height / GRID_SIZE);
            
            if (blockWidth < 1 || blockHeight < 1) {
                console.warn(`  Skipping level ${level}: image too small for ${GRID_SIZE}x${GRID_SIZE} grid.`);
                continue;
            }

            // Pre-calculate average colors for all blocks to avoid redundant work.
            const blockAverages = [];
            for (let y = 0; y < GRID_SIZE; y++) {
                for (let x = 0; x < GRID_SIZE; x++) {
                    blockAverages[y * GRID_SIZE + x] = getAverageColorOfBlock(
                        rawPixels, meta, x * blockWidth, y * blockHeight, blockWidth, blockHeight
                    );
                }
            }

            // Calculate gradients (vector changes) between adjacent blocks.
            for (let y = 0; y < GRID_SIZE; y++) {
                for (let x = 0; x < GRID_SIZE; x++) {
                    const currentBlock = blockAverages[y * GRID_SIZE + x];
                    
                    // Horizontal Gradient (compare with block to the right)
                    if (x < GRID_SIZE - 1) {
                        const rightBlock = blockAverages[y * GRID_SIZE + (x + 1)];
                        const hsvGradH = new Float32Array([
                            (rightBlock.h - currentBlock.h) / 360, // Normalize diff
                            (rightBlock.s - currentBlock.s) / 100,
                            (rightBlock.v - currentBlock.v) / 100,
                        ]);
                        allFeatures.push({
                            vector_type: 'hsv_gradient_h',
                            resolution_level: level, pos_x: x, pos_y: y,
                            vector_data: Buffer.from(hsvGradH.buffer)
                        });
                    }

                    // Vertical Gradient (compare with block below)
                    if (y < GRID_SIZE - 1) {
                        const bottomBlock = blockAverages[(y + 1) * GRID_SIZE + x];
                         const hsvGradV = new Float32Array([
                            (bottomBlock.h - currentBlock.h) / 360,
                            (bottomBlock.s - currentBlock.s) / 100,
                            (bottomBlock.v - currentBlock.v) / 100,
                        ]);
                        allFeatures.push({
                            vector_type: 'hsv_gradient_v',
                            resolution_level: level, pos_x: x, pos_y: y,
                            vector_data: Buffer.from(hsvGradV.buffer)
                        });
                    }
                }
            }
             console.log(`  Extracted ${allFeatures.length} feature vectors so far.`);
        }
        
        // 2. STORE IN DATABASE
        console.log(`\n🗄️  Connecting to database to store ${allFeatures.length} features...`);
        connection = await mysql.createConnection({
            host: process.env.DB_HOST, user: process.env.DB_USER,
            password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
        });

        await connection.beginTransaction();

        const [imageResult] = await connection.execute(
            'INSERT INTO images (original_filename) VALUES (?)',
            [path.basename(imagePath)]
        );
        const imageId = imageResult.insertId;
        console.log(`  Saved main record to 'images' table. ID: ${imageId}`);

        for (const feature of allFeatures) {
            await connection.execute(
                `INSERT INTO feature_vectors (image_id, vector_type, resolution_level, pos_x, pos_y, vector_data) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [imageId, feature.vector_type, feature.resolution_level, feature.pos_x, feature.pos_y, feature.vector_data]
            );
        }
        
        await connection.commit();
        console.log("\n🎉 Transaction committed successfully!");

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("\n❌ An error occurred:", error.code === 'ENOENT' ? `File not found at ${imagePath}` : error);
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
            console.log("\n🔌 Connection closed.");
        }
    }
}

// --- EXECUTION ---
const imagePathArg = process.argv[2];
if (!imagePathArg) {
    console.error("Usage: node featureExtractor.js <path_to_image>");
    process.exit(1);
}
extractAndStoreFeatures(imagePathArg);
