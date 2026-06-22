/**
 * Auto-capture filter functions for mysql-memory plugin.
 * These functions determine whether an assistant reply should be captured as memory.
 * Each function returns true if the text should be filtered (NOT captured).
 */

import { TOOL_USE_FILTER_RE, isToolMonologue, isInjection } from "../config.js";
import { CAPTURE_NOISE_PATTERNS, matchesCaptureNoisePattern } from "../config.js";

const DEFAULT_LLM_OUTPUT_MIN_LENGTH = 40;

// ─── Filter functions (each returns true if text should be skipped) ───────────

/**
 * Check if text is too short to capture.
 * @param {string} text - text to check
 * @param {number} cjkCount - CJK character count
 */
export function isTooShort(text, cjkCount) {
  const cjkThreshold = cjkCount >= 10 ? 15 : 40;
  return text.length < cjkThreshold || text.length < DEFAULT_LLM_OUTPUT_MIN_LENGTH;
}

/**
 * Check if text contains tool-use intermediate products (SDK internal messages).
 * @param {string} text - text to check
 */
export function isToolUseIntermediate(text) {
  return TOOL_USE_FILTER_RE.test(text.slice(0, 500));
}

/**
 * Check if text is a boot/heartbeat message.
 * @param {string} text - text to check
 */
export function isBootMessage(text) {
  return /boot\.md|启动检查|gateway 重启|heartbeat/i.test(text);
}

/**
 * Check if text is a pure question.
 * @param {string} text - text to check
 */
export function isPureQuestion(text) {
  return /^[^\n?？]*[?？]$/.test(text.trim());
}

/**
 * Check if text is markdown-only (headings, code fences, tables).
 * @param {string} text - text to check
 */
export function isMarkdownOnly(text) {
  const trimmed = text.trim();
  if (/^#{1,6}\s/.test(trimmed) && !/\n/.test(trimmed)) return true;
  if (/^[-*•]\s/.test(trimmed) && !/\n/.test(trimmed)) return true;
  return false;
}

/**
 * Check if text has reasoning tags (models with reasoning).
 * @param {string} text - text to check
 */
export function hasReasoningTags(text) {
  return /<(think|thinking)[^>]*>/.test(text.trim());
}

/**
 * Check if text is a tool-call monologue (LLM thinking-out-loud).
 * @param {string} text - text to check
 * @param {number} cjkCount - CJK character count
 */
export function isToolCallMonologue(text, cjkCount) {
  const trimmed = text.trim();
  if (cjkCount < 5) {
    // English thinking process / self-narration
    if (/^(now i (have|will|need to|should)|now let|let me|let's|callers use|i'll (add|create|check|read|look|see|find|explain|show)|i (should|need to|want to|think|guess|suppose)|hmm|okay|alright|sure|let's see|let me think)/i.test(trimmed)) return true;
    // Chain-of-thought step markers at start (short text)
    if (/^(first,?|next,?|then,?|finally,?|so,?|basically,?|essentially,?)\s/i.test(trimmed) && trimmed.split('\n').length <= 2) return true;
  }
  return isToolMonologue(trimmed) && trimmed.length < 120;
}

/**
 * Check if text is a pure confirmation (short, single-sentence).
 * @param {string} text - text to check
 */
export function isPureConfirmation(text) {
  const trimmed = text.trim();
  // Single-sentence confirmations
  if (/^(明白|好的|收到|收到啦|好的呢|了解|OK|ok|好的好的|没问题|没问题了|晚安|拜拜|再见|再会|bye|Bye)[。！？.!]?\s*$/.test(trimmed)) return true;
  // Meta-dialogue about the system
  if (/^(当前去重|当前处理|机制已|不会存储|上述机制|此功能不会|该功能不会)/.test(trimmed) && trimmed.length < 150) return true;
  return false;
}

/**
 * Check if text contains Chinese task status / dispatch reports.
 * @param {string} text - text to check
 */
export function isTaskStatus(text) {
  const trimmed = text.trim();
  if (/^(已派发给|正在等待|正在查询|正在执行|正在处理|正在检查|正在读取|任务完成|任务已|任务失败|已完成，|已完成[。！]|找到了|已找到|发现|检查结果|查询结果|执行结果)/.test(trimmed)) return true;
  return false;
}

/**
 * Check if text is AI meta-replies about execution.
 * @param {string} text - text to check
 */
export function isMetaReplies(text) {
  const trimmed = text.trim();
  if (/^(已记住|收到|好的我来|好的我|结果出来了|结论很清楚|扫描了一圈|这两个我都清楚|我来帮你|可以帮你|我来检查|让我来|让后端|让策划|任务已派发|已派发|派任务给|收到，|好的收到|明白，)[。！？.!]?(\s|$)/.test(trimmed) && trimmed.length < 80) return true;
  return false;
}

/**
 * Check if text is Chinese simple confirmations / acknowledgements.
 * @param {string} text - text to check
 */
export function isSimpleConfirmation(text) {
  const trimmed = text.trim();
  if (/^(收到，|好的，|明白，|了解，|没问题，|好的呢，|行，|嗯，|嗯嗯|知道了|已了解|收到啦|好的收到)/i.test(trimmed) && trimmed.length < 120) {
    const sentenceEnds = (trimmed.match(/[。！？.!?]/g) || []).length;
    return sentenceEnds <= 2;
  }
  return false;
}

/**
 * Check if text is an execution status record (not knowledge).
 * @param {string} text - text to check
 */
export function isExecutionStatus(text) {
  const trimmed = text.trim();
  if (/^(已执行|数据已记录|样本不足|已采集|已运行|已设置|已补完|补完了)/.test(trimmed) && trimmed.length < 200) return true;
  return false;
}

/**
 * Check if text contains noise patterns from config.
 * @param {string} text - text to check
 * @param {object} config - plugin config
 */
export function hasNoisePatterns(text, config) {
  return matchesCaptureNoisePattern(text, config);
}

// ─── Main filter function - composition of all checks ────────────────────────

/**
 * Check if assistant text should be captured as memory.
 * Returns true if SHOULD BE CAPTURED (not filtered out).
 * @param {string} text - text to check
 * @param {number} maxChars - maximum text length
 * @param {object} config - plugin config
 * @returns {boolean} true if text should be captured
 */
export function shouldCaptureAssistant(text, maxChars = 500, config = {}) {
  // Language-aware length filter
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  if (isTooShort(text, cjkCount)) return false;
  if (text.length > maxChars) return false;
  
  const trimmed = text.trim();
  
  // Skip special content
  if (text.includes("<relevant-memories>")) return false;
  if (text.startsWith("<") && text.includes("</")) return false;
  if (text.includes("<active_memory_plugin>")) return false;
  if (isInjection(text)) return false;
  
  // Filter tool-use intermediate products
  if (isToolUseIntermediate(trimmed)) return false;
  if (isBootMessage(trimmed)) return false;
  
  // Skip pure questions
  if (isPureQuestion(trimmed)) return false;
  
  // Skip markdown-only responses
  if (isMarkdownOnly(trimmed)) return false;
  
  // Skip reasoning content
  if (hasReasoningTags(trimmed)) return false;
  
  // Skip tool-call monologue
  if (isToolCallMonologue(trimmed, cjkCount)) {
    const sentenceEnds = (trimmed.match(/[。！？.!?]/g) || []).length;
    if (sentenceEnds <= 1) return false;
  }
  
  // Must end with sentence-ending punctuation
  if (!/[。！？.!?]$/.test(trimmed)) return false;
  
  // Apply noise filters
  if (hasNoisePatterns(trimmed, config)) return false;
  if (isPureConfirmation(trimmed)) return false;
  if (isTaskStatus(trimmed)) return false;
  if (isMetaReplies(trimmed)) return false;
  if (isSimpleConfirmation(trimmed)) return false;
  if (isExecutionStatus(trimmed)) return false;
  
  // Otherwise accept
  return true;
}
