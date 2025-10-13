const { createDescriptorKey, serializeDescriptor } = require('./descriptor');
const settings = require('../settings');

async function loadSetting(db, key, defaultValue = null) {
    const [rows] = await db.execute(
        'SELECT setting_value FROM system_settings WHERE setting_key = ?',
        [key]
    );
    if (rows.length === 0) {
        if (defaultValue !== null) {
            await db.execute(
                'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)',
                [key, String(defaultValue)]
            );
            return defaultValue;
        }
        return null;
    }
    const raw = rows[0].setting_value;
    const numeric = Number(raw);
    return Number.isNaN(numeric) ? raw : numeric;
}

async function recordVectorUsage(db, vectorIds, increment = 1, scoreDelta = 0) {
    if (!Array.isArray(vectorIds) || vectorIds.length === 0) return;
    const placeholders = vectorIds.map(() => '(?, ?, NOW(), ?)').join(',');
    const params = [];
    for (const vectorId of vectorIds) {
        params.push(vectorId, increment, scoreDelta);
    }
    await db.execute(
        `INSERT INTO feature_usage (vector_id, usage_count, last_used, last_score)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
            usage_count = usage_count + VALUES(usage_count),
            last_used = NOW(),
            last_score = last_score + VALUES(last_score)`,
        params
    );
}

async function saveSkipPattern(db, descriptor) {
    if (!descriptor) return;
    const descriptorKey = createDescriptorKey(descriptor);
    await db.execute(
        `INSERT INTO skip_patterns (descriptor_hash, descriptor_json, skip_count, last_used)
         VALUES (?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE
            skip_count = skip_count + 1,
            last_used = NOW()`,
        [descriptorKey, serializeDescriptor(descriptor)]
    );
}

async function currentDatabaseSizeGb(db, schemaName) {
    const [rows] = await db.execute(
        `SELECT COALESCE(SUM(data_length + index_length) / (1024 * 1024 * 1024), 0) AS size_gb
         FROM information_schema.tables
         WHERE table_schema = ?`,
        [schemaName]
    );
    return Number(rows[0]?.size_gb ?? 0);
}

async function pruneLowValueVectors(db, schemaName, targetGb) {
    const currentGb = await currentDatabaseSizeGb(db, schemaName);
    if (currentGb <= targetGb) return;

    const overshoot = currentGb - targetGb;
    const batchLimit = Math.min(5000, Math.max(500, Math.ceil(overshoot * 5000)));

    const [rows] = await db.execute(
        `SELECT fv.vector_id
         FROM feature_vectors fv
         LEFT JOIN feature_usage fu ON fu.vector_id = fv.vector_id
         LEFT JOIN knowledge_nodes kn1 ON kn1.vector_1_id = fv.vector_id
         LEFT JOIN knowledge_nodes kn2 ON kn2.vector_2_id = fv.vector_id
         WHERE kn1.node_id IS NULL AND kn2.node_id IS NULL
         ORDER BY COALESCE(fu.usage_count, 0) ASC, fv.created_at ASC
         LIMIT ?`,
        [batchLimit]
    );

    if (rows.length === 0) return;
    const vectorIds = rows.map((row) => row.vector_id);
    const placeholders = vectorIds.map(() => '?').join(',');
    await db.execute(
        `DELETE FROM feature_vectors WHERE vector_id IN (${placeholders})`,
        vectorIds
    );
    console.log(`🧹 Pruned ${vectorIds.length} low-usage feature vector(s) to respect storage limits.`);
}

async function ensureStorageCapacity(db, schemaName) {
    const defaultLimit = settings.database.defaultMaxSizeGb;
    const maxGbRaw = await loadSetting(db, 'max_db_size_gb', defaultLimit);
    const maxGb = Number(maxGbRaw) || defaultLimit;
    let currentGb = await currentDatabaseSizeGb(db, schemaName);
    if (currentGb <= maxGb) return;
    await pruneLowValueVectors(db, schemaName, maxGb);
    currentGb = await currentDatabaseSizeGb(db, schemaName);
    if (currentGb > maxGb) {
        console.warn(
            `[storage] Database still above target size (${currentGb.toFixed(
                3
            )} GB > ${maxGb} GB) after pruning. Consider increasing max_db_size_gb.`
        );
    }
}

module.exports = {
    loadSetting,
    recordVectorUsage,
    saveSkipPattern,
    ensureStorageCapacity,
    currentDatabaseSizeGb,
};
