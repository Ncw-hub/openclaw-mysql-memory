/**
 * MySQL storage layer — lazy init, connection pool.
 *
 * Key constraint: MySQL 9.7.0 does NOT support VECTOR INDEX syntax.
 * Vector search is done in-app: fetch candidates → JS cosineSimilarity().
 *
 * Uses pool.query() (not pool.execute) because VECTOR columns
 * are incompatible with prepared statements in MySQL 9.7.0.
 *
 * All timeouts/limits are config-driven with sensible defaults.
 */

import { createPool } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { vectorToString, parseVectorString, cosineSimilarity, isNoiseMemory, calculateRecencyBoost } from "../config.js";

const TABLE_NAME = "memories";
const DEFAULT_VECTOR_DIM = 768;

/**
 * Validate table name to prevent SQL injection / invalid identifiers.
 * Accepts only alphanumeric characters and underscores.
 */
function validateTableName(name) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`Invalid table name: ${name}`);
  }
  return name;
}

// Validate at module load time (early failure if misconfigured)
try {
  validateTableName(TABLE_NAME);
} catch (err) {
  throw new Error(`mysql-memory: Table name validation failed - ${err.message}`);
}

// Defaults for when config.mysql.* is missing
const DEFAULT_CONNECTION_LIMIT = 10;
const DEFAULT_CONNECT_TIMEOUT = 5_000;
const DEFAULT_QUERY_TIMEOUT = 10_000;
const DEFAULT_DDL_TIMEOUT = 30_000;

/** Helper: read a numeric timeout from config with fallback. */
function num(cfg, key, fallback) {
  return typeof cfg[key] === "number" ? cfg[key] : fallback;
}

export class MySqlStore {
  constructor(config, logger, opts = {}) {
    this.config = config;       // { host, port, database, user, password, connectionLimit, connectTimeout, queryTimeout, ddlTimeout }
    this.logger = logger;       // api.logger or console fallback
    this.vectorDim = typeof opts.vectorDim === "number" ? opts.vectorDim : DEFAULT_VECTOR_DIM;
    this.initPromise = null;
    this.pool = null;
  }

  // ─── Lazy init ─────────────────────────────────────────────────────────────

  async ensureInitialized() {
    if (this.pool) return this.pool;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  async _doInitialize() {
    const connectionLimit = num(this.config, "connectionLimit", DEFAULT_CONNECTION_LIMIT);
    const connectTimeout = num(this.config, "connectTimeout", DEFAULT_CONNECT_TIMEOUT);

    this.pool = createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      connectionLimit,
      connectTimeout,
      charset: "utf8mb4_unicode_ci",
    });

    const queryTimeout = num(this.config, "queryTimeout", DEFAULT_QUERY_TIMEOUT);
    // Test connection
    await this.pool.query("SELECT 1", [], { timeout: queryTimeout });

    // Create table (no VECTOR INDEX — not supported in MySQL 9.7.0)
    // Includes agent_id + scope_key for multi-agent isolation
    const ddlTimeout = num(this.config, "ddlTimeout", DEFAULT_DDL_TIMEOUT);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        id VARCHAR(36) PRIMARY KEY,
        text TEXT NOT NULL,
        category VARCHAR(20) DEFAULT NULL,
        vector VECTOR(${this.vectorDim}) DEFAULT NULL,
        session_key VARCHAR(100) NOT NULL,
        agent_id VARCHAR(50) NOT NULL DEFAULT 'main',
        scope_key VARCHAR(50) NOT NULL DEFAULT 'default',
        source VARCHAR(20) NOT NULL DEFAULT 'auto',
        created_at BIGINT NOT NULL,
        INDEX idx_session (session_key),
        INDEX idx_created_at (created_at),
        INDEX idx_category (category),
        INDEX idx_agent_scope (agent_id, scope_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `, [], { timeout: ddlTimeout });

    // Backfill: add columns to existing tables (idempotent — fails silently if already exists)
    try {
      await this.pool.query(`ALTER TABLE ${TABLE_NAME} ADD COLUMN agent_id VARCHAR(50) NOT NULL DEFAULT 'main'`, [], { timeout: ddlTimeout });
    } catch { /* column already exists */ }
    try {
      await this.pool.query(`ALTER TABLE ${TABLE_NAME} ADD COLUMN scope_key VARCHAR(50) NOT NULL DEFAULT 'default'`, [], { timeout: ddlTimeout });
    } catch { /* column already exists */ }
    try {
      await this.pool.query(`ALTER TABLE ${TABLE_NAME} ADD INDEX idx_agent_scope (agent_id, scope_key)`, [], { timeout: ddlTimeout });
    } catch { /* index already exists */ }
    // P2-4: allow vector to be NULL for text-only fallback; support dynamic dimension
    try {
      await this.pool.query(`ALTER TABLE ${TABLE_NAME} MODIFY COLUMN vector VECTOR(${this.vectorDim}) DEFAULT NULL`, [], { timeout: ddlTimeout });
    } catch { /* column already nullable / dim mismatch — manual migration needed */ }

    this.logger.info?.(`mysql-memory: table '${TABLE_NAME}' ready (VECTOR ${this.vectorDim}d, agent isolation ready)`);
    return this.pool;
  }

  // ─── Store ─────────────────────────────────────────────────────────────────

  /**
   * @param {object} entry - { text, vector, category?, session_key?, agent_id?, scope_key?, importance?, source? }
   *   vector may be null (text-only fallback).
   * @returns {object} full entry with id + created_at
   */
  async store(entry) {
    const pool = await this.ensureInitialized();

    const fullEntry = {
      id: randomUUID(),
      text: entry.text,
      vector: entry.vector,
      category: entry.category || null,
      session_key: entry.session_key || "default",
      agent_id: entry.agent_id || "main",
      scope_key: entry.scope_key || "default",
      source: entry.source || "auto",
      created_at: Date.now(),
    };

    const queryTimeout = num(this.config, "queryTimeout", DEFAULT_QUERY_TIMEOUT);
    if (fullEntry.vector === null) {
      // Text-only storage without embedding
      await pool.query(
        `INSERT INTO ${TABLE_NAME} (id, text, category, vector, session_key, agent_id, scope_key, source, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        [fullEntry.id, fullEntry.text, fullEntry.category, fullEntry.session_key, fullEntry.agent_id, fullEntry.scope_key, fullEntry.source, fullEntry.created_at],
        { timeout: queryTimeout },
      );
    } else {
      const vecStr = vectorToString(fullEntry.vector);
      await pool.query(
        `INSERT INTO ${TABLE_NAME} (id, text, category, vector, session_key, agent_id, scope_key, source, created_at)
         VALUES (?, ?, ?, STRING_TO_VECTOR(?), ?, ?, ?, ?, ?)`,
        [fullEntry.id, fullEntry.text, fullEntry.category, vecStr, fullEntry.session_key, fullEntry.agent_id, fullEntry.scope_key, fullEntry.source, fullEntry.created_at],
        { timeout: queryTimeout },
      );
    }

    return fullEntry;
  }

  // ─── Search (app-layer cosine similarity) ──────────────────────────────────
  /**
   * Search with cosine similarity computed in JavaScript.
   * Performance notes:
   * - Fetches up to candidateLimit records (default 50) from MySQL
   * - Each record has a 768-dimension vector (configurable)
   * - JS computes cosine similarity for all candidates
   * - Sorting is done in JS (O(n log n) for top N)
   * - For larger datasets, consider MySQL 9.7 VECTOR_DISTANCE() function
   *   (if available) or breaking into smaller batches
   *
   * @param {number[]} queryVector
   * @param {object} opts
   * @param {string} [opts.sessionKey]  — filter by session
   * @param {string} [opts.category]    — filter by category
   * @param {string} [opts.agentId]     — filter by agent
   * @param {string|string[]} [opts.scopeKey] — filter by scope(s)
   * @param {number} [opts.limit]       — max results (default 3)
   * @param {number} [opts.minScore]    — min cosine similarity (default 0.3)
   * @param {number} [opts.candidateLimit] — max candidates to fetch (default 50)
   * @returns {Array<{entry: object, score: number}>}
   */

  /**
   * @param {number[]} queryVector
   * @param {object} opts
   * @param {string} [opts.sessionKey]  — filter by session
   * @param {string} [opts.category]    — filter by category
   * @param {string} [opts.agentId]     — filter by agent
   * @param {string|string[]} [opts.scopeKey] — filter by scope(s)
   * @param {number} [opts.limit]       — max results (default 3)
   * @param {number} [opts.minScore]    — min cosine similarity (default 0.3)
   * @param {number} [opts.candidateLimit] — max candidates to fetch (default 50)
   * @returns {Array<{entry: object, score: number}>}
   */
  async search(queryVector, opts = {}) {
    const pool = await this.ensureInitialized();

    const limit = opts.limit ?? 3;
    const minScore = opts.minScore ?? 0.3;
    const candidateLimit = opts.candidateLimit ?? 50;

    // Build WHERE clause
    const conditions = [];
    const params = [];

    if (opts.sessionKey) {
      conditions.push("session_key = ?");
      params.push(opts.sessionKey);
    }
    if (opts.category) {
      conditions.push("category = ?");
      params.push(opts.category);
    }
    if (opts.agentId) {
      conditions.push("agent_id = ?");
      params.push(opts.agentId);
    }
    if (opts.scopeKey) {
      const scopes = Array.isArray(opts.scopeKey) ? opts.scopeKey : [opts.scopeKey];
      if (scopes.length > 0) {
        conditions.push(`scope_key IN (${scopes.map(() => "?").join(",")})`);
        params.push(...scopes);
      }
    }
    conditions.push("vector IS NOT NULL");

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const query = `
      SELECT id, text, category, session_key, source, created_at,
             VECTOR_TO_STRING(vector) AS vec_str
      FROM ${TABLE_NAME}
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params.push(candidateLimit);

    const queryTimeout = num(this.config, "queryTimeout", DEFAULT_QUERY_TIMEOUT);
    const [rows] = await pool.query(query, params, { timeout: queryTimeout });
    if (!rows || rows.length === 0) return [];

    // App-layer cosine similarity
    const results = [];
    for (const row of rows) {
      const vector = parseVectorString(row.vec_str);
      if (vector.length !== queryVector.length) {
        this.logger.warn?.(`mysql-memory: vector dim mismatch ${vector.length} vs ${queryVector.length}, skipping`);
        continue;
      }

      const score = cosineSimilarity(queryVector, vector);
      if (score >= minScore) {
        results.push({
          entry: {
            id: row.id,
            text: row.text,
            category: row.category,
            session_key: row.session_key,
            agent_id: row.agent_id,
            scope_key: row.scope_key,
            source: row.source,
            created_at: parseInt(row.created_at),
          },
          score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ─── searchForRecall (noise filter + recency rerank for recall scenarios) ──

  /**
   * Recall-oriented search: fetches expanded candidates, applies noise filtering
   * and recency-based reranking, then returns top N results.
   *
   * The existing search() method is left untouched — used by forgetByQuery and
   * shouldCaptureAssistant for dedup/delete operations.
   *
   * @param {number[]} queryVector
   * @param {object} opts
   * @param {number} [opts.limit]          — final results to return (default 3)
   * @param {number} [opts.minScore]       — min cosine similarity (default 0.3)
   * @param {number} [opts.candidateLimit] — max raw candidates from MySQL (default 50)
   * @param {object} [opts.noiseFilter]    — { enabled, expandFactor, maxExpandedCandidates }
   * @param {object} [opts.recencyRerank]  — { enabled, halfLifeDays, weight }
   * @param {string} [opts.sessionKey]
   * @param {string} [opts.category]
   * @param {string} [opts.agentId]
   * @param {string|string[]} [opts.scopeKey]
   * @returns {Array<{entry: object, score: number, compositeScore?: number}>}
   */
  async searchForRecall(queryVector, opts = {}) {
    const limit = opts.limit ?? 3;
    const minScore = opts.minScore ?? 0.3;
    const baseCandidateLimit = opts.candidateLimit ?? 50;
    const noiseFilter = opts.noiseFilter || { enabled: false };
    const recencyRerank = opts.recencyRerank || { enabled: false };

    // Determine expanded candidate count
    let candidateLimit = baseCandidateLimit;
    if (noiseFilter.enabled) {
      const expanded = Math.ceil(limit * (noiseFilter.expandFactor || 2.0));
      candidateLimit = Math.min(expanded, noiseFilter.maxExpandedCandidates || 100, baseCandidateLimit);
    }

    // Fetch raw candidates (no JS filtering)
    const rawCandidates = await this.searchRaw(queryVector, {
      ...opts,
      candidateLimit,
    });

    if (rawCandidates.length === 0) return [];

    // Step 1: Apply noise filtering
    let filtered = rawCandidates;
    if (noiseFilter.enabled) {
      filtered = rawCandidates.filter((r) => {
        // Keep only results meeting minScore
        if (r.cosine < minScore) return false;
        // Apply noise filter
        if (isNoiseMemory(r.entry.text, r.entry.category)) return false;
        return true;
      });
    } else {
      // Default path: just apply minScore filter
      filtered = rawCandidates.filter((r) => r.cosine >= minScore);
    }

    if (filtered.length === 0) return [];

    // Step 2: Sort — by compositeScore (recency-aware) or raw cosine
    if (recencyRerank.enabled) {
      const halfLife = recencyRerank.halfLifeDays || 14;
      const weight = recencyRerank.weight || 0.15;
      const now = Date.now();

      for (const r of filtered) {
        const semanticDistance = 1 - r.cosine;
        const recencyBoost = calculateRecencyBoost(r.entry.created_at, now, halfLife, weight);
        r.compositeScore = semanticDistance - recencyBoost;
      }

      // Lower compositeScore = better (closer semantically + fresher)
      filtered.sort((a, b) => a.compositeScore - b.compositeScore);
    } else {
      // Original behavior: sort by cosine similarity descending
      filtered.sort((a, b) => b.cosine - a.cosine);
    }

    // Step 3: Return top N, mapping to expected result format
    return filtered.slice(0, limit).map((r) => ({
      entry: r.entry,
      score: r.cosine,                         // keep original cosine as "score"
      compositeScore: r.compositeScore ?? null, // present when reranked
    }));
  }

  // ─── SearchRaw (no JS filtering — returns all candidates for reranking) ───
  /**
   * Fetch candidates with cosine scores, NO minScore filtering or limiting.
   * Used by recall.js for composite reranking.
   * Performance notes: same as search() but returns all candidates without sorting.
   * @param {number[]} queryVector
   * @param {object} opts
   * @param {number} [opts.candidateLimit] — max raw candidates from MySQL (default 50)
   * @returns {Array<{entry: object, cosine: number}>}
   */
  async searchRaw(queryVector, opts = {}) {
    const pool = await this.ensureInitialized();
    const candidateLimit = opts.candidateLimit ?? 50;

    // Build WHERE clause (same as search)
    const conditions = [];
    const params = [];
    if (opts.sessionKey) {
      conditions.push("session_key = ?");
      params.push(opts.sessionKey);
    }
    if (opts.category) {
      conditions.push("category = ?");
      params.push(opts.category);
    }
    if (opts.agentId) {
      conditions.push("agent_id = ?");
      params.push(opts.agentId);
    }
    if (opts.scopeKey) {
      const scopes = Array.isArray(opts.scopeKey) ? opts.scopeKey : [opts.scopeKey];
      if (scopes.length > 0) {
        conditions.push(`scope_key IN (${scopes.map(() => "?").join(",")})`);
        params.push(...scopes);
      }
    }
    conditions.push("vector IS NOT NULL");

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const query = `
      SELECT id, text, category, session_key, agent_id, scope_key, source, created_at,
             VECTOR_TO_STRING(vector) AS vec_str
      FROM ${TABLE_NAME}
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params.push(candidateLimit);

    const queryTimeout = num(this.config, "queryTimeout", DEFAULT_QUERY_TIMEOUT);
    const [rows] = await pool.query(query, params, { timeout: queryTimeout });
    if (!rows || rows.length === 0) return [];

    // Compute cosine only — no filtering, no sorting, no limiting
    const results = [];
    for (const row of rows) {
      const vector = parseVectorString(row.vec_str);
      if (vector.length !== queryVector.length) {
        this.logger.warn?.(`mysql-memory: vector dim mismatch ${vector.length} vs ${queryVector.length}, skipping`);
        continue;
      }
      const cosine = cosineSimilarity(queryVector, vector);
      results.push({
        entry: {
          id: row.id,
          text: row.text,
          category: row.category,
          session_key: row.session_key,
          agent_id: row.agent_id,
          scope_key: row.scope_key,
          source: row.source,
          created_at: parseInt(row.created_at),
        },
        cosine,
      });
    }
    return results;
  }

  // ─── Forget (delete by ID) ─────────────────────────────────────────────────

  async forget(id) {
    const pool = await this.ensureInitialized();

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(id)) {
      throw new Error(`Invalid memory ID: ${id}`);
    }

    const queryTimeout = num(this.config, "queryTimeout", DEFAULT_QUERY_TIMEOUT);
    const [result] = await pool.query(
      `DELETE FROM ${TABLE_NAME} WHERE id = ?`,
      [id],
      { timeout: queryTimeout },
    );
    return result.affectedRows > 0;
  }

  /**
   * Delete most similar memory to a query vector.
   * @returns {object} { found, deleted?, candidates? }
   */
  async forgetByQuery(queryVector, opts = {}) {
    const results = await this.search(queryVector, {
      limit: 1,
      minScore: opts.minScore ?? 0.7,
      sessionKey: opts.sessionKey,
      category: opts.category,
      agentId: opts.agentId,
      scopeKey: opts.scopeKey,
      candidateLimit: opts.candidateLimit ?? 50,
    });

    if (results.length === 0) return { found: 0 };

    const top = results[0];
    if (top.score >= (opts.autoForgetThreshold ?? 0.9)) {
      await this.forget(top.entry.id);
      return { found: 1, deleted: top.entry.id, score: top.score };
    }

    // Return candidates for manual selection
    const candidates = await this.search(queryVector, {
      limit: 5,
      minScore: opts.minScore ?? 0.3,
      sessionKey: opts.sessionKey,
      category: opts.category,
      agentId: opts.agentId,
      scopeKey: opts.scopeKey,
      candidateLimit: opts.candidateLimit ?? 50,
    });

    return {
      found: candidates.length,
      candidates: candidates.map((r) => ({
        id: r.entry.id,
        text: r.entry.text,
        category: r.entry.category,
        score: r.score,
      })),
    };
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  async list(opts = {}) {
    const pool = await this.ensureInitialized();

    const conditions = [];
    const params = [];

    if (opts.sessionKey) {
      conditions.push("session_key = ?");
      params.push(opts.sessionKey);
    }
    if (opts.category) {
      conditions.push("category = ?");
      params.push(opts.category);
    }
    if (opts.agentId) {
      conditions.push("agent_id = ?");
      params.push(opts.agentId);
    }
    if (opts.scopeKey) {
      const scopes = Array.isArray(opts.scopeKey) ? opts.scopeKey : [opts.scopeKey];
      if (scopes.length > 0) {
        conditions.push(`scope_key IN (${scopes.map(() => "?").join(",")})`);
        params.push(...scopes);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    let query = `SELECT id, text, category, session_key, source, created_at
                 FROM ${TABLE_NAME} ${where}
                 ORDER BY created_at DESC`;
    if (opts.limit !== undefined) {
      query += " LIMIT ?";
      params.push(opts.limit);
    }

    const queryTimeout = num(this.config, "queryTimeout", DEFAULT_QUERY_TIMEOUT);
    const [rows] = await pool.query(query, params, { timeout: queryTimeout });
    if (!rows || rows.length === 0) return [];

    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      category: row.category,
      session_key: row.session_key,
      agent_id: row.agent_id,
      scope_key: row.scope_key,
      source: row.source,
      created_at: parseInt(row.created_at),
    }));
  }

  // ─── Health check ────────────────────────────────────────────────────────
  /**
   * Check if the database connection is healthy.
   * @returns {Promise<{status: 'healthy'|'unhealthy', error?: string}>}
   */
  async healthCheck() {
    if (!this.pool) {
      try {
        await this.ensureInitialized();
      } catch (err) {
        return { status: 'unhealthy', error: err.message };
      }
    }
    try {
      const timeout = 2000;
      await this.pool.query("SELECT 1", [], { timeout });
      return { status: 'healthy' };
    } catch (err) {
      return { status: 'unhealthy', error: err.message };
    }
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  async count(opts = {}) {
    const pool = await this.ensureInitialized();

    const conditions = [];
    const params = [];
    if (opts.sessionKey) {
      conditions.push("session_key = ?");
      params.push(opts.sessionKey);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const queryTimeout = num(this.config, "queryTimeout", DEFAULT_QUERY_TIMEOUT);
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM ${TABLE_NAME} ${where}`,
      params,
      { timeout: queryTimeout },
    );
    return rows[0]?.cnt ?? 0;
  }

  async stats() {
    const pool = await this.ensureInitialized();

    const queryTimeout = num(this.config, "queryTimeout", DEFAULT_QUERY_TIMEOUT);
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM ${TABLE_NAME}`, [], { timeout: queryTimeout }
    );
    const total = countRows[0]?.cnt ?? 0;

    const [catRows] = await pool.query(
      `SELECT category, COUNT(*) AS cnt FROM ${TABLE_NAME} GROUP BY category ORDER BY cnt DESC`,
      [], { timeout: queryTimeout }
    );
    const categoryDistribution = {};
    for (const row of catRows || []) {
      categoryDistribution[row.category] = parseInt(row.cnt);
    }

    const [timeRange] = await pool.query(
      `SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest FROM ${TABLE_NAME}`,
      [], { timeout: queryTimeout }
    );

    return {
      total,
      categoryDistribution,
      earliest: timeRange[0]?.earliest ? parseInt(timeRange[0].earliest) : null,
      latest: timeRange[0]?.latest ? parseInt(timeRange[0].latest) : null,
    };
  }

  // ─── Cleanup (data lifecycle management) ──────────────────────────────────

  /**
   * Delete old memories to prevent unbounded growth.
   * @param {object} opts
   * @param {number} [opts.maxAgeDays=30] — retain memories newer than this
   * @returns {{deleted: number, cutoffMs: number}}
   */
  async cleanup(opts = {}) {
    const pool = await this.ensureInitialized();
    const maxAgeDays = typeof opts.maxAgeDays === "number" ? opts.maxAgeDays : 30;
    const cutoffMs = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    const queryTimeout = num(this.config, "queryTimeout", DEFAULT_QUERY_TIMEOUT);
    const [result] = await pool.query(
      `DELETE FROM ${TABLE_NAME} WHERE created_at < ?`,
      [cutoffMs],
      { timeout: queryTimeout },
    );
    const deleted = result?.affectedRows ?? 0;
    if (deleted > 0) {
      this.logger.info?.(`mysql-memory: cleanup deleted ${deleted} memories older than ${maxAgeDays}d`);
    }
    return { deleted, cutoffMs };
  }

  // ─── Stop ──────────────────────────────────────────────────────────────────

  async stop() {
    if (this.pool) {
      try { await this.pool.end(); } catch { /* ignore */ }
      this.pool = null;
    }
    this.initPromise = null;
  }
}
