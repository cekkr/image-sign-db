// --- LIBRARIES ---
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- SAMPLE DATA ---
const sampleCorrelations = [
    {
        start: { vector_type: 'hsv_rel_gradient_g10_dx1dy0', level: 10, x: 0, y: 0 },
        discriminator: { vector_type: 'hsv_tree_mean', level: 1, x: 1, y: 1 },
        stats: { mean_distance: 0.48, std_distance: 0.17, mean_cosine: 0.32, mean_pearson: 0.28, sample_size: 24 },
    },
    {
        start: { vector_type: 'hsv_rel_gradient_g14_dx1dy1#mirror_horizontal', level: 14, x: 3, y: 2 },
        discriminator: { vector_type: 'hsv_tree_delta#mirror_horizontal', level: 2, x: 6, y: 5 },
        stats: { mean_distance: 0.61, std_distance: 0.21, mean_cosine: 0.15, mean_pearson: 0.18, sample_size: 19 },
    },
    {
        start: { vector_type: 'hsv_tree_mean#random_combo_1', level: 0, x: 0, y: 0 },
        discriminator: { vector_type: 'hsv_rel_gradient_g6_dx2dy0#random_combo_1', level: 6, x: 2, y: 3 },
        stats: { mean_distance: 0.32, std_distance: 0.08, mean_cosine: 0.54, mean_pearson: 0.49, sample_size: 31 },
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
            const sql = `
                INSERT INTO feature_group_stats (
                    start_vector_type, start_resolution_level, start_pos_x, start_pos_y,
                    discriminator_vector_type, discriminator_resolution_level, discriminator_pos_x, discriminator_pos_y,
                    sample_size, mean_distance, std_distance, mean_cosine, mean_pearson
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    sample_size = GREATEST(sample_size, VALUES(sample_size)),
                    mean_distance = VALUES(mean_distance),
                    std_distance = VALUES(std_distance),
                    mean_cosine = VALUES(mean_cosine),
                    mean_pearson = VALUES(mean_pearson);
            `;
            await connection.execute(sql, [
                rule.start.vector_type,
                rule.start.level,
                rule.start.x,
                rule.start.y,
                rule.discriminator.vector_type,
                rule.discriminator.level,
                rule.discriminator.x,
                rule.discriminator.y,
                rule.stats.sample_size,
                rule.stats.mean_distance,
                rule.stats.std_distance,
                rule.stats.mean_cosine,
                rule.stats.mean_pearson,
            ]);
            console.log(`  -> Processed pair '${rule.start.vector_type}' → '${rule.discriminator.vector_type}'.`);
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
