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
  // ── 2026-08-30 审核返修：无主语/带修饰变体（真实毒行 4d930d13、2adcf2ac、04f96013、4d847fdf、d5292b1e）
  // 无主语「当前(正在)?使用的模型是」（行首或句中回声均算）
  /(?:^|[\n])\s*(?:当前|目前)(?:正在)?使用的?模型?\s*(?:是|为)/,
  /(?:^|[，。；;：:]\s*)(?:当前|目前)(?:正在)?使用的?模型?\s*(?:是|为)/,
  // 「我/你当前使用的大模型是」带修饰
  /我(?:现在|当前|目前)(?:实际)?使用(?:的)?(?:大|基础|底层|语言)?模型\s*(?:是|为)/,
  // 当前使用(运行)的对象是具体模型名（P0 一刀谓词同构，拦截型号罗列回声）
  /当前.{0,6}(?:使用|运行)(?:的)?[^。\n]{0,4}(?:模型|NVIDIA|nvidia|bailian|kimi|nemotron|qwen|gpt)/,
  // 宽松身份自述：我是…(语言|大|多模态|视觉)模型 / 本助手是…模型 / 作为…底层架构
  /我是[^。\n]{0,45}?(?:语言|大|多模态|视觉)[-\s]*(?:语言)?模型/,
  /本(?:助手|AI|ai)是.{0,30}模型/,
  /(?:^|[\n])\s*(?:基于)?我作为[^。\n]{0,24}底层架构/,
  /作为.{0,20}底层架构/,
  // 幻觉人设名（线上实测 NVIDIA Ising-Calibration 系列，受纯度门约束）
  /量子校准|Ising-Calibration/i,
  // 英文
  /\bmy\s+(?:current\s+)?model\s+is\b/i,
  /\bi\s+am\s+(?:currently\s+)?(?:running|powered\s+by)\b/i,
  /\bi\s+am\s+(?:currently\s+)?(?:running\s+(?:on|with)|powered\s+by|using)\s+(?:the\s+)?(?:model|claude|gpt|qwen|gemini|llama|deepseek|[A-Z][\w-]*-[\w.]+)/i,
  /\bi\s*am\s*(?:an?\s*)?(?:AI\s*assistant|a\s*large\s*language\s*model|claude|gpt-[\w.]+|qwen[\w.-]*|gemini)\b/i,
];

// 注入块回声前缀（「我在第 5 行：…」）：任何合法技术结论都不会以此开头，
// 不受纯度门约束（P0 一刀同构，真实毒行 2b332f3f）。
const INJECTION_ECHO_RE = /(?:^|[\n])\s*我在第\s*\d+\s*行[:：]/;

// 首行强身份声明（开头 200 字内出现「我当前使用的大模型是 X」且全文 ≤1200 字）：
// 整件都是自我模型介绍文（真实毒行 04f96013，730 字，行占比法拦不到）。
const STRONG_HEAD_RE = /^[\s\S]{0,200}?我(?:现在|当前|目前)(?:实际)?使用(?:的)?(?:大|基础|底层|语言)?模型\s*(?:是|为)/;

// 会话态/记忆机制自述回声（事故回放文）：命中 ≥2 个不同特征且 ≤2000 字则拦。
// 真实毒行：172fc817/71f6efca/81e090e7/d9650648/e28bd424/e8c38bd6（均为当日事故
// meta 对话，不可迁移）。已知可接受项（注释即可，按审核意见）：
// - user 角色系统描述回声（「你是通义千问…」）设计上不拦，宁漏勿误杀。
// - 单行长文以身份句开头会被行占比规则拦：语义上可接受。
const META_ECHO_TOKEN_RES = [
  /session[_\s]*status/i,
  /session\s*状态/,
  /relevant[-\s]*memories?/i,
  /注入的?(?:\s*\d+\s*条)?(?:历史)?(?:记忆|上下文|数据)|注入块/,
  /毒数据|毒发|毒样本|存量毒|噪音(?:全部|压|样本|数据)|全是"?短文/,
  /自动捕获|自动分配/,
  /召回(?:链路|缓存|盲区|机制|无法向量化)/,
  /缓存的模型配置|运行时状态/,
  /\b(?:captureMaxChars|recallLimit|recallMinScore|maxCapturesPerTurn|similarityThreshold|memory_store|memory_recall|searchForRecall)\b/,
];

/**
 * Is this text (nearly) a pure first-person model-identity statement,
 * an injection echo, a current-model spec dump, or a session-state meta
 * echo? Purity gate for pattern-set hits: whole text ≤ 400 chars OR
 * identity-line ratio > 0.5. A single identity sentence embedded inside a
 * long report passes.
 * @param {string} text
 * @returns {boolean}
 */
export function isIdentityStatement(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  // Unconditional arms (no purity gate) — shapes that never occur in real conclusions.
  if (INJECTION_ECHO_RE.test(t)) return true;
  if (t.length <= 1200 && STRONG_HEAD_RE.test(t)) return true;
  const metaHits = META_ECHO_TOKEN_RES.filter((r) => r.test(t)).length;
  if (metaHits >= 2 && t.length <= 2000) return true;
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
// ACK 开场的实质化中段：纯应答后接行动计划的才拦（真实毒行 85f87bd4/989f737e/
// 61401ede/9e521616/a2d79cae/cd971e8d）；带结论词的行放行（红线 10bcf776/d2fdb7a1）。
const ACK_BODY_PLAN_RE = /(?:让我|我先|我来|我将|继续|先推进|准备接|已就绪|接下来)/;
// 过程叙事短语（句中位置，仅短文 <300）：真实毒行三刀集 14223a1d/17516765/
// 4ff17a7d/6e76c2ca/cc734945/f70d1f3f；红线 ff1bc123 含「找到原因了」被排除项保护。
const PLAN_ANYWHERE_RE =
  /(?:现在我来|现在我会|现在开始|开始实际|试一下|顺便看|验证一下|再重测|先测|先直接|然后找)/;
// 结论词排除表：命中则不判独白（红线 91b7d994 靠「确认了」保护；
// ff1bc123 靠「找到原因」；10bcf776/d2fdb7a1 靠「不需要/已写入记忆」）。
const CONCLUSION_EXCLUDE_RE =
  /(?:结论|根因|原因了|找到原因|意味着|教训|已确认|确认了|确认过|决策|不需要|不用管|已写入记忆|以后.{0,12}(?:都|全部|一律|不用|不需要)|值得升级|显式声明|限制)/;

/**
 * Is this a process-monologue fragment (not a conclusion)?
 * All intent/ACK/plan branches are gated by CONCLUSION_EXCLUDE_RE (review
 * round 3: "好问题。让我查…✅确认了…保持 false 就行" must pass), except the
 * <40-char pure-ack branch — an ack fragment this short carries no
 * conclusion regardless of wording.
 * @param {string} text
 * @returns {boolean}
 */
export function isMonologueFragment(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t || t.length >= 300) return false;
  if (MONOLIGUE_INTENT_RE.test(t) && !CONCLUSION_EXCLUDE_RE.test(t)) return true;
  if (t.length < 40 && MONOLIGUE_ACK_RE.test(t)) return true;
  // ACK-open + body plan (mid length allowed) with conclusion exclusion
  if (MONOLIGUE_ACK_RE.test(t) && ACK_BODY_PLAN_RE.test(t) && !CONCLUSION_EXCLUDE_RE.test(t)) return true;
  // mid-sentence forward-plan phrasing in short text, conclusion-protected
  if (PLAN_ANYWHERE_RE.test(t) && !CONCLUSION_EXCLUDE_RE.test(t)) return true;
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
