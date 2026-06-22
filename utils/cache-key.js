/**
 * Cache key generation utilities for mysql-memory plugin.
 *Centralizes cache key logic to avoid duplication.
 */

import { simpleHash } from "../config.js";

/**
 * Generate cache key for recall results.
 * Includes config version to invalidate cache when noise filter / recency settings change.
 * @param {string} query - normalized query text
 * @param {string} sessionKey - session identifier (null if not applicable)
 * @param {number} limit - recall limit
 * @param {object} config - full plugin config
 * @returns {string} cache key
 */
export function recallCacheKey(query, sessionKey, limit, config) {
  const h = simpleHash(query);
  // Build config version string from key recall-time settings
  const nf = config.noiseFilter || {};
  const rr = config.recencyRerank || {};
  const configStr = [
    'nf', nf.enabled ? '1' : '0', nf.expandFactor || '2.0', nf.maxExpandedCandidates || '100',
    'rr', rr.enabled ? '1' : '0', rr.halfLifeDays || '14', rr.weight || '0.15',
  ].join('|');
  const configVersion = simpleHash(configStr);
  return `mysql-memory:recall:v2:${h}:${sessionKey || "all"}:${limit}:${configVersion}`;
}
