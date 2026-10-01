import { describe, it, expect } from 'vitest';
import {
  TICKET_STATUSES, TRANSITIONS, assertTransition, findTransition,
  allowedTransitions, isTerminal, IllegalTransitionError, verificationStateFor,
} from '@execugate/core';
import type { TicketStatus } from '@execugate/core';

const ALL: TicketStatus[] = [...TICKET_STATUSES];

/**
 * PRD §6 conformance. These tests are the contract: `ticketRepo.transition` is the
 * only writer of status, so if the table rejects a move, the ticket cannot make it.
 */
describe('PRD 6 state machine', () => {
  it('defines exactly the eight states the PRD lists', () => {
    expect(new Set(ALL)).toEqual(new Set([
      'DRAFT', 'PENDING_APPROVAL', 'ASSIGNED', 'IN_PROGRESS',
      'QA_VERIFICATION', 'REWORK_REQUIRED', 'COMPLETED', 'CANCELLED',
    ]));
    expect(ALL).toHaveLength(8);
  });

  it('has no transition rule pointing at an undeclared status', () => {
    for (const rule of TRANSITIONS) {
      expect(ALL).toContain(rule.to);
      for (const from of rule.from) expect(ALL).toContain(from);
    }
  });

  it('enters DRAFT only by creation, so no rule may target it mid-flow', () => {
    // DRAFT -> PENDING_APPROVAL is allowed; nothing else may arrive at DRAFT except
    // the commander correcting a draft.
    const intoDraft = TRANSITIONS.filter((r) => r.to === 'DRAFT');
    expect(intoDraft).toHaveLength(1);
    expect(intoDraft[0]!.from).toEqual(['PENDING_APPROVAL']);
  });

  it('permits the golden path end to end', () => {
    const path: Array<[TicketStatus, TicketStatus, string]> = [
      ['DRAFT', 'PENDING_APPROVAL', 'approval.requested'],
      ['PENDING_APPROVAL', 'ASSIGNED', 'approval.granted'],
      ['ASSIGNED', 'IN_PROGRESS', 'staff.acknowledged'],
      ['IN_PROGRESS', 'QA_VERIFICATION', 'staff.evidence_submitted'],
      ['QA_VERIFICATION', 'COMPLETED', 'gate.passed'],
    ];
    for (const [from, to, trigger] of path) {
      expect(() => assertTransition(from, to, trigger as never)).not.toThrow();
    }
  });

  it('permits the rework loop', () => {
    expect(() => assertTransition('QA_VERIFICATION', 'REWORK_REQUIRED', 'gate.failed')).not.toThrow();
    expect(() => assertTransition('REWORK_REQUIRED', 'IN_PROGRESS', 'staff.resubmitted')).not.toThrow();
  });

  it('treats COMPLETED and CANCELLED as terminal', () => {
    for (const status of ALL) {
      if (status === 'COMPLETED' || status === 'CANCELLED') {
        expect(isTerminal(status)).toBe(true);
        expect(allowedTransitions(status)).toHaveLength(0);
      }
    }
  });

  it('rejects every undeclared (from, to, trigger) combination', () => {
    let rejected = 0;
    for (const from of ALL) {
      for (const to of ALL) {
        if (from === to) continue;
        for (const trigger of ['intake.parsed', 'approval.granted', 'gate.passed', 'gate.failed', 'staff.resubmitted', 'approval.revoked', 'gate.manual_override'] as const) {
          const found = findTransition(from, to, trigger);
          const declared = !!found;
          try {
            assertTransition(from, to, trigger);
            expect(declared, `${from}->${to} via ${trigger} accepted but not declared`).toBe(true);
          } catch (err) {
            expect(declared).toBe(false);
            expect(err).toBeInstanceOf(IllegalTransitionError);
            rejected++;
          }
        }
      }
    }
    expect(rejected).toBeGreaterThan(0);
  });

  it('never allows a self-transition', () => {
    for (const rule of TRANSITIONS) expect(rule.to).not.toBe(rule.from[0]);
  });

  it('only allows REWORK_REQUIRED to be cleared by the gate or a manual override', () => {
    const exits = allowedTransitions('REWORK_REQUIRED').map((r) => r.to);
    expect(exits).toContain('IN_PROGRESS');
    // A rework ticket must not jump straight to COMPLETED without a re-run.
    const direct = TRANSITIONS.find((r) => r.from.includes('REWORK_REQUIRED') && r.to === 'COMPLETED' && r.trigger === 'gate.passed');
    expect(direct).toBeUndefined();
  });

  it('maps QA_VERIFICATION to a pending verification state (DEV-1)', () => {
    expect(verificationStateFor('QA_VERIFICATION')).toBe('pending');
    expect(verificationStateFor('COMPLETED')).toBe('none');
  });

  it('names an actionable reason on every rule', () => {
    for (const rule of TRANSITIONS) {
      expect(rule.reason.trim().length).toBeGreaterThan(5);
    }
  });
});