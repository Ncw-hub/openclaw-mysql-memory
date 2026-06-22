// Simple test for mysql-memory noise filter
// Run: node test.js

const CAPTURE_NOISE_PATTERNS = [
  // Execution transition phrases (matches "我来"/"让我" followed by any non-punctuation)
  /^我来[^，。！？]/i,
  /^让我[^，。！？]/i,
  /^好的，?\\s*/i,  // "好的" + optional comma + optional space
  /^这是[^，。！？]/i,
  /^从截图[^，。！？]/i,
  /^从您的[^，。！？]/i,
  /^从刚才[^，。！？]/i,
  /^你刚才[^，。！？]/i,
  /^现在让我/i,
  /^接下来让我/i,
  /^然后让我/i,
  /^我先来/i,
  /^那我来/i,
  /^那我就/i,
  /^那让我/i,
  /^已更新/i,
  /^已创建/i,
  /^已推送/i,
  /^已添加/i,
  /^已修改/i,
  /^已完成/i,
  /^已删除/i,
  /^已清理/i,
  /^已修复/i,
  /^已保存/i,
  /^已启动/i,
  /^已停止/i,
  /^已安装/i,
  /^已卸载/i,
  /^已重启/i,
  /^已重置/i,
  /^已同步/i,
  /^已启用/i,
  /^已禁用/i,
  /^已上线/i,
  /^已下线/i,
  /^已发布/i,
  /^已下架/i,
  /^推送成功/i,
  /^修复完成/i,
  /^清理完成/i,
  /^找到问题/i,
  /^问题已/i,
  /^解决完成/i,
  /^执行完成/i,
  /^处理完成/i,
  /^操作完成/i,
  /^准备工作已/i,
  /^推送失败/i,
  /^执行成功/i,
  /^执行失败/i,
  /^创建成功/i,
  /^删除成功/i,
  /^更新成功/i,
  /^上线成功/i,
  /^下线成功/i,
  /^✅\\s+/i,
  /^❌\\s+/i,
  /^⚠️\\s+/i,
  /^🌿\\s+/i,
  /^✨\\s+/i,
  /^🎉\\s+/i,
  /^✅\\s+完成/i,
  /^❌\\s+失败/i,
  /^✅\\s+已/i,
  /^❌\\s+未/i,
  /^好的$/i,
  /^好的，?$/i,
  /^收到$/i,
  /^收到，?$/i,
  /^明白$/i,
  /^明白，?$/i,
  /^了解$/i,
  /^了解，?$/i,
  /^行$/i,
  /^行，?$/i,
  /^嗯$/i,
  /^嗯，?$/i,
  /^嗯嗯$/i,
  /^好的好的$/i,
  /^没问题$/i,
  /^没问题，?$/i,
  /^好的呢$/i,
  /^好的呢，?$/i,
  /^可以$/i,
  /^可以，?$/i,
  /^收到啦$/i,
  /^好的收到$/i,
  /^好的收到，?$/i,
  /^明白了$/i,
  /^明白了，?$/i,
  /^好的，我来$/i,
  /^好的，我$/i,
  /^好的我来$/i,
  /^好的，$/i,
  /^收到，$/i,
  /^明白，$/i,
];

function matchesCaptureNoisePattern(text) {
  const trimmed = text.trim();
  
  // Very short pure noise - always filtered
  if (trimmed.length <= 4) {
    return true;
  }
  
  // Emoji-only status - always filtered (e.g., "✅ 完成！", "❌ 出错了")
  if (/^[\u2705\u274c\u26a0\ufe0f\u1f33f\u2728\u1f389]/.test(trimmed)) {
    return true;
  }
  
  // Whitelist: if text contains technical content, don't filter even if it starts with noise
  const WHITELIST_KEYWORDS = [
    /代码/i, /配置/i, /文件/i, /函数/i, /类/i, /方法/i,
    /API/i, /数据库/i, /表/i, /查询/i, /字段/i,
    /错误/i, /日志/i, /服务器/i, /进程/i, /线程/i,
    /超时/i, /连接/i, /请求/i, /响应/i, /状态/i,
    /版本/i, /分支/i, /提交/i, /Git/i,
    /JavaScript/i, /TypeScript/i, /Node\.js/i, /Vue/i, /React/i,
    /SQL/i, /MySQL/i, /Redis/i, /MongoDB/i,
    /逻辑/i, /实现/i, /功能/i, /模块/i, /组件/i,
    /问题/i, /解决方案/i, /修复/i, /更新/i, /调整/i,
    /检查/i, /分析/i, /测试/i, /调试/i, /运行/i,
  ];
  
  const hasSubstantiveContent = WHITELIST_KEYWORDS.some(keyword => keyword.test(trimmed));
  
  // Check against built-in patterns
  for (const pattern of CAPTURE_NOISE_PATTERNS) {
    if (pattern.test(trimmed)) {
      // If text is short (<= 15 chars) and no substantive content, it's noise
      if (trimmed.length <= 15 && !hasSubstantiveContent) {
        return true;
      }
      // If text has substantive content, allow it
      if (hasSubstantiveContent) {
        return false;
      }
      // If text is long, check if only the prefix matches
      const match = trimmed.match(pattern);
      if (match && match[0].length / trimmed.length > 0.85) {
        return true;
      }
    }
  }
  return false;
}

// Test cases
const tests = [
  // Should be filtered - pure noise (short or no technical content)
  { text: "我来", expected: true },
  { text: "让我", expected: true },
  { text: "这是", expected: true },
  { text: "从截图", expected: true },
  { text: "我先来", expected: true },
  { text: "那我来", expected: true },
  { text: "已更新", expected: true },
  { text: "已创建", expected: true },
  { text: "推送成功", expected: true },
  { text: "✅ 完成！", expected: true },
  { text: "❌ 出错了", expected: true },
  { text: "好的", expected: true },
  { text: "好的，", expected: true },
  { text: "收到", expected: true },
  { text: "明白", expected: true },
  { text: "好的好的", expected: true },
  { text: "没问题", expected: true },
  { text: "好的呢", expected: true },
  { text: "行", expected: true },
  { text: "嗯", expected: true },
  { text: "嗯嗯", expected: true },
  { text: "好的，我来", expected: true },
  
  // Should NOT be filtered (have substantive content)
  { text: "我已经更新了配置文件，现在服务器会自动重启。", expected: false },
  { text: "我来检查一下配置文件的具体内容，然后修改它。", expected: false },
  { text: "从截图来看，错误出现在第三行代码。", expected: false },
  { text: "我找到问题了，是数据库连接超时。", expected: false },
  { text: "好的，我来帮你解决这个问题。", expected: false },
  { text: "可以，我现在就处理。", expected: false },
  { text: "我来查看一下配置文件", expected: false },  // has "配置文件"
  { text: "让我检查一下数据库", expected: false },  // has "数据库"
  { text: "这是错误日志文件", expected: false },  // has "错误" and "日志"
  { text: "从截图来看服务器状态", expected: false },  // has "截图" and "服务器"
];

console.log('Testing noise filter patterns...\\n');

let passed = 0;
let failed = 0;

for (const test of tests) {
  const result = matchesCaptureNoisePattern(test.text);
  const status = result === test.expected ? '✅' : '❌';
  const message = result === test.expected ? 'PASS' : 'FAIL';
  
  console.log(`${status} "${test.text.substring(0, 50)}..." -> ${message}`);
  
  if (result === test.expected) {
    passed++;
  } else {
    failed++;
    console.log(`   Expected: ${test.expected}, Got: ${result}`);
  }
}

console.log(`\\nResults: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
