import { Env } from '../types';
import { json } from '../auth';
import { TelegramAPI } from '../tg';
import { logOp } from '../webhook';

export async function handleConnections(
  request: Request,
  env: Env,
  parts: string[],
): Promise<Response> {
  // parts = ['api', 'connections', '{id?}', '{sub?}', '{subId?}', '{subSub?}']
  const method = request.method;
  const connId = parts[2];
  const sub = parts[3]; // 'chats'

  // ── GET /api/connections ─────────────────────────────────────
  if (!connId && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT * FROM business_connections ORDER BY connected_at DESC`,
    ).all();
    return json({ ok: true, result: results });
  }

  // ── GET /api/connections/:id ─────────────────────────────────
  if (connId && !sub && method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT * FROM business_connections WHERE id = ?`,
    ).bind(connId).first();
    if (!row) return json({ ok: false, error: 'Connection not found' }, 404);

    // 同时从 Telegram 拉取最新状态
    const tg = new TelegramAPI(env.BOT_TOKEN);
    const live = await tg.getBusinessConnection(connId);

    // 如果 Telegram 返回最新 rights，更新本地缓存
    if (live.ok && live.result?.rights) {
      const newRights = JSON.stringify(live.result.rights);
      await env.DB.prepare(
        `UPDATE business_connections SET rights = ?, updated_at = ? WHERE id = ?`,
      ).bind(newRights, ts(), connId).run().catch(() => {});
    }

    return json({ ok: true, result: { ...row, live: live.result ?? null } });
  }

  // ── DELETE /api/connections/:id ──────────────────────────────
  if (connId && !sub && method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM business_connections WHERE id = ?`).bind(connId).run();
    await logOp(env, connId, 'connection_removed', {}, 'ok');
    return json({ ok: true, result: 'Removed' });
  }

  // ── GET /api/connections/:id/chats ───────────────────────────
  if (connId && sub === 'chats' && method === 'GET') {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200);
    const offset = parseInt(url.searchParams.get('offset') ?? '0');

    const { results } = await env.DB.prepare(`
      SELECT
        chat_id,
        chat_title,
        MAX(sent_at)  AS last_message_at,
        COUNT(*)      AS message_count,
        SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) AS incoming_count,
        SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) AS outgoing_count,
        (SELECT text FROM chat_messages m2
         WHERE m2.connection_id = m.connection_id AND m2.chat_id = m.chat_id
           AND m2.is_deleted = 0
         ORDER BY sent_at DESC LIMIT 1) AS last_text
      FROM chat_messages m
      WHERE connection_id = ? AND is_deleted = 0
      GROUP BY chat_id
      ORDER BY last_message_at DESC
      LIMIT ? OFFSET ?
    `).bind(connId, limit, offset).all();

    return json({ ok: true, result: results });
  }

  // ── GET /api/connections/:id/chats/:chatId/messages ──────────
  if (connId && sub === 'chats' && parts[5] === 'messages' && method === 'GET') {
    const chatId = parseInt(parts[4]);
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200);
    const before = url.searchParams.get('before');
    const search = url.searchParams.get('search');

    const binds: any[] = [connId, chatId];
    let where = `WHERE connection_id = ? AND chat_id = ? AND is_deleted = 0`;

    if (before) { where += ` AND sent_at < ?`; binds.push(parseInt(before)); }
    if (search)  { where += ` AND text LIKE ?`; binds.push(`%${search}%`); }

    const { results } = await env.DB.prepare(
      `SELECT * FROM chat_messages ${where} ORDER BY sent_at DESC LIMIT ?`,
    ).bind(...binds, limit).all();

    return json({ ok: true, result: (results as any[]).reverse() });
  }

  // ── DELETE /api/connections/:id/chats/:chatId/messages ───────
  if (connId && sub === 'chats' && parts[5] === 'messages' && method === 'DELETE') {
    const chatId = parseInt(parts[4]);
    const body: any = await request.json().catch(() => ({}));

    if (Array.isArray(body.message_ids) && body.message_ids.length) {
      for (const mid of body.message_ids) {
        await env.DB.prepare(`
          UPDATE chat_messages SET is_deleted = 1
          WHERE connection_id = ? AND chat_id = ? AND message_id = ?
        `).bind(connId, chatId, mid).run();
      }
    } else {
      // 清空整个聊天记录
      await env.DB.prepare(`
        UPDATE chat_messages SET is_deleted = 1
        WHERE connection_id = ? AND chat_id = ?
      `).bind(connId, chatId).run();
    }

    return json({ ok: true, result: 'Cleared' });
  }

  return json({ ok: false, error: 'Not found' }, 404);
}

function ts() { return Math.floor(Date.now() / 1000); }
