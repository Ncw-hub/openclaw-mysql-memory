/**
 * Tool implementations: memory_store, memory_recall, memory_forget.
 *
 * Each tool wraps the store/embed/cache layers with error handling
 * and Redis cache integration (for recall).
 */

import { Type } from "typebox";
import {
  MEMORY_CATEGORIES,
  normalizeQuery,
  simpleHash,
  detectCategory,
  resolveAgentScopePlan,
  recallCacheKey,
} from "../config.js";

/**
 * Register all memory tools on the plugin API.
 * @param {object} api - OpenClaw plugin API
 * @param {object} deps - { store, cache, embeddings, cfg, logger }
 */
export function registerMemoryTools(api, deps) {
  const { store, cache, embeddings, cfg, logger } = deps;

  // Resolve current agent scope plan for tool defaults
  function currentScopePlan(toolCtx) {
    return resolveAgentScopePlan(cfg, toolCtx || {});
  }

  // ─── Cached recall limit ─────────────────────────────────────────────────

  // ─── memory_recall ─────────────────────────────────────────────────────────

  api.registerTool(
    {
      name: "memory_recall",
      label: "Memory Recall",
      description:
        "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(Type.Number({ description: "Max results (default 3)" })),
        category: Type.Optional(Type.String({ description: "Memory category filter" })),
        scope: Type.Optional(Type.String({ description: "Memory scope filter (e.g. 'main', 'planning', 'shared')" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const { query, limit = cfg.recallLimit, category, scope } = params;
          const normalizedQuery = normalizeQuery(query, cfg.recallMaxChars);

          // Determine scope filter
          let scopeKeys;
          if (scope) {
            scopeKeys = [scope];
          } else if (cfg.isolateAgents) {
            scopeKeys = currentScopePlan(this).recallScopes;
          } else {
            scopeKeys = undefined; // no filter when isolation disabled
          }

          // Check Redis cache first
          if (cfg.cache.enabled) {
            const ckey = recallCacheKey(normalizedQuery, null, limit, cfg);
            const cached = await cache.getRecallCache(ckey);
            if (cached && Array.isArray(cached) && cached.length > 0) {
              return {
                content: [{ type: "text", text: `Found ${cached.length} memories (cached):\n\n${cached.map((r, i) => `${i + 1}. [${r.category}] ${r.text} (${(r.score * 100).toFixed(0)}%)`).join("\n")}` }],
                details: { count: cached.length, memories: cached, cached: true },
              };
            }
          }

          // Generate embedding
          const vector = await embeddings.embed(normalizedQuery);

          // Search MySQL + recall-time post-processing (noise filter + recency rerank)
          const results = await store.searchForRecall(vector, {
            limit,
            minScore: cfg.recallMinScore ?? 0.3,
            category,
            agentId: cfg.isolateAgents ? currentScopePlan(this).agentId : undefined,
            scopeKey: scopeKeys,
            candidateLimit: cfg.candidateLimit,
            noiseFilter: cfg.noiseFilter,
            recencyRerank: cfg.recencyRerank,
          });

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          // Cache results
          if (cfg.cache.enabled) {
            const ckey = recallCacheKey(normalizedQuery, null, limit, cfg);
            const cachePayload = results.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              score: r.score,
            }));
            await cache.setRecallCache(ckey, cachePayload, cfg.cache.recallCacheTTL);
          }

          const text = results
            .map((r, i) => `${i + 1}. [${r.entry.category}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%)`)
            .join("\n");

          return {
            content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
            details: { count: results.length, memories: results.map((r) => ({ id: r.entry.id, text: r.entry.text, category: r.entry.category, score: r.score })) },
          };
        } catch (err) {
          logger.warn(`memory_recall failed: ${err.message}`);
          return {
            content: [{ type: "text", text: `Memory recall failed: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    },
    { name: "memory_recall" },
  );

  // ─── memory_store ──────────────────────────────────────────────────────────

  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory. Use for preferences, facts, decisions.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        importance: Type.Optional(Type.Number({ description: "Importance 0-1 (default: 0.7)" })),
        category: Type.Optional(
          Type.Unsafe({ type: "string", enum: [...MEMORY_CATEGORIES] })
        ),
        scope: Type.Optional(Type.String({ description: "Memory scope to store into (e.g. 'main', 'planning')" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const { text, importance = 0.7, category = "other", scope } = params;

          // Null-safe: text is required
          if (!text || typeof text !== "string" || text.trim().length === 0) {
            return {
              content: [{ type: "text", text: "Missing or empty text parameter. Provide the text you want to store." }],
              details: { error: "missing_text" },
            };
          }

          // Determine agent_id and scope_key for storage
          const plan = currentScopePlan(this);
          const agentId = cfg.isolateAgents ? plan.agentId : "main";
          const scopeKey = (scope && cfg.isolateAgents) ? scope : plan.defaultStoreScope;

          // Generate embedding
          const vector = await embeddings.embed(text);

          // Check for duplicates (scope-aware)
          const existing = await store.search(vector, {
            limit: 1,
            minScore: cfg.similarityThreshold,
            agentId,
            scopeKey,
            candidateLimit: cfg.candidateLimit,
          });
          if (existing.length > 0) {
            const existingEntry = existing[0].entry || existing[0];
            return {
              content: [{ type: "text", text: `Similar memory already exists: "${existingEntry.text}"` }],
              details: {
                action: "duplicate",
                existingId: existingEntry.id,
                existingText: existingEntry.text,
              },
            };
          }

          const entry = await store.store({ text, vector, category, source: "tool", agent_id: agentId, scope_key: scopeKey });

          // Invalidate recall cache
          if (cfg.cache.enabled) {
            await cache.invalidate("mysql-memory:recall:*");
          }

          return {
            content: [{ type: "text", text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"` }],
            details: { action: "created", id: entry.id },
          };
        } catch (err) {
          logger.warn(`memory_store failed: ${err.message}`);
          return {
            content: [{ type: "text", text: `Memory store failed: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    },
    { name: "memory_store" },
  );

  // ─── memory_forget ─────────────────────────────────────────────────────────

  api.registerTool(
    {
      name: "memory_forget",
      label: "Memory Forget",
      description: "Delete specific memories. GDPR-compliant.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Search to find memory" })),
        memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
        scope: Type.Optional(Type.String({ description: "Memory scope to search within" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const { query, memoryId } = params;

          if (memoryId) {
            const deleted = await store.forget(memoryId);
            if (deleted) {
              if (cfg.cache.enabled) {
                await cache.invalidate("mysql-memory:recall:*");
              }
              return {
                content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
                details: { action: "deleted", id: memoryId },
              };
            }
            return {
              content: [{ type: "text", text: `Memory ${memoryId} not found.` }],
              details: { action: "not_found", id: memoryId },
            };
          }

          if (query) {
            const normalizedQuery = normalizeQuery(query, cfg.recallMaxChars);
            const vector = await embeddings.embed(normalizedQuery);

            // Determine scope filter for forget
            let scopeKeys;
            if (scope && cfg.isolateAgents) {
              scopeKeys = [scope];
            } else if (cfg.isolateAgents) {
              scopeKeys = currentScopePlan(this).toolScopes;
            } else {
              scopeKeys = undefined;
            }

            const result = await store.forgetByQuery(vector, {
              minScore: cfg.recallMinScore ?? 0.3,
              autoForgetThreshold: 0.9,
              candidateLimit: cfg.candidateLimit,
              agentId: cfg.isolateAgents ? currentScopePlan(this).agentId : undefined,
              scopeKey: scopeKeys,
            });

            if (result.found === 0) {
              return {
                content: [{ type: "text", text: "No matching memories found." }],
                details: { found: 0 },
              };
            }

            if (result.deleted) {
              if (cfg.cache.enabled) {
                await cache.invalidate("mysql-memory:recall:*");
              }
              return {
                content: [{ type: "text", text: `Forgotten memory: ${result.deleted}` }],
                details: { action: "deleted", id: result.deleted },
              };
            }

            if (result.candidates) {
              const list = result.candidates
                .map((r) => `- [${r.id}] ${(r.text || "").slice(0, 60)}... (score: ${(r.score * 100).toFixed(0)}%)`)
                .join("\n");
              return {
                content: [{ type: "text", text: `Found ${result.found} candidates below threshold. Specify memoryId:\n${list}` }],
                details: { action: "candidates", candidates: result.candidates },
              };
            }

            return {
              content: [{ type: "text", text: "No actionable result." }],
              details: { error: "no_action" },
            };
          }

          return {
            content: [{ type: "text", text: "Provide query or memoryId." }],
            details: { error: "missing_param" },
          };
        } catch (err) {
          logger.warn(`memory_forget failed: ${err.message}`);
          return {
            content: [{ type: "text", text: `Memory forget failed: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    },
    { name: "memory_forget" },
  );
}
