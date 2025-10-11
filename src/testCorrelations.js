// --- LIBRARIES ---
const mysql = require('mysql2/promise');
require('dotenv').config();
const { createDescriptorKey, serializeDescriptor } = require('./lib/descriptor');

// --- SAMPLE DATA ---
const sampleCorrelations = [
    {
        descriptor: { family: 'delta', channel: 'h', neighbor_dx: 1, neighbor_dy: 0 },
        resolution_level: 10,
        avg_length: 0.25,
        avg_angle: 0.12,
        sample_size: 24,
        mean_distance: 0.48,
        std_distance: 0.17,
        mean_cosine: 0.32,
        mean_pearson: 0.28,
    },
    {
        descriptor: { family: 'delta', channel: 's', neighbor_dx: 1, neighbor_dy: 1 },
        resolution_level: 14,
        avg_length: 0.33,
        avg_angle: -0.35,
        sample_size: 19,
        mean_distance: 0.61,
        std_distance: 0.21,
        mean_cosine: 0.15,
        mean_pearson: 0.18,
    },
    {
        descriptor: { family: 'delta', channel: 'luminance', neighbor_dx: 2, neighbor_dy: 0 },
        resolution_level: 6,
        avg_length: 0.18,
        avg_angle: 0.48,
        sample_size: 31,
        mean_distance: 0.32,
        std_distance: 0.08,
        mean_cosine: 0.54,
        mean_pearson: 0.49,
    },
];

// --- MAIN LOGIC ---
async function testAndSeedCorrelations() {
    let connection;
    console.log("🧪 Starting Correlation Table Test...");
    try {
        console.log("🗄️  Connecting to database...");
        connection = await mysql.createConnection({
            host: process.env.DB_HOST, user: process.env.DB_USER,
            password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
        });

        console.log("\n🌱 Seeding sample correlation stats...");
        for (const rule of sampleCorrelations) {
            const descriptorKey = createDescriptorKey(rule.descriptor);
            await connection.execute(
                `INSERT INTO value_types (descriptor_hash, descriptor_json)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE descriptor_json = VALUES(descriptor_json)`,
                [descriptorKey, serializeDescriptor(rule.descriptor)]
            );
            const [rows] = await connection.execute(
                'SELECT value_type_id FROM value_types WHERE descriptor_hash = ?',
                [descriptorKey]
            );
            if (rows.length === 0) {
                console.warn(`  ⚠️  Could not resolve descriptor for ${descriptorKey}`);
                continue;
            }
            const valueTypeId = rows[0].value_type_id;

            const sql = `
                INSERT INTO feature_group_stats (
                    value_type,
                    resolution_level,
                    avg_length,
                    avg_angle,
                    sample_size,
                    mean_distance,
                    std_distance,
                    mean_cosine,
                    mean_pearson
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    sample_size = GREATEST(sample_size, VALUES(sample_size)),
                    avg_length = VALUES(avg_length),
                    avg_angle = VALUES(avg_angle),
                    mean_distance = VALUES(mean_distance),
                    std_distance = VALUES(std_distance),
                    mean_cosine = VALUES(mean_cosine),
                    mean_pearson = VALUES(mean_pearson);
            `;
            await connection.execute(sql, [
                valueTypeId,
                rule.resolution_level,
                rule.avg_length,
                rule.avg_angle,
                rule.sample_size,
                rule.mean_distance,
                rule.std_distance,
                rule.mean_cosine,
                rule.mean_pearson,
            ]);
            console.log(`  -> Upserted stats for descriptor ${descriptorKey} at resolution ${rule.resolution_level}.`);
        }

        console.log("\n✅ Seeding complete. Verifying data...");

        const [rows] = await connection.query('SELECT * FROM feature_group_stats;');
        
        console.log("\n--- Current Data in 'feature_group_stats' ---");
        console.table(rows);
        console.log("----------------------------------------------");
        
        console.log("\n🎉 Correlation table test completed successfully!");

    } catch (error) {
        console.error("\n❌ An error occurred during the test:", error);
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
            console.log("\n🔌 Connection closed.");
        }
    }
}

testAndSeedCorrelations();
