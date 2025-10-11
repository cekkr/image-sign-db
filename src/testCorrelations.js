// --- LIBRARIES ---
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- SAMPLE DATA ---
// This is a list of hypothetical "knowledge" we might learn later.
// It asserts that certain feature combinations are useful for specific tasks.
const sampleCorrelations = [
    {
        feature_A_type: 'hsv_gradient_h',
        feature_A_location: 'level:2,quadrant:top_left',
        feature_B_type: 'hsv_gradient_v',
        feature_B_location: 'level:2,quadrant:top_left',
        utility_score: 0.85,
        best_for_distortion: 'color_filter'
    },
    {
        feature_A_type: 'hsv_gradient_v',
        feature_A_location: 'level:0,pos_x:0,pos_y:0',
        feature_B_type: 'hsv_gradient_v',
        feature_B_location: 'level:0,pos_x:7,pos_y:7',
        utility_score: 0.65,
        best_for_distortion: 'mirroring'
    },
    {
        feature_A_type: 'hsv_gradient_h',
        feature_A_location: 'level:1,quadrant:center',
        feature_B_type: 'hsv_gradient_h',
        feature_B_location: 'level:2,quadrant:center',
        utility_score: 0.40, // A less useful correlation
        best_for_distortion: 'low_quality'
    }
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

        console.log("\n🌱 Seeding sample correlation rules...");
        for (const rule of sampleCorrelations) {
            // "ON DUPLICATE KEY UPDATE" is a safe way to insert data. If a rule with the
            // same unique key already exists, it will update it instead of failing.
            const sql = `
                INSERT INTO vector_correlations 
                    (feature_A_type, feature_A_location, feature_B_type, feature_B_location, utility_score, best_for_distortion)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE utility_score = VALUES(utility_score);
            `;
            await connection.execute(sql, [
                rule.feature_A_type, rule.feature_A_location,
                rule.feature_B_type, rule.feature_B_location,
                rule.utility_score, rule.best_for_distortion
            ]);
            console.log(`  -> Processed rule for '${rule.feature_A_type}' & '${rule.feature_B_type}'.`);
        }

        console.log("\n✅ Seeding complete. Verifying data...");

        // Retrieve all data from the table to verify it was inserted.
        const [rows] = await connection.query('SELECT * FROM vector_correlations;');
        
        console.log("\n--- Current Data in 'vector_correlations' ---");
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
