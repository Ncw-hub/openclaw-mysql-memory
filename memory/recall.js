/**
 * Auto-recall logic — called from before_prompt_build hook.
 *
 * Flow:
 *   1. Trigger with latest user message as query
 *   2. Generate query vector via ollama-embed.js
 *   3. Check Redis cache first (redis-cache.js)
 *   4. Cache miss → search MySQL (mysql-store.js)
 *   5. Format results as <relevant-memories> block
 *   6. 15-second timeout protection
 *
 * On failure: gracefully skip (don't block prompt building).
 */

import { normalizeQuery, simpleHash, formatMemories, extractLatestUserText } from "../config.js";
import { computeFinalScore, resolveMinScore, extractKeywords } from "./scoring.js";

/**
 * Generate a cache key for recall results.
 */
function recallCacheKey(query, sessionKey, limit) {
  const h = simpleHash(query);
  return `mysql-memory:recall:${h}:${sessionKey || "all"}:${limit}`;
}

/**
 * Run a task with timeout.
 * Returns { status: "ok", value } or { status: "timeout" }.
 */
function runWithTimeout({ timeoutMs, task }) {
  let timeout;
  const TIMEOUT = Symbol("timeout");
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    timeout.unref?.();
  });
  const taskPromise = task().catch((err) => {
    throw err;
  });

  return Promise.race([taskPromise, timeoutPromise]).then((result) => {
    if (result === TIMEOUT) return { status: "timeout" };
    return { status: "ok", value: result };
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

/**
 * Auto-recall relevant memories for the current prompt.
 *
 * @param {object} event - before_prompt_build event
 * @param {object} ctx - hook context
 * @param {object} deps - { store, cache, embeddings, logger }
 * @param {object} cfg - parsed config object
 * @returns {Promise<string|null>} prependContext string or null
 */
export async function autoRecall(event, ctx, deps, cfg) {
  const { store, cache, embeddings, logger } = deps;

  try {
    // Extract latest user text
    const queryText = event.messages
      ? extractLatestUserText(event.messages)
      : event.prompt;

    if (!queryText || queryText.length < 5) {
      return null;
    }

    const normalizedQuery = normalizeQuery(queryText, cfg.recallMaxChars);

    // Run with timeout protection (15s default)
    const timeoutMs = cfg.autoRecallTimeout ?? 15_000;
    const result = await runWithTimeout({
      timeoutMs,
      task: async () => {
        // Check Redis cache first
        if (cfg.cache.enabled) {
          const ckey = recallCacheKey(normalizedQuery, ctx.sessionKey, cfg.recallLimit);
          try {
            const cached = await cache.getRecallCache(ckey);
            if (cached && Array.isArray(cached) && cached.length > 0) {
              logger.info?.(`mysql-memory: recall cache hit (${cached.length} results)`);
              return cached;
            }
          } catch (cacheErr) {
            logger.warn?.(`mysql-memory: cache check failed: ${cacheErr.message}`);
            // Continue to search
          }
        }

        // Generate query embedding (with 8s timeout to leave room for search)
        const vector = await embeddings.embed(normalizedQuery, { timeoutMs: 8000, maxRetries: 2 });

        // Fetch candidates from MySQL (lower SQL filter to 0.1 to let JS reranking decide)
        const rawResults = await store.searchRaw(vector, {
          minScore: cfg.recallMinScore ?? 0.1,
          sessionKey: cfg.isolateAgents ? ctx.sessionKey : undefined,
          category: undefined,
          candidateLimit: cfg.candidateLimit,
        });

        // Composite scoring + reranking
        const minScore = resolveMinScore(normalizedQuery, cfg);
        const scored = rawResults
          .map((r) => {
            const finalScore = computeFinalScore(
              r.cosine,
              r.entry.created_at,
              r.entry.text,
              normalizedQuery,
            );
            return {
              entry: r.entry,
              score: finalScore,
              _cosine: r.cosine,
              _recency: r.entry.created_at,
              _keyword: extractKeywords(normalizedQuery, 10)
                .filter((kw) => r.entry.text.toLowerCase().includes(kw)).length,
            };
          })
          .filter((r) => r.score >= minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, cfg.recallLimit);

        // Cache results if any
        if (cfg.cache.enabled && scored.length > 0) {
          const ckey = recallCacheKey(normalizedQuery, ctx.sessionKey, cfg.recallLimit);
          const payload = scored.map((r) => ({
            id: r.entry.id,
            text: r.entry.text,
            category: r.entry.category,
            score: r.score,
          }));
          try {
            await cache.setRecallCache(ckey, payload, cfg.cache.recallCacheTTL);
          } catch (cacheErr) {
            logger.warn?.(`mysql-memory: cache set failed: ${cacheErr.message}`);
          }
        }

        logger.info?.(`mysql-memory: recall scoring: ${rawResults.length} candidates → ${scored.length} after threshold=${minScore.toFixed(2)}`);
        return scored;
      },
    });

    if (result.status === "timeout") {
      logger.warn?.(`mysql-memory: auto-recall timed out after ${timeoutMs}ms`);
      return null;
    }

    const memories = result.value;
    if (!memories || memories.length === 0) {
      return null;
    }

    logger.info?.(`mysql-memory: injecting ${memories.length} memories into context`);

    // Format as <relevant-memories> block
    return formatMemories(memories.map((r) => ({
      text: r.entry.text,
      category: r.entry.category || "other",
    })));

  } catch (err) {
    logger.warn?.(`mysql-memory: recall failed: ${err.message}`);
    // Graceful degradation — don't block prompt building
    return null;
  }
}


