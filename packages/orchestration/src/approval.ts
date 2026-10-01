import type { Actor, OrgScope, Ticket, InstructionParse } from '@execugate/core';
import { AppError, authorize } from '@execugate/core';
import { ticketRepo, instructionRepo, dodRepo, divisionRepo, userRepo, auditRepo, metricsRepo } from '@execugate/db';
import { createLogger } from '@execugate/observability';
import type { AppContext } from './context.ts';

const log = createLogger('orchestration:approval');

export type ApprovalDecision =
  | { action: 'approve'; assigneeOverrides?: Record<string, string>; reason?: string }
  | { action: 'cancel'; reason?: string }
  | { action: 'correct'; changes: Array<{ ticketId: string; assigneeId?: string; priority?: string; dueAt?: string | null }> };

export interface ApprovalResult {
  decision: ApprovalDecision['action'];
  dispatched: Ticket[];
  skipped: Array<{ code: string; reason: string }>;
  alreadyProcessed: boolean;
}

/**
 * FR-03.1 / FR-03.3 — the governance gate.
 *
 * This is the only function in the system that moves tickets out of
 * `PENDING_APPROVAL`. FR-03.1 ("distribution is forbidden without confirmation") is
 * therefore structurally enforced: `dispatchTickets` reads only `ASSIGNED` rows.
 */
export async function handleApproval(
  ctx: AppContext,
  scope: OrgScope,
  actor: Actor,
  instructionId: string,
  decision: ApprovalDecision,
): Promise<ApprovalResult> {
  const { store } = ctx;
  const tickets = ticketRepo(store);
  const instructions = instructionRepo(store);
  const audit = auditRepo(store);
  const metrics = metricsRepo(store);

  const instruction = instructions.get(scope, instructionId);
  if (!instruction) throw new AppError('NOT_FOUND', `Instruction not found: ${instructionId}`);

  const parse = instruction.parse_json ? (JSON.parse(instruction.parse_json) as InstructionParse) : null;

  // Collect the drafts belonging to this instruction.
  const drafts = store.all<{ id: string; status: string; code: string }>(
    'SELECT id, status, code FROM tickets WHERE org_id = ? AND instruction_id = ? ORDER BY seq',
    scope.orgId, instructionId,
  );

  // Idempotency: a repeated button press must not distribute twice.
  if (!drafts.some((d) => d.status === 'PENDING_APPROVAL')) {
    const already = drafts.map((d) => ({ code: d.code, reason: `sudah berstatus ${d.status}` }));
    log.info('approval already processed', { instructionId, statuses: already });
    return { decision: decision.action, dispatched: [], skipped: already, alreadyProcessed: true };
  }

  authorize(actor, decision.action === 'approve' ? 'approval.grant' : decision.action === 'cancel' ? 'approval.cancel' : 'approval.correct');

  if (decision.action === 'correct') {
    const users = userRepo(store);
    for (const change of decision.changes) {
      const ticket = tickets.get(scope, change.ticketId);
      if (ticket.status !== 'PENDING_APPROVAL') {
        throw new AppError('VALIDATION_FAILED', `Ticket ${ticket.code} is not awaiting approval (status ${ticket.status})`);
      }
      if (change.assigneeId !== undefined) {
        const assignee = users.byId(scope.orgId, change.assigneeId);
        if (!assignee) throw new AppError('NOT_FOUND', `Assignee not found: ${change.assigneeId}`);
        tickets.updateAssignment(scope, ticket.id, change.assigneeId);
      }
      if (change.priority || change.dueAt !== undefined) {
        store.run(
          'UPDATE tickets SET priority = ?, due_at = ?, updated_at = ? WHERE org_id = ? AND id = ?',
          change.priority ?? ticket.priority,
          change.dueAt !== undefined ? change.dueAt : ticket.dueAt,
          new Date().toISOString(), scope.orgId, ticket.id,
        );
      }
      // Audit the correction itself: governance controls need a record of edits.
      audit.log(scope, {
        actorId: actor.userId,
        action: 'approval.corrected',
        entity: 'ticket',
        entityId: ticket.id,
        meta: change as unknown as Record<string, unknown>,
      });
    }
    return { decision: 'correct', dispatched: [], skipped: [], alreadyProcessed: false };
  }

  if (decision.action === 'cancel') {
    const cancelled: Ticket[] = [];
    for (const draft of drafts) {
      if (draft.status !== 'PENDING_APPROVAL') continue;
      cancelled.push(
        tickets.transition(scope, draft.id, 'CANCELLED', 'approval.revoked', { id: actor.userId }, {
          reason: decision.reason ?? 'Pimpinan membatalkan penugasan',
          meta: { instructionId },
        }),
      );
    }
    audit.log(scope, { actorId: actor.userId, action: 'approval.cancelled', entity: 'instruction', entityId: instructionId, meta: { count: cancelled.length } });
    metrics.incr(scope.orgId, 'approvals.cancelled', cancelled.length);
    return { decision: 'cancel', dispatched: [], skipped: [], alreadyProcessed: false };
  }

  // Approve: every draft transitions, then the dispatcher fans them out.
  const approved: Ticket[] = [];
  const skipped: Array<{ code: string; reason: string }> = [];

  for (const draft of drafts) {
    if (draft.status !== 'PENDING_APPROVAL') {
      skipped.push({ code: draft.code, reason: `sudah berstatus ${draft.status}` });
      continue;
    }

    const ticket = tickets.transition(scope, draft.id, 'ASSIGNED', 'approval.granted', { id: actor.userId }, {
      reason: decision.reason ?? 'Pimpinan menyetujui dan mendistribusikan penugasan',
      meta: { instructionId },
      assigneeId: decision.assigneeOverrides?.[draft.id],
    });

    // A ticket with no assignee cannot be worked on; flag it rather than
    // silently distributing to nobody.
    if (!ticket.assigneeId) {
      skipped.push({ code: ticket.code, reason: 'belum ada personel yang ditugaskan' });
      metrics.incr(scope.orgId, 'approval.unassigned');
    }
    approved.push(ticket);
  }

  audit.log(scope, {
    actorId: actor.userId,
    action: 'approval.granted',
    entity: 'instruction',
    entityId: instructionId,
    meta: { count: approved.length, skipped: skipped.length, summary: parse?.summary },
  });
  metrics.incr(scope.orgId, 'approvals.granted', approved.length);
  metrics.incr(scope.orgId, 'approval.approved_first_try', approved.length);

  log.info('approval granted', { instructionId, dispatched: approved.length, skipped: skipped.length });

  return { decision: 'approve', dispatched: approved, skipped, alreadyProcessed: false };
}

export interface DispatchedTicket {
  ticket: Ticket;
  target: string;
}

/**
 * Reads only `ASSIGNED` tickets for an instruction. Because the approval function is
 * the only writer of that status, this is what makes FR-03.1 hold by construction
 * rather than by discipline.
 */
export function collectDispatchable(scope: OrgScope, instructionId: string, store: AppContext['store']): Ticket[] {
  const rows = store.all<{ id: string }>(
    "SELECT id FROM tickets WHERE org_id = ? AND instruction_id = ? AND status = 'ASSIGNED' ORDER BY seq",
    scope.orgId, instructionId,
  );
  const tickets = ticketRepo(store);
  return rows.map((r) => tickets.get(scope, r.id));
}

/** Reference documents shown on the staff card, resolved from project memory. */
export function referenceDocs(ctx: AppContext, scope: OrgScope, projectId: string, title: string) {
  const docs = ctx.store.all<{ title: string }>(
    'SELECT title FROM documents WHERE org_id = ? AND project_id = ? AND ingest_state = ? ORDER BY created_at DESC LIMIT 4',
    scope.orgId, projectId, 'ready',
  );
  const lower = title.toLowerCase();
  const targeted = docs.filter((d) => lower.includes(d.title.split(/[\s—-]/)[0]!.toLowerCase()));
  return (targeted.length ? targeted : docs).map((d) => ({ title: d.title }));
}

export function buildTicketCardData(ctx: AppContext, scope: OrgScope, ticket: Ticket) {
  const dod = dodRepo(ctx.store).list(scope, ticket.id);
  const divisions = divisionRepo(ctx.store).list(scope.orgId);
  const users = userRepo(ctx.store).list(scope.orgId);
  return {
    dod: dod.map((d) => ({ label: d.label, kind: d.kind })),
    divisionName: divisions.find((d) => d.id === ticket.divisionId)?.name ?? 'Divisi',
    assigneeName: users.find((u) => u.id === ticket.assigneeId)?.display_name ?? null,
  };
}