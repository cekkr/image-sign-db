const { createDbConnection } = require('./knowledge');

class RealTimePruner {
  constructor(config = {}) {
    this.enabled = Boolean(config.enabled);
    this.intervalMs = Math.max(15000, Number(config.intervalMs) || 60000);
    this.minIngests = Math.max(1, Number(config.minIngests) || 24);
    this.batchSize = Math.max(1, Number(config.batchSize) || 24);
    this.vectorBatchSize = Math.max(10, Number(config.vectorBatchSize) || 400);
    const configuredSkip = Number(config.minSkipCount);
    const fallbackSkip = Number(config.skipThresholdOverride);
    const resolvedSkip = Number.isFinite(configuredSkip)
      ? configuredSkip
      : Number.isFinite(fallbackSkip)
        ? fallbackSkip
        : 4;
    this.minSkipCount = Math.max(1, resolvedSkip);
    this.minGroupAgeMinutes = Math.max(0, Number(config.minGroupAgeMinutes) || 45);
    this.maxGroupHitCount = Math.max(0, Number(config.maxGroupHitCount) || 1);

    this.ingestCounter = 0;
    this.lastRunAt = 0;
    this.lastRunIngestCounter = 0;
    this.running = false;
    this.runPromise = null;
    this.db = null;
  }

  async ensureDb() {
    if (!this.db) {
      this.db = await createDbConnection();
    }
    return this.db;
  }

  onImageIngested() {
    if (!this.enabled) return;
    this.ingestCounter += 1;
    if (this.running) return;
    if (this.ingestCounter % this.minIngests !== 0) return;
    const now = Date.now();
    if (now - this.lastRunAt < this.intervalMs) return;
    this.schedule();
  }

  schedule() {
    if (!this.enabled || this.running) return;
    this.running = true;
    const promise = this.runCycle()
      .catch((error) => {
        console.warn(`⚠️  Real-time pruning failed: ${error?.message ?? error}`);
      })
      .finally(() => {
        this.running = false;
        this.lastRunAt = Date.now();
        this.lastRunIngestCounter = this.ingestCounter;
        if (this.runPromise === promise) {
          this.runPromise = null;
        }
      });
    this.runPromise = promise;
  }

  async runCycle() {
    const db = await this.ensureDb();
    const processedSinceLastRun = this.ingestCounter - this.lastRunIngestCounter;
    const summary = {
      vectorsPruned: 0,
      valueTypesPruned: 0,
      patternsCleared: 0,
      constellationsPruned: 0,
    };

    const skipSummary = await this.pruneBySkipPatterns(db);
    summary.vectorsPruned += skipSummary.vectorsPruned;
    summary.valueTypesPruned += skipSummary.valueTypesPruned;
    summary.patternsCleared += skipSummary.patternsCleared;

    const constellationSummary = await this.pruneStaleConstellations(db);
    summary.constellationsPruned += constellationSummary.constellationsPruned;

    if (
      summary.vectorsPruned > 0 ||
      summary.valueTypesPruned > 0 ||
      summary.constellationsPruned > 0
    ) {
      const parts = [];
      parts.push(
        `🧹 Real-time pruning (${processedSinceLastRun || 0} new ingest${
          processedSinceLastRun === 1 ? '' : 's'
        })`
      );
      parts.push(`vectors -${summary.vectorsPruned}`);
      if (summary.valueTypesPruned > 0) {
        parts.push(`descriptors -${summary.valueTypesPruned}`);
      }
      if (summary.constellationsPruned > 0) {
        parts.push(`constellations -${summary.constellationsPruned}`);
      }
      if (summary.patternsCleared > 0) {
        parts.push(`skip-patterns cleared ${summary.patternsCleared}`);
      }
      console.log(parts.join(' | '));
    }
  }

  async pruneBySkipPatterns(db) {
    if (this.batchSize <= 0) {
      return { vectorsPruned: 0, valueTypesPruned: 0, patternsCleared: 0 };
    }
    const [rows] = await db.execute(
      `SELECT sp.descriptor_hash, sp.skip_count, vt.value_type_id
       FROM skip_patterns sp
       JOIN value_types vt ON vt.descriptor_hash = sp.descriptor_hash
       WHERE sp.skip_count >= ?
       ORDER BY sp.skip_count DESC, sp.last_used DESC
       LIMIT ?`,
      [this.minSkipCount, this.batchSize]
    );
    if (!rows || rows.length === 0) {
      return { vectorsPruned: 0, valueTypesPruned: 0, patternsCleared: 0 };
    }

    const valueTypeIds = [...new Set(rows.map((row) => row.value_type_id))];
    const descriptorHashes = [...new Set(rows.map((row) => row.descriptor_hash))];

    let vectorsPruned = 0;
    if (valueTypeIds.length > 0) {
      const vtPlaceholders = valueTypeIds.map(() => '?').join(',');
      const vectorQuery = `SELECT vector_id FROM feature_vectors WHERE value_type IN (${vtPlaceholders}) LIMIT ?`;
      const vectorParams = [...valueTypeIds, this.vectorBatchSize];
      const [vectorRows] = await db.execute(vectorQuery, vectorParams);
      if (vectorRows && vectorRows.length > 0) {
        const vectorIds = vectorRows.map((row) => row.vector_id);
        const vectorPlaceholders = vectorIds.map(() => '?').join(',');
        await db.execute(
          `DELETE FROM feature_vectors WHERE vector_id IN (${vectorPlaceholders})`,
          vectorIds
        );
        vectorsPruned = vectorIds.length;
      }

      if (descriptorHashes.length > 0) {
        const orphanQuery = `SELECT vt.value_type_id, vt.descriptor_hash
                             FROM value_types vt
                             LEFT JOIN feature_vectors fv ON fv.value_type = vt.value_type_id
                             WHERE vt.value_type_id IN (${vtPlaceholders})
                             GROUP BY vt.value_type_id, vt.descriptor_hash
                             HAVING COUNT(fv.vector_id) = 0`;
        const [orphanRows] = await db.execute(orphanQuery, valueTypeIds);
        if (orphanRows && orphanRows.length > 0) {
          const orphanIds = orphanRows.map((row) => row.value_type_id);
          const orphanPlaceholders = orphanIds.map(() => '?').join(',');
          await db.execute(
            `DELETE FROM value_types WHERE value_type_id IN (${orphanPlaceholders})`,
            orphanIds
          );
          const orphanHashes = orphanRows.map((row) => row.descriptor_hash);
          if (orphanHashes.length > 0) {
            const hashPlaceholders = orphanHashes.map(() => '?').join(',');
            await db.execute(
              `DELETE FROM skip_patterns WHERE descriptor_hash IN (${hashPlaceholders})`,
              orphanHashes
            );
          }
          return {
            vectorsPruned,
            valueTypesPruned: orphanIds.length,
            patternsCleared: orphanHashes.length,
          };
        }
      }
    }

    return { vectorsPruned, valueTypesPruned: 0, patternsCleared: 0 };
  }

  async pruneStaleConstellations(db) {
    if (this.minGroupAgeMinutes <= 0 || this.batchSize <= 0) {
      return { constellationsPruned: 0 };
    }
    const [rows] = await db.execute(
      `SELECT node_id
       FROM knowledge_nodes
       WHERE node_type = 'GROUP'
         AND hit_count <= ?
         AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
       LIMIT ?`,
      [this.maxGroupHitCount, this.minGroupAgeMinutes, this.batchSize]
    );
    if (!rows || rows.length === 0) {
      return { constellationsPruned: 0 };
    }
    const nodeIds = rows.map((row) => row.node_id);
    const placeholders = nodeIds.map(() => '?').join(',');
    await db.execute(`DELETE FROM knowledge_nodes WHERE node_id IN (${placeholders})`, nodeIds);
    return { constellationsPruned: nodeIds.length };
  }

  async flush() {
    if (!this.enabled) return;
    if (this.running) {
      await this.drain();
      return;
    }
    if (this.ingestCounter === this.lastRunIngestCounter) return;
    this.schedule();
    await this.drain();
  }

  async drain() {
    if (!this.runPromise) return;
    try {
      await this.runPromise;
    } catch {
      // error already logged in schedule()
    }
  }

  async dispose() {
    await this.drain();
    if (this.db) {
      try {
        await this.db.end();
      } catch {
        // ignore close errors
      }
      this.db = null;
    }
  }
}

module.exports = RealTimePruner;

