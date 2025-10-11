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

const createValueTypesTableSQL = `
CREATE TABLE IF NOT EXISTS value_types (
    value_type_id MEDIUMINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    channel_name VARCHAR(32) NOT NULL,
    description VARCHAR(255),
    UNIQUE KEY uq_channel_name (channel_name)
) ENGINE=InnoDB;`;

const VALUE_TYPE_SEEDS = [
    ['r', 'Red channel'],
    ['g', 'Green channel'],
    ['b', 'Blue channel'],
    ['h', 'Hue (HSV)'],
    ['s', 'Saturation (HSV)'],
    ['v', 'Value/Brightness (HSV)'],
    ['luminance', 'Relative luminance'],
    ['stddev', 'Standard deviation of luminance'],
];

const createFeatureVectorsTableSQL = `
CREATE TABLE IF NOT EXISTS feature_vectors (
    vector_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    image_id INT NOT NULL,
    value_type MEDIUMINT UNSIGNED NOT NULL,
    resolution_level TINYINT UNSIGNED NOT NULL,
    pos_x SMALLINT UNSIGNED NOT NULL,
    pos_y SMALLINT UNSIGNED NOT NULL,
    rel_x FLOAT NOT NULL,
    rel_y FLOAT NOT NULL,
    value FLOAT NOT NULL,
    size FLOAT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES images(image_id) ON DELETE CASCADE,
    FOREIGN KEY (value_type) REFERENCES value_types(value_type_id),
    INDEX idx_feature_lookup (value_type, resolution_level, pos_x, pos_y)
) ENGINE=InnoDB;`;

const createKnowledgeNodesTableSQL = `
CREATE TABLE IF NOT EXISTS knowledge_nodes (
    node_id INT AUTO_INCREMENT PRIMARY KEY,
    parent_node_id INT,
    node_type ENUM('FEATURE', 'GROUP') NOT NULL,
    vector_1_id BIGINT NOT NULL,
    vector_2_id BIGINT,
    vector_length FLOAT NOT NULL,
    vector_angle FLOAT NOT NULL,
    vector_value FLOAT NOT NULL,
    hit_count BIGINT DEFAULT 0,
    miss_count BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_node_id) REFERENCES knowledge_nodes(node_id) ON DELETE CASCADE,
    FOREIGN KEY (vector_1_id) REFERENCES feature_vectors(vector_id) ON DELETE CASCADE,
    FOREIGN KEY (vector_2_id) REFERENCES feature_vectors(vector_id) ON DELETE SET NULL,
    UNIQUE KEY uq_vector_relation (node_type, vector_1_id, vector_2_id, vector_length, vector_angle)
) ENGINE=InnoDB;`;

const createFeatureGroupStatsTableSQL = `
CREATE TABLE IF NOT EXISTS feature_group_stats (
    stat_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    value_type MEDIUMINT UNSIGNED NOT NULL,
    resolution_level TINYINT UNSIGNED NOT NULL,
    avg_length FLOAT NOT NULL,
    avg_angle FLOAT NOT NULL,
    sample_size INT UNSIGNED DEFAULT 0,
    mean_distance DOUBLE DEFAULT 0,
    std_distance DOUBLE DEFAULT 0,
    mean_cosine DOUBLE DEFAULT 0,
    mean_pearson DOUBLE DEFAULT 0,
    FOREIGN KEY (value_type) REFERENCES value_types(value_type_id),
    UNIQUE KEY uq_feature_statistics (
        value_type,
        resolution_level
    )
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

        console.log(" -> Creating 'value_types' table...");
        await connection.query(createValueTypesTableSQL);
        console.log("    ✅ Table 'value_types' is ready.");
        for (const [channel, description] of VALUE_TYPE_SEEDS) {
            await connection.query(
                'INSERT IGNORE INTO value_types (channel_name, description) VALUES (?, ?)',
                [channel, description]
            );
        }

        console.log(" -> Creating 'feature_vectors' table...");
        await connection.query(createFeatureVectorsTableSQL);
        console.log("    ✅ Table 'feature_vectors' is ready.");
        
        console.log(" -> Creating new 'knowledge_nodes' table...");
        await connection.query(createKnowledgeNodesTableSQL);
        console.log("    ✅ Table 'knowledge_nodes' is ready.");
        console.log(" -> Creating 'feature_group_stats' table...");
        await connection.query(createFeatureGroupStatsTableSQL);
        console.log("    ✅ Table 'feature_group_stats' is ready.");

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
