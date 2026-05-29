import UI_HTML from '../ui/index.html';
import { Env, CronMessageJob } from './types';
import { checkAuth, authError, json, corsPreFlight, loginHandler, logoutHandler } from './auth';
import { getSetupStatus, initDB, initWebhook } from './setup';
import { handleWebhook, logOp } from './webhook';
import { handleProxy } from './proxy';
import { handleConnections } from './api/connections';
import { handleRules } from './api/rules';
import { handleSchedule } from './api/schedule';
import { handleLogs } from './api/logs';
import { SchedulerDO, handleQueueBatch } from './scheduler';
import { TelegramAPI } from './tg';

export { SchedulerDO };

const INTERNAL = new Set(['connections', 'rules', 'schedule', 'logs', 'setup']);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url    = new URL(request.url);
      const path   = url.pathname;
      const method = request.method;

      // CORS preflight
      if (method === 'OPTIONS') return corsPreFlight();

      // ── 静态资源：Worker 直接返回 HTML ──────────────────────────
      if (path === '/' || path === '/index.html') {
        return new Response(UI_HTML, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }

      // ── 认证端点（无需预先认证）──────────────────────────────────
      if (path === '/login'  && method === 'POST') return await loginHandler(request, env);
      if (path === '/logout' && method === 'POST') return logoutHandler();

      // ── Telegram Webhook（Telegram secret token 验证，无需密码）─
      if (path.startsWith('/webhook/')) {
        return await handleWebhook(request, env, ctx);  // 传 ctx 确保 waitUntil 生效
      }

      // ── 以下全部需要认证 ─────────────────────────────────────────
      if (!await checkAuth(request, env)) return authError();

      // 透明代理 /bot{TOKEN}/{method}
      if (/^\/bot[^/]+\//.test(path)) {
        return await handleProxy(request);
      }

      // /api/* 路由
      if (path.startsWith('/api/')) {
        const parts    = path.split('/').filter(Boolean);
        const resource = parts[1] ?? '';
        const sub      = parts[2] ?? '';

        try {
          // 系统设置
          if (resource === 'setup') {
            if (method === 'GET'  && !sub) return json({ ok: true, result: await getSetupStatus(request, env) });
            if (method === 'POST' && sub === 'db') {
              const r = await initDB(env); return json({ ok: r.ok, result: r });
            }
            if (method === 'POST' && sub === 'webhook') {
              const r = await initWebhook(request, env); return json({ ok: r.ok, result: r });
            }
          }

          if (resource === 'connections') return await handleConnections(request, env, parts);
          if (resource === 'rules')       return await handleRules(request, env, parts);
          if (resource === 'schedule')    return await handleSchedule(request, env, parts);
          if (resource === 'logs')        return await handleLogs(request, env, parts);

          // 通用 Telegram API 代理
          if (!INTERNAL.has(resource)) {
            const tg = new TelegramAPI(env.BOT_TOKEN);
            let body: Record<string, any> = {};
            if (method === 'GET' || method === 'HEAD') {
              for (const [k, v] of url.searchParams.entries()) body[k] = v;
            } else {
              const ct = request.headers.get('Content-Type') ?? '';
              if (ct.includes('application/json')) {
                body = await request.json<Record<string, any>>().catch(() => ({}));
              } else if (ct.includes('multipart/') || ct.includes('x-www-form-urlencoded')) {
                const fd = await request.formData().catch(() => new FormData());
                for (const [k, v] of fd.entries()) body[k] = v;
              }
            }
            const result = await tg.call(resource, body);
            const readOnly = new Set(['getMe','getWebhookInfo','getBusinessConnection',
              'getChat','getChatMember','getUserProfilePhotos','getUpdates']);
            if (!readOnly.has(resource)) {
              ctx.waitUntil(logOp(env,
                (body as any).business_connection_id ?? null,
                resource, body, result.ok ? 'ok' : 'error', result.description));
            }
            return json(result);
          }
        } catch (e: any) {
          console.error('[router:api]', e);
          return json({ ok: false, error: e?.message ?? 'Internal error' }, 500);
        }
      }

      return json({ ok: false, error: 'Not found' }, 404);

    } catch (e: any) {
      console.error('[worker:unhandled]', e);
      return new Response(
        JSON.stringify({ ok: false, error: 'Worker error: ' + (e?.message ?? String(e)) }),
        { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
      );
    }
  },

  async queue(batch: MessageBatch<CronMessageJob>, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleQueueBatch(batch, env);
  },
};
