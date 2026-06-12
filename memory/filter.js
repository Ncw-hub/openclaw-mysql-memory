/**
 * Content filtering + deduplication for auto-capture.
 *
 * Layers:
 *   1. Structure — skip non-user messages, tool results
 *   2. Injection — filter boot.md, heartbeat, <relevant-memories>, etc.
 *   3. Noise     — pure emoji, short messages, pure questions
 *   4. Dedup     — fingerprint-based cursor tracking
 */

import { isInjection, shouldCapture, fingerprint } from "../config.js";

// ─── Layer 1: Structure ──────────────────────────────────────────────────────

/**
 * Check if a message is structurally eligible for capture.
 * - Must have an eligible role (user or assistant, configurable)
 * - Must not be a tool result
 * - Must have non-empty text content
 */
export function isStructurallyEligible(message, roles) {
  if (!message || typeof message !== "object") return false;
  const allowed = Array.isArray(roles) ? roles : ["user"];
  if (!allowed.includes(message.role)) return false;
  // Skip tool results
  if (message.content && Array.isArray(message.content)) {
    return message.content.some((b) => b?.type === "text" && b.text?.length > 0);
  }
  if (typeof message.content === "string") return message.content.length > 0;
  return false;
}

// ─── Layer 2: Injection filtering ───────────────────────────────────────────

/**
 * Detect and filter prompt injection patterns.
 * Filters: boot.md, heartbeat, <relevant-memories>, system prompts, etc.
 */
export function filterInjection(text) {
  // Already covered by isInjection() in config.js
  if (isInjection(text)) return false;

  // Additional patterns specific to system messages
  const systemPatterns = [
    /<relevant-memories>/i,
    /<active_memory_plugin>/i,
    /boot\.md.*启动检查/i,
    /gateway 重启/i,
    /HEARTBEAT/i,
    /HEARTBEAT_OK/i,
    /keepalive/i,
    /^[\s\[\]#\-]*$/m,  // Pure markdown formatting
  ];

  return !systemPatterns.some((r) => r.test(text));
}

// ─── Layer 3: Noise filtering ───────────────────────────────────────────────

/**
 * Detect and filter noise patterns.
 * - Pure emoji (> 3 emojis, no meaningful text)
 * - Too short (< 10 chars)
 * - Pure question (ends with ? or ？)
 * - Pure numbers
 * - Pure URLs
 */
export function filterNoise(text) {
  const trimmed = text.trim();

  // Too short
  if (trimmed.length < 10) return false;

  // Pure question
  if (/^[^\w\u4e00-\u9fff]*[\?\？][^\w\u4e00-\u9fff]*$/i.test(trimmed)) return false;

  // Pure numbers
  if (/^\d+$/.test(trimmed)) return false;

  // Pure URL
  if (/^https?:\/\/\S+$/.test(trimmed)) return false;

  // Pure emoji (more than 3 emojis, no alphanumeric or CJK)
  const emojiMatch = trimmed.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu);
  if (emojiMatch && emojiMatch.length > 3) {
    const nonEmoji = trimmed.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]/gu, "");
    if (nonEmoji.length === 0) return false;
  }

  return true;
}

// ─── Layer 4: Deduplication ─────────────────────────────────────────────────

/**
 * Check if a message fingerprint is already in the recent set.
 */
export function isDuplicate(text, recentFingerprints = new Set()) {
  const fp = fingerprint(text);
  if (recentFingerprints.has(fp)) return true;
  return false;
}

/**
 * Create a message fingerprint for dedup.
 */
export { fingerprint } from "../config.js";

// ─── Combined filter pipeline ───────────────────────────────────────────────

/**
 * Full filter pipeline — apply all layers.
 * Returns true if the message should be captured.
 */
export function shouldCaptureMessage(message, recentFingerprints = new Set(), maxChars = 500) {
  // Layer 1: Structure
  if (!isStructurallyEligible(message)) return false;

  // Extract text
  let text = "";
  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    text = message.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  }

  if (!text) return false;

  // Layer 2: Injection
  if (!filterInjection(text)) return false;

  // Layer 3: Noise
  if (!filterNoise(text)) return false;

  // Layer 4: Content value (reuse config.js shouldCapture)
  if (!shouldCapture(text, maxChars)) return false;

  // Layer 5: Dedup
  if (isDuplicate(text, recentFingerprints)) return false;

  return true;
}

/**
 * Extract text from a message object.
 */
export function extractText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}
