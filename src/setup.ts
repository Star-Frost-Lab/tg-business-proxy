import { Env } from './types';
import { TelegramAPI } from './tg';

// ── DDL ───────────────────────────────────────────────────────────
const TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS business_connections (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    user_chat_id INTEGER NOT NULL,
    user_name TEXT,
    user_username TEXT,
    rights TEXT NOT NULL DEFAULT '{}',
    is_enabled INTEGER DEFAULT 1,
    connected_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    chat_title TEXT,
    message_id INTEGER,
    from_user_id INTEGER,
    from_name TEXT,
    direction TEXT CHECK(direction IN ('incoming','outgoing')) DEFAULT 'incoming',
    content_type TEXT NOT NULL DEFAULT 'text',
    text TEXT,
    media_file_id TEXT,
    sent_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS auto_reply_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT,
    trigger_type TEXT CHECK(trigger_type IN ('keyword','regex','all')) NOT NULL DEFAULT 'keyword',
    trigger_value TEXT,
    reply_text TEXT NOT NULL,
    reply_parse_mode TEXT NOT NULL DEFAULT 'HTML',
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cron_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    parse_mode TEXT NOT NULL DEFAULT 'HTML',
    reply_markup TEXT,
    cron_expr TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run INTEGER,
    next_run INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cron_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    connection_id TEXT,
    fired_at INTEGER NOT NULL,
    result TEXT CHECK(result IN ('ok','error')) NOT NULL DEFAULT 'ok',
    error_msg TEXT,
    tg_message_id INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    result TEXT CHECK(result IN ('ok','error')) NOT NULL DEFAULT 'ok',
    error_msg TEXT,
    created_at INTEGER NOT NULL
  )`,
];

// ALTER TABLE 迁移：给旧表补上可能缺失的列（IF NOT EXISTS 在 SQLite 不支持，用 try/catch）
const MIGRATIONS: string[] = [
  `ALTER TABLE chat_messages ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text'`,
  `ALTER TABLE chat_messages ADD COLUMN direction TEXT CHECK(direction IN ('incoming','outgoing')) DEFAULT 'incoming'`,
  `ALTER TABLE chat_messages ADD COLUMN sent_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE chat_messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE chat_messages ADD COLUMN from_name TEXT`,
  `ALTER TABLE chat_messages ADD COLUMN chat_title TEXT`,
];

const INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_msg_conn     ON chat_messages(connection_id)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_chat     ON chat_messages(connection_id, chat_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rule_conn    ON auto_reply_rules(connection_id, enabled)`,
  `CREATE INDEX IF NOT EXISTS idx_cron_next    ON cron_rules(enabled, next_run)`,
  `CREATE INDEX IF NOT EXISTS idx_cron_conn    ON cron_rules(connection_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cronlog_rule ON cron_logs(rule_id, fired_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_log_created  ON operation_logs(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_log_conn     ON operation_logs(connection_id)`,
];

// ── 状态查询（登录时调用，不做任何初始化）────────────────────────
export async function getSetupStatus(request: Request, env: Env): Promise<object> {
  const tg = new TelegramAPI(env.BOT_TOKEN);

  const [botRes, webhookRes] = await Promise.all([
    tg.getMe().catch(() => ({ result: null })),
    tg.getWebhookInfo().catch(() => ({ result: null })),
  ]);

  const origin   = new URL(request.url).origin;
  const expected = `${origin}/webhook/${env.WEBHOOK_SECRET}`;
  const wh       = (webhookRes.result as any) ?? {};

  // 检查 DB：尝试查 business_connections，失败说明表不存在
  const safeCount = async (sql: string) => {
    try { return (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0; }
    catch { return -1; } // -1 = 表不存在
  };

  const [conns, msgs, cronRules, rules] = await Promise.all([
    safeCount('SELECT COUNT(*) as n FROM business_connections'),
    safeCount('SELECT COUNT(*) as n FROM chat_messages WHERE is_deleted=0'),
    safeCount('SELECT COUNT(*) as n FROM cron_rules WHERE enabled=1'),
    safeCount('SELECT COUNT(*) as n FROM auto_reply_rules WHERE enabled=1'),
  ]);

  return {
    bot: botRes.result ?? null,
    webhook: {
      current:            wh.url ?? null,
      expected,
      ok:                 wh.url === expected,
      pending_updates:    wh.pending_update_count ?? 0,
      last_error_message: wh.last_error_message ?? null,
    },
    db: {
      initialized:       conns >= 0,   // false = 表不存在
      connections:       conns,
      messages:          msgs,
      active_cron_rules: cronRules,
      active_rules:      rules,
    },
  };
}

// ── 初始化数据库（用户在设置页点击按钮触发）──────────────────────
export async function initDB(env: Env): Promise<{
  ok: boolean;
  results: { name: string; ok: boolean; error?: string }[];
}> {
  const results: { name: string; ok: boolean; error?: string }[] = [];

  for (const sql of TABLES) {
    const name = sql.match(/TABLE IF NOT EXISTS (\w+)/)?.[1] ?? '?';
    try {
      await env.DB.prepare(sql).run();
      results.push({ name, ok: true });
    } catch (e: any) {
      const error = String(e?.message ?? e).slice(0, 120);
      results.push({ name, ok: false, error });
      console.error('[setup:db]', name, error);
    }
  }

  for (const sql of INDEXES) {
    try { await env.DB.prepare(sql).run(); }
    catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes('already exists'))
        console.error('[setup:index]', msg.slice(0, 80));
    }
  }

  return { ok: results.every(r => r.ok), results };
}

// ── 注册 Webhook（用户在设置页点击按钮触发）─────────────────────
export async function initWebhook(request: Request, env: Env): Promise<{
  ok: boolean;
  url: string;
  error?: string;
}> {
  const tg  = new TelegramAPI(env.BOT_TOKEN);
  const url = `${new URL(request.url).origin}/webhook/${env.WEBHOOK_SECRET}`;
  try {
    const res = await tg.setWebhook(url, env.WEBHOOK_SECRET);
    return { ok: res.ok, url, error: res.ok ? undefined : res.description };
  } catch (e: any) {
    return { ok: false, url, error: String(e?.message ?? e) };
  }
}
