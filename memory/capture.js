/**
 * Auto-capture logic — called from agent_end hook.
 *
 * Flow:
 *   1. Receive messages from agent_end event
 *   2. Filter through filter.js
 *   3. Generate embedding via ollama-embed.js
 *   4. Store via mysql-store.js
 *   5. Update cursor tracking
 *
 * Timeout and limits are config-driven.
 */

import { shouldCaptureMessage, extractText } from "./filter.js";
import { fingerprint } from "../config.js";

/**
 * Process agent_end event and auto-capture relevant messages.
 *
 * @param {object} event - agent_end event payload
 * @param {object} ctx - hook context (sessionKey, sessionId)
 * @param {object} deps - { store, embeddings, logger, cfg }
 * @param {object} opts - { maxCaptured, cursorMap }
 * @returns {Promise<{captured: number, skipped: number}>}
 */
export async function autoCapture(event, ctx, deps, opts = {}) {
  const { store, embeddings, logger, cfg } = deps;
  const cursorMap = opts.cursorMap || new Map();

  // Config-driven defaults
  const maxCaptured = opts.maxCaptured ?? (typeof cfg?.maxCapturesPerTurn === "number" ? cfg.maxCapturesPerTurn : 3);
  const maxChars = opts.maxChars ?? (typeof cfg?.captureMaxChars === "number" ? cfg.captureMaxChars : 500);
  const similarityThreshold = typeof cfg?.similarityThreshold === "number" ? cfg.similarityThreshold : 0.95;
  const candidateLimit = typeof cfg?.candidateLimit === "number" ? cfg.candidateLimit : 50;

  if (!event.success || !event.messages || event.messages.length === 0) {
    return { captured: 0, skipped: 0 };
  }

  const cursorKey = ctx.sessionKey ?? ctx.sessionId ?? "default";
  const cursor = cursorMap.get(cursorKey);
  const startIndex = cursor?.nextIndex ?? 0;

  // Build recent fingerprint set from cursor
  const recentFingerprints = new Set(cursor?.recentFingerprints ?? []);

  let captured = 0;
  let skipped = 0;

  for (let i = startIndex; i < event.messages.length; i++) {
    const message = event.messages[i];

    try {
      // Apply filter pipeline
      if (!shouldCaptureMessage(message, recentFingerprints, maxChars)) {
        skipped++;
        continue;
      }

      // Enforce max captures per turn
      if (captured >= maxCaptured) {
        skipped++;
        continue;
      }

      const text = extractText(message);
      if (!text) {
        skipped++;
        continue;
      }

      // Generate embedding (config-driven timeout via ollama-embed)
      let vector;
      try {
        vector = await embeddings.embed(text);
      } catch (embedErr) {
        logger.warn?.(`mysql-memory: embed failed during capture: ${embedErr.message}`);
        skipped++;
        continue;
      }

      // Check for duplicates in store (config-driven threshold)
      const existing = await store.search(vector, {
        limit: 1,
        minScore: similarityThreshold,
        candidateLimit,
      });
      if (existing.length > 0) {
        logger.info?.(`mysql-memory: capture skipped, duplicate found: "${text.slice(0, 50)}..."`);
        skipped++;
        // Still add fingerprint to recent set
        recentFingerprints.add(fingerprint(message));
        continue;
      }

      // Store the memory (scope-aware)
      const agentId = cfg?.isolateAgents ? (cfg._scopePlan?.agentId || "main") : "main";
      const scopeKey = cfg?.isolateAgents ? (cfg._scopePlan?.defaultStoreScope || "default") : "default";
      await store.store({
        text,
        vector,
        session_key: ctx.sessionKey ?? "default",
        agent_id: agentId,
        scope_key: scopeKey,
        source: "auto",
      });

      captured++;
      logger.info?.(`mysql-memory: captured memory #${captured}: "${text.slice(0, 50)}..."`);

      // Add fingerprint to recent set
      recentFingerprints.add(fingerprint(message));

      // Keep recent fingerprints bounded (max 50)
      if (recentFingerprints.size > 50) {
        const arr = [...recentFingerprints];
        recentFingerprints.clear();
        arr.slice(-50).forEach((fp) => recentFingerprints.add(fp));
      }

    } catch (err) {
      logger.warn?.(`mysql-memory: capture failed for message ${i}: ${err.message}`);
      skipped++;
    }
  }

  // Update cursor
  cursorMap.set(cursorKey, {
    nextIndex: event.messages.length,
    recentFingerprints: [...recentFingerprints],
    updatedAt: Date.now(),
  });

  return { captured, skipped };
}

/**
 * Clean up cursor for a session.
 * Called from session_end hook.
 */
export function cleanupCursor(cursorMap, event, ctx) {
  const cursorKey = ctx.sessionKey ?? event.sessionKey ?? ctx.sessionId ?? event.sessionId;
  cursorMap.delete(cursorKey);

  // Also clean up next session cursor if provided
  const nextCursorKey = event.nextSessionKey ?? event.nextSessionId;
  if (nextCursorKey) cursorMap.delete(nextCursorKey);
}
