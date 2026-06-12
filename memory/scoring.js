/**
 * Composite scoring for mysql-memory recall — JS 伪 Reranking.
 *
 * finalScore = wCosine × cosine + wRecency × recency + wKeyword × keyword
 *
 * No storage changes, no new dependencies.
 */

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_SCORING = {
  wCosine: 0.55,
  wRecency: 0.30,
  wKeyword: 0.15,
  dynamicMinScore: 0.45,
  normalMinScore: 0.6,
  shortQueryLen: 20,
};

// ─── Keyword extraction ─────────────────────────────────────────────────────

/**
 * Extract frequent 2–4 char/word ngrams from text (simplified BM25-style).
 * Works with Chinese, English, and mixed text.
 */
export function extractKeywords(text, maxN = 20) {
  if (!text) return [];
  const freq = new Map();

  for (let w = 4; w >= 2; w--) {
    for (let i = 0; i <= text.length - w; i++) {
      const kw = text.substring(i, i + w).toLowerCase();
      // Skip if mostly punctuation/symbols — needs at least one letter, digit, or CJK char
      if (!/[a-zA-Z0-9]/.test(kw) && !/[\u4e00-\u9fff\u3400-\u4dbf]/.test(kw)) continue;
      freq.set(kw, (freq.get(kw) || 0) + 1);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxN)
    .map(([kw]) => kw);
}

// ─── Scoring functions ──────────────────────────────────────────────────────

/**
 * Recency score: e^(-ageDays/30). Fresh = ~1.0, 30d = ~0.37, 90d = ~0.05.
 */
export function recencyScore(createdAt) {
  const ageMs = Date.now() - (createdAt || Date.now());
  const ageDays = Math.max(0, ageMs / 86_400_000);
  return Math.exp(-ageDays / 30);
}

/**
 * Keyword match score: what fraction of query keywords appear in text.
 */
export function keywordMatchScore(queryKeywords, text) {
  if (!queryKeywords.length || !text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of queryKeywords) {
    if (lower.includes(kw)) hits++;
  }
  return hits / queryKeywords.length;
}

/**
 * Compute composite score from cosine + recency + keyword components.
 */
export function computeFinalScore(cosine, createdAt, text, query, scoring = DEFAULT_SCORING) {
  const { wCosine, wRecency, wKeyword } = scoring;
  const recency = wRecency > 0 ? recencyScore(createdAt) : 0;
  const queryKw = wKeyword > 0 ? extractKeywords(query) : [];
  const keyword = wKeyword > 0 ? keywordMatchScore(queryKw, text) : 0;
  return wCosine * cosine + wRecency * recency + wKeyword * keyword;
}

// ─── Dynamic threshold ──────────────────────────────────────────────────────

/** Short query (<20 chars) or backtrack terms → lower threshold. */
export function shouldLowerThreshold(query) {
  if (query.length <= DEFAULT_SCORING.shortQueryLen) return true;
  const lower = query.toLowerCase();
  const backtrackTerms = [
    "remember", "before", "yesterday", "last time", "ago", "previously",
    "之前", "以前", "上次", "昨天", "前几天", "还记得", "记得", "曾经", "过去",
  ];
  return backtrackTerms.some((t) => lower.includes(t));
}

/** Resolve the effective min composite score for a query. */
export function resolveMinScore(query, cfg) {
  return shouldLowerThreshold(query)
    ? (cfg?.dynamicMinScore ?? DEFAULT_SCORING.dynamicMinScore)
    : (cfg?.normalMinScore ?? DEFAULT_SCORING.normalMinScore);
}
