const { createDbConnection } = require('./knowledge');

const TARGET_COLUMNS = [
  {
    table: 'value_types',
    column: 'value_type_id',
    expectation: /mediumint(?:\(\d+\))?\s+unsigned/i,
    alterSql:
      'ALTER TABLE value_types MODIFY COLUMN value_type_id MEDIUMINT UNSIGNED NOT NULL AUTO_INCREMENT',
  },
  {
    table: 'feature_vectors',
    column: 'value_type',
    expectation: /mediumint(?:\(\d+\))?\s+unsigned/i,
    alterSql: 'ALTER TABLE feature_vectors MODIFY COLUMN value_type MEDIUMINT UNSIGNED NOT NULL',
  },
  {
    table: 'feature_group_stats',
    column: 'value_type',
    expectation: /mediumint(?:\(\d+\))?\s+unsigned/i,
    alterSql:
      'ALTER TABLE feature_group_stats MODIFY COLUMN value_type MEDIUMINT UNSIGNED NOT NULL',
  },
];

async function fetchColumnMetadata(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0] ?? null;
}

async function ensureColumnType(connection, descriptor) {
  const { table, column, expectation, alterSql } = descriptor;
  const metadata = await fetchColumnMetadata(connection, table, column);
  if (!metadata || !metadata.COLUMN_TYPE) return false;

  if (expectation.test(String(metadata.COLUMN_TYPE))) {
    return false;
  }

  await connection.execute(alterSql);
  return true;
}

async function ensureValueTypeCapacity(connection) {
  let externalConnection = connection;
  let ownsConnection = false;
  if (!externalConnection) {
    externalConnection = await createDbConnection();
    ownsConnection = true;
  }

  const upgraded = [];
  try {
    for (const descriptor of TARGET_COLUMNS) {
      const changed = await ensureColumnType(externalConnection, descriptor);
      if (changed) {
        upgraded.push(`${descriptor.table}.${descriptor.column}`);
      }
    }
  } catch (error) {
    throw new Error(
      `Schema validation failed: ${error?.message ?? error}. ` +
        'Please ensure the value type columns allow at least MEDIUMINT UNSIGNED.'
    );
  } finally {
    if (ownsConnection && externalConnection) {
      await externalConnection.end();
    }
  }

  return upgraded;
}

module.exports = {
  ensureValueTypeCapacity,
};
