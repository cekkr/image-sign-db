// --- LIBRARIES ---
const mysql = require('mysql2/promise');
require('dotenv').config();

// --- SQL DEFINITIONS ---
const dbName = process.env.DB_NAME || 'image_hypercube_db';

const createDatabaseSQL = `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;

// Table for master image records. Unchanged.
const createImagesTableSQL = `
CREATE TABLE IF NOT EXISTS images (
    image_id INT AUTO_INCREMENT PRIMARY KEY,
    original_filename VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;`;

// Table for individual feature vectors. Unchanged.
const createFeatureVectorsTableSQL = `
CREATE TABLE IF NOT EXISTS feature_vectors (
    vector_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    image_id INT NOT NULL,
    vector_type VARCHAR(50) NOT NULL,
    resolution_level TINYINT UNSIGNED NOT NULL,
    pos_x SMALLINT UNSIGNED NOT NULL,
    pos_y SMALLINT UNSIGNED NOT NULL,
    vector_data BLOB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES images(image_id) ON DELETE CASCADE,
    INDEX idx_feature_lookup (vector_type, resolution_level, pos_x, pos_y)
) ENGINE=InnoDB;`;

// The NEW "knowledge base" of the system. This hierarchical structure can represent
// relationships between individual features and groups of features.
const createKnowledgeNodesTableSQL = `
CREATE TABLE IF NOT EXISTS knowledge_nodes (
    node_id INT AUTO_INCREMENT PRIMARY KEY,
    -- Self-referencing key to create the hierarchy. NULL for top-level nodes.
    parent_node_id INT,
    -- Differentiates a leaf ('FEATURE') from a learned combination ('GROUP').
    node_type ENUM('FEATURE', 'GROUP') NOT NULL,
    -- A flexible way to describe a leaf feature node without many columns.
    feature_details JSON,
    -- Raw counters for the learning algorithm to calculate utility.
    hit_count BIGINT DEFAULT 0,
    miss_count BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_node_id) REFERENCES knowledge_nodes(node_id) ON DELETE CASCADE,
    -- Ensure feature definitions are unique to avoid duplicate leaf nodes.
    UNIQUE KEY uq_feature_definition (node_type, feature_details(256))
) ENGINE=InnoDB;`;

// --- MAIN EXECUTION LOGIC ---
async function setupDatabase() {
    let connection;
    try {
        console.log("Connecting to MySQL server...");
        connection = await mysql.createConnection({
            host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        });

        console.log(`Executing: CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
        await connection.query(createDatabaseSQL);
        console.log(`✅ Database '${dbName}' is ready.`);
        
        await connection.query(`USE \`${dbName}\``);
        console.log(`\nSuccessfully connected to '${dbName}'.`);

        console.log("\nCreating tables from scratch...");
        
        console.log(" -> Creating 'images' table...");
        await connection.query(createImagesTableSQL);
        console.log("    ✅ Table 'images' is ready.");

        console.log(" -> Creating 'feature_vectors' table...");
        await connection.query(createFeatureVectorsTableSQL);
        console.log("    ✅ Table 'feature_vectors' is ready.");
        
        // Dropping the old table if it exists to ensure a clean slate.
        console.log(" -> Dropping old 'vector_correlations' table if it exists...");
        await connection.query('DROP TABLE IF EXISTS vector_correlations;');
        console.log(" -> Creating new 'knowledge_nodes' table...");
        await connection.query(createKnowledgeNodesTableSQL);
        console.log("    ✅ Table 'knowledge_nodes' is ready.");

        console.log("\n🎉 Database setup completed successfully with the new schema!");

    } catch (error) {
        console.error("❌ An error occurred during database setup:", error);
        process.exit(1); 
    } finally {
        if (connection) {
            await connection.end();
            console.log("\nConnection to MySQL closed.");
        }
    }
}

setupDatabase();

