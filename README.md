# ShortX Method Hub

> 基于 Cloudflare Workers + D1 数据库的 Telegram Bot 方法知识库管理系统

一个强大的代码方法收集和管理系统，通过 Telegram Bot 自动采集群组中的代码片段，支持标签分类、验证管理、历史消息获取等功能。

## ✨ 主要特性

- 🤖 **自动采集**：Bot 自动监听群组消息，提取代码块并保存
- 🔍 **智能搜索**：支持单字搜索，搜索标题、代码和标签
- 🏷️ **标签管理**：自动识别消息中的 hashtag 作为标签
- ✅ **验证系统**：管理员可标记已验证的方法
- 📥 **历史获取**：支持获取群组历史消息中的代码
- 🔄 **消息编辑**：支持 Telegram 消息编辑后自动更新
- 🎯 **话题过滤**：超级群组支持指定话题 ID 采集
- 🗂️ **群组管理**：自动识别群组类型，管理多个群组
- 📤 **多种导出**：JSON 导出、ShortX 专用格式
- ⚡ **实时同步**：Webhook 实时接收消息更新

## 📋 目录

- [快速开始](#快速开始)
- [配置步骤](#配置步骤)
- [使用指南](#使用指南)
- [代码格式要求](#代码格式要求)
- [API 接口](#api-接口)
- [常见问题](#常见问题)

## 🚀 快速开始

### 前置要求

- Cloudflare 账号（免费版即可）
- Telegram 账号
- Telegram Bot Token

### 部署步骤

#### 1. 创建 Telegram Bot

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 创建新 Bot
3. 按提示设置 Bot 名称和用户名
4. 保存返回的 **Bot Token**（格式：`123456789:ABCdefGHIjklMNOpqrsTUVwxyz`）
5. 发送 `/setprivacy` 选择你的 Bot，设置为 `Disable` 让 Bot 能读取所有消息

#### 2. 创建 D1 数据库

在 Cloudflare Dashboard：

1. 进入 Cloudflare Dashboard
2. 选择 **Workers & Pages** > **D1**
3. 点击 **"Create Database"**
4. 数据库名称：`shortx-db`（或自定义名称）
5. 点击创建

⚠️ **注意**：只需创建空数据库，表结构会在第 6 步自动初始化

#### 3. 部署 Worker

1. 在 Cloudflare Dashboard 创建 Worker
2. 复制完整代码到 Worker 编辑器
3. 点击 "Save and Deploy"

#### 4. 配置环境变量

在 Worker 设置中添加以下环境变量：

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `BOT_TOKEN` | Telegram Bot Token | `123456789:ABCdefGHI...` |
| `ADMIN_KEY` | 管理员密钥 | `your_secure_password` |
| `WEBHOOK_SECRET` | Webhook 密钥（可选） | `random_secret_string` |

#### 5. 绑定 D1 数据库

在 Worker 设置 > Variables > D1 Database Bindings：

- Variable name: `SHORTX_DB`
- D1 database: 选择刚创建的数据库

#### 6. 初始化数据库

在浏览器中访问：
```
https://your-worker.workers.dev/init-db
```

✅ 成功后会显示：
```json
{
  "success": true,
  "message": "数据库初始化成功（包含更新时间字段）"
}
```

✨ **自动完成的操作：**
- 创建 `methods` 表（方法数据）
- 创建 `group_configs` 表（群组配置）
- 创建所有必要的索引
- 添加 `updated_at` 等新字段（如果不存在）

💡 **提示**：
- 可以多次访问此接口，不会重复创建表
- 如果数据库结构更新，重新访问即可自动添加新字段
- 不会删除或修改现有数据

#### 7. 设置 Webhook

访问（需要在浏览器控制台或 API 工具中设置 Header）：

```bash
POST https://your-worker.workers.dev/set-webhook
Headers:
  X-Admin-Key: your_admin_key
```

或在前端登录后，浏览器控制台执行：
```javascript
fetch('/set-webhook', {
  method: 'POST',
  headers: { 'X-Admin-Key': 'your_admin_key' }
}).then(r => r.json()).then(console.log)
```

## 📖 使用指南

### 管理员登录

1. 访问 Worker 部署的 URL
2. 点击右上角登录按钮
3. 输入 `ADMIN_KEY` 环境变量中设置的密钥
4. 登录后可访问管理面板和群组配置

### 添加 Bot 到群组

#### 必要条件（重要！）
⚠️ **Bot 必须被设置为群组管理员才能正常工作**

#### 步骤：

1. 将 Bot 添加到目标群组
2. **将 Bot 提升为管理员**（必须）
3. 群组会自动出现在"群组配置"页面
4. 默认启用状态，可以开始采集代码

#### 群组类型说明：

| 类型 | 显示 | 话题功能 | 说明 |
|------|------|---------|------|
| 普通群组 | 🔵 蓝色徽章 | ❌ 不支持 | 基础群组 |
| 超级群组 | 🟣 紫色徽章 | ✅ 支持 | 可设置话题 ID |
| 频道 | 🟢 绿色徽章 | ❌ 不支持 | 单向发布 |

### 群组配置

访问"群组配置"页面：

#### 1. 启用/禁用采集
- 开关按钮控制是否采集该群组的消息
- 禁用后不会采集新消息（已有方法不受影响）

#### 2. 设置话题 ID（仅超级群组）
- 输入话题 ID（逗号分隔），如：`123,456,789`
- 留空表示采集所有话题
- 只采集指定话题中的代码

#### 3. 获取历史消息
- **获取全部历史**：获取该群组所有历史消息
- **获取话题历史**：仅获取指定话题的历史消息
- 默认获取 100 条，可调整（最多 500）

#### 4. 清理失效群组
- 点击"清理失效"按钮
- 自动验证 Bot 是否还是管理员
- 删除失效的群组配置和相关方法
- 同时更新群组类型信息

### 代码采集规则

Bot 会自动采集以下格式的代码：

#### 格式 1：Telegram 原生代码块
```
在 Telegram 中，使用等宽字体输入代码，
选择代码语言后发送
```

#### 格式 2：Markdown 代码块
````
```javascript
function hello() {
  console.log("Hello World");
}
```
````

#### 格式 3：自动识别
消息中包含明显的代码特征（如 `function`、`=>`、`{}`、`;` 等）

#### 标签识别
在消息末尾添加 hashtag 作为标签：
```
你的代码内容

#JavaScript #工具函数 #实用
```

### 方法管理

#### 搜索方法
- 支持单字搜索
- 搜索范围：标题、代码、标签
- 按标签筛选

#### 管理操作（需要管理员权限）
- ✓ **标记验证**：标记为已验证的方法
- ✏️ **编辑**：修改标题、代码、标签、链接
- 🗑️ **删除**：永久删除方法
- ➕ **手动添加**：手动输入方法

#### 导出功能
- **JSON 导出**：导出所有方法（包含完整信息）
- **ShortX 格式**：仅导出已验证方法，格式适配 ShortX 应用

## 🔧 代码格式要求

### 支持的语言标识

系统会自动识别以下语言：

| 输入 | 识别为 |
|------|--------|
| `js`, `javascript` | JavaScript |
| `java` | Java |
| `mvel` | MVEL |
| 其他 | 保持原样 |

### 最佳实践

✅ **推荐做法：**
```
使用 Telegram 代码块功能：
1. 输入代码
2. 选中代码文本
3. 点击「等宽字体」
4. 选择语言（如 JavaScript）

添加标签：
#分类 #用途 #关键词
```

❌ **不推荐：**
- 纯文本代码（可能不被识别）
- 代码块中混入大量注释
- 代码过于简短（少于 20 字符）

## 🔌 API 接口

### 公开接口

#### 获取方法列表
```http
GET /api/methods?q=搜索词&tag=标签&verified=true&limit=100&offset=0
```

#### 获取单个方法
```http
GET /api/methods/{id}
```

#### ShortX 专用接口
```http
GET /api/shortx/methods.json
```
返回所有已验证方法，JSON 格式

#### 统计信息
```http
GET /api/stats
```

#### 获取所有标签
```http
GET /api/tags
```

### 管理接口（需要 X-Admin-Key）

#### 添加方法
```http
POST /api/methods
Headers: X-Admin-Key: your_key
Body: {
  "title": "方法名称",
  "code": "代码内容",
  "tags": ["标签1", "标签2"],
  "link": "来源链接"
}
```

#### 更新方法
```http
PUT /api/methods/{id}
Headers: X-Admin-Key: your_key
Body: {
  "title": "新标题",
  "verified": true
}
```

#### 删除方法
```http
DELETE /api/methods/{id}
Headers: X-Admin-Key: your_key
```

#### 获取历史消息
```http
POST /api/fetch-history
Headers: X-Admin-Key: your_key
Body: {
  "chat_id": "-1001234567890",
  "message_thread_id": 123,  // 可选
  "limit": 100
}
```

#### 验证并清理群组
```http
POST /api/group-configs/validate
Headers: X-Admin-Key: your_key
```

## ❓ 常见问题

### Q1: Bot 加入群组后看不到消息？
**A:** 确保：
1. Bot 被设置为**群组管理员**（必须）
2. BotFather 中设置了 Privacy Mode 为 `Disable`
3. Webhook 已正确设置

### Q2: 代码没有被采集？
**A:** 检查：
1. 代码格式是否正确（使用代码块或等宽字体）
2. 群组是否已启用采集
3. 如果设置了话题 ID，检查消息是否在指定话题中
4. Bot 是否是管理员

### Q3: 群组类型显示错误？
**A:** 
1. 点击"群组配置"页面的"清理失效"按钮
2. 系统会自动更新所有群组的类型信息

### Q4: 消息编辑后没有更新？
**A:** 
1. 检查 Webhook 是否包含 `edited_message`
2. 重新设置 Webhook：`POST /set-webhook`

### Q5: 如何获取 Chat ID？
**A:** 
- 将 Bot 添加为管理员后，Chat ID 会显示在群组配置页面
- 或使用 [@userinfobot](https://t.me/userinfobot) 转发群组消息获取

### Q6: 如何获取话题 ID（Message Thread ID）？
**A:** 在超级群组中：
1. 进入目标话题
2. 发送任意消息
3. 在 Web 版 Telegram URL 中查看：`https://t.me/c/xxxxxxx/话题ID/消息ID`
4. 或使用 Bot API 的 `message_thread_id` 字段

### Q7: 历史消息获取失败？
**A:** 
- Telegram API 限制，可能无法获取太久远的消息
- 分批次获取，每次不超过 500 条
- 确保 Bot 在消息发送时就已经在群组中

### Q8: 数据库满了怎么办？
**A:** 
- Cloudflare D1 免费版有 5GB 限制
- 定期删除不需要的方法
- 或升级到付费版

## 🗂️ 数据库结构

### methods 表
```sql
CREATE TABLE methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,              -- 方法标题
  code TEXT NOT NULL,                -- 代码内容
  tags TEXT,                         -- 标签（逗号分隔）
  verified INTEGER DEFAULT 0,        -- 是否已验证
  author TEXT,                       -- 作者
  source TEXT,                       -- 来源（telegram/manual）
  chat_id TEXT,                      -- 群组 ID
  message_id INTEGER,                -- 消息 ID
  link TEXT,                         -- 来源链接
  hash TEXT UNIQUE,                  -- 代码 SHA256
  created_at INTEGER,                -- 创建时间（时间戳）
  updated_at INTEGER                 -- 更新时间（时间戳）
);
```

### group_configs 表
```sql
CREATE TABLE group_configs (
  chat_id TEXT PRIMARY KEY,          -- 群组 ID
  chat_title TEXT,                   -- 群组名称
  chat_type TEXT,                    -- 群组类型
  enabled INTEGER DEFAULT 1,         -- 是否启用
  allowed_thread_ids TEXT,           -- 允许的话题 ID
  updated_at INTEGER                 -- 更新时间
);
```

## 🎯 最佳实践

### 1. 群组管理
- 为不同类型的代码创建不同的群组
- 使用超级群组的话题功能分类管理
- 定期使用"清理失效"功能维护群组列表

### 2. 代码提交
- 使用 Telegram 代码块功能确保格式正确
- 添加有意义的标签便于检索
- 代码要有适当的注释说明

### 3. 标签规范
建议使用以下标签分类：
- **语言标签**：`#JavaScript` `#Python` `#Java`
- **功能标签**：`#工具函数` `#UI组件` `#数据处理`
- **场景标签**：`#ShortX` `#自动化` `#实用`

### 4. 安全建议
- 使用强密码作为 `ADMIN_KEY`
- 定期更换 `WEBHOOK_SECRET`
- 不要在公开群组中泄露管理员密钥
- 定期备份数据库

## 📊 性能优化

### Cloudflare Workers 限制
- 免费版：每天 100,000 请求
- CPU 时间：10ms（免费）/ 50ms（付费）

### 优化建议
1. 合理设置获取历史消息的数量
2. 避免频繁调用验证接口
3. 使用标签筛选减少数据传输

## 🔄 更新日志

### v1.0.0 (2026-01)
- ✨ 初始版本发布
- 🤖 支持 Telegram Bot 自动采集
- 🏷️ 标签系统
- ✅ 验证管理
- 📥 历史消息获取
- 🔄 消息编辑同步
- 🎯 话题过滤
- 🗂️ 群组类型识别
- 🧹 失效群组清理
