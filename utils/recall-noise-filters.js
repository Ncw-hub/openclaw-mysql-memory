/**
 * Recall-phase noise filters (P2-③) — second line of defense at injection time.
 *
 * Scope constraint: these predicates are used ONLY by store/mysql-store.js
 * `searchForRecall` noise-filter stage. They must NEVER touch the capture
 * chain (utils/capture-filters.js, index.js llm_output/agent_end).
 * Capture stays full-fidelity; interception happens only before injection.
 *
 * Design notes (planning/docs/design/mysql-memory-noise-p1p3-design.md):
 * - Checks are category-independent, fixing finding A: isNoiseMemory() is
 *   short-circuited by detectCategory mapping almost everything to 'fact',
 *   which permanently blinded the recall noise filter for poisoned rows.
 * - Callers must skip these checks for entries with source === 'tool'
 *   (manual memory_store rows are never filtered here).
 * - Identity/table regexes mirror the P1-①/② capture-side design so both
 *   phases share one semantic source; duplication here is intentional to
 *   keep the capture module untouched (red line for this iteration).
 */

// ─── Identity statements ──────────────────────────────────────────────────────

/**
 * First-person model-identity sentences (pattern-driven, no model-name list —
 * catches unknown hallucinated names too). Base set from design report P1-①
 * plus 2026-07-21 field-observed variants.
 */
const IDENTITY_STATEMENT_RES = [
  // 中文：我(现在|当前|目前)使用…模型是/为…
  /^(?:你好[，,]\s*)?(?:我|本人)(?:现在|当前|目前|此时)?(?:所)?使用(?:的)?(?:基础|底层|当前)?模型?\s*(?:是|为)/,
  /我(?:现在|当前|目前)使用(?:的)?(?:是|模型是|模型为)/,
  /(?:我|本(?:AI|ai|助手))(?:是|作为)\s*(?:一个|一款)?\s*(?:AI|人工智能|大|语言|多模态)\s*模型/,
  /^作为\s*(?:一个|一款)?\s*(?:AI|人工智能|大|语言)\s*模型/,
  // 2026-07-21 线上注入块实测新变体
  /当前运行模型/,
  /^(?:我在第.{1,6}[:：])?我(?:现在|当前|目前)(?:正在)?(?:运行|使用)/,
  /作为\s*(?:AI|人工智能|大|语言)\s*模型/,
  // 英文
  /\bmy\s+(?:current\s+)?model\s+is\b/i,
  /\bi\s+am\s+(?:currently\s+)?(?:running|powered\s+by)\b/i,
  /\bi\s+am\s+(?:currently\s+)?(?:running\s+(?:on|with)|powered\s+by|using)\s+(?:the\s+)?(?:model|claude|gpt|qwen|gemini|llama|deepseek|[A-Z][\w-]*-[\w.]+)/i,
  /\bi\s*am\s*(?:an?\s*)?(?:AI\s*assistant|a\s*large\s*language\s*model|claude|gpt-[\w.]+|qwen[\w.-]*|gemini)\b/i,
];

/**
 * Is this text (nearly) a pure first-person model-identity statement?
 * Purity gate: regex hit AND (whole text ≤ 400 chars OR identity-line ratio
 * > 0.5). A single identity sentence embedded inside a long report passes.
 * @param {string} text
 * @returns {boolean}
 */
export function isIdentityStatement(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  if (!IDENTITY_STATEMENT_RES.some((r) => r.test(t))) return false;
  // Purity gate: only block when the text is essentially all identity noise.
  if (t.length <= 400) return true;
  const lines = t.split('\n').filter((l) => l.trim());
  const hitLines = lines.filter((l) => IDENTITY_STATEMENT_RES.some((r) => r.test(l)));
  return lines.length > 0 && hitLines.length / lines.length > 0.5;
}

// ─── Process-monologue fragments ──────────────────────────────────────────────

/**
 * Short "thinking out loud" fragments: 我先/让我 style openings, optionally
 * prefixed by one short lead-in clause (≤12 chars + 逗号/句号/顿号).
 * Length-capped (<300 chars) so real conclusions survive.
 *
 * Acknowledgement-only openers (明白了/收到/好的！) are split out with a much
 * stricter <40-char cap: decisions routinely open with "收到！" + substance
 * (red-line fixtures 10bcf776 @191字 / d2fdb7a1 @49字 must pass), so bare 收到
 * may only intercept pure ack fragments. 宁漏勿误杀, per 8-28 lesson.
 */
const MONOLIGUE_INTENT_RE =
  /^(?:.{0,12}[，。、]\s*)?(?:我先|我来|我去|我将|让我|现在我(?:来|将|看到|会)|继续(?:下一批|读取|检查|整理))/;
const MONOLIGUE_ACK_RE =
  /^(?:.{0,12}[，。、]\s*)?(?:明白了|收到|好的！)/;

/**
 * Is this a process-monologue fragment (not a conclusion)?
 * @param {string} text
 * @returns {boolean}
 */
export function isMonologueFragment(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t || t.length >= 300) return false;
  if (MONOLIGUE_INTENT_RE.test(t)) return true;
  if (t.length < 40 && MONOLIGUE_ACK_RE.test(t)) return true;
  return false;
}

// ─── Table-dominated dumps ────────────────────────────────────────────────────

/**
 * Is this text dominated by markdown table lines with too little prose?
 * Two tiers (design report P1-②):
 *   - ratio ≥ 0.5 and prose chars < 120  → pure table dump
 *   - ratio ≥ 0.35 and total > 2500 chars and prose chars < 400 → long-form
 *     table filler (tutorial style)
 * Narrative-dominated reports (the 8-28 regression samples) always pass.
 * @param {string} text
 * @returns {boolean}
 */
export function isTableDominated(text) {
  if (typeof text !== 'string') return false;
  const lines = text.split('\n');
  if (lines.length < 8) return false;
  const tableLines = lines.filter((l) => /^\s*\|/.test(l));
  const ratio = tableLines.length / lines.length;
  const proseChars = lines
    .filter((l) => !/^\s*\|/.test(l))
    .join('')
    .replace(/\s+/g, '').length;
  if (ratio >= 0.5 && proseChars < 120) return true;
  if (ratio >= 0.35 && text.length > 2500 && proseChars < 400) return true;
  return false;
}
