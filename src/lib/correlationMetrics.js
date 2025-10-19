const settings = require('../settings');
const { resolutionLevelsMatch } = require('./resolutionLevel');

const MAX_CANDIDATE_SAMPLE = Math.max(1, settings.correlation.maxCandidateSample);
const MIN_AFFINITY = Math.max(0, Math.min(1, settings.correlation.minAffinity));
const MIN_COHESION = Math.max(0, Math.min(1, settings.correlation.minCohesion ?? settings.correlation.minSpread ?? 0));

function buildFeatureVector(feature) {
    return [
        feature.value ?? 0,
        feature.rel_x ?? 0,
        feature.rel_y ?? 0,
        feature.magnitude ?? feature.size ?? 0,
    ];
}

function euclideanDistance(a, b) {
    if (!a || !b) return Infinity;
    if (a.value_type !== b.value_type || !resolutionLevelsMatch(a.resolution_level, b.resolution_level)) {
        return Infinity;
    }
    const componentsA = buildFeatureVector(a);
    const componentsB = buildFeatureVector(b);
    let sum = 0;
    for (let i = 0; i < componentsA.length; i++) {
        sum += (componentsA[i] - componentsB[i]) ** 2;
    }
    return Math.sqrt(sum);
}

function cosineSimilarity(a, b) {
    if (!a || !b) return 0;
    const componentsA = buildFeatureVector(a);
    const componentsB = buildFeatureVector(b);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < componentsA.length; i++) {
        dot += componentsA[i] * componentsB[i];
        normA += componentsA[i] * componentsA[i];
        normB += componentsB[i] * componentsB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function pearsonCorrelation(a, b) {
    if (!a || !b) return 0;
    const componentsA = buildFeatureVector(a);
    const componentsB = buildFeatureVector(b);
    const n = componentsA.length;
    if (n === 0) return 0;

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    let sumY2 = 0;
    for (let i = 0; i < n; i++) {
        const x = componentsA[i];
        const y = componentsB[i];
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
    const variance = values.reduce((acc, val) => acc + (val - mean) ** 2, 0) / values.length;
    return { mean, std: Math.sqrt(Math.max(variance, 0)) };
}

function scoreCandidateFeature(targetFeature, candidateFeatures) {
    if (!candidateFeatures || candidateFeatures.length === 0) return null;

    const sampled = candidateFeatures.slice(0, MAX_CANDIDATE_SAMPLE);
    const distances = [];
    const cosineValues = [];
    const pearsonValues = [];

    for (const candidate of sampled) {
        const distance = euclideanDistance(targetFeature, candidate);
        if (!Number.isFinite(distance)) continue;
        distances.push(distance);
        cosineValues.push(cosineSimilarity(targetFeature, candidate));
        pearsonValues.push(pearsonCorrelation(targetFeature, candidate));
    }

    if (distances.length === 0) return null;

    const { mean: meanDistance, std: stdDistance } = meanAndStd(distances);
    const meanCosine = cosineValues.reduce((acc, val) => acc + val, 0) / cosineValues.length;
    const meanPearson = pearsonValues.reduce((acc, val) => acc + val, 0) / pearsonValues.length;

    const normalizedCosine = (meanCosine + 1) / 2;
    const normalizedPearson = (meanPearson + 1) / 2;
    const affinity = Math.max(0, Math.min(1, (normalizedCosine + normalizedPearson) / 2));

    const density = 1 / (1 + Math.max(meanDistance, 0));
    const stability = 1 / (1 + Math.max(stdDistance, 0));
    const cohesion = Math.max(0, Math.min(1, (density + stability) / 2));
    if (affinity < MIN_AFFINITY || cohesion < MIN_COHESION) return null;

    const sampleSize = sampled.length;
    const coverage = 1 + Math.log1p(sampleSize);
    const separationScore = affinity * cohesion * coverage;

    return {
        score: separationScore,
        metrics: {
            meanDistance,
            stdDistance,
            meanCosine,
            meanPearson,
            sampleSize,
            originalCandidateCount: candidateFeatures.length,
            affinity,
            cohesion,
            density,
            stability,
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
    MIN_COHESION,
};
