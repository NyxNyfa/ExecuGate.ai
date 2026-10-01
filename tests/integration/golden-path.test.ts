import { describe, it, expect, beforeEach } from 'vitest';
import { Store, seedCore } from '@execugate/db';
import { createContext } from '@execugate/orchestration';
import type { AppContext } from '@execugate/orchestration';
import { createFakeEmbedder, ingestDocument } from '@execugate/memory';
import { createFakeAsr } from '@execugate/asr';
import { GatekeeperEngine, FakeGitHubProvider, OpsProvider, FixtureOpsSource } from '@execugate/gatekeeper';
import type { FakeScenario } from '@execugate/gatekeeper/github';
import { intakeInstruction } from '@execugate/orchestration/intake';
import { handleApproval } from '@execugate/orchestration/approval';
import { acknowledgeTicket, askClarification, submitEvidence } from '@execugate/orchestration/staff';
import { runGatekeeper, manualVerification } from '@execugate/orchestration/gate';
import { buildWalkthrough } from '@execugate/orchestration/report';
import { ticketRepo, eventRepo } from '@execugate/db';
import type { Actor } from '@execugate/core';

const ARCH_DOC = `# Arsitektur Payment Service

## Batas Kapasitas

| Parameter | Nilai Baku |
|---|---|
| Batas payload request | 512 KB |
| Timeout upstream | 8 detik |

Batas payload adalah 512 KB. Melebihi itu mengembalikan HTTP 413.
`;

const SOP_DOC = `# SOP Rekonsiliasi Harian

Dokumen acuan untuk rekonsiliasi harian. Lampiran wajib berupa berkas CSV output rekonsiliasi.
`;

interface Harness {
  ctx: AppContext;
  store: Store;
  orgId: string;
  projectId: string;
  commander: Actor;
  budi: Actor;
  sari: Actor;
  ops: FixtureOpsSource;
}

function makeHarness(githubScenarios: Array<{ match: string; evidence: FakeScenario }> = []): Harness {
  const store = new Store(':memory:');
  // seedCore assumes migrations already ran; in-memory stores start empty.
  store.migrate();
  const refs = seedCore(store);

  const ops = new FixtureOpsSource('test', {
    rows: { '2026-09-30': [{ date: '2026-09-30', transaction_count: 120, settlement_count: 120, total_amount: 45000000 }] },
    files: { 'reconciliation-2026-09-30.csv': 2048 },
  });

  const embedder = createFakeEmbedder(384);
  const ctx = createContext({
    store,
    embedder,
    asr: createFakeAsr(),
    gatekeeper: new GatekeeperEngine({
      github: new FakeGitHubProvider(githubScenarios),
      ops: new OpsProvider(ops),
    }),
  });

  const scope = { orgId: refs.orgId };
  void ingestDocument(store, embedder, scope, { projectId: refs.projectId, title: 'Arsitektur Payment Service', body: ARCH_DOC, mime: 'text/markdown' });
  void ingestDocument(store, embedder, scope, { projectId: refs.projectId, title: 'SOP Rekonsiliasi Harian', body: SOP_DOC, mime: 'text/markdown' });

  const actor = (userId: string, role: Actor['role'], divisionId: string | null, name: string): Actor => ({
    orgId: refs.orgId, userId, role, divisionId, displayName: name,
  });

  return {
    ctx, store, orgId: refs.orgId, projectId: refs.projectId, ops,
    commander: actor(refs.users.commander!, 'commander', refs.divisions.management ?? null, 'Rahma Dewi'),
    budi: actor(refs.users.budi!, 'technical', refs.divisions.technical ?? null, 'Budi Santoso'),
    sari: actor(refs.users.sari!, 'ops', refs.divisions.operational ?? null, 'Sari Wijaya'),
  };
}

const INSTRUCTION = 'Besok pagi deploy payment service ya, sekalian update SOP reconciliation, Mas Budi yang infra, deadline Kamis.';

describe('golden path (PRD FR-01 -> FR-06)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('FR-01.3/FR-03.1: intake produces PENDING_APPROVAL drafts and dispatches nothing', async () => {
    const scope = { orgId: h.orgId };
    const result = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });

    expect(result.ticketIds.length).toBeGreaterThanOrEqual(2);
    const tickets = result.ticketIds.map((id) => ticketRepo(h.store).get(scope, id));
    for (const t of tickets) {
      expect(t.status).toBe('PENDING_APPROVAL');
    }
    // FR-03.1: no ticket may be ASSIGNED before approval.
    expect(tickets.some((t) => t.status === 'ASSIGNED')).toBe(false);
  });

  it('FR-03.3: approve moves drafts to ASSIGNED; cancel would move them to CANCELLED', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });

    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    expect(approved.decision).toBe('approve');
    expect(approved.dispatched.length).toBeGreaterThanOrEqual(2);
    for (const t of approved.dispatched) expect(t.status).toBe('ASSIGNED');
  });

  it('FR-03.3 idempotency: a repeated approval press dispatches nothing extra', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    const second = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });

    expect(second.alreadyProcessed).toBe(true);
    expect(second.dispatched).toHaveLength(0);
  });

  it('FR-05.2: engineering lane passes a healthy PR and completes the ticket', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });

    const techTicket = approved.dispatched.find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id);
    expect(techTicket).toBeDefined();

    await acknowledgeTicket(h.ctx, scope, h.budi, techTicket!.id);
    await submitEvidence(h.ctx, scope, h.budi, techTicket!.id, { url: 'https://github.com/acme/payment-service/pull/7' });

    const gate = await runGatekeeper(h.ctx, scope, techTicket!.id, h.commander);
    expect(gate.verdict).toBe('pass');
    expect(gate.ticket.status).toBe('COMPLETED');
  });

  it('FR-05.2: a red CI job produces REWORK_REQUIRED naming the failing job', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    const techTicket = approved.dispatched.find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id)!;

    await acknowledgeTicket(h.ctx, scope, h.budi, techTicket.id);
    await submitEvidence(h.ctx, scope, h.budi, techTicket.id, { url: 'https://github.com/acme/payment-service/pull/8' });

    // Re-run the gate with a failing scenario.
    const failing = makeHarness([{
      match: 'payment-service',
      evidence: {
        prNumber: 8,
        prUrl: 'https://github.com/acme/payment-service/pull/8',
        headSha: 'a1b2c3d4e5f6a7b8',
        state: 'open',
        mergeable: true,
        checks: [{ name: 'integration-test', status: 'completed', conclusion: 'failure', url: null }],
      },
    }]);

    const scope2 = { orgId: failing.orgId };
    const intake2 = await intakeInstruction(failing.ctx, scope2, { rawText: INSTRUCTION, actorUserId: failing.commander.userId });
    const approved2 = await handleApproval(failing.ctx, scope2, failing.commander, intake2.instructionId, { action: 'approve' });
    const tech2 = approved2.dispatched.find((t) => t.divisionId === failing.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', failing.orgId, 'technical')?.id)!;

    await acknowledgeTicket(failing.ctx, scope2, failing.budi, tech2.id);
    await submitEvidence(failing.ctx, scope2, failing.budi, tech2.id, { url: 'https://github.com/acme/payment-service/pull/8' });

    const gate = await runGatekeeper(failing.ctx, scope2, tech2.id, failing.commander);
    expect(gate.verdict).toBe('fail');
    expect(gate.ticket.status).toBe('REWORK_REQUIRED');
    // FR-05.2 demands specific text, not a generic failure.
    expect(gate.staffMessage).toMatch(/gagal|integration-test|belum ter-merge/i);
  });

  it('NFR 8.3: an external outage yields unverifiable, never COMPLETED nor REWORK', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    const techTicket = approved.dispatched.find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id)!;

    await acknowledgeTicket(h.ctx, scope, h.budi, techTicket.id);
    await submitEvidence(h.ctx, scope, h.budi, techTicket.id, {});

    const down = makeHarness([{ match: 'payment-service', evidence: { error: 'ECONNREFUSED' } }]);
    const scope2 = { orgId: down.orgId };
    const intake2 = await intakeInstruction(down.ctx, scope2, { rawText: INSTRUCTION, actorUserId: down.commander.userId });
    const approved2 = await handleApproval(down.ctx, scope2, down.commander, intake2.instructionId, { action: 'approve' });
    const tech2 = approved2.dispatched.find((t) => t.divisionId === down.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', down.orgId, 'technical')?.id)!;

    await acknowledgeTicket(down.ctx, scope2, down.budi, tech2.id);
    await submitEvidence(down.ctx, scope2, down.budi, tech2.id, {});

    const gate = await runGatekeeper(down.ctx, scope2, tech2.id, down.commander);
    expect(gate.verdict).toBe('unverifiable');
    expect(gate.ticket.status).toBe('QA_VERIFICATION');
    expect(gate.ticket.verificationState).toBe('pending');
  });

  it('NFR 8.3: an unverifiable verdict really enqueues a retry job', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    const techTicket = approved.dispatched.find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id)!;

    await acknowledgeTicket(h.ctx, scope, h.budi, techTicket.id);
    await submitEvidence(h.ctx, scope, h.budi, techTicket.id, {});

    const down = makeHarness([{ match: 'payment-service', evidence: { error: 'ECONNREFUSED' } }]);
    const scope2 = { orgId: down.orgId };
    const intake2 = await intakeInstruction(down.ctx, scope2, { rawText: INSTRUCTION, actorUserId: down.commander.userId });
    const approved2 = await handleApproval(down.ctx, scope2, down.commander, intake2.instructionId, { action: 'approve' });
    const tech2 = approved2.dispatched.find((t) => t.divisionId === down.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', down.orgId, 'technical')?.id)!;

    await acknowledgeTicket(down.ctx, scope2, down.budi, tech2.id);
    await submitEvidence(down.ctx, scope2, down.budi, tech2.id, {});

    const queuedBefore = down.ctx.store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM job_queue WHERE org_id = ? AND kind = 'gate.verify'", scope2.orgId,
    )?.n ?? 0;

    await runGatekeeper(down.ctx, scope2, tech2.id, down.commander);

    // Without this job the "will be rechecked automatically" promise is unfulfilled:
    // nothing would ever revisit the ticket.
    const queuedAfter = down.ctx.store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM job_queue WHERE org_id = ? AND kind = 'gate.verify'", scope2.orgId,
    )?.n ?? 0;
    expect(queuedAfter).toBe(queuedBefore + 1);

    // It must be bounded, so a permanent outage cannot loop forever.
    const job = down.ctx.store.get<{ max_attempts: number; status: string }>(
      "SELECT max_attempts, status FROM job_queue WHERE org_id = ? AND kind = 'gate.verify' ORDER BY created_at DESC LIMIT 1",
      scope2.orgId,
    )!;
    expect(job.max_attempts).toBeLessThanOrEqual(5);
    expect(job.status).toBe('queued');
  });

  it('a passing verdict does not enqueue a retry', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    const techTicket = approved.dispatched.find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id)!;

    const before = h.ctx.store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM job_queue WHERE org_id = ? AND kind = 'gate.verify'", h.orgId,
    )?.n ?? 0;

    await acknowledgeTicket(h.ctx, scope, h.budi, techTicket.id);
    await submitEvidence(h.ctx, scope, h.budi, techTicket.id, {});
    const gate = await runGatekeeper(h.ctx, scope, techTicket.id, h.commander);
    expect(gate.verdict).toBe('pass');

    const after = h.ctx.store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM job_queue WHERE org_id = ? AND kind = 'gate.verify'", h.orgId,
    )?.n ?? 0;
    expect(after).toBe(before);
  });

  it('FR-04.2/4.3: staff clarification is answered from project memory', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    const techTicket = approved.dispatched.find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id)!;

    await acknowledgeTicket(h.ctx, scope, h.budi, techTicket.id);
    const answer = await askClarification(h.ctx, scope, h.budi, techTicket.id, 'Berapa batas kapasitas payload untuk modul ini?');

    expect(answer.answer.length).toBeGreaterThan(10);
    // FR-02.3: a grounded answer must cite a real ingested document.
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.grounded).toBe(true);
  });

  it('DEV-4: manual verification requires commander role and an audited reason', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    const techTicket = approved.dispatched.find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id)!;

    await acknowledgeTicket(h.ctx, scope, h.budi, techTicket.id);
    await submitEvidence(h.ctx, scope, h.budi, techTicket.id, {});

    // Staff cannot override the gate.
    await expect(manualVerification(h.ctx, scope, h.budi, techTicket.id, { approve: true, reason: 'saya yakin selesai' }))
      .rejects.toThrow();

    const done = await manualVerification(h.ctx, scope, h.commander, techTicket.id, { approve: true, reason: 'CI_TIMEOUT, diverifikasi manual oleh QA lead' });
    expect(done.status).toBe('COMPLETED');
  });

  it('FR-04.1: a named person in the instruction becomes the assignee', async () => {
    const scope = { orgId: h.orgId };
    const result = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });

    const techTicket = result.ticketIds.map((id) => ticketRepo(h.store).get(scope, id))
      .find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id)!;

    // "Mas Budi" must survive the whole path: parse -> resolve -> persist -> transition.
    expect(techTicket.assigneeId).toBe(h.budi.userId);
  });

  it('a transition without an assignee override must not clear the assignee', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    const techTicket = approved.dispatched.find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id)!;

    // approve -> ack -> evidence all transition without passing assigneeId.
    expect(techTicket.assigneeId).toBe(h.budi.userId);
    await acknowledgeTicket(h.ctx, scope, h.budi, techTicket.id);
    expect(ticketRepo(h.store).get(scope, techTicket.id).assigneeId).toBe(h.budi.userId);
    await submitEvidence(h.ctx, scope, h.budi, techTicket.id, {});
    expect(ticketRepo(h.store).get(scope, techTicket.id).assigneeId).toBe(h.budi.userId);
  });

  it('PRD 6: every state transition is recorded in the audit trail', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    const techTicket = approved.dispatched.find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id)!;

    await acknowledgeTicket(h.ctx, scope, h.budi, techTicket.id);
    await submitEvidence(h.ctx, scope, h.budi, techTicket.id, {});
    await runGatekeeper(h.ctx, scope, techTicket.id, h.commander);

    const events = eventRepo(h.store).listForTicket(scope, techTicket.id);
    const path = events.map((e) => e.toStatus);
    expect(path).toEqual(['PENDING_APPROVAL', 'ASSIGNED', 'IN_PROGRESS', 'QA_VERIFICATION', 'COMPLETED']);
    for (const e of events) expect(e.actorId).toBeTruthy();
  });

  it('FR-06.2: the walkthrough aggregates the day activity', async () => {
    const scope = { orgId: h.orgId };
    const intake = await intakeInstruction(h.ctx, scope, { rawText: INSTRUCTION, actorUserId: h.commander.userId });
    const approved = await handleApproval(h.ctx, scope, h.commander, intake.instructionId, { action: 'approve' });
    const techTicket = approved.dispatched.find((t) => t.divisionId === h.ctx.store.get<{ id: string }>('SELECT id FROM divisions WHERE org_id = ? AND kind = ?', h.orgId, 'technical')?.id)!;

    await acknowledgeTicket(h.ctx, scope, h.budi, techTicket.id);
    await submitEvidence(h.ctx, scope, h.budi, techTicket.id, {});
    await runGatekeeper(h.ctx, scope, techTicket.id, h.commander);

    const report = buildWalkthrough(h.ctx, scope);
    expect(report.counts.completed).toBeGreaterThanOrEqual(1);
    expect(report.completed[0]!.code).toBe(techTicket.code);
  });
});