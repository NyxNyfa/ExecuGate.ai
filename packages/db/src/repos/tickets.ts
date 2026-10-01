import type { Store } from '../db.ts';
import { newId, ticketCode, assertTransition } from '@execugate/core';
import type {
  Actor, Check, DodCriterion, DodKind, OrgScope, Priority,
  Ticket, TicketEvent, TicketStatus, TransitionTrigger, VerificationState, Verification,
  CheckOutcome, Verdict, WalkthroughReport,
} from '@execugate/core';
import { tenantViolation, notFound } from '@execugate/core';

const now = () => new Date().toISOString();

interface TicketRow {
  id: string; org_id: string; project_id: string; instruction_id: string | null;
  seq: number; code: string; title: string; description: string; division_id: string;
  assignee_id: string | null; priority: Priority; due_at: string | null; status: TicketStatus;
  verification_state: VerificationState; created_by: string; created_at: string;
  updated_at: string; completed_at: string | null;
}

const toTicket = (r: TicketRow): Ticket => ({
  id: r.id, orgId: r.org_id, projectId: r.project_id, code: r.code, title: r.title,
  description: r.description, divisionId: r.division_id, assigneeId: r.assignee_id,
  priority: r.priority, dueAt: r.due_at, status: r.status,
  verificationState: r.verification_state, createdBy: r.created_by,
  createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
});

export function ticketRepo(store: Store) {
  const insert = (
    orgId: string,
    t: {
      projectId: string; instructionId?: string | null; title: string; description: string;
      divisionId: string; assigneeId?: string | null; priority: Priority; dueAt?: string | null;
      status: TicketStatus; createdBy: string;
    },
  ): Ticket => {
    const id = newId('tic');
    const seqRow = store.get<{ n: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tickets WHERE org_id = ?', orgId,
    );
    const seq = seqRow?.n ?? 1;
    const code = ticketCode(new Date().getFullYear(), seq);
    const ts = now();
    store.run(
      `INSERT INTO tickets (id, org_id, project_id, instruction_id, seq, code, title, description,
        division_id, assignee_id, priority, due_at, status, verification_state, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, orgId, t.projectId, t.instructionId ?? null, seq, code, t.title, t.description,
      t.divisionId, t.assigneeId ?? null, t.priority, t.dueAt ?? null, t.status, 'none', t.createdBy, ts, ts,
    );
    return toTicket(store.get<TicketRow>('SELECT * FROM tickets WHERE org_id = ? AND id = ?', orgId, id)!);
  };

  return {
    insert,

    /**
     * Tenant-scoped read.
     *
     * Throws `NOT_FOUND` rather than a bare Error: the API maps error codes to HTTP
     * status, and a plain Error becomes VALIDATION_FAILED (400), which tells a caller
     * its request was malformed when in fact the resource does not exist.
     */
    get(scope: OrgScope, id: string): Ticket {
      const row = store.get<TicketRow>('SELECT * FROM tickets WHERE id = ? AND org_id = ?', id, scope.orgId);
      if (!row) throw notFound('ticket', id);
      return toTicket(row);
    },

    /**
     * Distinguishes "absent" from "belongs to another tenant" so isolation breaches
     * can be alarmed on rather than logged as ordinary misses.
     */
    getStrict(scope: OrgScope, id: string): Ticket {
      const row = store.get<TicketRow>('SELECT * FROM tickets WHERE id = ?', id);
      if (!row) throw notFound('ticket', id);
      if (row.org_id !== scope.orgId) throw tenantViolation('ticket', id, scope.orgId, row.org_id);
      return toTicket(row);
    },

    list(scope: OrgScope, filter: { status?: TicketStatus[]; divisionId?: string; assigneeId?: string; since?: string } = {}) {
      const where = ['org_id = ?'];
      const params: unknown[] = [scope.orgId];
      if (filter.status?.length) {
        where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
        params.push(...filter.status);
      }
      if (filter.divisionId) { where.push('division_id = ?'); params.push(filter.divisionId); }
      if (filter.assigneeId) { where.push('assignee_id = ?'); params.push(filter.assigneeId); }
      if (filter.since) { where.push('created_at >= ?'); params.push(filter.since); }
      return store
        .all<TicketRow>(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, ...params)
        .map(toTicket);
    },

    /**
     * The ONLY writer of `tickets.status`. Every path validates against the PRD §6
     * transition table and writes a matching `ticket_events` audit row.
     *
     * Every transition is also mirrored into `audit_log`, in the same transaction.
     * That mirroring is done here rather than at each call site because the alternative
     * is a per-call-site audit write that is silently forgotten the next time someone
     * adds a transition — which is exactly what had happened: staff actions
     * (`staff.acknowledged`, `staff.evidence_submitted`) appeared in `ticket_events`
     * but never in the organisation-level audit trail, so an auditor asking "who
     * acknowledged this ticket?" got nothing back.
     */
    transition(
      scope: OrgScope,
      id: string,
      to: TicketStatus,
      trigger: TransitionTrigger,
      actor: { id: string },
      opts: { reason?: string; meta?: Record<string, unknown>; verificationState?: VerificationState; assigneeId?: string | null } = {},
    ): Ticket {
      return store.transaction(() => {
        const row = store.get<TicketRow>('SELECT * FROM tickets WHERE id = ? AND org_id = ?', id, scope.orgId);
        if (!row) throw notFound('ticket', id);
        const rule = assertTransition(row.status, to, trigger);

        const ts = now();
        const verificationState = opts.verificationState ?? 'none';

        // The assignee is only touched when one was actually supplied. The sentinel is
        // SQL NULL, not a numeric flag: SQLite evaluates `0 IS NOT NULL` as true, so a
        // 0/1 flag would make every transition clear the assignee.
        const newAssignee = opts.assigneeId === undefined ? null : opts.assigneeId;

        store.run(
          `UPDATE tickets SET status = ?, verification_state = ?, updated_at = ?,
             completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END,
             assignee_id = COALESCE(?, assignee_id)
           WHERE id = ? AND org_id = ?`,
          to, verificationState, ts,
          to, ts,
          newAssignee,
          id, scope.orgId,
        );

        store.run(
          `INSERT INTO ticket_events (id, org_id, ticket_id, from_status, to_status, actor_id, trigger, reason, meta_json, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          newId('evt'), scope.orgId, id, row.status, to, actor.id, trigger,
          opts.reason ?? rule.reason, JSON.stringify(opts.meta ?? {}), ts,
        );

        // The org-level trail. `from`/`to` are included so the audit endpoint answers
        // "what happened" without a second query, and so a transition is
        // distinguishable from the looser `approval.granted` rows written elsewhere.
        store.run(
          `INSERT INTO audit_log (id, org_id, actor_id, action, entity, entity_id, meta_json, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          newId('aud'), scope.orgId, actor.id, trigger, 'ticket', id,
          JSON.stringify({ from: row.status, to, ...(opts.meta ?? {}) }), ts,
        );

        return toTicket(store.get<TicketRow>('SELECT * FROM tickets WHERE id = ? AND org_id = ?', id, scope.orgId)!);
      });
    },

    updateAssignment(scope: OrgScope, id: string, assigneeId: string | null) {
      store.run('UPDATE tickets SET assignee_id = ?, updated_at = ? WHERE id = ? AND org_id = ?', assigneeId, now(), id, scope.orgId);
    },

    setVerificationState(scope: OrgScope, id: string, state: VerificationState) {
      store.run('UPDATE tickets SET verification_state = ?, updated_at = ? WHERE id = ? AND org_id = ?', state, now(), id, scope.orgId);
    },

    countsByStatus(scope: OrgScope) {
      const rows = store.all<{ status: TicketStatus; n: number }>(
        'SELECT status, COUNT(*) AS n FROM tickets WHERE org_id = ? GROUP BY status', scope.orgId,
      );
      return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<TicketStatus, number>;
    },
  };
}

export function eventRepo(store: Store) {
  return {
    listForTicket(scope: OrgScope, ticketId: string) {
      return store
        .all<{
          id: string; org_id: string; ticket_id: string; from_status: TicketStatus | null;
          to_status: TicketStatus; actor_id: string; trigger: string; reason: string;
          meta_json: string; created_at: string;
        }>('SELECT * FROM ticket_events WHERE org_id = ? AND ticket_id = ? ORDER BY created_at', scope.orgId, ticketId)
        .map<TicketEvent>((r) => ({
          id: r.id, orgId: r.org_id, ticketId: r.ticket_id, fromStatus: r.from_status,
          toStatus: r.to_status, actorId: r.actor_id, reason: r.reason,
          meta: JSON.parse(r.meta_json), createdAt: r.created_at,
        }));
    },

    listSince(scope: OrgScope, sinceIso: string) {
      return store
        .all<{
          id: string; org_id: string; ticket_id: string; from_status: TicketStatus | null;
          to_status: TicketStatus; actor_id: string; reason: string; meta_json: string; created_at: string;
        }>('SELECT * FROM ticket_events WHERE org_id = ? AND created_at >= ? ORDER BY created_at', scope.orgId, sinceIso)
        .map<TicketEvent>((r) => ({
          id: r.id, orgId: r.org_id, ticketId: r.ticket_id, fromStatus: r.from_status,
          toStatus: r.to_status, actorId: r.actor_id, reason: r.reason,
          meta: JSON.parse(r.meta_json), createdAt: r.created_at,
        }));
    },
  };
}

export function dodRepo(store: Store) {
  return {
    replaceAll(scope: OrgScope, ticketId: string, items: Array<{ kind: DodKind; label: string; required: boolean; check: Check }>) {
      store.run('DELETE FROM dod_criteria WHERE org_id = ? AND ticket_id = ?', scope.orgId, ticketId);
      items.forEach((d, i) => {
        store.run(
          'INSERT INTO dod_criteria (id, org_id, ticket_id, kind, label, required, check_json, position) VALUES (?,?,?,?,?,?,?,?)',
          newId('dod'), scope.orgId, ticketId, d.kind, d.label, d.required ? 1 : 0, JSON.stringify(d.check), i,
        );
      });
    },
    list(scope: OrgScope, ticketId: string): DodCriterion[] {
      return store
        .all<{
          id: string; org_id: string; ticket_id: string; kind: DodKind; label: string;
          required: number; check_json: string; position: number;
        }>('SELECT * FROM dod_criteria WHERE org_id = ? AND ticket_id = ? ORDER BY position', scope.orgId, ticketId)
        .map((r) => ({
          id: r.id, orgId: r.org_id, ticketId: r.ticket_id, kind: r.kind, label: r.label,
          required: !!r.required, check: JSON.parse(r.check_json) as Check, position: r.position,
        }));
    },
  };
}

export function verificationRepo(store: Store) {
  return {
    record(scope: OrgScope, v: {
      ticketId: string; lane: 'engineering' | 'operational'; provider: string;
      verdict: Verdict; outcomes: CheckOutcome[]; messageId: string | null; latencyMs: number;
    }) {
      const id = newId('vrf');
      store.run(
        `INSERT INTO verifications (id, org_id, ticket_id, lane, provider, verdict, outcomes_json, message_id, latency_ms, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, scope.orgId, v.ticketId, v.lane, v.provider, v.verdict,
        JSON.stringify(v.outcomes), v.messageId, Math.round(v.latencyMs), now(),
      );
      return id;
    },
    listForTicket(scope: OrgScope, ticketId: string): Verification[] {
      return store
        .all<{
          id: string; org_id: string; ticket_id: string; lane: 'engineering' | 'operational';
          provider: string; verdict: Verdict; outcomes_json: string; message_id: string | null;
          latency_ms: number; created_at: string;
        }>('SELECT * FROM verifications WHERE org_id = ? AND ticket_id = ? ORDER BY created_at DESC', scope.orgId, ticketId)
        .map((r) => ({
          id: r.id, orgId: r.org_id, ticketId: r.ticket_id, lane: r.lane, provider: r.provider,
          verdict: r.verdict, outcomes: JSON.parse(r.outcomes_json) as CheckOutcome[],
          messageId: r.message_id, latencyMs: r.latency_ms, createdAt: r.created_at,
        }));
    },
    evidenceUrls(scope: OrgScope, ticketId: string): string[] {
      const rows = store.all<{ outcomes_json: string }>(
        "SELECT outcomes_json FROM verifications WHERE org_id = ? AND ticket_id = ? AND verdict = 'pass'", scope.orgId, ticketId,
      );
      const urls = new Set<string>();
      for (const r of rows) for (const o of JSON.parse(r.outcomes_json) as CheckOutcome[]) if (o.evidenceUrl) urls.add(o.evidenceUrl);
      return [...urls];
    },
  };
}

export function clarificationRepo(store: Store) {
  return {
    add(scope: OrgScope, c: {
      ticketId: string; askedBy: string; question: string; answer: string;
      citations: unknown[]; grounded: boolean; escalated: boolean;
    }) {
      store.run(
        `INSERT INTO clarifications (id, org_id, ticket_id, asked_by, question, answer, citations_json, grounded, escalated, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        newId('clr'), scope.orgId, c.ticketId, c.askedBy, c.question, c.answer,
        JSON.stringify(c.citations), c.grounded ? 1 : 0, c.escalated ? 1 : 0, now(),
      );
    },
    list(scope: OrgScope, ticketId: string) {
      return store
        .all<{
          id: string; asked_by: string; question: string; answer: string;
          citations_json: string; grounded: number; escalated: number; created_at: string;
        }>('SELECT * FROM clarifications WHERE org_id = ? AND ticket_id = ? ORDER BY created_at', scope.orgId, ticketId)
        .map((r) => ({
          id: r.id, askedBy: r.asked_by, question: r.question, answer: r.answer,
          citations: JSON.parse(r.citations_json), grounded: !!r.grounded,
          escalated: !!r.escalated, createdAt: r.created_at,
        }));
    },
    countSince(scope: OrgScope, ticketId: string, sinceIso: string) {
      return store.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM clarifications WHERE org_id = ? AND ticket_id = ? AND created_at >= ?',
        scope.orgId, ticketId, sinceIso,
      )?.n ?? 0;
    },
  };
}

/** FR-06.2 aggregation. Powers both the Telegram report and the web dashboard. */
export function walkthroughRepo(store: Store) {
  return {
    build(scope: OrgScope, dateIso: string, names: Map<string, string>): WalkthroughReport {
      const dayStart = `${dateIso}T00:00:00.000Z`;
      const dayEnd = `${dateIso}T23:59:59.999Z`;
      const events = eventRepo(store).listSince(scope, dayStart).filter((e) => e.createdAt <= dayEnd);

      const completed = events.filter((e) => e.toStatus === 'COMPLETED').map((e) => {
        const t = ticketRepo(store).get(scope, e.ticketId);
        return {
          code: t.code, title: t.title, assignee: names.get(t.assigneeId ?? '') ?? 'Unassigned',
          evidenceUrls: verificationRepo(store).evidenceUrls(scope, t.id),
        };
      });

      const blocked = events
        .filter((e) => e.toStatus === 'REWORK_REQUIRED')
        .map((e) => {
          const t = ticketRepo(store).get(scope, e.ticketId);
          return { code: t.code, title: t.title, assignee: names.get(t.assigneeId ?? '') ?? 'Unassigned', blocker: e.reason };
        });

      const reopened = events
        .filter((e) => e.toStatus === 'REWORK_REQUIRED' || e.fromStatus === 'REWORK_REQUIRED')
        .map((e) => {
          const t = ticketRepo(store).get(scope, e.ticketId);
          return { code: t.code, title: t.title, reason: e.reason };
        });

      const open = ticketRepo(store)
        .list(scope, { status: ['ASSIGNED', 'IN_PROGRESS', 'QA_VERIFICATION', 'REWORK_REQUIRED', 'PENDING_APPROVAL'] })
        .map((t) => ({
          code: t.code, title: t.title, priority: t.priority, dueAt: t.dueAt,
          assignee: names.get(t.assigneeId ?? '') ?? 'Unassigned',
        }))
        .sort((a, b) => {
          const rank = { P0: 0, P1: 1, P2: 2 } as const;
          if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
          return (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999');
        });

      const verifs = store.all<{ verdict: Verdict }>(
        "SELECT verdict FROM verifications WHERE org_id = ? AND created_at >= ? AND created_at <= ?", scope.orgId, dayStart, dayEnd,
      );
      const passRate = verifs.length ? verifs.filter((v) => v.verdict === 'pass').length / verifs.length : 0;

      return {
        orgId: scope.orgId, date: dateIso, generatedAt: now(),
        completed, blocked, reopened,
        tomorrow: open.slice(0, 10).map(({ code, title, priority, dueAt }) => ({ code, title, priority, dueAt })),
        counts: { completed: completed.length, blocked: blocked.length, open: open.length, passRate },
      };
    },
  };
}

export type { Actor };
