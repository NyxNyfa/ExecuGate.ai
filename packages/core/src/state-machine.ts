import type { TicketStatus, VerificationState } from './types.ts';

/**
 * PRD §6 state machine, encoded as data.
 *
 * Nothing in the codebase is permitted to assign `tickets.status` directly; all
 * writes go through `assertTransition`. Illegal transitions throw, which is what
 * keeps the audit trail trustworthy.
 */
export const TICKET_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'ASSIGNED',
  'IN_PROGRESS',
  'QA_VERIFICATION',
  'REWORK_REQUIRED',
  'COMPLETED',
  'CANCELLED',
] as const satisfies readonly TicketStatus[];

export type TransitionTrigger =
  | 'intake.parsed'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.corrected'
  | 'approval.revoked'
  | 'staff.acknowledged'
  | 'staff.evidence_submitted'
  | 'gate.passed'
  | 'gate.failed'
  | 'gate.unverifiable'
  | 'gate.manual_override'
  | 'staff.resubmitted';

interface TransitionRule {
  from: TicketStatus[];
  to: TicketStatus;
  trigger: TransitionTrigger;
  /** Human-readable PRD trigger, used as the audit `reason`. */
  reason: string;
  /** When true, the transition demands a `COMPLETED`-style terminal state. */
  terminal?: boolean;
}

export const TRANSITIONS: readonly TransitionRule[] = [
  { from: ['DRAFT'], to: 'PENDING_APPROVAL', trigger: 'approval.requested', reason: 'Draf tiket disajikan untuk otorisasi' },
  { from: ['PENDING_APPROVAL'], to: 'ASSIGNED', trigger: 'approval.granted', reason: 'Pimpinan menyetujui dan mendistribusikan penugasan' },
  { from: ['PENDING_APPROVAL'], to: 'DRAFT', trigger: 'approval.corrected', reason: 'Pimpinan mengoreksi parameter penugasan' },
  { from: ['PENDING_APPROVAL', 'ASSIGNED'], to: 'CANCELLED', trigger: 'approval.revoked', reason: 'Pimpinan membatalkan penugasan', terminal: true },
  { from: ['ASSIGNED'], to: 'IN_PROGRESS', trigger: 'staff.acknowledged', reason: 'Staf mengonfirmasi penerimaan penugasan' },
  { from: ['IN_PROGRESS'], to: 'QA_VERIFICATION', trigger: 'staff.evidence_submitted', reason: 'Staf melaporkan selesai dan melampirkan bukti kerja' },
  { from: ['QA_VERIFICATION'], to: 'COMPLETED', trigger: 'gate.passed', reason: 'Gatekeeper menyatakan artefak lolos verifikasi otomatis', terminal: true },
  { from: ['QA_VERIFICATION'], to: 'REWORK_REQUIRED', trigger: 'gate.failed', reason: 'Gatekeeper menemukan anomali pada artefak kerja' },
  { from: ['REWORK_REQUIRED'], to: 'IN_PROGRESS', trigger: 'staff.resubmitted', reason: 'Staf memperbaiki dan melaporkan ulang' },
  { from: ['REWORK_REQUIRED', 'QA_VERIFICATION'], to: 'COMPLETED', trigger: 'gate.manual_override', reason: 'Verifikasi manual disetujui commanding officer', terminal: true },
] as const;

export const TERMINAL_STATUSES: readonly TicketStatus[] = ['COMPLETED', 'CANCELLED'];

export function isTerminal(status: TicketStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function findTransition(
  from: TicketStatus,
  to: TicketStatus,
  trigger: TransitionTrigger,
): TransitionRule | undefined {
  return TRANSITIONS.find((r) => r.to === to && r.trigger === trigger && r.from.includes(from));
}

export function allowedTransitions(from: TicketStatus): readonly TransitionRule[] {
  return TRANSITIONS.filter((r) => r.from.includes(from));
}

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  constructor(
    readonly from: TicketStatus,
    readonly to: TicketStatus,
    readonly trigger: string,
  ) {
    super(
      `Illegal ticket transition: ${from} -> ${to} (trigger: ${trigger}). ` +
        `Allowed from ${from}: ${allowedTransitions(from).map((t) => `${t.to} via ${t.trigger}`).join(', ') || 'none (terminal)'}`,
    );
    this.name = 'IllegalTransitionError';
  }
}

/** Gate every status write. Throws on anything not explicitly allowed. */
export function assertTransition(from: TicketStatus, to: TicketStatus, trigger: TransitionTrigger): TransitionRule {
  const rule = findTransition(from, to, trigger);
  if (!rule) throw new IllegalTransitionError(from, to, trigger);
  return rule;
}

/**
 * DEV-1: initial verification state implied by a target status. Keeps the
 * parallel field consistent without a second source of truth.
 */
export function verificationStateFor(status: TicketStatus): VerificationState {
  switch (status) {
    case 'QA_VERIFICATION':
      return 'pending';
    case 'COMPLETED':
      return 'none';
    default:
      return 'none';
  }
}
