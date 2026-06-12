/**
 * Ollama embedding layer — lazy init, timeout + retry.
 *
 * Uses Ollama /api/embed endpoint (not /api/embeddings which is legacy).
 * Zero I/O in constructor — first embed() triggers init.
 *
 * All timeouts and limits are config-driven with sensible defaults.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_CHARS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 500;

export class OllamaEmbed {
  constructor(config, logger) {
    this.config = config;   // { model, baseUrl, dimensions, timeoutMs, maxChars }
    this.logger = logger;
    this.baseUrl = null;
    this.readyPromise = null;
    // Serial queue — bge-m3 (BERT) GPU doesn't support concurrent embeddings;
    // queueing all requests guarantees sequential execution, eliminating NaN at source.
    this._queue = Promise.resolve();
    // Cooldown for consecutive embed failures (NaN/GPU instability)
    this.lastFailTime = 0;
    this.consecutiveFailures = 0;
    this.cooldownMs = typeof config?.cooldownMs === "number" ? config.cooldownMs : 60_000; // default 60s
  }

  // ─── Lazy init ─────────────────────────────────────────────────────────────

  async ensureReady() {
    if (this.baseUrl) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = this._doReady().catch((err) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  async _doReady() {
    if (!this.config.baseUrl) {
      throw new Error("Ollama embedding baseUrl not configured");
    }
    this.baseUrl = this.config.baseUrl.replace(/\/+$/, "");
  }

  // ─── Embed ─────────────────────────────────────────────────────────────────

  /**
   * Generate embedding vector for text.
   * @param {string} text
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]  — per-request timeout (default from config, fallback 10s)
   * @param {number} [opts.maxRetries] — retries on NaN errors (default from config, fallback 2)
   * @returns {Promise<number[]>}
   */
  async embed(text, opts = {}) {
    await this.ensureReady();

    // Serial queue: bge-m3 (BERT) GPU doesn't support concurrent embeddings.
    // Chain every call so at most one request is in-flight at any time.
    const task = async () => this._doEmbedWithCooldown(text, opts);
    const result = this._queue.then(task, task);
    this._queue = result.then(() => {}, () => {}); // swallow to keep queue alive
    return result;
  }

  /**
   * Internal embed with cooldown check and retry logic.
   * Called only from the serial queue via embed().
   */
  async _doEmbedWithCooldown(text, opts = {}) {
    // Cooldown: skip embed after consecutive failures to avoid log flood and server pressure
    if (this.consecutiveFailures >= 3) {
      const elapsed = Date.now() - this.lastFailTime;
      if (elapsed < this.cooldownMs) {
        const remaining = Math.ceil((this.cooldownMs - elapsed) / 1000);
        const err = new Error(
          `Ollama embedding in cooldown (${this.consecutiveFailures} consecutive failures, ` +
          `retry after ${remaining}s)`
        );
        err.isCooldown = true;
        throw err;
      }
      // Cooldown expired, reset and allow retry
      this.logger.info?.(`mysql-memory: embed cooldown expired, resetting (${this.consecutiveFailures} failures, ${Math.round(elapsed/1000)}s elapsed)`);
      this.consecutiveFailures = 0;
    }

    const timeoutMs = typeof opts.timeoutMs === "number"
      ? opts.timeoutMs
      : (typeof this.config.timeoutMs === "number" ? this.config.timeoutMs : DEFAULT_TIMEOUT_MS);
    const maxRetries = typeof opts.maxRetries === "number"
      ? opts.maxRetries
      : (typeof this.config.maxRetries === "number" ? this.config.maxRetries : DEFAULT_MAX_RETRIES);

    // Configurable text truncation to prevent exceeding Ollama context window (8192 tokens).
    // 2000 Chinese chars ≈ 1200-4000 tokens depending on tokenizer — safe margin.
    const maxChars = typeof this.config.maxChars === "number"
      ? this.config.maxChars
      : DEFAULT_MAX_CHARS;

    if (text.length > maxChars) {
      // Use Array.from to safely truncate at code-point boundary (handles surrogate pairs / emoji)
      text = Array.from(text).slice(0, maxChars).join('');
    }

    let lastError;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.config.model,
            input: text,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Ollama embed API ${response.status}: ${body}`);
        }

        const data = await response.json();

        // /api/embed returns { embeddings: [number[][]] } or { embedding: number[] } (legacy)
        let vector;
        if (data.embeddings && Array.isArray(data.embeddings)) {
          vector = data.embeddings[0]; // single input → first embedding
        } else if (data.embedding && Array.isArray(data.embedding)) {
          vector = data.embedding;     // legacy format
        } else {
          throw new Error("Ollama returned empty or invalid embedding");
        }

        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error("Ollama returned empty embedding vector");
        }

        const mapped = vector.map((v) => Number(v));

        // Detect NaN (GPU OOM transient issue)
        if (mapped.some((v) => Number.isNaN(v))) {
          throw new Error("Ollama returned NaN in embedding (GPU memory issue)");
        }

        return mapped;
      } catch (err) {
        if (err.name === "AbortError") {
          throw new Error(`Ollama embedding timed out after ${timeoutMs}ms`);
        }

        lastError = err;

        // Retry for NaN (GPU memory transient) or empty vector (Ollama cold start)
        const isRetryable = err.message.includes("NaN") || err.message.includes("empty");
        if (isRetryable && attempt <= maxRetries) {
          await new Promise((r) => setTimeout(r, DEFAULT_RETRY_DELAY_MS));
          continue;
        }

        // Track consecutive failures for cooldown
        if (isRetryable) {
          this.consecutiveFailures++;
          this.lastFailTime = Date.now();
        }

        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError;
  }
}
