const crypto = require('crypto');

function normalizeDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
        throw new Error('Descriptor must be an object');
    }
    const ordered = {};
    Object.keys(descriptor)
        .sort()
        .forEach((key) => {
            ordered[key] = descriptor[key];
        });
    return ordered;
}

function createDescriptorKey(descriptor) {
    const normalized = normalizeDescriptor(descriptor);
    return crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
}

function serializeDescriptor(descriptor) {
    return JSON.stringify(normalizeDescriptor(descriptor));
}

function parseDescriptor(json) {
    if (!json) return null;
    if (typeof json === 'object') return json;
    try {
        return JSON.parse(json);
    } catch (error) {
        return null;
    }
}

module.exports = {
    createDescriptorKey,
    serializeDescriptor,
    parseDescriptor,
};
