const { GRID_SIZES, CHANNEL_DIMENSIONS } = require('./constants');

const DEFAULT_MAX_VECTOR_LENGTH = 1.5; // expressed in grid cells
const DEFAULT_AUGMENTATION = 'original';

function randomChoice(list) {
    if (!list || list.length === 0) {
        throw new Error('randomChoice requires a non-empty array.');
    }
    const index = Math.floor(Math.random() * list.length);
    return list[index];
}

function computeAverageRadius(dx, dy, gridSize) {
    const horizontal = Math.abs(dx) / gridSize;
    const vertical = Math.abs(dy) / gridSize;
    if (horizontal === 0 && vertical === 0) {
        return 1 / gridSize;
    }
    return (horizontal + vertical) / (horizontal > 0 && vertical > 0 ? 2 : 1);
}

function isOffsetWithinConstraint(dx, dy, maxLength) {
    if (dx === 0 && dy === 0) return false;
    return Math.hypot(dx, dy) <= maxLength;
}

function sampleOffset(maxLength = DEFAULT_MAX_VECTOR_LENGTH) {
    const candidates = [];
    for (let dx = -2; dx <= 2; dx += 1) {
        for (let dy = -2; dy <= 2; dy += 1) {
            if (!isOffsetWithinConstraint(dx, dy, maxLength)) continue;
            candidates.push({ dx, dy });
        }
    }
    return randomChoice(candidates);
}

function ensureValidPosition(gridSize, dx, dy, preferred = {}) {
    const minX = Math.max(0, dx < 0 ? Math.abs(dx) : 0);
    const maxX = Math.min(gridSize - 1, dx > 0 ? gridSize - 1 - dx : gridSize - 1);
    const minY = Math.max(0, dy < 0 ? Math.abs(dy) : 0);
    const maxY = Math.min(gridSize - 1, dy > 0 ? gridSize - 1 - dy : gridSize - 1);

    if (minX > maxX || minY > maxY) {
        return null;
    }

    const candidateX = Number.isFinite(preferred.pos_x) ? preferred.pos_x : null;
    const candidateY = Number.isFinite(preferred.pos_y) ? preferred.pos_y : null;

    const withinPreferred =
        candidateX !== null &&
        candidateY !== null &&
        candidateX >= minX &&
        candidateX <= maxX &&
        candidateY >= minY &&
        candidateY <= maxY;

    if (withinPreferred) {
        return { pos_x: candidateX, pos_y: candidateY };
    }

    const pos_x = minX + Math.floor(Math.random() * (maxX - minX + 1));
    const pos_y = minY + Math.floor(Math.random() * (maxY - minY + 1));
    return { pos_x, pos_y };
}

function createRandomConstellationSpec(options = {}) {
    const gridSize = options.gridSize ?? randomChoice(GRID_SIZES);
    const channel = options.channel ?? randomChoice(CHANNEL_DIMENSIONS);
    const maxLength = options.maxLength ?? DEFAULT_MAX_VECTOR_LENGTH;
    const augmentation = options.augmentation ?? DEFAULT_AUGMENTATION;
    const requestedDx = Number.isFinite(options.dx) ? options.dx : null;
    const requestedDy = Number.isFinite(options.dy) ? options.dy : null;

    let offset = null;
    let position = null;
    let attempts = 0;
    const maxAttempts = 12;

    while ((!offset || !position) && attempts < maxAttempts) {
        attempts += 1;
        if (requestedDx !== null || requestedDy !== null) {
            const dx = requestedDx ?? 0;
            const dy = requestedDy ?? 0;
            if (isOffsetWithinConstraint(dx, dy, maxLength)) {
                offset = { dx, dy };
            } else {
                offset = null;
            }
        } else {
            offset = sampleOffset(maxLength);
        }

        if (!offset) continue;
        position = ensureValidPosition(gridSize, offset.dx, offset.dy, options);
    }

    if (!offset || !position) {
        offset = { dx: 1, dy: 0 };
        position = ensureValidPosition(gridSize, offset.dx, offset.dy, options) ?? { pos_x: 0, pos_y: 0 };
    }

    const descriptor = {
        family: 'delta',
        channel,
        neighbor_dx: offset.dx,
        neighbor_dy: offset.dy,
    };

    return {
        gridSize,
        pos_x: position.pos_x,
        pos_y: position.pos_y,
        dx: offset.dx,
        dy: offset.dy,
        augmentation,
        descriptor,
    };
}

function extendConstellationPath(path = [], stepInput = {}) {
    const step = {
        descriptorKey: stepInput.descriptorKey,
        candidateCount: stepInput.candidateCount ?? 0,
        rel_x: stepInput.rel_x ?? 0,
        rel_y: stepInput.rel_y ?? 0,
        size: stepInput.size ?? 0,
    };
    const accuracyScore = step.candidateCount > 0 ? 1 / step.candidateCount : 0;
    const previousCumulative = path.length > 0 ? path[path.length - 1].cumulativeAccuracy ?? 1 : 1;
    step.accuracyScore = Number(accuracyScore.toFixed(6));
    step.cumulativeAccuracy = Number((previousCumulative * (step.accuracyScore || 1)).toFixed(6));
    return [...path, step];
}

module.exports = {
    createRandomConstellationSpec,
    computeAverageRadius,
    extendConstellationPath,
};
