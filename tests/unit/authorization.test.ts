import { describe, it, expect } from 'vitest';
import { can, authorize, authorizeTicketOwnership, AppError } from '@execugate/core';
import type { Actor } from '@execugate/core';

const actor = (role: Actor['role'], divisionId: string | null = null, userId = 'u1'): Actor => ({
  orgId: 'org1', userId, role, divisionId, displayName: role,
});

describe('RBAC (PRD 3 personas)', () => {
  it('lets only commanders and admins approve or cancel', () => {
    for (const action of ['approval.grant', 'approval.cancel', 'approval.correct'] as const) {
      expect(can(actor('commander'), action)).toBe(true);
      expect(can(actor('admin'), action)).toBe(true);
      expect(can(actor('technical'), action)).toBe(false);
      expect(can(actor('ops'), action)).toBe(false);
    }
  });

  it('reserves manual verification for commanders (DEV-4)', () => {
    expect(can(actor('commander'), 'gate.manual_verify')).toBe(true);
    expect(can(actor('admin'), 'gate.manual_verify')).toBe(true);
    expect(can(actor('technical'), 'gate.manual_verify')).toBe(false);
    expect(can(actor('ops'), 'gate.manual_verify')).toBe(false);
  });

  it('lets any member ask for clarification', () => {
    for (const role of ['commander', 'technical', 'ops', 'admin'] as const) {
      expect(can(actor(role), 'ticket.clarify')).toBe(true);
    }
  });

  it('throws FORBIDDEN with the allowed roles attached', () => {
    try {
      authorize(actor('ops'), 'approval.grant');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('FORBIDDEN');
      expect((err as AppError).details.allowed).toEqual(['commander', 'admin']);
    }
  });

  describe('staff are scoped to their own division', () => {
    const ticket = { assigneeId: 'u-tech', divisionId: 'div-tech' };

    it('allows the assigned user', () => {
      expect(() => authorizeTicketOwnership(actor('technical', 'div-tech', 'u-tech'), 'ticket.ack', ticket)).not.toThrow();
    });

    it('rejects a different division', () => {
      expect(() => authorizeTicketOwnership(actor('ops', 'div-ops', 'u-ops'), 'ticket.ack', ticket))
        .toThrow(/owning division/);
    });

    it('rejects another user in the same division', () => {
      expect(() => authorizeTicketOwnership(actor('technical', 'div-tech', 'u-other'), 'ticket.evidence', ticket))
        .toThrow(/assigned to another user/);
    });

    it('does not let a commander execute staff work: approval authority is not execution authority', () => {
      // A commander authorises work; they do not acknowledge or submit evidence on
      // someone else's ticket. That separation is what keeps the audit trail honest.
      expect(() => authorizeTicketOwnership(actor('commander'), 'ticket.ack', ticket))
        .toThrow(/may not perform/);
    });

    it('still blocks staff on commander-only actions even in their own division', () => {
      expect(() => authorizeTicketOwnership(actor('technical', 'div-tech', 'u-tech'), 'gate.manual_verify', ticket))
        .toThrow();
    });
  });
});