const MAX_CANDIDATE_SAMPLE = 256;
const MIN_AFFINITY = 0.12;
const MIN_SPREAD = 0.008;

function euclideanDistance(buf1, buf2) {
    if (!buf1 || !buf2 || buf1.length !== buf2.length) {
        return Infinity;
    }
    const vec1 = new Float32Array(buf1.buffer, buf1.byteOffset, buf1.length / Float32Array.BYTES_PER_ELEMENT);
    const vec2 = new Float32Array(buf2.buffer, buf2.byteOffset, buf2.length / Float32Array.BYTES_PER_ELEMENT);

    let sum = 0;
    for (let i = 0; i < vec1.length; i++) {
        sum += (vec1[i] - vec2[i]) ** 2;
    }
    return Math.sqrt(sum);
}

function bufferToFloat32Array(buffer) {
    if (!buffer) return null;
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / Float32Array.BYTES_PER_ELEMENT);
}

function cosineSimilarity(buf1, buf2) {
    if (!buf1 || !buf2 || buf1.length !== buf2.length) return 0;
    const vec1 = bufferToFloat32Array(buf1);
    const vec2 = bufferToFloat32Array(buf2);
    let dot = 0;
    let norm1 = 0;
    let norm2 = 0;
    for (let i = 0; i < vec1.length; i++) {
        dot += vec1[i] * vec2[i];
        norm1 += vec1[i] * vec1[i];
        norm2 += vec2[i] * vec2[i];
    }
    if (norm1 === 0 || norm2 === 0) return 0;
    return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

function pearsonCorrelation(buf1, buf2) {
    if (!buf1 || !buf2 || buf1.length !== buf2.length) return 0;
    const vec1 = bufferToFloat32Array(buf1);
    const vec2 = bufferToFloat32Array(buf2);
    const n = vec1.length;
    if (n === 0) return 0;

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    let sumY2 = 0;
    for (let i = 0; i < n; i++) {
        const x = vec1[i];
        const y = vec2[i];
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
        sumY2 += y * y;
    }
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (!isFinite(denominator) || denominator === 0) return 0;
    return numerator / denominator;
}

function meanAndStd(values) {
    if (!values || values.length === 0) return { mean: 0, std: 0 };
    const mean = values.reduce((acc, val) => acc + val, 0) / values.length;
    const variance = values.reduce((acc, val) => acc + (val - mean) * (val - mean), 0) / values.length;
    return { mean, std: Math.sqrt(Math.max(variance, 0)) };
}

function scoreCandidateFeature(targetFeature, candidateFeatures) {
    if (!candidateFeatures || candidateFeatures.length === 0) return null;

    const sampledCandidates = candidateFeatures.slice(0, MAX_CANDIDATE_SAMPLE);
    const distances = [];
    const cosineValues = [];
    const pearsonValues = [];

    for (const candidate of sampledCandidates) {
        distances.push(euclideanDistance(targetFeature.vector_data, candidate.vector_data));
        cosineValues.push(cosineSimilarity(targetFeature.vector_data, candidate.vector_data));
        pearsonValues.push(pearsonCorrelation(targetFeature.vector_data, candidate.vector_data));
    }

    const { mean: meanDistance, std: stdDistance } = meanAndStd(distances);
    const meanCosine = cosineValues.reduce((acc, val) => acc + val, 0) / cosineValues.length;
    const meanPearson = pearsonValues.reduce((acc, val) => acc + val, 0) / pearsonValues.length;

    const affinity = Math.max(0, (1 - (meanCosine || 0)) + (1 - (meanPearson || 0)));
    const spread = Math.max(0, (meanDistance || 0) + (stdDistance || 0));
    if (affinity < MIN_AFFINITY || spread < MIN_SPREAD) {
        return null;
    }

    const costPenalty = Math.log1p(sampledCandidates.length);
    const separationScore = (spread * affinity) / Math.max(costPenalty, 1);

    return {
        score: separationScore,
        metrics: {
            meanDistance,
            stdDistance,
            meanCosine,
            meanPearson,
            sampleSize: sampledCandidates.length,
            originalCandidateCount: candidateFeatures.length,
            affinity,
            spread,
        },
    };
}

module.exports = {
    euclideanDistance,
    cosineSimilarity,
    pearsonCorrelation,
    scoreCandidateFeature,
    MAX_CANDIDATE_SAMPLE,
    MIN_AFFINITY,
    MIN_SPREAD,
};
