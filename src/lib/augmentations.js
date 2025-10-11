const sharp = require('sharp');
const crypto = require('crypto');
const { STOCHASTIC_AUGMENTATIONS } = require('./constants');

const BASE_AUGMENTATIONS = Object.freeze({
    original(image) {
        return image.clone();
    },
    mirror_horizontal(image) {
        return image.clone().flop();
    },
    mirror_vertical(image) {
        return image.clone().flip();
    },
    gaussian_blur(image) {
        return image.clone().blur(1.2);
    },
});

function createSeededRandom(seed) {
    const buffer = crypto.createHash('sha1').update(seed).digest();
    let state = buffer.readUInt32BE(0);
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function applyRandomCombo(baseImage, baseMeta, imagePath, augmentationName) {
    const rand = createSeededRandom(`${imagePath}:${augmentationName}:${baseMeta.width}x${baseMeta.height}`);
    const cropRatio = 0.82 + rand() * 0.15;
    const rotation = rand() * 12 - 6;
    const saturation = 0.85 + rand() * 0.3;
    const brightness = 0.9 + rand() * 0.2;
    const hueShift = rand() * 36 - 18; // float range [-18, +18]
    // sharp.modulate expects integer degrees; normalize to [0, 359]
    let hueShiftDeg = Math.round(hueShift);
    hueShiftDeg = ((hueShiftDeg % 360) + 360) % 360;
    const blurSigma = 0.4 + rand() * 0.6;

    const cropWidth = Math.max(1, Math.floor(baseMeta.width * cropRatio));
    const cropHeight = Math.max(1, Math.floor(baseMeta.height * cropRatio));
    const maxLeft = Math.max(0, baseMeta.width - cropWidth);
    const maxTop = Math.max(0, baseMeta.height - cropHeight);
    const left = Math.floor(rand() * (maxLeft + 1));
    const top = Math.floor(rand() * (maxTop + 1));

    let transformed = baseImage.clone();

    if (cropWidth < baseMeta.width || cropHeight < baseMeta.height) {
        transformed = transformed.extract({ left, top, width: cropWidth, height: cropHeight });
    }

    transformed = transformed
        .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .resize(baseMeta.width, baseMeta.height, { fit: 'cover' })
        .modulate({
            saturation,
            brightness,
            hue: hueShiftDeg,
        });

    if (rand() > 0.5) {
        transformed = transformed.blur(blurSigma);
    }

    return transformed;
}

function applyAugmentation(baseImage, augmentationName, baseMeta, imagePath) {
    if (BASE_AUGMENTATIONS[augmentationName]) {
        return BASE_AUGMENTATIONS[augmentationName](baseImage);
    }
    if (augmentationName.startsWith('random_combo_')) {
        return applyRandomCombo(baseImage, baseMeta, imagePath, augmentationName);
    }
    throw new Error(`Unknown augmentation '${augmentationName}'`);
}

const AUGMENTATION_ORDER = Object.freeze([
    'original',
    'mirror_horizontal',
    'mirror_vertical',
    'gaussian_blur',
    ...STOCHASTIC_AUGMENTATIONS,
]);

module.exports = {
    AUGMENTATION_ORDER,
    applyAugmentation,
    BASE_AUGMENTATIONS,
    STOCHASTIC_AUGMENTATIONS,
    createSeededRandom,
};
