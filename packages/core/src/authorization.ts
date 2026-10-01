import { AppError } from './errors.ts';
import type { Actor, Role } from './types.ts';

/**
 * RBAC chokepoint (BUILD_PLAN §11). Every privileged operation calls `authorize`;
 * there are no inline role checks elsewhere.
 *
 * Roles map to PRD §3 personas:
 *   commander  → §3.1 Pimpinan Eksekutif / Project Owner
 *   technical  → §3.2 Tim Teknis / Staf Rekayasa
 *   ops        → §3.3 Tim Operasional / Administrasi
 *   admin      → system operator
 */
export type Action =
  | 'instruction.create'
  | 'approval.grant'
  | 'approval.cancel'
  | 'approval.correct'
  | 'ticket.assign'
  | 'ticket.ack'
  | 'ticket.evidence'
  | 'ticket.clarify'
  | 'ticket.escalate'
  | 'gate.manual_verify'
  | 'document.upload'
  | 'report.read'
  | 'audit.read'
  | 'metrics.read';

const MATRIX: Record<Action, readonly Role[]> = {
  'instruction.create': ['commander', 'admin'],
  'approval.grant': ['commander', 'admin'],
  'approval.cancel': ['commander', 'admin'],
  'approval.correct': ['commander', 'admin'],
  'ticket.assign': ['commander', 'admin'],
  'ticket.ack': ['technical', 'ops', 'admin'],
  'ticket.evidence': ['technical', 'ops', 'admin'],
  'ticket.clarify': ['commander', 'technical', 'ops', 'admin'],
  'ticket.escalate': ['technical', 'ops', 'admin'],
  // DEV-4: manual verification is an explicit, audited human override of FR-05.
  'gate.manual_verify': ['commander', 'admin'],
  'document.upload': ['admin', 'commander'],
  'report.read': ['commander', 'admin'],
  'audit.read': ['commander', 'admin'],
  'metrics.read': ['commander', 'admin'],
};

export function can(actor: Actor, action: Action): boolean {
  return MATRIX[action].includes(actor.role);
}

export function authorize(actor: Actor, action: Action): void {
  if (!can(actor, action)) {
    throw new AppError('FORBIDDEN', `Role '${actor.role}' may not perform '${action}'`, {
      action,
      role: actor.role,
      allowed: MATRIX[action],
    });
  }
}

/**
 * Staff may only act on tickets assigned to their own division. This is the
 * second half of authorization: role alone is never sufficient.
 */
export function authorizeTicketOwnership(
  actor: Actor,
  action: Action,
  ticket: { assigneeId: string | null; divisionId: string },
): void {
  authorize(actor, action);
  if (actor.role === 'admin') return;
  if (actor.role === 'commander') return;

  const staffScoped: Action[] = ['ticket.ack', 'ticket.evidence'];
  if (!staffScoped.includes(action)) return;

  if (actor.divisionId !== ticket.divisionId) {
    throw new AppError('FORBIDDEN', `Action '${action}' is limited to the owning division`, {
      action,
      actorDivision: actor.divisionId,
      ticketDivision: ticket.divisionId,
    });
  }
  if (ticket.assigneeId && ticket.assigneeId !== actor.userId) {
    throw new AppError('FORBIDDEN', `Ticket is assigned to another user`, {
      action,
      ticketId: ticket.assigneeId,
    });
  }
}

export const ROLE_LABELS_ID: Record<Role, string> = {
  commander: 'Pimpinan',
  technical: 'Tim Teknis',
  ops: 'Tim Operasional',
  admin: 'Administrator Sistem',
};
