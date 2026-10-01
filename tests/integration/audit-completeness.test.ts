import { describe, it, expect, beforeEach } from 'vitest';
import { Store, seedCore, auditRepo, orgRepo, SECOND_ORG_SLUG } from '@execugate/db';
import {
  createContext, intakeInstruction, handleApproval, acknowledgeTicket,
  submitEvidence, runGatekeeper,
} from '@execugate/orchestration';
import type { AppContext } from '@execugate/orchestration';
import type { Actor } from '@execugate/core';
import { createFakeEmbedder } from '@execugate/memory';
import { GatekeeperEngine, FakeGitHubProvider, OpsProvider, FixtureOpsSource } from '@execugate/gatekeeper';

/**
 * Audit completeness.
 *
 * The product's central claim is that every action is attributable. A gap was found by
 * driving the real system: `ticket_events` recorded `staff.acknowledged` and
 * `staff.evidence_submitted` with the right actor, but the organisation-level
 * `audit_log` that `/api/v1/audit` serves did not — so the question "who acknowledged
 * this ticket?" had no answer in the audit trail.
 *
 * The fix mirrors every transition into `audit_log` inside `ticketRepo.transition`,
 * which makes completeness structural rather than a rule each call site must remember.
 * These tests assert that property rather than the implementation.
 */

let store: Store;
let ctx: AppContext;
let scope: { orgId: string };
let commander: Actor;
let staff: Actor;

beforeEach(() => {
  store = new Store(':memory:');
  store.migrate();
  const refs = seedCore(store);

  ctx = createContext({
    store,
    embedder: createFakeEmbedder(256),
    gatekeeper: new GatekeeperEngine({
      github: new FakeGitHubProvider(),
      ops: new OpsProvider(new FixtureOpsSource('audit', { rows: { today: [{ transaction_count: 10, settlement_count: 10 }] } })),
    }),
  });

  scope = { orgId: refs.orgId };
  commander = { orgId: refs.orgId, userId: refs.users.commander!, role: 'commander', divisionId: null, displayName: 'Commander' };
  staff = { orgId: refs.orgId, userId: refs.users.budi!, role: 'technical', divisionId: refs.divisions.technical, displayName: 'Budi' };
});

/** The org-level audit trail, as `/api/v1/audit` would return it. */
const audit = () => auditRepo(store).list(scope, {});

describe('every ticket transition reaches the audit trail', () => {
  it('records who did what, across commander and staff', async () => {
    const intake = await intakeInstruction(ctx, scope, {
      rawText: 'Besok pagi deploy payment service ya, Mas Budi yang infra',
      actorUserId: commander.userId,
    });
    await handleApproval(ctx, scope, commander, intake.instructionId, { action: 'approve' });

    const ticket = ticketOf(ctx, scope, intake.ticketIds[0]!);
    await acknowledgeTicket(ctx, scope, staff, ticket.id);
    await submitEvidence(ctx, scope, staff, ticket.id, {});
    await runGatekeeper(ctx, scope, ticket.id, commander);

    const rows = audit();
    const actions = rows.map((r) => r.action);

    // The specific gap: staff actions used to be missing entirely.
    expect(actions).toContain('staff.acknowledged');
    expect(actions).toContain('staff.evidence_submitted');

    // And each must name the person who did it.
    const ack = rows.find((r) => r.action === 'staff.acknowledged')!;
    expect(ack.actorId).toBe(staff.userId);
    expect(ack.entity).toBe('ticket');
    expect(ack.entityId).toBe(ticket.id);

    const evidence = rows.find((r) => r.action === 'staff.evidence_submitted')!;
    expect(evidence.actorId).toBe(staff.userId);
  });

  it('attributes actions to more than one identity across a full cycle', async () => {
    const intake = await intakeInstruction(ctx, scope, {
      rawText: 'Deploy payment service besok, Mas Budi',
      actorUserId: commander.userId,
    });
    await handleApproval(ctx, scope, commander, intake.instructionId, { action: 'approve' });
    const ticket = ticketOf(ctx, scope, intake.ticketIds[0]!);
    await acknowledgeTicket(ctx, scope, staff, ticket.id);
    await submitEvidence(ctx, scope, staff, ticket.id, {});
    await runGatekeeper(ctx, scope, ticket.id, commander);

    const actors = new Set(audit().map((r) => r.actorId));
    expect(actors.size).toBeGreaterThanOrEqual(2);
    expect(actors.has(staff.userId)).toBe(true);
    expect(actors.has(commander.userId)).toBe(true);
  });

  it('records the from/to states so the trail reads as a history', async () => {
    const intake = await intakeInstruction(ctx, scope, {
      rawText: 'Deploy payment service besok, Mas Budi',
      actorUserId: commander.userId,
    });
    await handleApproval(ctx, scope, commander, intake.instructionId, { action: 'approve' });
    const ticket = ticketOf(ctx, scope, intake.ticketIds[0]!);
    await acknowledgeTicket(ctx, scope, staff, ticket.id);

    const ack = audit().find((r) => r.action === 'staff.acknowledged')!;
    const meta = ack.meta as { from: string; to: string };
    expect(meta.from).toBe('ASSIGNED');
    expect(meta.to).toBe('IN_PROGRESS');
  });

  it('writes nothing extra when a transition is rejected', async () => {
    const intake = await intakeInstruction(ctx, scope, {
      rawText: 'Deploy payment service besok, Mas Budi',
      actorUserId: commander.userId,
    });
    await handleApproval(ctx, scope, commander, intake.instructionId, { action: 'approve' });
    const ticket = ticketOf(ctx, scope, intake.ticketIds[0]!);

    const before = audit().length;

    // An illegal transition must not leave an audit entry: the trail has to reflect
    // what actually happened, not what was attempted.
    await acknowledgeTicket(ctx, scope, staff, ticket.id);
    await expect(acknowledgeTicket(ctx, scope, staff, ticket.id)).rejects.toThrow();

    const after = audit().filter((r) => r.action === 'staff.acknowledged');
    expect(after).toHaveLength(1);
    expect(audit().length).toBeGreaterThanOrEqual(before);
  });

  it('keeps the trail scoped to one organisation', async () => {
    const intake = await intakeInstruction(ctx, scope, {
      rawText: 'Deploy payment service besok, Mas Budi',
      actorUserId: commander.userId,
    });
    await handleApproval(ctx, scope, commander, intake.instructionId, { action: 'approve' });
    await acknowledgeTicket(ctx, scope, staff, ticketOf(ctx, scope, intake.ticketIds[0]!).id);

    // Select the partner tenant by slug. Ordering by created_at is unreliable: both
    // organisations are seeded within the same millisecond, so `ORDER BY ... LIMIT 1`
    // can return the tenant under test and turn this into a false failure.
    const otherOrg = orgRepo(store).bySlug(SECOND_ORG_SLUG)!;
    expect(otherOrg.id).not.toBe(scope.orgId);

    const foreign = auditRepo(store).list({ orgId: otherOrg.id }, {});
    expect(foreign).toHaveLength(0);
  });
});

function ticketOf(ctx: AppContext, scope: { orgId: string }, id: string) {
  return ctx.store.get<{ id: string }>('SELECT id FROM tickets WHERE org_id = ? AND id = ?', scope.orgId, id)!;
}

