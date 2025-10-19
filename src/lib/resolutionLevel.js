const DEFAULT_PRECISION = 6;
const DEFAULT_TOLERANCE = 1e-4;

const precisionEnv = Number.parseInt(process.env.RESOLUTION_LEVEL_PRECISION ?? '', 10);
const toleranceEnv = Number.parseFloat(process.env.RESOLUTION_LEVEL_TOLERANCE ?? '');

const RESOLUTION_LEVEL_PRECISION = Number.isFinite(precisionEnv) && precisionEnv >= 0
    ? Math.min(precisionEnv, 10)
    : DEFAULT_PRECISION;

const RESOLUTION_LEVEL_TOLERANCE = Number.isFinite(toleranceEnv) && toleranceEnv > 0
    ? toleranceEnv
    : DEFAULT_TOLERANCE;

function normalizeResolutionLevel(raw) {
    if (!Number.isFinite(raw)) return 0;
    const factor = 10 ** RESOLUTION_LEVEL_PRECISION;
    return Math.round(raw * factor) / factor;
}

function resolutionLevelsMatch(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= RESOLUTION_LEVEL_TOLERANCE;
}

function resolutionLevelKey(raw) {
    return normalizeResolutionLevel(raw).toFixed(RESOLUTION_LEVEL_PRECISION);
}

module.exports = {
    normalizeResolutionLevel,
    resolutionLevelsMatch,
    resolutionLevelKey,
    RESOLUTION_LEVEL_PRECISION,
    RESOLUTION_LEVEL_TOLERANCE,
};
