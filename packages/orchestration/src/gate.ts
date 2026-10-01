import type { Actor, OrgScope, Ticket } from '@execugate/core';
import { AppError, authorize } from '@execugate/core';
import { ticketRepo, dodRepo, verificationRepo, auditRepo, metricsRepo, jobRepo } from '@execugate/db';
import { reworkMessage, verificationPendingMessage } from '@execugate/gatekeeper';
import { createLogger } from '@execugate/observability';
import type { AppContext } from './context.ts';

const log = createLogger('orchestration:gate');

export interface GateOutcome {
  ticket: Ticket;
  verdict: 'pass' | 'fail' | 'unverifiable';
  /** The exact message to show staff (FR-05.2: specific, never generic). */
  staffMessage: string;
  commanderMessage: string | null;
  latencyMs: number;
}

/**
 * FR-05.2 — the automated quality gatekeeper, and the only place a ticket becomes
 * COMPLETED.
 *
 * Three outcomes, deliberately kept distinct:
 *   pass          -> COMPLETED, verification audit recorded
 *   fail          -> REWORK_REQUIRED with a specific correction message
 *   unverifiable  -> stays QA_VERIFICATION with verification_state='pending'
 *                    (NFR §8.3: an outage must never fail the work)
 */
export async function runGatekeeper(ctx: AppContext, scope: OrgScope, ticketId: string, actor?: Actor): Promise<GateOutcome> {
  const { store } = ctx;
  const tickets = ticketRepo(store);
  const dod = dodRepo(store);
  const verifications = verificationRepo(store);
  const audit = auditRepo(store);
  const metrics = metricsRepo(store);

  const ticket = tickets.get(scope, ticketId);
  if (ticket.status !== 'QA_VERIFICATION') {
    throw new AppError(
      'VALIDATION_FAILED',
      `Gatekeeper hanya dapat dijalankan pada status QA_VERIFICATION (saat ini ${ticket.status})`,
      { ticketId, status: ticket.status },
    );
  }

  const criteria = dod.list(scope, ticket.id);
  const result = await ctx.gatekeeper.verifyTicket(criteria);

  verifications.record(scope, {
    ticketId: ticket.id,
    lane: result.lane,
    provider: result.provider,
    verdict: result.verdict,
    outcomes: result.outcomes,
    messageId: result.messageId,
    latencyMs: result.latencyMs,
  });

  audit.log(scope, {
    actorId: actor?.userId ?? null,
    action: `gate.${result.verdict}`,
    entity: 'ticket',
    entityId: ticket.id,
    meta: {
      code: ticket.code,
      lane: result.lane,
      messageId: result.messageId,
      latencyMs: result.latencyMs,
      checks: result.outcomes.map((o) => ({ type: o.type, ok: o.ok, unverifiable: !!o.unverifiable })),
    },
  });

  metrics.incr(scope.orgId, `gate.${result.verdict}`);
  metrics.set(scope.orgId, 'gate.last_latency_ms', result.latencyMs);

  if (result.verdict === 'pass') {
    const completed = tickets.transition(scope, ticket.id, 'COMPLETED', 'gate.passed', { id: actor?.userId ?? 'system' }, {
      verificationState: 'none',
      meta: { messageId: result.messageId, latencyMs: result.latencyMs },
    });
    log.info('gate passed', { code: ticket.code, checks: result.outcomes.length, latencyMs: result.latencyMs });
    return {
      ticket: completed,
      verdict: 'pass',
      staffMessage: `✅ ${ticket.code} terverifikasi otomatis oleh Gatekeeper.`,
      commanderMessage: null,
      latencyMs: result.latencyMs,
    };
  }

  if (result.verdict === 'fail') {
    // A real failure: the work is wrong, so say so now rather than waiting for a retry.
    const rework = tickets.transition(scope, ticket.id, 'REWORK_REQUIRED', 'gate.failed', { id: actor?.userId ?? 'system' }, {
      reason: result.outcomes.find((o) => !o.ok && !o.unverifiable)?.detail ?? 'Verifikasi otomatis gagal',
      meta: { messageId: result.messageId },
      verificationState: 'none',
    });
    log.info('gate failed', { code: ticket.code, messageId: result.messageId });
    return {
      ticket: rework,
      verdict: 'fail',
      staffMessage: reworkMessage(result),
      commanderMessage: `${ticket.code} dikembalikan: ${result.outcomes.find((o) => !o.ok && !o.unverifiable)?.detail ?? 'verifikasi gagal'}`,
      latencyMs: result.latencyMs,
    };
  }

  // Unverifiable: NFR §8.3. Stay in QA_VERIFICATION, queued for retry.
  tickets.setVerificationState(scope, ticket.id, 'pending');

  // The retry must actually be enqueued here. Setting `verification_state` on its own
  // only marks intent: nothing would ever revisit the ticket, so the promise made to
  // staff in the pending-verification message ("diperiksa ulang otomatis") would be
  // false. maxAttempts 5 keeps a permanent outage from looping forever.
  const jobId = jobRepo(store).enqueue(scope.orgId, 'gate.verify', { ticketId: ticket.id }, {
    delayMs: 60_000,
    maxAttempts: 5,
  });

  audit.log(scope, {
    actorId: actor?.userId ?? null,
    action: 'gate.pending',
    entity: 'ticket',
    entityId: ticket.id,
    meta: { code: ticket.code, messageId: result.messageId, retryJobId: jobId },
  });
  log.warn('gate unverifiable; queued for retry', { code: ticket.code, messageId: result.messageId, jobId });

  return {
    ticket: tickets.get(scope, ticket.id),
    verdict: 'unverifiable',
    staffMessage: verificationPendingMessage(result),
    commanderMessage: `${ticket.code} menunggu verifikasi — sistem eksternal sedang tidak dapat dihubungi.`,
    latencyMs: result.latencyMs,
  };
}

/**
 * DEV-4 — manual verification is an explicit, audited human override of FR-05,
 * available only after automated verification has exhausted its retries.
 * It is never a silent bypass.
 */
export async function manualVerification(
  ctx: AppContext,
  scope: OrgScope,
  actor: Actor,
  ticketId: string,
  input: { approve: boolean; reason: string },
): Promise<Ticket> {
  if (!input.reason || input.reason.trim().length < 5) {
    throw new AppError('VALIDATION_FAILED', 'Alasan verifikasi manual wajib diisi (minimal 5 karakter)');
  }
  authorize(actor, 'gate.manual_verify');

  const { store } = ctx;
  const tickets = ticketRepo(store);
  const ticket = tickets.get(scope, ticketId);

  if (ticket.status !== 'QA_VERIFICATION' && ticket.status !== 'REWORK_REQUIRED') {
    throw new AppError('VALIDATION_FAILED', `Verifikasi manual tidak dapat dilakukan pada status ${ticket.status}`);
  }

  const updated = tickets.transition(scope, ticket.id, 'COMPLETED', 'gate.manual_override', { id: actor.userId }, {
    reason: `Verifikasi manual: ${input.reason}`,
    meta: { manualOverride: true, reason: input.reason },
    verificationState: 'none',
  });

  verificationRepo(store).record(scope, {
    ticketId: ticket.id,
    lane: 'engineering',
    provider: 'manual',
    verdict: input.approve ? 'pass' : 'fail',
    outcomes: [{
      type: 'manual_review',
      ok: input.approve,
      detail: `Verifikasi manual oleh ${actor.displayName}: ${input.reason}`,
      latencyMs: 0,
    }],
    messageId: 'manual.override',
    latencyMs: 0,
  });

  auditRepo(store).log(scope, {
    actorId: actor.userId,
    action: 'gate.manual_override',
    entity: 'ticket',
    entityId: ticket.id,
    meta: { code: ticket.code, approve: input.approve, reason: input.reason },
  });

  metricsRepo(store).incr(scope.orgId, 'gate.manual_override');
  log.info('manual verification applied', { code: ticket.code, by: actor.displayName, approve: input.approve });

  return updated;
}