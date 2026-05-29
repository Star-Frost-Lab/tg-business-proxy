import { Env } from '../types';
import { json } from '../auth';

export async function handleLogs(
  request: Request,
  env: Env,
  _parts: string[],
): Promise<Response> {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);

  const url    = new URL(request.url);
  const cid    = url.searchParams.get('connection_id');
  const action = url.searchParams.get('action');
  const result = url.searchParams.get('result');
  const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 500);
  const offset = parseInt(url.searchParams.get('offset') ?? '0');

  let q = `SELECT * FROM operation_logs WHERE 1=1`;
  const b: any[] = [];

  if (cid)    { q += ` AND connection_id = ?`; b.push(cid); }
  if (action) { q += ` AND action = ?`;        b.push(action); }
  if (result) { q += ` AND result = ?`;        b.push(result); }

  q += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  b.push(limit, offset);

  const [logs, stats, total] = await Promise.all([
    env.DB.prepare(q).bind(...b).all(),
    env.DB.prepare(`
      SELECT action, result, COUNT(*) as count
      FROM operation_logs
      ${cid ? 'WHERE connection_id = ?' : ''}
      GROUP BY action, result
      ORDER BY count DESC
    `).bind(...(cid ? [cid] : [])).all(),
    env.DB.prepare(`SELECT COUNT(*) as n FROM operation_logs WHERE 1=1 ${cid ? 'AND connection_id = ?' : ''}`)
      .bind(...(cid ? [cid] : [])).first<{ n: number }>(),
  ]);

  return json({
    ok: true,
    result: {
      logs: logs.results,
      stats: stats.results,
      total: total?.n ?? 0,
    },
  });
}
