# TG Business Bot Proxy — Telegram Business Bot API 中转管理系统

**一键部署到 Cloudflare Workers 的 Telegram Business Bot API 完整代理服务，支持 Bot API 10.0 全特性，含可视化管理面板、自动回复、Cron 定时消息、多用户管理。**

[![Bot API](https://img.shields.io/badge/Bot%20API-10.0-blue)](https://core.telegram.org/bots/api)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)

## ✨ 核心特性

- **Business Bot 全权限支持**：消息/资料/礼物/动态管理，基于 `BusinessBotRights` 动态显示功能
- **Bot API 10.0**：Business Bot 无需 Telegram Premium，支持 Guest Mode
- **多用户管理**：可视化连接列表，点击用户进入独立管理面板
- **自动回复引擎**：关键词 / 正则 / 全匹配，支持优先级和全局/专属规则
- **Cron 定时消息**：Durable Objects Alarm 精确调度 + Queue 可靠投递，支持标准 Cron 表达式
- **聊天历史**：D1 持久化，可视化查看、搜索、清除
- **透明代理**：`/bot{TOKEN}/{method}` 格式，现有 SDK 仅改 base URL 即可迁移
- **交互式 API 文档**：内置文档页，带 curl 示例和一键执行

## 🚀 部署步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 Cloudflare 资源

```bash
# D1 数据库
wrangler d1 create tg-business-bot
# 复制输出的 database_id 填入 wrangler.toml

# Queue（定时消息可靠投递）
wrangler queues create tg-scheduled-messages
wrangler queues create tg-scheduled-messages-dlq

# Durable Objects 和 KV 无需手动创建（wrangler deploy 自动处理 DO 迁移）
```

### 3. 更新 wrangler.toml

```toml
[[d1_databases]]
database_id = "你的-D1-ID"   # 替换此处
```

### 4. 设置密钥

```bash
wrangler secret put BOT_TOKEN        # Telegram Bot Token
wrangler secret put ACCESS_PASSWORD  # 管理面板访问密码
wrangler secret put WEBHOOK_SECRET   # 随机字符串，建议：openssl rand -hex 16
```

### 5. 部署

```bash
npm run deploy
```

### 6. 初始化（部署后必须执行）

打开 `https://your-worker.workers.dev`，输入密码登录。

进入 **系统设置** 页面，点击两个按钮完成初始化：

| 按钮            | 作用                         |
| ------------- | -------------------------- |
| 🚀 初始化数据库     | 创建所有 D1 表和索引               |
| 🚀 注册 Webhook | 将 Webhook URL 注册到 Telegram |

两项都显示绿色 ✓ 后即可正常使用。

---

## 📁 项目结构

```
tg-business-proxy/
├── wrangler.toml
├── package.json
├── src/
│   ├── index.ts           # 主路由
│   ├── types.ts           # 类型定义
│   ├── auth.ts            # 密码验证
│   ├── setup.ts           # 系统初始化（建表 / Webhook）
│   ├── tg.ts              # Telegram API 客户端
│   ├── webhook.ts         # Update 处理 + 自动回复
│   ├── proxy.ts           # 透明代理
│   ├── scheduler.ts       # Durable Objects 调度器 + Queue Consumer
│   └── api/
│       ├── connections.ts # 连接管理 + 聊天历史
│       ├── rules.ts       # 自动回复规则
│       ├── schedule.ts    # Cron 规则管理
│       └── logs.ts        # 操作日志
└── ui/
    └── index.html         # 单页 Web UI
```

---

## 🔑 API 认证

**浏览器 UI**：登录后自动设置 Cookie，无需任何操作。

**curl / API 客户端**（三种方式均支持）：

```bash
# 1. Header（推荐）
curl -H "X-Access-Password: YOUR_PASSWORD" https://your-worker.dev/api/connections

# 2. Query 参数
curl "https://your-worker.dev/api/connections?password=YOUR_PASSWORD"

# 3. Cookie（浏览器登录后可从开发者工具获取）
curl -b "tgp_session=TOKEN" https://your-worker.dev/api/connections
```

---

## 📡 路由说明

| 路由                               | 说明                     |
| -------------------------------- | ---------------------- |
| `GET /`                          | Web 管理面板               |
| `POST /webhook/{SECRET}`         | Telegram Webhook（自动接收） |
| `GET /api/setup`                 | 查看系统状态（登录验证用）          |
| `POST /api/setup/db`             | 初始化数据库表                |
| `POST /api/setup/webhook`        | 注册 Telegram Webhook    |
| `GET /api/connections`           | Business 连接列表          |
| `GET/POST/DELETE /api/rules`     | 自动回复规则                 |
| `GET/POST/DELETE /api/schedule`  | Cron 定时规则              |
| `POST /api/schedule/:id/trigger` | 手动触发 Cron 规则           |
| `GET /api/logs`                  | 操作日志                   |
| `POST /api/{tgMethod}`           | 任意 Telegram API 代理     |
| `ALL /bot{TOKEN}/{method}`       | 透明代理（SDK 直连）           |

---

## 🔀 SDK 透明代理迁移

```python
# python-telegram-bot
from telegram import Bot
bot = Bot(token=TOKEN, base_url="https://your-worker.dev/bot")
```

```typescript
// grammY
const bot = new Bot(TOKEN, {
  client: { apiRoot: "https://your-worker.dev" }
});
```

---

## ⏰ Cron 表达式示例

| 表达式            | 含义           |
| -------------- | ------------ |
| `0 9 * * *`    | 每天早上 9 点     |
| `0 9 * * 1-5`  | 工作日早上 9 点    |
| `*/30 * * * *` | 每 30 分钟      |
| `0 9,18 * * *` | 每天 9 点和 18 点 |
| `0 0 1 * *`    | 每月 1 日零点     |
| `@daily`       | 每天零点（别名）     |
| `@hourly`      | 每小时整点（别名）    |

---

这是一个使用 Cloudflare Workers、D1、Durable Objects、Queue 构建的 Telegram Business Bot API 代理服务，支持 Bot API 10.0 全特性、Cron 定时调度、多连接管理和完整的可视化管理界面。
