// --- LIBRARIES ---
// 'mysql2/promise' enables modern async/await syntax for database operations.
const mysql = require('mysql2/promise');
// 'dotenv' loads sensitive configuration from a separate .env file.
require('dotenv').config();


// --- SQL DEFINITIONS ---
// This section contains the SQL commands to construct our database schema.

const dbName = process.env.DB_NAME || 'image_hypercube_db';

const createDatabaseSQL = `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;

// Table to store the master record for each original image.
const createImagesTableSQL = `
CREATE TABLE IF NOT EXISTS images (
    image_id INT AUTO_INCREMENT PRIMARY KEY,
    original_filename VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;`;

// The core table holding every single "vector change" or gradient.
// Each row is a single feature at a specific point in the image "hypercube".
const createFeatureVectorsTableSQL = `
CREATE TABLE IF NOT EXISTS feature_vectors (
    vector_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    image_id INT NOT NULL,
    -- Type of feature, e.g., 'hsv_gradient', 'rgb_intensity'
    vector_type VARCHAR(50) NOT NULL,
    -- Scale of analysis, e.g., 0 for full-res, 1 for half-res
    resolution_level TINYINT UNSIGNED NOT NULL,
    -- The X,Y coordinates of this feature within its grid/scale
    pos_x SMALLINT UNSIGNED NOT NULL,
    pos_y SMALLINT UNSIGNED NOT NULL,
    -- The actual vector data (e.g., gradient differences)
    vector_data BLOB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES images(image_id) ON DELETE CASCADE,
    -- Indexes for fast searching of specific feature types and locations
    INDEX idx_vector_type (vector_type),
    INDEX idx_image_resolution_pos (image_id, resolution_level, pos_x, pos_y)
) ENGINE=InnoDB;`;

// The "knowledge base" of the system. It stores learned relationships
// between different types of features.
const createVectorCorrelationsTableSQL = `
CREATE TABLE IF NOT EXISTS vector_correlations (
    correlation_id INT AUTO_INCREMENT PRIMARY KEY,
    -- Describes the first feature in the correlated pair
    feature_A_type VARCHAR(50) NOT NULL,
    feature_A_location VARCHAR(100), -- Flexible, e.g., 'center_quadrant' or 'pos_x:0,pos_y:1'
    -- Describes the second feature in the correlated pair
    feature_B_type VARCHAR(50) NOT NULL,
    feature_B_location VARCHAR(100),
    -- The "learning" score. Higher means this correlation is more useful.
    utility_score FLOAT DEFAULT 0.5,
    -- Tracks which distortions this correlation is good at solving
    best_for_distortion VARCHAR(50),
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    -- Ensure we don't store duplicate correlation rules
    UNIQUE KEY uq_correlation_pair (feature_A_type, feature_A_location, feature_B_type, feature_B_location)
) ENGINE=InnoDB;`;


// --- MAIN EXECUTION LOGIC ---
async function setupDatabase() {
    let connection;
    try {
        console.log("Attempting to connect to MySQL server...");
        // First, connect without a specific DB to ensure we can create it.
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
        });

        // 1. Create the main database.
        console.log(`Executing: CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
        await connection.query(createDatabaseSQL);
        console.log(`✅ Database '${dbName}' is ready.`);
        
        // Reconnect, this time to our specific database.
        await connection.end();
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: dbName,
        });
        console.log(`\nSuccessfully connected to '${dbName}'.`);

        // 2. Create the tables one by one.
        console.log("\nCreating tables...");
        
        console.log(" -> Creating 'images' table...");
        await connection.query(createImagesTableSQL);
        console.log("    ✅ Table 'images' is ready.");

        console.log(" -> Creating 'feature_vectors' table...");
        await connection.query(createFeatureVectorsTableSQL);
        console.log("    ✅ Table 'feature_vectors' is ready.");
        
        console.log(" -> Creating 'vector_correlations' table...");
        await connection.query(createVectorCorrelationsTableSQL);
        console.log("    ✅ Table 'vector_correlations' is ready.");

        console.log("\n🎉 Database setup completed successfully!");

    } catch (error) {
        console.error("❌ An error occurred during database setup:", error);
        // Exit with an error code to indicate failure
        process.exit(1); 
    } finally {
        if (connection) {
            await connection.end();
            console.log("\nConnection to MySQL closed.");
        }
    }
}

// Execute the main function.
setupDatabase();
