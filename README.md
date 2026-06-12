# MySQL Memory 插件

基于 MySQL 9.7+ VECTOR 类型和 Redis 缓存的长期记忆插件。为 OpenClaw 代理系统提供可扩展、智能的记忆存储与检索能力。

## 📦 核心功能

- **向量搜索**：使用 MySQL 9.7+ 原生 VECTOR 类型存储文本向量，支持语义相似度检索
- **自动记忆**：在代理会话中自动捕获用户和助手的重要对话内容
- **智能去重**：基于语义相似度和内容指纹的双重去重机制
- **多 Agent 隔离**：支持多代理共享或独立记忆空间
- **延迟折叠**：可选方案，根据时间衰减和关键词匹配重新排序检索结果
- **失败降级**：当 Embedding 服务不可用时，自动降级到文本-only 存储
- **Redis 缓存**：可选的 Redis 缓存层，大幅加速重复查询响应
- **自动清理**：定期清理过期记忆，防止数据无限增长

## 🚀 安装方法

### 从 GitHub 安装

```bash
cd "C:\Users\Administrator\.openclaw\extensions"
git clone https://github.com/your-username/mysql-memory.git mysql-memory
```

### 确保依赖已安装

插件需要以下依赖（通常已包含在 OpenClaw 环境中）：

```bash
npm install mysql2 ioredis
```

## ⚙️ 配置说明

### 接管源生记忆（必需）

启用此插件后，可以完全接管 OpenClaw 源生的文件记忆系统。在 `openclaw.json` 中添加以下配置：

```json
{
  "plugins": {
    "slots": {
      "memory": "mysql-memory"
    }
  }
}
```

**效果说明**：
- 设置 `plugins.slots.memory` 为 `"mysql-memory"` 后，OpenClaw 内置的文件记忆（`MEMORY.md`、`memory/` 目录等）将被 MySQL 记忆完全替代
- 所有 `memory_store` / `memory_recall` / `memory_forget` 工具调用都走 MySQL 存储
- 用户无需再手动管理 `MEMORY.md` 文件
- 记忆持久化到 MySQL，支持向量检索，不再因文件丢失而失效

在 `openclaw.json` 中配置插件：

```json
{
  "plugins": {
    "mysql-memory": {
      "mysql": {
        "host": "192.168.110.245",
        "port": 3306,
        "database": "openclaw_memory",
        "user": "openclaw",
        "password": "${MYSQL_PASSWORD}",
        "connectionLimit": 10,
        "connectTimeout": 5000,
        "queryTimeout": 10000,
        "ddlTimeout": 30000
      },
      "redis": {
        "host": "192.168.110.245",
        "port": 6377,
        "password": "",
        "db": 0,
        "enabled": true,
        "connectTimeout": 2000,
        "commandTimeout": 3000,
        "maxRetries": 3
      },
      "embedding": {
        "model": "nomic-embed-text:latest",
        "baseUrl": "http://192.168.110.245:11434",
        "dimensions": 768,
        "timeoutMs": 10000,
        "maxChars": 2000
      },
      "autoCapture": true,
      "autoRecall": true,
      "autoRecallTimeout": 15000,
      "captureMaxChars": 500,
      "recallMaxChars": 1000,
      "similarityThreshold": 0.95,
      "candidateLimit": 50,
      "recallLimit": 3,
      "recallMinScore": 0.3,
      "maxCapturesPerTurn": 5,
      "storeOnEmbedFailure": true,
      "isolateAgents": false,
      "scopes": {},
      "cache": {
        "recallCacheTTL": 300,
        "maxCacheEntries": 1000
      },
      "noiseFilter": {
        "enabled": false,
        "expandFactor": 2.0,
        "maxExpandedCandidates": 100
      },
      "recencyRerank": {
        "enabled": false,
        "halfLifeDays": 14,
        "weight": 0.15
      }
    }
  }
}
```

### 配置项说明

| 配置路径 | 类型 | 默认值 | 说明 |
|---------|------|--------|------|
| `mysql.host` | string | - | MySQL 服务器地址（必需） |
| `mysql.port` | number | - | MySQL 端口（必需） |
| `mysql.database` | string | - | MySQL 数据库名（必需） |
| `mysql.user` | string | - | MySQL 用户名（必需） |
| `mysql.password` | string | - | MySQL 密码（必需，支持 `${ENV_VAR}` 引用） |
| `mysql.connectionLimit` | number | 10 | 连接池最大连接数 |
| `mysql.connectTimeout` | number | 5000 | 连接超时（毫秒） |
| `mysql.queryTimeout` | number | 10000 | 查询超时（毫秒） |
| `mysql.ddlTimeout` | number | 30000 | DDL 执行超时（毫秒） |
| `redis.enabled` | boolean | true | 是否启用 Redis 缓存 |
| `redis.host` | string | localhost | Redis 服务器地址 |
| `redis.port` | number | 6379 | Redis 端口 |
| `redis.password` | string | "" | Redis 密码 |
| `redis.db` | number | 0 | Redis 数据库编号 |
| `embedding.model` | string | nomic-embed-text:latest | Ollama 嵌入模型名 |
| `embedding.baseUrl` | string | http://localhost:11434 | Ollama API 基地址 |
| `embedding.dimensions` | number | 768 | 嵌入向量维度 |
| `autoCapture` | boolean | true | 是否自动捕获对话作为记忆 |
| `autoRecall` | boolean | true | 是否在提示构建时自动检索相关记忆 |
| `autoRecallTimeout` | number | 15000 | 自动检索超时（毫秒） |
| `captureMaxChars` | number | 500 | 单次捕获文本最大长度 |
| `recallMaxChars` | number | 1000 | 检索查询文本最大长度 |
| `similarityThreshold` | number | 0.95 | 去重所需的最小语义相似度 |
| `candidateLimit` | number | 50 | 检索候选数量 |
| `recallLimit` | number | 3 | 返回的最终结果数量 |
| `recallMinScore` | number | 0.3 | 检索结果最小分数（0-1） |
| `maxCapturesPerTurn` | number | 5 | 每轮会话最大捕获数量 |
| `storeOnEmbedFailure` | boolean | true | Embedding 失败时是否降级存储文本 |
| `isolateAgents` | boolean | false | 是否启用 Agent 隔离（每个 Agent 独立记忆空间） |

## 🛠️ 使用方法

### 自动记忆模式（推荐 默认）

启用 `autoCapture` 和 `autoRecall` 后，插件将：

1. **自动记录**：在每次代理回复后自动捕获有价值的对话内容
2. **自动检索**：在构建提示前自动检索相关历史记忆并注入上下文

无需手动调用工具，适用于大多数场景。

### 手动记忆工具

#### 1. 记忆存储 `memory_store`

**用法**：手动将重要信息存入长期记忆库

```json
{
  "tool": "memory_store",
  "params": {
    "text": "用户偏好使用 TypeScript 进行后端开发",
    "category": "preference",
    "scope": "main"
  }
}
```

**参数说明**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `text` | 是 | 要存储的信息 |
| `category` | 否 | 分类：`preference`（偏好）、`fact`（事实）、`decision`（决策）、`entity`（实体）、`other`（其他） |
| `scope` | 否 | 作用域（仅在 `isolateAgents=true` 时有效） |

#### 2. 记忆检索 `memory_recall`

**用法**：主动搜索相关历史记忆

```json
{
  "tool": "memory_recall",
  "params": {
    "query": "用户的技术栈偏好",
    "limit": 3,
    "category": "preference"
  }
}
```

**参数说明**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `query` | 是 | 搜索关键词 |
| `limit` | 否 | 最多返回数量（默认 3） |
| `category` | 否 | 分类过滤 |
| `scope` | 否 | 作用域过滤 |

#### 3. 记忆删除 `memory_forget`

**用法**：删除指定记忆

```json
{
  "tool": "memory_forget",
  "params": {
    "memoryId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  }
}
```

或通过关键词搜索删除：

```json
{
  "tool": "memory_forget",
  "params": {
    "query": "过时的用户偏好",
    "scope": "main"
  }
}
```

**参数说明**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `memoryId` | 否 | 记忆 ID（精确删除） |
| `query` | 否 | 关键词搜索（模糊删除） |
| `scope` | 否 | 作用域过滤 |

## 🏗️ 技术架构

### 数据存储层

```
MySQL 9.7+ (VECTOR 类型)
├── memories 表结构
│   ├── id (VARCHAR(36))         主键 UUID
│   ├── text (TEXT)              存储原始文本
│   ├── category (VARCHAR(20))   分类标签
│   ├── vector (VECTOR(768))     向量嵌入（可为空）
│   ├── session_key (VARCHAR)    会话标识
│   ├── agent_id (VARCHAR)       Agent 标识
│   ├── scope_key (VARCHAR)      作用域标识
│   ├── source (VARCHAR)         来源：auto/tool
│   └── created_at (BIGINT)      创建时间戳
└── 索引
    ├── idx_session
    ├── idx_created_at
    ├── idx_category
    └── idx_agent_scope
```

### 检索流程

1. **查询向量化**：使用 Ollama 生成查询向量
2. **候选检索**：从 MySQL 获取相似度候选（无 JS 过滤）
3. **应用层过滤**：
   - 噪音过滤（自动过滤问候语、拒绝语等）
   - 时间衰减重新排序（可选）
   - 基于关键词匹配的组合评分
4. **结果返回**：返回前 N 条最终结果

### 缓存策略

- **Redis Recall Cache**：缓存最近的检索结果，TTL 可配置
- **自动失效**：新记忆写入时自动清理相关缓存

## 🎯 实现设计亮点

- **零 I/O 注册**：`register()` 函数不进行任何网络连接，连接.lazy-init 第一次使用时建立
- **超时保护**：所有关键操作（Embedding、MySQL 查询、Redis 操作）都有超时控制
- **失败降级**：
  - Embedding 失败 → 降级到纯文本存储
  - Redis 失败 → 缓存操作静默失败
- **串行队列**：Embedding 请求串行化，避免 GPU OOM 导致 NaN 错误
- **冷却保护**：连续失败后进入冷却期，防止日志洪水和服务器压力

## 📝 常见场景示例

### 场景 1：多 Agent 隔离

```json
{
  "plugins": {
    "mysql-memory": {
      "isolateAgents": true,
      "agentScopes": {
        "backend": { "primaryScope": "backend", "recallScopes": ["backend", "default"] },
        "frontend": { "primaryScope": "frontend", "recallScopes": ["frontend", "default"] }
      }
    }
  }
}
```

### 场景 2：延迟折叠启用

```json
{
  "plugins": {
    "mysql-memory": {
      "recencyRerank": {
        "enabled": true,
        "halfLifeDays": 14,
        "weight": 0.15
      }
    }
  }
}
```

### 场景 3：噪音过滤启用

```json
{
  "plugins": {
    "mysql-memory": {
      "noiseFilter": {
        "enabled": true,
        "expandFactor": 2.0,
        "maxExpandedCandidates": 100
      }
    }
  }
}
```

## 🔧 维护命令

### 查看统计信息

```sql
SELECT 
  COUNT(*) AS total,
  category,
  COUNT(*) OVER() AS total_all
FROM memories 
GROUP BY category
ORDER BY cnt DESC;
```

### 清理 30 天前的记忆

```sql
DELETE FROM memories 
WHERE created_at < UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL 30 DAY)) * 1000;
```

### 查看代理隔离状态

```sql
SELECT agent_id, scope_key, COUNT(*) AS cnt 
FROM memories 
GROUP BY agent_id, scope_key 
ORDER BY agent_id, scope_key;
```

## 📚 相关资源

- [OpenClaw Plugin SDK 文档](https://docs.openclaw.ai)
- [MySQL 9.7 VECTOR 类型](https://dev.mysql.com/doc/refman/9.7/en/vector-data-type.html)
- [Ollama Embeddings API](https://ollama.com/blog/embedding-models)
