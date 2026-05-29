import { Env } from '../types';
import { json } from '../auth';

export async function handleRules(
  request: Request,
  env: Env,
  parts: string[],
): Promise<Response> {
  const method = request.method;
  const ruleId = parts[2] ? parseInt(parts[2]) : null;
  const now = ts();

  // ── GET /api/rules[?connection_id=] ─────────────────────────
  if (!ruleId && method === 'GET') {
    const url = new URL(request.url);
    const cid = url.searchParams.get('connection_id');

    let q = `SELECT * FROM auto_reply_rules`;
    const b: any[] = [];

    if (cid) {
      q += ` WHERE connection_id = ? OR connection_id IS NULL`;
      b.push(cid);
    }
    q += ` ORDER BY (connection_id IS NOT NULL) DESC, priority DESC, id ASC`;

    const { results } = await env.DB.prepare(q).bind(...b).all();
    return json({ ok: true, result: results });
  }

  // ── POST /api/rules ──────────────────────────────────────────
  if (!ruleId && method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const { connection_id, trigger_type, trigger_value, reply_text, reply_parse_mode, priority, enabled } = body;

    if (!reply_text)        return json({ ok: false, error: 'reply_text 必填' }, 400);
    if (!['keyword', 'regex', 'all'].includes(trigger_type))
      return json({ ok: false, error: 'trigger_type 无效，可选: keyword | regex | all' }, 400);
    if (trigger_type !== 'all' && !trigger_value)
      return json({ ok: false, error: 'keyword/regex 类型必须提供 trigger_value' }, 400);

    if (trigger_type === 'regex' && trigger_value) {
      try { new RegExp(trigger_value); } catch {
        return json({ ok: false, error: '无效的正则表达式' }, 400);
      }
    }

    const res = await env.DB.prepare(`
      INSERT INTO auto_reply_rules
        (connection_id, trigger_type, trigger_value, reply_text, reply_parse_mode, enabled, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      connection_id ?? null,
      trigger_type,
      trigger_value ?? null,
      reply_text,
      reply_parse_mode ?? 'HTML',
      enabled !== false ? 1 : 0,
      priority ?? 0,
      now, now,
    ).run();

    const created = await env.DB.prepare(`SELECT * FROM auto_reply_rules WHERE id = ?`)
      .bind(res.meta.last_row_id).first();
    return json({ ok: true, result: created });
  }

  // ── PUT /api/rules/:id ───────────────────────────────────────
  if (ruleId && method === 'PUT') {
    const body: any = await request.json().catch(() => ({}));
    const cols: string[] = [];
    const b: any[] = [];

    const setIfPresent = (key: string, val: any) => {
      if (val !== undefined) { cols.push(`${key} = ?`); b.push(val); }
    };

    setIfPresent('connection_id',     body.connection_id ?? null);
    setIfPresent('trigger_type',      body.trigger_type);
    setIfPresent('trigger_value',     body.trigger_value);
    setIfPresent('reply_text',        body.reply_text);
    setIfPresent('reply_parse_mode',  body.reply_parse_mode);
    setIfPresent('priority',          body.priority);

    if (body.enabled !== undefined) {
      cols.push('enabled = ?');
      b.push(body.enabled ? 1 : 0);
    }

    if (!cols.length) return json({ ok: false, error: '无可更新字段' }, 400);

    cols.push('updated_at = ?');
    b.push(now, ruleId);

    await env.DB.prepare(`UPDATE auto_reply_rules SET ${cols.join(', ')} WHERE id = ?`).bind(...b).run();
    const updated = await env.DB.prepare(`SELECT * FROM auto_reply_rules WHERE id = ?`).bind(ruleId).first();
    return json({ ok: true, result: updated });
  }

  // ── DELETE /api/rules/:id ────────────────────────────────────
  if (ruleId && method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM auto_reply_rules WHERE id = ?`).bind(ruleId).run();
    return json({ ok: true, result: 'Deleted' });
  }

  return json({ ok: false, error: 'Not found' }, 404);
}

function ts() { return Math.floor(Date.now() / 1000); }
