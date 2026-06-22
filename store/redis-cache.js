/**
 * Redis cache layer — lazy init, graceful degradation.
 *
 * If Redis is unavailable or disabled, all cache operations
 * become no-ops (return null on get, silent on set/del).
 *
 * All timeouts/retry counts are config-driven with sensible defaults.
 */

import Redis from "ioredis";

const DEFAULT_CONNECT_TIMEOUT = 2_000;
const DEFAULT_COMMAND_TIMEOUT = 3_000;
const DEFAULT_MAX_RETRIES = 3;

export class RedisCache {
  constructor(config, logger) {
    this.config = config;   // { host, port, password, db, enabled, connectTimeout, commandTimeout, maxRetries }
    this.logger = logger;
    this.initPromise = null;
    this.client = null;
    this.failed = false;
    this.lastFailTime = 0;  // For retry cooldown
  }

  // ─── Lazy connect ──────────────────────────────────────────────────────────

  async ensureConnected() {
    if (this.client) return this.client;
    if (this.failed) {
      // Allow retry after 5 minute cooldown
      const retryCooldown = 300_000; // 5 minutes
      if (Date.now() - this.lastFailTime < retryCooldown) {
        return null;
      }
    }
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doConnect().catch((err) => {
      this.initPromise = null;
      this.failed = true;
      this.lastFailTime = Date.now();
      this.logger.warn?.(`mysql-memory: Redis connection failed, cache disabled (cooldown until ${new Date(Date.now() + 300_000).toLocaleTimeString()}): ${err.message}`);
      return null;
    });
    return this.initPromise;
  }

  async _doConnect() {
    if (!this.config.enabled) return null;
    if (this.client) return this.client;

    const connectTimeout = typeof this.config.connectTimeout === "number"
      ? this.config.connectTimeout : DEFAULT_CONNECT_TIMEOUT;
    const commandTimeout = typeof this.config.commandTimeout === "number"
      ? this.config.commandTimeout : DEFAULT_COMMAND_TIMEOUT;
    const maxRetries = typeof this.config.maxRetries === "number"
      ? this.config.maxRetries : DEFAULT_MAX_RETRIES;

    this.client = new Redis({
      host: this.config.host,
      port: this.config.port,
      password: this.config.password || undefined,
      db: this.config.db,
      connectTimeout,
      commandTimeout,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > maxRetries) return null;
        return Math.min(times * 50, 2000);
      },
    });

    this.client.on("error", (err) => {
      this.logger.warn?.(`mysql-memory: Redis error: ${err.message}`);
    });
    // Auto-reconnect: when retries exhausted and connection closes, reset state
    // so next ensureConnected() re-initializes fresh
    this.client.on("close", () => {
      this.logger.info?.("mysql-memory: Redis connection closed, will reconnect on next use");
      this.client = null;
      this.initPromise = null;
    });

    this.client.on("end", () => {
      this.logger.info?.("mysql-memory: Redis connection ended, will reconnect on next use");
      this.client = null;
      this.initPromise = null;
    });

    await this.client.connect();
    return this.client;
  }

  // ─── Recall cache ──────────────────────────────────────────────────────────

  /**
   * Get cached recall results.
   * @param {string} key — full cache key
   * @returns {object[]|null} cached array or null
   */
  async getRecallCache(key) {
    const client = await this.ensureConnected();
    if (!client) return null;
    try {
      const raw = await client.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      this.logger.warn?.(`mysql-memory: Redis GET failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Set cached recall results.
   * @param {string} key
   * @param {object[]} value
   * @param {number} ttl — seconds (jitter ±300s added automatically to prevent cache stampede)
   */
  async setRecallCache(key, value, ttl = 1800) {
    const client = await this.ensureConnected();
    if (!client) return;
    try {
      const jitter = Math.floor(Math.random() * 601) - 300; // ±300s (0-600 → -300..+300)
      const effectiveTtl = Math.max(60, ttl + jitter); // clamp min 60s
      await client.setex(key, effectiveTtl, JSON.stringify(value));
    } catch (err) {
      this.logger.warn?.(`mysql-memory: Redis SET failed: ${err.message}`);
    }
  }

  // ─── Invalidation ──────────────────────────────────────────────────────────

  /**
   * Delete keys matching a glob pattern (e.g. "mysql-memory:recall:*").
   * Uses SCAN + DEL for safety (no KEYS *).
   */
  async invalidate(pattern) {
    const client = await this.ensureConnected();
    if (!client) return;
    try {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = nextCursor;
        if (keys.length > 0) await client.del(...keys);
      } while (cursor !== "0");
    } catch (err) {
      this.logger.warn?.(`mysql-memory: Redis SCAN/DEL failed: ${err.message}`);
    }
  }

  /**
   * Delete a single key.
   */
  async del(key) {
    const client = await this.ensureConnected();
    if (!client) return;
    try { await client.del(key); } catch { /* ignore */ }
  }

  // ─── Disconnect ────────────────────────────────────────────────────────────

  async disconnect() {
    if (this.client) {
      try { await this.client.quit(); } catch { /* ignore */ }
      this.client = null;
    }
    this.initPromise = null;
    this.failed = false;
  }
}
