import { Env } from '../types';
import { json } from '../auth';
import { calcNextRun, validateCron, notifyReschedule, getScheduler } from '../scheduler';

// ══════════════════════════════════════════════════════════════════
// REST API — Cron 规则 CRUD
// 每次规则变化后调用 notifyReschedule()，告知 DO 重算 Alarm
// ══════════════════════════════════════════════════════════════════

export async function handleSchedule(
  request: Request,
  env: Env,
  parts: string[],
): Promise<Response> {
  const method = request.method;
  const ruleId = parts[2] ? parseInt(parts[2]) : null;
  const action = parts[3]; // trigger | logs
  const now    = ts();

  // ── GET /api/schedule ────────────────────────────────────────
  if (!ruleId && method === 'GET') {
    const url    = new URL(request.url);
    const cid    = url.searchParams.get('connection_id');
    const only   = url.searchParams.get('enabled');
    const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 500);
    const offset = parseInt(url.searchParams.get('offset') ?? '0');

    let q = `SELECT * FROM cron_rules WHERE 1=1`;
    const b: any[] = [];
    if (cid)  { q += ` AND connection_id = ?`; b.push(cid); }
    if (only != null) { q += ` AND enabled = ?`; b.push(parseInt(only)); }
    q += ` ORDER BY id ASC LIMIT ? OFFSET ?`;
    b.push(limit, offset);

    const { results } = await env.DB.prepare(q).bind(...b).all();
    return json({ ok: true, result: results });
  }

  // ── POST /api/schedule — 创建规则 ───────────────────────────
  if (!ruleId && method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const { name, connection_id, chat_id, text, parse_mode,
            reply_markup, cron_expr, timezone } = body;

    if (!name)          return json({ ok: false, error: 'name 必填' }, 400);
    if (!connection_id) return json({ ok: false, error: 'connection_id 必填' }, 400);
    if (!chat_id)       return json({ ok: false, error: 'chat_id 必填' }, 400);
    if (!text)          return json({ ok: false, error: 'text 必填' }, 400);
    if (!cron_expr)     return json({ ok: false, error: 'cron_expr 必填，如 "0 9 * * *"' }, 400);

    const valid = validateCron(cron_expr);
    if (!valid.ok) return json({ ok: false, error: `cron_expr 无效：${valid.error}` }, 400);

    const rmStr   = reply_markup
      ? (typeof reply_markup === 'string' ? reply_markup : JSON.stringify(reply_markup))
      : null;
    const nextRun = calcNextRun(cron_expr);

    const res = await env.DB.prepare(`
      INSERT INTO cron_rules
        (name, connection_id, chat_id, text, parse_mode, reply_markup,
         cron_expr, timezone, enabled, next_run, run_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
    `).bind(name, connection_id, chat_id, text, parse_mode ?? 'HTML',
            rmStr, cron_expr, timezone ?? 'Asia/Shanghai', nextRun, now, now).run();

    const created = await env.DB.prepare(
      `SELECT * FROM cron_rules WHERE id = ?`,
    ).bind(res.meta.last_row_id).first();

    // 通知 DO 重算 Alarm（新规则可能比当前 Alarm 更早）
    await notifyReschedule(env);

    return json({ ok: true, result: created });
  }

  // ── GET /api/schedule/:id ────────────────────────────────────
  if (ruleId && !action && method === 'GET') {
    const rule = await env.DB.prepare(
      `SELECT * FROM cron_rules WHERE id = ?`,
    ).bind(ruleId).first();
    if (!rule) return json({ ok: false, error: 'Not found' }, 404);
    return json({ ok: true, result: rule });
  }

  // ── PUT /api/schedule/:id — 更新规则 ────────────────────────
  if (ruleId && !action && method === 'PUT') {
    const body: any = await request.json().catch(() => ({}));
    const cols: string[] = [];
    const b: any[]       = [];

    const set = (col: string, val: any) => { cols.push(`${col} = ?`); b.push(val); };

    if (body.name          !== undefined) set('name',          body.name);
    if (body.connection_id !== undefined) set('connection_id', body.connection_id);
    if (body.chat_id       !== undefined) set('chat_id',       body.chat_id);
    if (body.text          !== undefined) set('text',          body.text);
    if (body.parse_mode    !== undefined) set('parse_mode',    body.parse_mode);
    if (body.timezone      !== undefined) set('timezone',      body.timezone);
    if (body.reply_markup  !== undefined) {
      set('reply_markup', body.reply_markup
        ? (typeof body.reply_markup === 'string' ? body.reply_markup : JSON.stringify(body.reply_markup))
        : null);
    }
    if (body.enabled !== undefined) {
      set('enabled', body.enabled ? 1 : 0);
      // 启用时若 next_run 为空则重新计算
      if (body.enabled) {
        const rule = await env.DB.prepare(
          `SELECT cron_expr, next_run FROM cron_rules WHERE id = ?`,
        ).bind(ruleId).first() as any;
        if (rule && !rule.next_run) {
          set('next_run', calcNextRun(rule.cron_expr));
        }
      }
    }
    if (body.cron_expr !== undefined) {
      const valid = validateCron(body.cron_expr);
      if (!valid.ok) return json({ ok: false, error: `cron_expr 无效：${valid.error}` }, 400);
      set('cron_expr', body.cron_expr);
      set('next_run',  calcNextRun(body.cron_expr)); // 表达式变更，重算 next_run
    }

    if (!cols.length) return json({ ok: false, error: '无可更新字段' }, 400);

    set('updated_at', now);
    b.push(ruleId);

    await env.DB.prepare(
      `UPDATE cron_rules SET ${cols.join(', ')} WHERE id = ?`,
    ).bind(...b).run();

    // 通知 DO 重算 Alarm
    await notifyReschedule(env);

    const updated = await env.DB.prepare(
      `SELECT * FROM cron_rules WHERE id = ?`,
    ).bind(ruleId).first();
    return json({ ok: true, result: updated });
  }

  // ── DELETE /api/schedule/:id ─────────────────────────────────
  if (ruleId && !action && method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM cron_rules WHERE id = ?`).bind(ruleId).run();
    await env.DB.prepare(`DELETE FROM cron_logs  WHERE rule_id = ?`).bind(ruleId).run();

    // 通知 DO 重算（已删规则可能就是当前最早的 Alarm）
    await notifyReschedule(env);

    return json({ ok: true, result: 'Deleted' });
  }

  // ── POST /api/schedule/:id/trigger — 手动立即触发 ────────────
  if (ruleId && action === 'trigger' && method === 'POST') {
    const rule = await env.DB.prepare(
      `SELECT id FROM cron_rules WHERE id = ?`,
    ).bind(ruleId).first();
    if (!rule) return json({ ok: false, error: 'Not found' }, 404);

    // 通过 DO 触发（保持单点入口，便于审计）
    const stub = getScheduler(env);
    await stub.fetch('https://do/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rule_id: ruleId }),
    });

    return json({ ok: true, result: 'Triggered, message queued' });
  }

  // ── GET /api/schedule/:id/logs — 执行历史 ───────────────────
  if (ruleId && action === 'logs' && method === 'GET') {
    const url   = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200);
    const { results } = await env.DB.prepare(
      `SELECT * FROM cron_logs WHERE rule_id = ? ORDER BY fired_at DESC LIMIT ?`,
    ).bind(ruleId, limit).all();
    return json({ ok: true, result: results });
  }

  return json({ ok: false, error: 'Not found' }, 404);
}

function ts() { return Math.floor(Date.now() / 1000); }
