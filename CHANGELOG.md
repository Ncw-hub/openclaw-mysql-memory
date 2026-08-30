# Changelog

## v2026.7.1-5（2026-08-30）

### feat(store): P2-③ 召回期噪音过滤器
- 新增 `utils/recall-noise-filters.js`：**身份自述 / 过程独白 / 表格主导 / meta 回声**四类谓词，接入 `searchForRecall` 噪声过滤阶段。
- 仅拦 `source !== 'tool'` 的条目——手动 `memory_store` 存入的记录永不拦截。
- 检查**独立于 category**，修复 `isNoiseMemory` 被 `detectCategory`（"是/有"→fact）短路导致的召回端永久盲区（设计报告发现 A）。
- 身份谓词覆盖无主语变体（「当前使用的模型是 X」）、带修饰长句（「我是…视觉-语言模型」）、注入块回声前缀（「我在第 N 行：」）及幻觉人设名；纯度门（≤400 字或命中行占比 >0.5）保证长报告内嵌身份句不误杀。
- 独白谓词带结论词排除表（结论/根因/确认了/已写入记忆…），"收到！+实质决策"类条目放行。
- 表格谓词双档：ratio≥0.5 且正文 <120 字；或 ratio≥0.35 且 >2500 字且正文 <400 字。

### fix(cache): 缓存键兼容
- `utils/cache-key.js` configVersion 串追加 `rnf1` 标记——升级后旧召回缓存自动失效，不会绕过新过滤器（发现 E）。

### test: DB-free 回归套件
- `tests/recall-noise-filters.test.mjs`（node:test，无需网络/数据库）。
- 夹具快照固化于 `tests/fixtures/`：`poison-real.tsv` **47 条真实毒样本**（P0 三刀并集，来自 `memories_backup_20260830`）必拦 100%；`keep-real.tsv` **10 条决策/边界样本**必放行 0 误杀。
- 含 searchForRecall 集成断言（searchRaw 内存桩）、`noiseFilter.enabled=false` 回滚开关断言、缓存键版本断言。

### 运维注意
- **升级到本版本建议先 flush Redis**：`mysql-memory:recall:*`（rnf1 版本串已使旧键不命中，flush 仅为清库存量）。
- **回滚**：`git revert` 本 release 前两枚 commit（`5c8c428`、`edd4191`），或配置 `noiseFilter.enabled:false` 总开关即时回退。
- **捕获端行为零变化**：自动捕获仍全量存储，过滤仅发生在召回注入前（用户原则：捕获全量，只在注入前拦截）。
