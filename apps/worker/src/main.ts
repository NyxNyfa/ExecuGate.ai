import { config } from '@execugate/core';
import type { JobKind } from '@execugate/core';
import { createContext, runGatekeeper, buildWalkthrough, scheduleWalkthrough } from '@execugate/orchestration';
import type { AppContext } from '@execugate/orchestration';
import { ticketRepo, jobRepo } from '@execugate/db';
import { renderWalkthrough, TelegramAdapter } from '@execugate/channels';
import { createLogger } from '@execugate/observability';

const log = createLogger('worker');

/**
 * Background worker (ADR-5).
 *
 * Owns the retry loop that makes NFR §8.3 true: an external API outage becomes a
 * queued retry with exponential backoff, never a lost or failed task. Also drives
 * the scheduled 17:00 walkthrough (FR-06.1).
 */
async function main() {
  const ctx = createContext();
  const store = ctx.store;

  const adapter = config.telegram.token ? new TelegramAdapter({ token: config.telegram.token }) : null;
  const orgs = store.all<{ id: string }>('SELECT id FROM organizations');

  log.info('worker started', { orgs: orgs.length, gatekeeper: config.gatekeeper.provider });

  // Anything left `running` by a crash is returned to the queue on boot.
  const recovered = jobRepo(store).recoverStale();
  if (recovered > 0) log.warn('recovered stale jobs', { count: recovered });

  const daily = startDailyScheduler(ctx);

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    const jobs = jobRepo(store).claim(3);
    if (!jobs.length) {
      await sleep(1000);
      continue;
    }

    for (const job of jobs) {
      try {
        await handle(ctx, job, adapter);
        jobRepo(store).complete(job.id);
        log.info('job done', { kind: job.kind, id: job.id, attempt: job.attempts });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // fail() applies exponential backoff and dead-letters after maxAttempts.
        jobRepo(store).fail(job, message);
        log.error('job failed', { kind: job.kind, id: job.id, attempt: job.attempts, error: message });
      }
    }
  }

  daily.stop();
  store.close();
  log.info('worker stopped');
}

async function handle(
  ctx: AppContext,
  job: { org_id: string; kind: JobKind; payload_json: string },
  adapter: TelegramAdapter | null,
): Promise<void> {
  const payload = JSON.parse(job.payload_json) as { ticketId?: string; date?: string };
  const scope = { orgId: job.org_id };

  switch (job.kind) {
    case 'gate.verify': {
      if (!payload.ticketId) throw new Error('gate.verify requires ticketId');

      // Retry a ticket parked in QA_VERIFICATION while an external system was down.
      const ticket = ticketRepo(ctx.store).get(scope, payload.ticketId);
      if (ticket.status !== 'QA_VERIFICATION') {
        log.info('skipping gate retry; ticket moved on', { code: ticket.code, status: ticket.status });
        return;
      }

      const result = await runGatekeeper(ctx, scope, payload.ticketId);
      log.info('gate retry result', { code: ticket.code, verdict: result.verdict });

      // No requeue here on purpose: runGatekeeper already enqueues the next attempt
      // when the verdict is `unverifiable`. Doing it again would double the queue for
      // the same ticket and defeat the maxAttempts bound.
      return;
    }

    case 'report.walkthrough': {
      const report = buildWalkthrough(ctx, scope, payload.date);
      log.info('walkthrough built', { date: report.date, completed: report.counts.completed, blocked: report.counts.blocked });

      const chatId = config.telegram.commanderChatId;
      if (adapter && chatId) {
        await adapter.send(chatId, { target: chatId, text: renderWalkthrough(report), parseMode: 'markdown' });
      }
      return;
    }

    case 'retention.sweep': {
      log.info('retention sweep (no-op in alpha)');
      return;
    }

    default:
      log.warn('unhandled job kind', { kind: job.kind });
  }
}

/**
 * Daily 17:00 walkthrough scheduler. Enqueued rather than executed inline so a
 * restart during the evening report cannot lose it (ADR-5).
 */
function startDailyScheduler(ctx: AppContext): { stop: () => void } {
  const store = ctx.store;
  let lastFired = '';

  const check = () => {
    const now = new Date();
    const stamp = `${now.toISOString().slice(0, 10)}T17`;
    // Guard with a per-day stamp so a slow tick cannot enqueue twice.
    if (now.getHours() === 17 && now.getMinutes() === 0 && lastFired !== stamp) {
      lastFired = stamp;
      for (const org of store.all<{ id: string }>('SELECT id FROM organizations')) {
        scheduleWalkthrough(ctx, { orgId: org.id });
      }
    }
  };

  const timer = setInterval(check, 60_000);
  check();
  log.info('daily walkthrough scheduler active (17:00 local)');
  return { stop: () => clearInterval(timer) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  log.error('fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});