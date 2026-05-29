import { Env, TelegramUpdate, BusinessConnection, TelegramMessage } from './types';
import { TelegramAPI } from './tg';

// ── Webhook 入口 ──────────────────────────────────────────────────
export async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,   // 必须传入 ctx 才能用 waitUntil
): Promise<Response> {
  // 验证 Telegram 下发的 Secret Token
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== env.WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // ctx.waitUntil 确保 Worker 返回 200 后异步处理仍然完整执行
  // 不加 waitUntil 时，Cloudflare 可能在 Response 返回后立即终止 Worker，
  // 导致 D1 写入被中断，Telegram 以为成功但数据丢失
  ctx.waitUntil(
    processUpdate(update, env).catch(e => console.error('[webhook] process error:', e))
  );

  return new Response('OK', { status: 200 });
}

// ── Update 分发器 ─────────────────────────────────────────────────
async function processUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const now = ts();

  if (update.business_connection) {
    await onBusinessConnection(update.business_connection, env, now);
    return;
  }

  if (update.business_message) {
    await saveMessage(update.business_message, 'incoming', env, now);
    await runAutoReply(update.business_message, env);
    return;
  }

  if (update.edited_business_message) {
    const m = update.edited_business_message;
    await env.DB.prepare(`
      UPDATE chat_messages SET text = ?, updated_at = ?
      WHERE connection_id = ? AND message_id = ? AND chat_id = ?
    `).bind(
      m.text || m.caption || null,
      now,
      m.business_connection_id ?? '',
      m.message_id,
      m.chat.id,
    ).run().catch(console.error);
    return;
  }

  if (update.deleted_business_messages) {
    const { business_connection_id: cid, chat, message_ids } = update.deleted_business_messages;
    for (const mid of message_ids) {
      await env.DB.prepare(`
        UPDATE chat_messages SET is_deleted = 1
        WHERE connection_id = ? AND message_id = ? AND chat_id = ?
      `).bind(cid, mid, chat.id).run().catch(console.error);
    }
    return;
  }

  // Guest Mode（API 10.0）
  if (update.guest_message) {
    await saveMessage(update.guest_message, 'incoming', env, now);
    await logOp(env, null, 'guest_message', {
      guest_query_id: update.guest_message.guest_query_id,
      from_user: update.guest_message.from?.id,
      chat_id: update.guest_message.chat.id,
    }, 'ok');
  }
}

// ── Business Connection 注册/更新 ─────────────────────────────────
async function onBusinessConnection(conn: BusinessConnection, env: Env, now: number): Promise<void> {
  // 白名单过滤
  const allowed = (env.ALLOWED_BUSINESS_CONNECTION_IDS ?? '').trim();
  if (allowed) {
    const ids = allowed.split(',').map(s => s.trim());
    if (!ids.includes(conn.id)) return;
  }

  const userName = [conn.user.first_name, conn.user.last_name].filter(Boolean).join(' ');
  const rights = JSON.stringify(conn.rights ?? (conn.can_reply ? { can_reply: true } : {}));

  await env.DB.prepare(`
    INSERT INTO business_connections
      (id, user_id, user_chat_id, user_name, user_username, rights, is_enabled, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_name   = excluded.user_name,
      user_username = excluded.user_username,
      rights      = excluded.rights,
      is_enabled  = excluded.is_enabled,
      updated_at  = excluded.updated_at
  `).bind(
    conn.id,
    conn.user.id,
    conn.user_chat_id,
    userName,
    conn.user.username ?? null,
    rights,
    conn.is_enabled ? 1 : 0,
    conn.date,
    now,
  ).run();


  await logOp(env, conn.id, 'business_connection', {
    is_enabled: conn.is_enabled,
    user: conn.user.id,
    rights: conn.rights,
  }, 'ok');
}

// ── 保存消息到 D1 ─────────────────────────────────────────────────
export async function saveMessage(
  msg: TelegramMessage,
  direction: 'incoming' | 'outgoing',
  env: Env,
  now: number,
): Promise<void> {
  const connId = msg.business_connection_id ?? '';
  const fromName = msg.from ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') : null;
  const chatTitle =
    msg.chat.title ||
    [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') ||
    null;

  const contentType = msg.photo ? 'photo'
    : msg.video ? 'video'
    : msg.document ? 'document'
    : msg.audio ? 'audio'
    : msg.voice ? 'voice'
    : msg.sticker ? 'sticker'
    : msg.animation ? 'animation'
    : 'text';

  const mediaFileId = msg.photo
    ? msg.photo[msg.photo.length - 1]?.file_id
    : (msg.video ?? msg.document ?? msg.audio ?? msg.voice ?? msg.sticker ?? msg.animation)?.file_id ?? null;

  await env.DB.prepare(`
    INSERT OR IGNORE INTO chat_messages
      (connection_id, chat_id, chat_title, message_id, from_user_id, from_name,
       direction, content_type, text, media_file_id, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    connId,
    msg.chat.id,
    chatTitle,
    msg.message_id,
    msg.from?.id ?? null,
    fromName,
    direction,
    contentType,
    msg.text ?? msg.caption ?? null,
    mediaFileId,
    msg.date ?? now,
  ).run().catch(console.error);
}

// ── 自动回复引擎 ──────────────────────────────────────────────────
async function runAutoReply(msg: TelegramMessage, env: Env): Promise<void> {
  const connId = msg.business_connection_id;
  if (!connId) return;

  // 从 D1 查询权限（无需 KV）
  const connRow = await env.DB.prepare(
    `SELECT rights, is_enabled FROM business_connections WHERE id = ?`
  ).bind(connId).first<{ rights: string; is_enabled: number }>().catch(() => null);
  if (!connRow || !connRow.is_enabled) return;
  const rights = JSON.parse(connRow.rights || '{}');
  if (!rights.can_reply) return;

  // 加载规则：连接专属规则优先，全局规则兜底
  const { results: rules } = await env.DB.prepare(`
    SELECT * FROM auto_reply_rules
    WHERE enabled = 1 AND (connection_id = ? OR connection_id IS NULL)
    ORDER BY (connection_id IS NOT NULL) DESC, priority DESC
    LIMIT 30
  `).bind(connId).all();

  const text = (msg.text ?? msg.caption ?? '').toLowerCase();

  let matched: any = null;
  for (const rule of rules as any[]) {
    if (rule.trigger_type === 'all') { matched = rule; break; }

    if (rule.trigger_type === 'keyword' && rule.trigger_value) {
      if (text.includes((rule.trigger_value as string).toLowerCase())) { matched = rule; break; }
    }

    if (rule.trigger_type === 'regex' && rule.trigger_value) {
      try {
        if (new RegExp(rule.trigger_value, 'i').test(text)) { matched = rule; break; }
      } catch { /* 无效正则跳过 */ }
    }
  }

  if (!matched) return;

  const tg = new TelegramAPI(env.BOT_TOKEN);
  const res = await tg.sendMessage({
    business_connection_id: connId,
    chat_id: msg.chat.id,
    text: matched.reply_text,
    parse_mode: matched.reply_parse_mode ?? 'HTML',
  });

  if (res.ok) {
    await saveMessage(res.result as TelegramMessage, 'outgoing', env, ts());
  }

  await logOp(
    env, connId, 'auto_reply',
    { rule_id: matched.id, chat_id: msg.chat.id, trigger: matched.trigger_value },
    res.ok ? 'ok' : 'error',
    res.ok ? undefined : res.description,
  );
}

// ── 工具函数 ──────────────────────────────────────────────────────
export async function logOp(
  env: Env,
  connectionId: string | null,
  action: string,
  detail: object,
  result: 'ok' | 'error',
  errorMsg?: string,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO operation_logs (connection_id, action, detail, result, error_msg, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(connectionId, action, JSON.stringify(detail), result, errorMsg ?? null, ts())
    .run().catch(console.error);
}

function ts() { return Math.floor(Date.now() / 1000); }
