# MySQL Memory 插件捕获噪声过滤优化

## 修改概述

优化了 mysql-memory 插件的自动捕获（autoCapture）过滤逻辑，防止将 agent 回复的过渡语/噪声保存为记忆。

## 修改内容

### 1. 新增常量 `CAPTURE_NOISE_PATTERNS`

在 `config.js` 中添加了 60+ 个正则表达式模式，覆盖以下噪声类型：

#### 执行过渡语
- `/^我来[^\u4e00-\u9fff]/` - "我来..." 后跟非中文标点
- `/^让我[^\u4e00-\u9fff]/` - "让我..." 后跟非中文标点
- `/^好的[\s，]?/` - "好的" + 可选逗号/空格
- `/^这是[^\u4e00-\u9fff]/` - "这是..."
- `/^从截图[^\u4e00-\u9fff]/` - "从截图..."
- `/^从您的[^\u4e00-\u9fff]/` - "从您的..."
- `/^从刚才[^\u4e00-\u9fff]/` - "从刚才..."
- `/^你刚才[^\u4e00-\u9fff]/` - "你刚才..."

#### 完成通知
- ` /^已更新/` - "已更新..."
- ` /^已创建/` - "已创建..."
- ` /^已推送/` - "已推送..."
- ` /^已添加/` - "已添加..."
- ` /^已修改/` - "已修改..."
- ` /^已完成/` - "已完成..."
- ` /^已删除/` - "已删除..."
- ` /^已清理/` - "已清理..."
- ` /^已修复/` - "已修复..."
- ` /^已保存/` - "已保存..."
- ` /^已启动/` - "已启动..."
- ` /^已停止/` - "已停止..."
- ` /^已安装/` - "已安装..."
- ` /^已卸载/` - "已卸载..."
- ` /^已重启/` - "已重启..."
- ` /^已重置/` - "已重置..."
- ` /^已同步/` - "已同步..."
- ` /^已启用/` - "已启用..."
- ` /^已禁用/` - "已禁用..."

#### 操作结果
- ` /^推送成功/` - "推送成功..."
- ` /^修复完成/` - "修复完成..."
- ` /^清理完成/` - "清理完成..."
- ` /^找到问题/` - "找到问题..."
- ` /^问题已/` - "问题已..."
- ` /^解决完成/` - "解决完成..."
- ` /^执行完成/` - "执行完成..."
- ` /^处理完成/` - "处理完成..."
- ` /^操作完成/` - "操作完成..."
- ` /^准备工作已/` - "准备工作已..."

#### Emoji 状态
- ` /^✅\\s+/` - "✅ ..."
- ` /^❌\\s+/` - "❌ ..."
- ` /^⚠️\\s+/` - "⚠️ ..."
- ` /^🌿\\s+/` - "🌿 ..."
- ` /^✨\\s+/` - "✨ ..."
- ` /^🎉\\s+/` - "🎉 ..."

#### 简短确认
- ` /^好的$/` - "好的"（精确匹配）
- ` /^好的，?$/` - "好的，"（可选逗号）
- ` /^收到$/` - "收到"
- ` /^收到，?$/` - "收到，"
- ` /^明白$/` - "明白"
- ` /^明白，?$/` - "明白，"
- ` /^了解$/` - "了解"
- ` /^了解，?$/` - "了解，"
- ` /^行$/` - "行"
- ` /^行，?$/` - "行，"
- ` /^嗯$/` - "嗯"
- ` /^嗯，?$/` - "嗯，"
- ` /^嗯嗯$/` - "嗯嗯"
- ` /^好的好的$/` - "好的好的"
- ` /^没问题$/` - "没问题"
- ` /^没问题，?$/` - "没问题，"
- ` /^好的呢$/` - "好的呢"
- ` /^好的呢，?$/` - "好的呢，"
- ` /^可以$/` - "可以"
- ` /^可以，?$/` - "可以，"
- ` /^收到啦$/` - "收到啦"
- ` /^好的收到$/` - "好的收到"
- ` /^好的收到，?$/` - "好的收到，"
- ` /^明白了$/` - "明白了"
- ` /^明白了，?$/` - "明白了，"
- ` /^好的，我来$/` - "好的，我来"
- ` /^好的，我$/` - "好的，我"
- ` /^好的我来$/` - "好的我来"
- ` /^好的，$/` - "好的，"
- ` /^收到，$/` - "收到，"
- ` /^明白，$/` - "明白，"

### 2. 新增函数 `matchesCaptureNoisePattern`

```javascript
export function matchesCaptureNoisePattern(text, config) {
  const trimmed = text.trim();
  
  // 极短文本（≤4 chars）总是过滤
  if (trimmed.length <= 4) {
    return true;
  }
  
  // Emoji-only 状态总是过滤
  if (/^[\u2705\u274c\u26a0\ufe0f\u1f33f\u2728\u1f389]/.test(trimmed)) {
    return true;
  }
  
  // 技术关键词白名单
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
  
  // 检查内置模式
  for (const pattern of CAPTURE_NOISE_PATTERNS) {
    if (pattern.test(trimmed)) {
      if (trimmed.length <= 15 && !hasSubstantiveContent) {
        return true;
      }
      if (hasSubstantiveContent) {
        return false;
      }
      // 检查是否只是前缀匹配
      const match = trimmed.match(pattern);
      if (match && match[0].length / trimmed.length > 0.85) {
        return true;
      }
    }
  }
  
  // 检查自定义模式
  if (config?.captureNoiseFilter?.enabled && Array.isArray(config.captureNoiseFilter.customPatterns)) {
    for (const pattern of config.captureNoiseFilter.customPatterns) {
      if (typeof pattern === 'string') {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(trimmed)) return true;
      } else if (pattern instanceof RegExp) {
        if (pattern.test(trimmed)) return true;
      }
    }
  }
  
  return false;
}
```

### 3. 更新 `shouldCaptureAssistant` 函数

在检查中添加了噪声模式过滤：

```javascript
// ─── NEW: Check against configurable auto-capture noise patterns ───
if (matchesCaptureNoisePattern(trimmed, config)) return false;
```

### 4. 配置支持

在 `parseConfig` 函数中添加了 `captureNoiseFilter` 选项：

```javascript
// Auto-capture noise filter (NEW)
const captureNoiseFilter = cfg.captureNoiseFilter || {};
const captureNoiseFilterEnabled = captureNoiseFilter.enabled !== false;
const captureNoiseFilterCustomPatterns = Array.isArray(captureNoiseFilter.customPatterns)
  ? captureNoiseFilter.customPatterns
  : [];

// 在返回的 config 中添加
captureNoiseFilter: {
  enabled: captureNoiseFilterEnabled,
  customPatterns: captureNoiseFilterCustomPatterns,
},
```

## 使用示例

### 默认配置（自动启用噪声过滤）

```json
{
  "plugins": {
    "mysql-memory": {
      "autoCapture": true,
      "mysql": { ... },
      "embedding": { ... }
    }
  }
}
```

### 自定义噪声模式

```json
{
  "plugins": {
    "mysql-memory": {
      "autoCapture": true,
      "captureNoiseFilter": {
        "enabled": true,
        "customPatterns": [
          "^自定义模式.*",
          "^另外.*"
        ]
      },
      "mysql": { ... },
      "embedding": { ... }
    }
  }
}
```

## 测试结果

所有 32 个测试用例通过：

### 测试通过的噪声模式
- ✅ 执行过渡语：`我来`、`让我`、`这是`、`从截图` 等
- ✅ 简短确认：`好的`、`收到`、`明白` 等
- ✅ Emoji 状态：`✅ 完成！`、`❌ 出错了` 等
- ✅ 完成通知：`已更新`、`已创建`、`推送成功` 等

### 保留的实质性内容
- ✅ 包含技术名词的文本：`我来检查一下配置文件`
- ✅ 包含详细信息的过渡语：`从截图来看，错误出现在第三行代码`
- ✅ 包含具体动作的承诺：`好的，我来帮你解决这个问题`

## 向后兼容性

- ✅ 新增的 `captureNoiseFilter` 配置项是可选的
- ✅ 默认启用噪声过滤，但可以通过配置关闭
- ✅ 不影响已保存的记忆（只影响未来捕获）
- ✅ 不影响 `shouldCapture` 函数（user 消息）的逻辑

## 文件修改

- `~/.openclaw/extensions/mysql-memory/config.js` - 主要修改文件
- `~/.openclaw/extensions/mysql-memory/test.js` - 新增测试脚本

## 验证

运行测试脚本验证：

```bash
cd ~/.openclaw/extensions/mysql-memory
node test.js
```

预期输出：`Results: 32 passed, 0 failed`
