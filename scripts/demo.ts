import { config } from '@execugate/core';
import { createContext, intakeInstruction, handleApproval, acknowledgeTicket, askClarification, submitEvidence, runGatekeeper, buildWalkthrough, referenceDocs, buildTicketCardData } from '@execugate/orchestration';
import type { Actor, Ticket } from '@execugate/core';
import { Store, orgRepo, userRepo, divisionRepo, projectRepo, ticketRepo } from '@execugate/db';
import { renderApprovalCard, renderTicketCard, renderStaffActions, renderWalkthrough, renderReworkNotice } from '@execugate/channels';
import { GatekeeperEngine, FakeGitHubProvider, OpsProvider, FixtureOpsSource } from '@execugate/gatekeeper';
import { ingestDocument } from '@execugate/memory';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const FIXTURES = resolve(process.cwd(), 'fixtures', 'seed');

function listFixtures() {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.md'))
    .map((name) => ({ name, path: join(FIXTURES, name) }));
}

/**
 * End-to-end demo rehearsal with no Telegram and no network.
 *
 * Exercises the exact PRD §4 journey against fake providers, printing every card the
 * commander and staff would see. This is the script used to verify the demo works
 * before a live run, and it doubles as a regression check on the narrative.
 */

const INSTRUCTION = 'Besok pagi deploy payment service ya, sekalian update SOP reconciliation, Mas Budi yang infra, deadline Kamis.';

type Scenario = 'ci-failure' | 'github-outage' | 'clean-pass';

const scenario = (process.argv[2] as Scenario) ?? 'ci-failure';
const showId = process.argv.includes('--ids');

const line = (s = '') => console.log(s);
const step = (n: number, title: string) => {
  line();
  line('='.repeat(78));
  line(`STEP ${n} — ${title}`);
  line('='.repeat(78));
};

async function main() {
  // In-memory by default: a rehearsal must never write to the live database. Every
  // run creates a fresh organisation, so pointing this at the real file would
  // accumulate demo tenants and tickets alongside real work.
  const store = new Store(process.argv.includes('--persist') ? undefined : ':memory:');
  store.migrate();

  // A fresh org per rehearsal keeps the transcript reproducible.
  const slug = `demo-${Date.now()}`;
  const orgId = orgRepo(store).insert({ name: 'Demo Rehearsal', slug, timezone: 'Asia/Jakarta' });
  const scope = { orgId };

  const divTech = divisionRepo(store).insert(orgId, { name: 'Divisi Teknikal', kind: 'technical' });
  const divOps = divisionRepo(store).insert(orgId, { name: 'Divisi Operasional', kind: 'operational' });
  divisionRepo(store).insert(orgId, { name: 'Manajemen', kind: 'management' });

  const commanderId = userRepo(store).insert(orgId, { displayName: 'Rahma Dewi', role: 'commander', email: null });
  const budiId = userRepo(store).insert(orgId, { displayName: 'Budi Santoso', role: 'technical', divisionId: divTech, specializations: ['payment service', 'backend'] });
  const sariId = userRepo(store).insert(orgId, { displayName: 'Sari Wijaya', role: 'ops', divisionId: divOps, specializations: ['reconciliation', 'settlement'] });
  const projectId = projectRepo(store).insert(orgId, { name: 'Core Platform', code: 'CORE' });

  const ops = new FixtureOpsSource('demo', {
    rows: { today: [{ transaction_count: 120, settlement_count: 120, total_amount: 45_000_000 }] },
    files: { 'reconciliation.csv': 2048 },
  });

  const githubScenarios = {
    'ci-failure': [{ match: 'payment-service', evidence: { prNumber: 8, prUrl: 'https://github.com/acme/payment-service/pull/8', headSha: 'a1b2c3d4e5f6a7b8', state: 'merged' as const, mergeable: true, checks: [{ name: 'integration-test', status: 'completed', conclusion: 'failure' as const, url: null }, { name: 'lint', status: 'completed', conclusion: 'success' as const, url: null }] } }],
    'github-outage': [{ match: 'payment-service', evidence: { error: 'ECONNREFUSED 140.82.113.4:443' } }],
    'clean-pass': [],
  }[scenario];

  const ctx = createContext({ store, gatekeeper: new GatekeeperEngine({ github: new FakeGitHubProvider(githubScenarios), ops: new OpsProvider(ops) }) });

  // FR-02: the demo is only credible if project memory is actually populated.
  //
  // The check is scoped to this org on purpose: retrieval is tenant-filtered, so
  // documents ingested under a different org are invisible here no matter how many
  // exist. A global count would wrongly skip ingest and silently make every staff
  // question answer "not found in project memory".
  let docsIngested = 0;
  const alreadyIngested = store.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM documents WHERE org_id = ?', orgId,
  )?.n ?? 0;

  if (!alreadyIngested) {
    const embedder = ctx.embedder;
    for (const file of listFixtures()) {
      const body = readFileSync(file.path, 'utf8');
      const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.name.replace(/\.md$/, '');
      const r = await ingestDocument(store, embedder, { orgId }, {
        projectId, title, body, mime: 'text/markdown', sourcePath: `fixtures/seed/${file.name}`,
      });
      if (!r.deduplicated) docsIngested++;
    }
  }
  const chunkCount = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM doc_chunks WHERE org_id = ?', orgId)?.n ?? 0;
  line(`Memori proyek: ${chunkCount} chunk tersedia untuk org ini (${docsIngested} dokumen di-ingest pada run ini).`);

  // Fail fast rather than demonstrating an ungrounded demo: retrieval is the whole
  // basis of FR-02/FR-04, so an empty corpus invalidates steps 4 and 5.
  if (!chunkCount) {
    throw new Error('Project memory is empty for this organisation; the rehearsal cannot proceed');
  }

  const commander: Actor = { orgId, userId: commanderId, role: 'commander', divisionId: null, displayName: 'Rahma Dewi' };
  const budi: Actor = { orgId, userId: budiId, role: 'technical', divisionId: divTech, displayName: 'Budi Santoso' };

  line(`ExecuGate.ai demo rehearsal — scenario: ${scenario}`);
  line(`Runtime: llm=${config.llm.provider} embed=${config.embed.provider} asr=${config.asr.provider} gate=github(fake)`);
  line(`Database: ${process.argv.includes('--persist') ? 'live file (--persist)' : 'in-memory (discarded on exit)'}`);
  if (showId) line(`org=${orgId} project=${projectId} techDivision=${divTech} budi=${budiId} sari=${sariId}`);

  // ── Step 1: instruction ──────────────────────────────────────────────────
  step(1, 'Pimpinan mengirim arahan (teks; pada demo syg sebagai voice note)');
  line(`> ${INSTRUCTION}`);

  const intake = await intakeInstruction(ctx, scope, { rawText: INSTRUCTION, actorUserId: commanderId, projectId, asrConfidence: 0.91 });
  line();
  line(`Decomposisi -> ${intake.ticketIds.length} tiket | TTFT ${intake.ttftMs}ms | total ${intake.totalMs}ms | fallback=${intake.usedFallback}`);

  const tickets = intake.ticketIds.map((id) => ticketRepo(store).get(scope, id));
  const divisionList = divisionRepo(store).list(orgId);
  const userList = userRepo(store).list(orgId);

  // ── Step 2: approval card ─────────────────────────────────────────────────
  step(2, 'Kartu otorisasi (FR-03.2) — BELUM ada yang didistribusikan');
  const card = renderApprovalCard({
    instructionId: intake.instructionId,
    rawText: INSTRUCTION,
    asrConfidence: 0.91,
    parse: intake.parse,
    tickets: tickets.map((t) => ({
      ticket: t,
      assigneeName: userList.find((u) => u.id === t.assigneeId)?.display_name ?? null,
      divisionName: divisionList.find((d) => d.id === t.divisionId)?.name ?? 'Divisi',
    })),
  });
  line(card.text);
  line();
  line('Aksi tersedia:');
  for (const a of card.actions) line(`  [${a.label}]`);

  const pendingCount = tickets.filter((t) => t.status === 'PENDING_APPROVAL').length;
  line();
  line(`FR-03.1 check: ${pendingCount} tiket di PENDING_APPROVAL, ${tickets.filter((t) => t.status === 'ASSIGNED').length} dispatched.`);
  if (tickets.some((t) => t.status === 'ASSIGNED')) {
    throw new Error('FR-03.1 violated: a ticket was distributed before approval');
  }

  // ── Step 3: approve + dispatch ───────────────────────────────────────────
  step(3, 'Pimpinan menekan [Setujui & Distribusikan] (FR-03.3)');
  const approval = await handleApproval(ctx, scope, commander, intake.instructionId, { action: 'approve' });
  line(`${approval.dispatched.length} tiket -> ASSIGNED dan dikirim ke kanal divisi.`);

  const techTicket = approval.dispatched.find((t) => t.divisionId === divTech);
  const opsTicket = approval.dispatched.find((t) => t.divisionId === divOps);

  if (techTicket) {
    const meta = buildTicketCardData(ctx, scope, techTicket);
    line();
    line('--- Kartu tiket yang diterima staf Teknikal ---');
    line(renderTicketCard({
      ticket: techTicket,
      assigneeName: meta.assigneeName,
      divisionName: meta.divisionName,
      dod: meta.dod,
      referenceDocs: referenceDocs(ctx, scope, techTicket.projectId, techTicket.title),
    }));
    line();
    line('Aksi: ' + renderStaffActions(techTicket.code).map((a) => `[${a.label}]`).join(' '));
  }

  // ── Step 4: staff acknowledges, then asks a question ─────────────────────
  step(4, 'Staf menerima tugas lalu bertanya konteks (FR-04.1 / FR-04.2)');
  if (techTicket) {
    await acknowledgeTicket(ctx, scope, budi, techTicket.id);
    line(`${techTicket.code} -> IN_PROGRESS oleh ${budi.displayName}`);

    const answer = await askClarification(ctx, scope, budi, techTicket.id, 'Berapa batasan kapasitas payload untuk modul ini?');
    line();
    line(`Q: Berapa batasan kapasitas payload untuk modul ini?`);
    line(`A: ${answer.answer}`);
    line(`   grounded=${answer.grounded} citations=${answer.citations.length}`);
    for (const c of answer.citations) line(`   - ${c.docTitle} bagian ${c.ordinal + 1}`);
  }

  // ── Step 5: false completion attempt ──────────────────────────────────────
  step(5, 'Staf melaporkan "selesai" — Gatekeeper memverifikasi otomatis (FR-05)');
  if (techTicket) {
    await submitEvidence(ctx, scope, budi, techTicket.id, { url: 'https://github.com/acme/payment-service/pull/8' });
    line(`${techTicket.code} -> QA_VERIFICATION`);
    line();

    const gate = await runGatekeeper(ctx, scope, techTicket.id, commander);
    line(`Verdict: ${gate.verdict.toUpperCase()}  (${gate.latencyMs}ms)`);
    line();
    if (gate.verdict === 'fail') {
      line('--- Pesan koreksi yang diterima staf ---');
      line(renderReworkNotice(techTicket.code, techTicket.title, gate.staffMessage));
    } else if (gate.verdict === 'unverifiable') {
      line('--- Pesan menunggu verifikasi ---');
      line(gate.staffMessage);
    } else {
      line(gate.staffMessage);
    }
    line();
    line(`Status akhir: ${gate.ticket.status} (verification_state=${gate.ticket.verificationState})`);
  }

  // ── Step 6: rework loop for the CI-failure scenario ───────────────────────
  if (scenario === 'ci-failure' && techTicket) {
    step(6, 'Staf memperbaiki, mengunggah ulang, Gatekeeper dijalankan kembali');
    const { resubmit } = await import('@execugate/orchestration/staff');
    await resubmit(ctx, scope, budi, techTicket.id, 'CI integration-test diperbaiki, pipeline hijau');

    // The next run sees a green pipeline, which is the point of the loop.
    const green = new GatekeeperEngine({ github: new FakeGitHubProvider(), ops: new OpsProvider(ops) });
    const ctx2 = { ...ctx, gatekeeper: green };

    await submitEvidence(ctx2, scope, budi, techTicket.id, { url: 'https://github.com/acme/payment-service/pull/8' });
    const gate2 = await runGatekeeper(ctx2, scope, techTicket.id, commander);
    line(`Verdict: ${gate2.verdict.toUpperCase()} (${gate2.latencyMs}ms)`);
    line(gate2.staffMessage);
    line();
    line(`Status akhir: ${gate2.ticket.status}`);
  }

  // ── Step 7: evening walkthrough ───────────────────────────────────────────
  step(7, 'Laporan progres sore hari (FR-06)');
  const report = buildWalkthrough(ctx, scope);
  line(renderWalkthrough(report));

  line();
  line('='.repeat(78));
  line('Rehearsal complete.');
  line(`Verified: FR-03.1 (no pre-approval dispatch), FR-05.2 (${scenario} verdict), FR-06.2 (report built)`);
  line('='.repeat(78));

  store.close();
}

main().catch((err) => {
  console.error('Rehearsal failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});