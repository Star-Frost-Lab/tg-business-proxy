import { Cron } from 'croner';
import { Env, CronMessageJob } from './types';
import { TelegramAPI } from './tg';
import { saveMessage, logOp } from './webhook';

// ══════════════════════════════════════════════════════════════════
//  SchedulerDO — 真正的任务调度器
//
//  职责划分：
//    fetch('/reschedule')      API 层创建/更新/删除规则后调用，
//                             重新计算最近到期时间并 setAlarm
//    fetch('/trigger')         手动立即触发某条规则
//    alarm()                   Cloudflare 在预定时间唤醒 DO，
//                             扫描到期规则 → sendBatch → 更新 D1 → 再次 reschedule
//
//  每个 DO 实例同时只能持有一个 Alarm，因此调度逻辑是：
//    始终 setAlarm(最近一条规则的 next_run)
//    alarm 触发后处理所有 next_run <= now 的规则，再设下一个 Alarm
// ══════════════════════════════════════════════════════════════════

export class SchedulerDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    // blockConcurrencyWhile 保证初始化完成后才处理请求
    this.state.blockConcurrencyWhile(async () => {
      // DO 重启后检查 alarm 是否还在，若 D1 有活跃规则但 alarm 丢失则补设
      await this.recoverAlarmIfNeeded();
    });
  }

  // ── HTTP 入口（由 API Worker 调用）────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const url    = new URL(request.url);
    const action = url.pathname.replace(/^\//, ''); // 'reschedule' | 'trigger'

    try {
      if (action === 'reschedule') {
        await this.reschedule();
        return ok('rescheduled');
      }

      if (action === 'trigger') {
        const { rule_id } = await request.json<{ rule_id: number }>();
        await this.fireRule(rule_id);
        return ok('triggered');
      }

      return new Response('Not found', { status: 404 });

    } catch (e: any) {
      console.error('[SchedulerDO] fetch error:', e);
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // ── Alarm 触发（核心调度逻辑）────────────────────────────────
  async alarm(): Promise<void> {
    const now = ts();
    console.log('[SchedulerDO] alarm fired at', new Date(now * 1000).toISOString());

    try {
      // 1. 查询所有到期且 enabled 的规则
      const { results: due } = await this.env.DB.prepare(`
        SELECT * FROM cron_rules
        WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?
        LIMIT 100
      `).bind(now).all();

      if (due.length > 0) {
        // 2. 批量投入 Queue（解耦：DO 负责调度，Consumer 负责执行）
        const jobs: CronMessageJob[] = [];

        for (const row of due as any[]) {
          // 计算该规则的下次触发时间
          const nextRun = calcNextRun(row.cron_expr, new Date(now * 1000));

          // 原子更新：防止重复触发（若已被其他实例更新则跳过）
          const upd = await this.env.DB.prepare(`
            UPDATE cron_rules
            SET last_run  = ?,
                next_run  = ?,
                run_count = run_count + 1,
                updated_at = ?
            WHERE id = ? AND next_run <= ? AND enabled = 1
          `).bind(now, nextRun, now, row.id, now).run();

          if (upd.meta.changes === 0) continue; // 已被处理，跳过

          jobs.push({
            rule_id:       row.id,
            connection_id: row.connection_id,
            chat_id:       row.chat_id,
            text:          row.text,
            parse_mode:    row.parse_mode ?? 'HTML',
            reply_markup:  row.reply_markup ?? null,
            fired_at:      now,
          });
        }

        if (jobs.length > 0) {
          await this.env.QUEUE.sendBatch(jobs.map(j => ({ body: j })));
          console.log(`[SchedulerDO] ${jobs.length} rule(s) queued`);
        }
      }

    } catch (e) {
      console.error('[SchedulerDO] alarm processing error:', e);
      // 即使出错也要重新 reschedule，否则后续任务全部丢失
    }

    // 3. 无论成功与否，始终重新计算并设置下一个 Alarm
    await this.reschedule();
  }

  // ── 重新计算最近到期时间并 setAlarm ──────────────────────────
  async reschedule(): Promise<void> {
    const row = await this.env.DB.prepare(`
      SELECT MIN(next_run) AS earliest
      FROM cron_rules
      WHERE enabled = 1 AND next_run IS NOT NULL
    `).first<{ earliest: number | null }>();

    const earliest = row?.earliest ?? null;

    if (earliest !== null) {
      const alarmTime = earliest * 1000; // DO alarm 使用毫秒
      await this.state.storage.setAlarm(alarmTime);
      console.log('[SchedulerDO] next alarm:', new Date(alarmTime).toISOString());
    } else {
      // 没有任何活跃规则，清除 Alarm
      await this.state.storage.deleteAlarm();
      console.log('[SchedulerDO] no active rules, alarm cleared');
    }
  }

  // ── 手动触发单条规则（立即投 Queue）──────────────────────────
  async fireRule(ruleId: number): Promise<void> {
    const rule = await this.env.DB.prepare(
      `SELECT * FROM cron_rules WHERE id = ?`,
    ).bind(ruleId).first() as any;

    if (!rule) throw new Error(`Rule ${ruleId} not found`);

    const job: CronMessageJob = {
      rule_id:       rule.id,
      connection_id: rule.connection_id,
      chat_id:       rule.chat_id,
      text:          rule.text,
      parse_mode:    rule.parse_mode ?? 'HTML',
      reply_markup:  rule.reply_markup ?? null,
      fired_at:      ts(),
    };

    await this.env.QUEUE.send(job);
  }

  // ── DO 重启恢复：检查是否有漏掉的 Alarm ──────────────────────
  private async recoverAlarmIfNeeded(): Promise<void> {
    try {
      const current = await this.state.storage.getAlarm();
      if (current !== null) return; // Alarm 存在，无需恢复

      // Alarm 丢失（DO 重启、迁移等），重新 reschedule
      await this.reschedule();
      console.log('[SchedulerDO] alarm recovered after restart');
    } catch {
      // 静默处理，不影响正常请求
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// Queue Consumer Handler（独立于 DO，由 Queue 触发）
// ══════════════════════════════════════════════════════════════════

export async function handleQueueBatch(
  batch: MessageBatch<CronMessageJob>,
  env: Env,
): Promise<void> {
  const tg  = new TelegramAPI(env.BOT_TOKEN);
  const now = ts();

  for (const msg of batch.messages) {
    const job = msg.body;

    try {
      const rm  = job.reply_markup ? JSON.parse(job.reply_markup) : undefined;
      const res = await tg.call('sendMessage', {
        business_connection_id: job.connection_id,
        chat_id:      job.chat_id,
        text:         job.text,
        parse_mode:   job.parse_mode,
        reply_markup: rm,
      });

      if (res.ok) {
        await env.DB.prepare(`
          INSERT INTO cron_logs
            (rule_id, connection_id, fired_at, result, tg_message_id, created_at)
          VALUES (?, ?, ?, 'ok', ?, ?)
        `).bind(job.rule_id, job.connection_id, job.fired_at,
                res.result?.message_id ?? null, now).run();

        await saveMessage(res.result, 'outgoing', env, now);
        await logOp(env, job.connection_id, 'cron_sent',
          { rule_id: job.rule_id, chat_id: job.chat_id }, 'ok');

        msg.ack();

      } else {
        await env.DB.prepare(`
          INSERT INTO cron_logs
            (rule_id, connection_id, fired_at, result, error_msg, created_at)
          VALUES (?, ?, ?, 'error', ?, ?)
        `).bind(job.rule_id, job.connection_id, job.fired_at,
                res.description ?? 'TG error', now).run();

        await logOp(env, job.connection_id, 'cron_failed',
          { rule_id: job.rule_id, code: res.error_code, error: res.description },
          'error', res.description);

        // 永久性错误（400/403/404）不重试，其余交 Queue 重试
        if (isPermanent(res.error_code)) msg.ack();
        else msg.retry();
      }

    } catch (e: any) {
      console.error('[queue] exception rule_id=' + job.rule_id, e);
      await logOp(env, job.connection_id, 'cron_exception',
        { rule_id: job.rule_id, error: e.message }, 'error', e.message);
      msg.retry();
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════════════

/** 获取单例 SchedulerDO stub（全局共享同一实例） */
export function getScheduler(env: Env): DurableObjectStub {
  const id = env.SCHEDULER.idFromName('scheduler');
  return env.SCHEDULER.get(id);
}

/** 通知调度器重新计算 Alarm（规则变化后调用，fire-and-forget） */
export async function notifyReschedule(env: Env): Promise<void> {
  try {
    const stub = getScheduler(env);
    await stub.fetch('https://do/reschedule');
  } catch (e) {
    console.error('[scheduler] reschedule notify failed:', e);
  }
}

/** 计算 Cron 表达式的下次触发时间（Unix 秒），返回 null 表示无下次 */
export function calcNextRun(expr: string, after?: Date): number | null {
  const aliases: Record<string, string> = {
    '@hourly':  '0 * * * *', '@daily':   '0 0 * * *',
    '@midnight':'0 0 * * *', '@weekly':  '0 0 * * 0',
    '@monthly': '0 0 1 * *', '@yearly':  '0 0 1 1 *',
  };
  const resolved = aliases[expr.trim().toLowerCase()] ?? expr;
  try {
    const job  = new Cron(resolved, { timezone: 'UTC' });
    const next = job.nextRun(after);
    return next ? Math.floor(next.getTime() / 1000) : null;
  } catch {
    return null;
  }
}

/** 校验 Cron 表达式 */
export function validateCron(expr: string): { ok: boolean; error?: string } {
  const aliases = ['@hourly','@daily','@midnight','@weekly','@monthly','@yearly'];
  if (aliases.includes(expr.trim().toLowerCase())) return { ok: true };
  try {
    new Cron(expr);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function isPermanent(code?: number): boolean {
  return code === 400 || code === 403 || code === 404;
}

function ok(msg: string): Response {
  return new Response(JSON.stringify({ ok: true, msg }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function ts() { return Math.floor(Date.now() / 1000); }
