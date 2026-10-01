import type { Actor, OrgScope, Ticket } from '@execugate/core';
import { AppError, authorizeTicketOwnership } from '@execugate/core';
import { ticketRepo, dodRepo, clarificationRepo, auditRepo, metricsRepo } from '@execugate/db';
import { answerQuestion } from '@execugate/memory';
import { createLogger } from '@execugate/observability';
import type { AppContext } from './context.ts';

const log = createLogger('orchestration:staff');

/** Bounds an LLM from politely chatting forever and stalling a ticket. */
const MAX_CLARIFICATIONS_PER_HOUR = 6;

/** FR-04.1 — staff acknowledges and work begins. */
export async function acknowledgeTicket(ctx: AppContext, scope: OrgScope, actor: Actor, ticketId: string): Promise<Ticket> {
  const tickets = ticketRepo(ctx.store);
  const ticket = tickets.get(scope, ticketId);
  authorizeTicketOwnership(actor, 'ticket.ack', ticket);

  const updated = tickets.transition(scope, ticket.id, 'IN_PROGRESS', 'staff.acknowledged', { id: actor.userId });
  metricsRepo(ctx.store).incr(scope.orgId, 'tickets.acknowledged');
  log.info('ticket acknowledged', { code: ticket.code, by: actor.displayName });
  return updated;
}

/** FR-04.2 / FR-04.3 — staff asks, project memory answers. */
export async function askClarification(
  ctx: AppContext,
  scope: OrgScope,
  actor: Actor,
  ticketId: string,
  question: string,
): Promise<{ answer: string; grounded: boolean; citations: Array<{ docTitle: string; ordinal: number; excerpt: string }>; escalated: boolean; latencyMs: number }> {
  const tickets = ticketRepo(ctx.store);
  const ticket = tickets.get(scope, ticketId);
  authorizeTicketOwnership(actor, 'ticket.clarify', ticket);

  const clarifications = clarificationRepo(ctx.store);
  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = clarifications.countSince(scope, ticket.id, since);

  // Past the cap, stop answering and escalate rather than looping.
  if (recent >= MAX_CLARIFICATIONS_PER_HOUR) {
    clarifications.add(scope, {
      ticketId: ticket.id, askedBy: actor.userId, question,
      answer: 'Batas interaksi klarifikasi tercapai. Pertanyaan diteruskan ke commanding officer.',
      citations: [], grounded: false, escalated: true,
    });
    auditRepo(ctx.store).log(scope, {
      actorId: actor.userId, action: 'clarification.escalated',
      entity: 'ticket', entityId: ticket.id, meta: { question, reason: 'rate_limit' },
    });
    log.warn('clarification cap reached; escalated', { code: ticket.code, count: recent });
    return {
      answer: 'Batas interaksi klarifikasi tercapai. Pertanyaan diteruskan ke commanding officer.',
      grounded: false, citations: [], escalated: true, latencyMs: 0,
    };
  }

  const project = ctx.store.get<{ name: string }>(
    'SELECT name FROM projects WHERE org_id = ? AND id = ?', scope.orgId, ticket.projectId,
  );

  // Extractive mode keeps the offline (`fake` provider) path honest: it quotes the
  // canonical document rather than simulating model-written prose.
  //
  // The answer is then trimmed to the sentences that actually answer the question. A
  // bare chunk quote starts with the document title and heading, which reads as a bug
  // in the demo; the citations already carry the provenance.
  const useExtractive = ctx.llm.name === 'fake';

  const result = await answerQuestion(ctx.store, ctx.embedder, ctx.llm, scope, {
    projectId: ticket.projectId,
    projectName: project?.name ?? 'Project',
    question,
    extractiveOnly: useExtractive,
  });

  // In extractive mode the retrieved chunk opens with the document title and heading.
  // Trim to the sentences that bear on the question so the reply reads as an answer
  // rather than a pasted fragment; the citation already carries the provenance.
  const answer = useExtractive ? trimExtractiveAnswer(result.answer, question) : result.answer;

  clarifications.add(scope, {
    ticketId: ticket.id,
    askedBy: actor.userId,
    question,
    answer,
    citations: result.citations,
    grounded: result.grounded,
    escalated: !result.grounded,
  });

  metricsRepo(ctx.store).incr(scope.orgId, 'clarifications.asked');
  metricsRepo(ctx.store).incr(scope.orgId, result.grounded ? 'clarifications.grounded' : 'clarifications.ungrounded');

  log.info('clarification answered', {
    code: ticket.code,
    grounded: result.grounded,
    citations: result.citations.length,
    latencyMs: result.latencyMs,
  });

  return { ...result, answer, escalated: !result.grounded };
}

/**
 * Keeps the sentences of a quoted chunk that overlap the question, falling back to
 * the leading content sentence when nothing matches lexically.
 */
export function trimExtractiveAnswer(chunk: string, question: string, maxSentences = 3): string {
  const lines = chunk
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[#|>*`]/.test(l) && !/^-{3,}/.test(l));

  if (!lines.length) return chunk.trim();

  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4);

  const scored = lines
    .map((text) => {
      const lower = text.toLowerCase();
      const score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
      // A line carrying a concrete value is more likely the answer than prose.
      const numeric = /\d/.test(text) ? 0.5 : 0;
      return { text, score: score + numeric };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const chosen = (scored.length ? scored : lines.map((text) => ({ text, score: 0 })))
    .slice(0, maxSentences)
    .map((s) => s.text);

  // Preserve document order so a multi-line answer still reads coherently.
  return chosen.sort((a, b) => lines.indexOf(a) - lines.indexOf(b)).join(' ').trim();
}

/** FR-04.1 -> QA_VERIFICATION. Staff claims done; nothing is verified yet. */
export async function submitEvidence(
  ctx: AppContext,
  scope: OrgScope,
  actor: Actor,
  ticketId: string,
  evidence: { url?: string; note?: string },
): Promise<Ticket> {
  const tickets = ticketRepo(ctx.store);
  const ticket = tickets.get(scope, ticketId);
  authorizeTicketOwnership(actor, 'ticket.evidence', ticket);

  const criteria = dodRepo(ctx.store).list(scope, ticket.id);

  // FR-05.1 requires at least one objective criterion; a ticket with none can
  // never be auto-verified, so refuse rather than accepting an unverifiable claim.
  const machineCheckable = criteria.filter((c) => c.check.type !== 'manual_review');
  if (!machineCheckable.length && criteria.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Ticket ${ticket.code} tidak memiliki kriteria yang dapat diverifikasi otomatis`,
      { criteria: criteria.map((c) => c.label) },
    );
  }

  const updated = tickets.transition(scope, ticket.id, 'QA_VERIFICATION', 'staff.evidence_submitted', { id: actor.userId }, {
    reason: 'Staf melaporkan selesai dan melampirkan bukti kerja',
    // verification_state='pending' is the DEV-1 signal: waiting on the gatekeeper.
    verificationState: 'pending',
    meta: { url: evidence.url ?? null, note: evidence.note ?? null },
  });

  metricsRepo(ctx.store).incr(scope.orgId, 'tickets.evidence_submitted');
  log.info('evidence submitted', { code: ticket.code, hasUrl: !!evidence.url });

  return updated;
}

/** REWORK_REQUIRED -> IN_PROGRESS when staff resubmits. */
export async function resubmit(ctx: AppContext, scope: OrgScope, actor: Actor, ticketId: string, note?: string): Promise<Ticket> {
  const tickets = ticketRepo(ctx.store);
  const ticket = tickets.get(scope, ticketId);
  authorizeTicketOwnership(actor, 'ticket.evidence', ticket);

  const updated = tickets.transition(scope, ticket.id, 'IN_PROGRESS', 'staff.resubmitted', { id: actor.userId }, {
    reason: note ?? 'Staf memperbaiki dan melaporkan ulang',
    verificationState: 'none',
  });
  metricsRepo(ctx.store).incr(scope.orgId, 'tickets.resubmitted');
  return updated;
}