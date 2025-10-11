const { rgbToHsv } = require('./colorUtils');

function getBlockRange(gridSize, dimension, index) {
    if (gridSize <= 0 || dimension <= 0) return [0, 0];
    const start = Math.floor((index * dimension) / gridSize);
    let end = index === gridSize - 1 ? dimension : Math.floor(((index + 1) * dimension) / gridSize);
    if (end <= start) end = Math.min(dimension, start + 1);
    return [start, end];
}

function calculateStatsForRegion(rawPixels, meta, startX, startY, endX, endY) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumR2 = 0;
    let sumG2 = 0;
    let sumB2 = 0;
    let pixelCount = 0;

    const channels = meta.channels;
    const maxX = Math.min(endX, meta.width);
    const maxY = Math.min(endY, meta.height);

    for (let y = startY; y < maxY; y++) {
        for (let x = startX; x < maxX; x++) {
            const index = (y * meta.width + x) * channels;
            if (index + 2 < rawPixels.length) {
                const r = rawPixels[index];
                const g = rawPixels[index + 1];
                const b = rawPixels[index + 2];
                sumR += r;
                sumG += g;
                sumB += b;
                sumR2 += r * r;
                sumG2 += g * g;
                sumB2 += b * b;
                pixelCount++;
            }
        }
    }

    if (pixelCount === 0) {
        return { r: 0, g: 0, b: 0, h: 0, s: 0, v: 0, luminance: 0, stdDev: 0 };
    }

    const avgR = sumR / pixelCount;
    const avgG = sumG / pixelCount;
    const avgB = sumB / pixelCount;
    const varianceR = Math.max(0, sumR2 / pixelCount - avgR * avgR);
    const varianceG = Math.max(0, sumG2 / pixelCount - avgG * avgG);
    const varianceB = Math.max(0, sumB2 / pixelCount - avgB * avgB);
    const combinedStdDev = Math.sqrt((varianceR + varianceG + varianceB) / 3);
    const luminance = 0.2126 * avgR + 0.7152 * avgG + 0.0722 * avgB;
    const [h, s, v] = rgbToHsv(avgR, avgG, avgB);

    return { r: avgR, g: avgG, b: avgB, h, s, v, luminance, stdDev: combinedStdDev };
}

async function getRawPixels(sharpInstance) {
    const { data, info } = await sharpInstance.raw().toBuffer({ resolveWithObject: true });
    return { rawPixels: data, meta: info };
}

module.exports = {
    getBlockRange,
    calculateStatsForRegion,
    getRawPixels,
};
