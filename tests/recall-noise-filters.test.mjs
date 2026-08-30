/**
 * P2-③ recall-noise-filters regression suite (node:test, DB-free).
 *
 * Fixtures are SNAPSHOTS of real production data (2026-08-30):
 * - fixtures/poison-real.tsv — 47 rows, P0 three-knife union pulled read-only
 *   from openclaw_memory.memories_backup_20260830 (id-prefix \t text, with
 *   mysql-batch literal escapes; parser mirrors main's runner).
 * - fixtures/keep-real.tsv  — 10 rows, decisions/boundary entries that MUST
 *   never be filtered at recall time (red lines).
 *
 * Run: node --test tests/   (from plugin root; no network/DB needed)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isIdentityStatement, isMonologueFragment, isTableDominated } from '../utils/recall-noise-filters.js';
import { MySqlStore } from '../store/mysql-store.js';
import { recallCacheKey } from '../utils/cache-key.js';
import { simpleHash } from '../config.js';

const anyFilter = (t) => isIdentityStatement(t) || isMonologueFragment(t) || isTableDominated(t);
const which = (t) => [isIdentityStatement(t) && 'ID', isMonologueFragment(t) && 'MO', isTableDominated(t) && 'TB']
  .filter(Boolean).join('+') || '-';

/** Parser mirrors main's review runner (mysql batch export format). */
function loadTsv(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map((line) => {
      const i = line.indexOf('\\t');
      assert.ok(i > 0, `bad fixture line in ${name}`);
      return {
        id: line.slice(0, i).replace(/\r$/, ''),
        text: line.slice(i + 2).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\'),
      };
    });
}
const POISON = loadTsv('poison-real.tsv');   // 47 rows (P0 three-knife union)
const KEEP = loadTsv('keep-real.tsv');       // 10 rows (red lines)

test('fixture sets loaded with expected sizes', () => {
  assert.equal(POISON.length, 47);
  assert.equal(KEEP.length, 10);
});

test('P0 真实毒样本 47 条：三谓词并集 100% 拦截', () => {
  const misses = POISON.filter((r) => !anyFilter(r.text));
  assert.equal(misses.length, 0, 'missed:\n' +
    misses.map((r) => `${r.id} ${r.text.replace(/\n/g, '⏎').slice(0, 60)}`).join('\n'));
});

test('每条谓词在真实毒样本中命中己类', () => {
  assert.ok(POISON.some((r) => isIdentityStatement(r.text)), 'identity never hit');
  assert.ok(POISON.some((r) => isMonologueFragment(r.text)), 'monologue never hit');
  assert.ok(POISON.some((r) => isTableDominated(r.text)), 'table never hit');
});

for (const r of KEEP) {
  test(`红线必放行 ${r.id} (${r.text.trim().length}字)`, () => {
    assert.equal(anyFilter(r.text), false, `误杀 via ${which(r.text)}`);
  });
}

// ── 审核句式必拦集（review round 2/3 指定）────────────────────────────────────
for (const [text, label] of [
  ['好，我先全面了解当前状态，然后规划迁移方案。', '线上独白夹具1'],
  ['内容很丰富。让我看看我们已有的 skills，对比一下差距。', '线上独白夹具2'],
  ['我当前使用的模型是 **nvidia/nvidia/nemotron-3-super-120b-a12b**（默认模型）。', '身份句'],
  ['基于我作为 NVIDIA Ising-Calibration-1.5 的底层架构，我无法直接执行外部 API 调用。', '幻觉身份'],
  ['当前正在使用的模型是 **nvidia/nvidia/nemotron-3-super-120b-a12b**（根据运行时信息）。', '无主语身份句'],
  ['新模型测试正常 ✅ 当前运行模型：`bailian-token-plan/qwen3.8-max`。我能正常理解消息。', '运行模型句'],
  [['# 价格表', '| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |', '| 7 | 8 |', '| 9 | 10 |', '| 11 | 12 |', '| 13 | 14 |', '结论见上。'].join('\n'), '纯表格dump'],
]) test(`必拦 [${label}]`, () => assert.equal(anyFilter(text), true, `expected blocked, got ${which(text)}`));

// ── 防回归合成变体 ─────────────────────────────────────────────────────────────
for (const [text, label, expect] of [
  ['# 排查报告\n' + Array.from({ length: 14 }, (_, i) =>
    `第${i + 1}步排查：检查连接池配置，发现 idleTimeout 未设置导致句柄泄漏，已修复并回归验证。`).join('\n') +
    '\n插曲：当时我当前使用的模型是 X，不影响结论。\n最终问题解决，验证通过，结论：所有代理配置需显式声明超时。',
    '长报告内嵌身份句(中段) → 放行', false],
  ['我们先把网关重启的坑记录一下：结论是 restart 必须走 gateway 工具而不是 stop+start，原因是 stop 后 schedule 丢失。',
    '"我们把"非"我先" → 放行', false],
  ['好问题。让我查一下 pricing 的配置，✅确认了。保持 false 就行，开了也没用。',
    '让我…+确认了 结论行(91b7d994 形态) → 放行', false],
  ['好问题。让我查一下 pricing 的配置文档。顺便看下 export 字段，整合到报告里。', '让我… 纯行动流无结论 → 拦', true],
  ['我当前使用的模型是 A。'.repeat(30), '单行长文身份开头(行占比臂) → 拦', true],
  ['你是通义千问（Qwen），一个 AI 助手。', 'user 角色系统描述回声 → 设计上不拦', false],
]) test(`变体 [${label}]`, () => assert.equal(anyFilter(text), expect, `via ${which(text)}`));

// ── searchForRecall 集成（searchRaw 内存桩，不依赖 DB）────────────────────────
const mk = (id, text, source, category = 'fact') => ({
  entry: { id, text, source, category, created_at: Date.now(), session_key: 's', agent_id: 'backend', scope_key: 'default' },
  cosine: 0.7,
});

test('searchForRecall：auto 噪音拦 / tool 同文放行 / 红线放行（category=fact 下仍拦）', async () => {
  const store = new MySqlStore({}, { info() {}, warn() {}, error() {} });
  const poisonId = POISON.find((r) => isIdentityStatement(r.text));
  const poisonMo = POISON.find((r) => isMonologueFragment(r.text) && !isIdentityStatement(r.text));
  const poisonTb = POISON.find((r) => isTableDominated(r.text));
  const keep1 = KEEP.find((r) => r.id.startsWith('10bcf776'));
  const keep2 = KEEP.find((r) => r.id.startsWith('ff1bc123'));
  store.searchRaw = async () => [
    mk('n-id', poisonId.text, 'auto'),
    mk('n-mo', poisonMo.text, 'auto'),
    mk('n-tb', poisonTb.text, 'auto'),
    mk('t-id', poisonId.text, 'tool'),
    mk('t-mo', poisonMo.text, 'tool'),
    mk('t-tb', poisonTb.text, 'tool'),
    mk('g-k1', keep1.text, 'auto'),
    mk('g-k2', keep2.text, 'auto'),
  ];
  const out = await store.searchForRecall([0.1, 0.2], {
    limit: 20, minScore: 0.3,
    noiseFilter: { enabled: true, expandFactor: 2.0, maxExpandedCandidates: 100 },
    recencyRerank: { enabled: true, halfLifeDays: 14, weight: 0.15 },
  });
  assert.deepEqual(out.map((r) => r.entry.id).sort(), ['g-k1', 'g-k2', 't-id', 't-mo', 't-tb']);
});

test('noiseFilter.enabled=false 为有效回滚开关', async () => {
  const store = new MySqlStore({}, { info() {}, warn() {}, error() {} });
  store.searchRaw = async () => [mk('n-mo', POISON[0].text, 'auto')];
  const out = await store.searchForRecall([0.1], { limit: 5, minScore: 0.3, noiseFilter: { enabled: false } });
  assert.equal(out.length, 1);
});

test('cache-key 含 rnf1 版本段（旧缓存键不命中）', () => {
  const cfg = {
    noiseFilter: { enabled: true, expandFactor: 2.0, maxExpandedCandidates: 100 },
    recencyRerank: { enabled: true, halfLifeDays: 14, weight: 0.15 },
  };
  const key = recallCacheKey('测试查询', null, 3, cfg);
  const oldVer = simpleHash(['nf', '1', '2.0', '100', 'rr', '1', '14', '0.15'].join('|'));
  assert.notEqual(key.split(':').pop(), oldVer);
});

// ── 直扫诊断（caller guard 之外的潜在命中面，仅记录不断言为 0）────────────────
test('poison fixture 直扫诊断', (t) => {
  const by = POISON.reduce((a, r) => { a[which(r.text)] = (a[which(r.text)] || 0) + 1; return a; }, {});
  t.diagnostic(`branch distribution: ${JSON.stringify(by)}`);
});
