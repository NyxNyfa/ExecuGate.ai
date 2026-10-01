import type { OrgScope, WalkthroughReport } from '@execugate/core';
import { walkthroughRepo, userRepo, jobRepo, metricsRepo } from '@execugate/db';
import { createLogger } from '@execugate/observability';
import type { AppContext } from './context.ts';

const log = createLogger('orchestration:report');

/** FR-06.1 trigger phrases. Kept broad: natural command, not a formal query language. */
const REPORT_TRIGGERS = [
  'tampilkan progres', 'tampilkan progress', 'laporan progres', 'laporan hari ini',
  'progres hari ini', 'rekap hari ini', 'ringkasan hari ini', 'show progress',
  'daily report', 'how did today go', 'ringkasan pagi', 'laporan mingguan',
];

export function isWalkthroughRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return REPORT_TRIGGERS.some((t) => lower.includes(t));
}

/** FR-06.2 — aggregate the day's status changes into an executive walkthrough. */
export function buildWalkthrough(ctx: AppContext, scope: OrgScope, date?: string): WalkthroughReport {
  const users = userRepo(ctx.store);
  const names = new Map(users.list(scope.orgId).map((u) => [u.id, u.display_name]));
  const day = date ?? new Date().toISOString().slice(0, 10);
  return walkthroughRepo(ctx.store).build(scope, day, names);
}

/**
 * Scheduled 17:00 walkthrough. Enqueued rather than executed inline so a restart
 * during the evening report cannot lose it (ADR-5).
 */
export function scheduleWalkthrough(ctx: AppContext, scope: OrgScope, date?: string): string {
  const day = date ?? new Date().toISOString().slice(0, 10);
  const id = jobRepo(ctx.store).enqueue(scope.orgId, 'report.walkthrough', { date: day });
  log.info('walkthrough scheduled', { date: day, jobId: id });
  return id;
}

/** KPI counters backing PRD §10, derived from stored data rather than asserted. */
export function computeKpis(ctx: AppContext, scope: OrgScope): Record<string, number> {
  const store = ctx.store;
  const counters = metricsRepo(store).all(scope.orgId);

  const rows = store.all<{ verdict: string }>(
    "SELECT verdict FROM verifications WHERE org_id = ? AND created_at >= ?",
    scope.orgId, new Date(Date.now() - 86400_000).toISOString(),
  );
  const passed = rows.filter((r) => r.verdict === 'pass').length;

  // PRD §10.3 "Zero false completion": every COMPLETED ticket must have at least
  // one passing verification.
  const completedWithoutEvidence = store.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tickets t
      WHERE t.org_id = ? AND t.status = 'COMPLETED'
        AND NOT EXISTS (SELECT 1 FROM verifications v WHERE v.ticket_id = t.id AND v.verdict = 'pass')`,
    scope.orgId,
  )?.n ?? 0;

  return {
    ...counters,
    'gate.verifications_24h': rows.length,
    'gate.pass_rate_24h': rows.length ? passed / rows.length : 0,
    'kpi.false_completion_24h': completedWithoutEvidence,
  };
}