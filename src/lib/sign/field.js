// The continuous colour field of studies/continuous_colors_function.md, in the
// form this pipeline needs.
//
// The study interpolates *absolute* HSV and therefore spends its section 1 on
// encoding hue on a circle. This pipeline never stores an absolute colour: a
// constellation records the three **magnitudes** |dH|, |dS|, |dV| against the
// neighbour towards the centre. Magnitudes are not circular, so the encoding
// step does not apply and is not implemented — everything else (the exact
// Gaussian RBF interpolator, the Gaussian-process posterior variance read as a
// confidence, the probe descriptor, the confidence-penalised score) is the
// study's, unchanged.
//
// The domain is the constellation's own local frame: the centre at the origin,
// every other point placed by its stored distance and bearing, in half-diagonal
// units. That frame is translation invariant by construction, which is what
// lets two constellations sampled at different places in the image be compared
// at all.

const {
    FIELD_ERROR_WEIGHTS,
    FIELD_JITTER,
    FIELD_MIN_LENGTH_SCALE,
    FIELD_PROBE_GRID,
    FIELD_PROBE_RADIUS,
    FIELD_UNCERTAINTY_PENALTY,
} = require('./constants');

/**
 * Solve `A x = B` for a symmetric positive-definite `A` (n x n) and a matrix
 * `B` (n x m) by Cholesky, retrying with a larger ridge when the decomposition
 * meets a non-positive pivot. n is the constellation point count, so this is
 * always tiny and an explicit implementation beats a dependency.
 */
function choleskySolve(matrix, rightHand, jitter = FIELD_JITTER) {
    const size = matrix.length;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const ridge = jitter * 10 ** attempt;
        const lower = matrix.map((row, i) => row.map((value, j) => value + (i === j ? ridge : 0)));
        let ok = true;
        for (let i = 0; i < size && ok; i += 1) {
            for (let j = 0; j <= i; j += 1) {
                let sum = lower[i][j];
                for (let k = 0; k < j; k += 1) sum -= lower[i][k] * lower[j][k];
                if (i === j) {
                    if (!(sum > 0)) { ok = false; break; }
                    lower[i][i] = Math.sqrt(sum);
                } else {
                    lower[i][j] = sum / lower[j][j];
                }
            }
            for (let j = i + 1; j < size; j += 1) lower[i][j] = 0;
        }
        if (!ok) continue;

        const width = rightHand[0].length;
        const solution = Array.from({ length: size }, () => new Array(width).fill(0));
        for (let column = 0; column < width; column += 1) {
            const intermediate = new Array(size).fill(0);
            for (let i = 0; i < size; i += 1) {
                let sum = rightHand[i][column];
                for (let k = 0; k < i; k += 1) sum -= lower[i][k] * intermediate[k];
                intermediate[i] = sum / lower[i][i];
            }
            for (let i = size - 1; i >= 0; i -= 1) {
                let sum = intermediate[i];
                for (let k = i + 1; k < size; k += 1) sum -= lower[k][i] * solution[k][column];
                solution[i][column] = sum / lower[i][i];
            }
        }
        return solution;
    }
    throw new Error('kernel matrix is not positive definite even with a ridge');
}

/** The study's automatic length scale: the median nearest-neighbour distance. */
function medianNearestNeighbour(points) {
    if (points.length < 2) return FIELD_MIN_LENGTH_SCALE;
    const nearest = points.map((point, index) => {
        let best = Infinity;
        points.forEach((other, otherIndex) => {
            if (otherIndex === index) return;
            best = Math.min(best, Math.hypot(point.x - other.x, point.y - other.y));
        });
        return best;
    }).sort((a, b) => a - b);
    const middle = Math.floor(nearest.length / 2);
    const median = nearest.length % 2 === 1
        ? nearest[middle]
        : (nearest[middle - 1] + nearest[middle]) / 2;
    return Number.isFinite(median) && median > FIELD_MIN_LENGTH_SCALE
        ? median
        : FIELD_MIN_LENGTH_SCALE;
}

/**
 * Exact Gaussian-RBF interpolator over 2-D points with a Gaussian-process
 * posterior variance. `predict` answers both the interpolated vector and the
 * confidence the study defines as `1 - clamp(sigma^2, 0, 1)`.
 */
class RadialBasisField {
    constructor(points, values, { lengthScale = null, jitter = FIELD_JITTER } = {}) {
        if (!Array.isArray(points) || points.length === 0) {
            throw new TypeError('points must be a non-empty array');
        }
        if (!Array.isArray(values) || values.length !== points.length) {
            throw new TypeError('values must have one row per point');
        }
        this.points = points.map((point) => ({ x: Number(point.x), y: Number(point.y) }));
        this.values = values.map((row) => row.map(Number));
        this.width = this.values[0].length;
        this.lengthScale = Math.max(
            FIELD_MIN_LENGTH_SCALE,
            Number(lengthScale) > 0 ? Number(lengthScale) : medianNearestNeighbour(this.points)
        );
        this.jitter = jitter;

        // The mean term matters: far from every sample the field relaxes to the
        // average observation instead of collapsing to zero.
        this.mean = new Array(this.width).fill(0);
        for (const row of this.values) {
            for (let index = 0; index < this.width; index += 1) this.mean[index] += row[index];
        }
        for (let index = 0; index < this.width; index += 1) this.mean[index] /= this.values.length;

        this.kernel = this.points.map((left) => this.points.map((right) => this.#kernel(left, right)));
        this.coefficients = choleskySolve(
            this.kernel,
            this.values.map((row) => row.map((value, index) => value - this.mean[index])),
            this.jitter
        );
    }

    #kernel(left, right) {
        const dx = left.x - right.x;
        const dy = left.y - right.y;
        return Math.exp(-0.5 * (dx * dx + dy * dy) / (this.lengthScale * this.lengthScale));
    }

    /** `{ values: number[][], confidence: number[] }` for a batch of queries. */
    predict(queries) {
        const rows = queries.map((query) => this.points.map((point) => this.#kernel(query, point)));
        const values = rows.map((row) => {
            const out = this.mean.slice();
            row.forEach((weight, index) => {
                for (let channel = 0; channel < this.width; channel += 1) {
                    out[channel] += weight * this.coefficients[index][channel];
                }
            });
            return out;
        });

        // sigma^2(P) = 1 - k(P)^T K^-1 k(P): the full geometry of the samples,
        // not just the nearest one, so a point surrounded by observations is
        // trusted more than a point at the same distance from a single one.
        const solved = choleskySolve(this.kernel, transpose(rows), this.jitter);
        const confidence = rows.map((row, queryIndex) => {
            let quadratic = 0;
            for (let index = 0; index < row.length; index += 1) {
                quadratic += row[index] * solved[index][queryIndex];
            }
            return 1 - Math.min(1, Math.max(0, 1 - quadratic));
        });

        return { values, confidence };
    }
}

function transpose(matrix) {
    if (matrix.length === 0) return [];
    return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

/** The fixed probe square every canonical descriptor is evaluated on. */
function probeGrid(grid = FIELD_PROBE_GRID, radius = FIELD_PROBE_RADIUS) {
    const probes = [];
    for (let row = 0; row < grid; row += 1) {
        for (let column = 0; column < grid; column += 1) {
            probes.push({
                x: -radius + (2 * radius * column) / (grid - 1),
                y: -radius + (2 * radius * row) / (grid - 1),
            });
        }
    }
    return probes;
}

/**
 * The study's canonical descriptor, adapted to magnitude channels: four values
 * per probe (`|dH|`, `|dS|`, `|dV|`, confidence) over a **fixed** square, so two
 * descriptors are directly comparable. The grid is fixed rather than fitted to
 * each constellation's own extent precisely so that a query and a candidate
 * measured at different scales do not silently agree.
 */
function canonicalDescriptor(field, { grid = FIELD_PROBE_GRID, radius = FIELD_PROBE_RADIUS } = {}) {
    const { values, confidence } = field.predict(probeGrid(grid, radius));
    const descriptor = [];
    values.forEach((row, index) => {
        descriptor.push(row[0], row[1], row[2], confidence[index]);
    });
    return descriptor;
}

/** Euclidean distance between two canonical descriptors of equal length. */
function descriptorDistance(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        return Infinity;
    }
    let total = 0;
    for (let index = 0; index < left.length; index += 1) {
        const difference = left[index] - right[index];
        total += difference * difference;
    }
    return Math.sqrt(total / left.length);
}

/**
 * The study's scoring rule, lower is better:
 *
 *   score = mean_j [ C(Q_j) * E_j + beta * (1 - C(Q_j)) ]
 *
 * The second term is the point of the formula. Without it a candidate could win
 * by being uncertain everywhere, since a confidence of zero would cancel every
 * error it makes; with it, an answer produced by extrapolation costs `beta`
 * whether or not it happens to be right.
 */
function scoreObservations(field, observations, {
    weights = FIELD_ERROR_WEIGHTS,
    beta = FIELD_UNCERTAINTY_PENALTY,
} = {}) {
    if (!Array.isArray(observations) || observations.length === 0) return Infinity;
    const { values, confidence } = field.predict(observations.map((entry) => entry.point));
    let total = 0;
    observations.forEach((entry, index) => {
        const [h, s, v] = values[index];
        const [qh, qs, qv] = entry.delta;
        const error =
            weights.h * (h - qh) ** 2 +
            weights.s * (s - qs) ** 2 +
            weights.v * (v - qv) ** 2;
        total += confidence[index] * error + beta * (1 - confidence[index]);
    });
    return total / observations.length;
}

module.exports = {
    RadialBasisField,
    canonicalDescriptor,
    choleskySolve,
    descriptorDistance,
    medianNearestNeighbour,
    probeGrid,
    scoreObservations,
    transpose,
};
