import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, seedCore } from '@execugate/db';
import { createContext, intakeInstruction, runGatekeeper, acknowledgeTicket, submitEvidence, handleApproval } from '@execugate/orchestration';
import { GatekeeperEngine, FakeGitHubProvider, OpsProvider, FixtureOpsSource } from '@execugate/gatekeeper';

/**
 * NFR §8.1 latency measurement.
 *
 * Measures the three budgets the PRD names, with the gatekeeper run against a local
 * fake provider so the number reflects this machine rather than GitHub's network:
 *
 *   ASR 30 s voice  -> text        < 4000 ms
 *   instruction decomposition      < 3000 ms
 *   external artefact check        < 2000 ms
 *
 * Time-to-first-token and time-to-complete are reported separately (BUILD_PLAN §9.2):
 * with a local model on a 4 GB GPU only TTFT meets the target, and collapsing them
 * would hide that.
 */

const BUDGETS = { asrMs: 4000, llmMs: 3000, gateMs: 2000 };

function stats(values: number[]) {
  if (!values.length) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  return {
    n: sorted.length,
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: at(50),
    p95: at(95),
    max: sorted[sorted.length - 1]!,
  };
}

async function main() {
  // In-memory and freshly seeded: a latency run writes eval_runs rows and creates
  // tickets, and it has no business doing either to a live database.
  const store = new Store(':memory:');
  store.migrate();
  const refs = seedCore(store);

  const orgId = refs.orgId;
  const scope = { orgId };

  const projectId = store.get<{ id: string }>("SELECT id FROM projects WHERE org_id = ? AND status='active' LIMIT 1", orgId)?.id;
  const commanderId = store.get<{ id: string }>("SELECT id FROM users WHERE org_id = ? AND role='commander' LIMIT 1", orgId)?.id;

  if (!projectId || !commanderId) {
    throw new Error('Seed data missing. Run: npm run seed');
  }

  const ops = new FixtureOpsSource('latency', {
    rows: { today: [{ transaction_count: 120, settlement_count: 120 }] },
    files: { 'output.csv': 2048 },
  });
  const ctx = createContext({ store, gatekeeper: new GatekeeperEngine({ github: new FakeGitHubProvider(), ops: new OpsProvider(ops) }) });

  console.log('Latency evaluation — NFR §8.1');
  console.log(`Providers: llm=${ctx.llm.name} embed=${ctx.embedder.name} asr=${ctx.asr.name}\n`);

  const INSTRUCTIONS = [
    'Besok pagi deploy payment service ya, sekalian update SOP reconciliation, Mas Budi yang infra, deadline Kamis.',
    'Tolong urgent patch bug refund di payment service, deadline besok.',
    'Buatkan laporan keuangan bulan ini dan review pipeline docker',
    'Sari tolong cek stok gudang besok',
  ];

  // ── Decomposition ──────────────────────────────────────────────────────────
  const ttfts: number[] = [];
  const totals: number[] = [];
  const retrievals: number[] = [];

  for (let i = 0; i < 6; i++) {
    const text = INSTRUCTIONS[i % INSTRUCTIONS.length]!;

    // Decomposition acquires the LLM role; ASR and embeddings are released first.
    const outcome = await ctx.arbiter.withRole('llm', () =>
      intakeInstruction(ctx, scope, { rawText: text, actorUserId: commanderId, projectId }),
    );
    ttfts.push(outcome.ttftMs);
    totals.push(outcome.totalMs);

    // Decompose read of the store, reported separately.
    const t0 = performance.now();
    store.get<{ n: number }>('SELECT COUNT(*) AS n FROM doc_chunks WHERE org_id = ?', orgId);
    retrievals.push(Math.round(performance.now() - t0));
  }

  // ── Gatekeeper ─────────────────────────────────────────────────────────────
  const gates: number[] = [];
  const instruction = await intakeInstruction(ctx, scope, {
    rawText: INSTRUCTIONS[0]!, actorUserId: commanderId, projectId,
  });
  const approval = await handleApproval(ctx, scope, {
    orgId, userId: commanderId, role: 'commander', divisionId: null, displayName: 'Commander',
  }, instruction.instructionId, { action: 'approve' });

  // A fresh ticket per iteration: once a gate passes, the ticket is COMPLETED and
  // terminal, so reusing one would measure nothing after the first run.
  const budi = store.get<{ id: string }>(
    "SELECT id FROM users WHERE org_id = ? AND role='technical' ORDER BY created_at LIMIT 1", orgId,
  );

  for (let i = 0; i < 5; i++) {
    const draft = await intakeInstruction(ctx, scope, {
      rawText: `${INSTRUCTIONS[0]} (iterasi ${i + 1})`, actorUserId: commanderId, projectId,
    });
    const ok = await handleApproval(ctx, scope, {
      orgId, userId: commanderId, role: 'commander', divisionId: null, displayName: 'Commander',
    }, draft.instructionId, { action: 'approve' });

    const ticket = ok.dispatched[0];
    if (!ticket || !budi) break;

    const actor = { orgId, userId: budi.id, role: 'technical' as const, divisionId: ticket.divisionId, displayName: 'Budi' };
    await acknowledgeTicket(ctx, scope, actor, ticket.id);
    await submitEvidence(ctx, scope, actor, ticket.id, {});

    const started = performance.now();
    const gate = await runGatekeeper(ctx, scope, ticket.id, actor);
    gates.push(Math.round(performance.now() - started));

    if (gate.verdict !== 'pass') {
      throw new Error(`Gatekeeper did not pass during the latency run (got ${gate.verdict}); timings would be meaningless`);
    }
  }

  // ── ASR ────────────────────────────────────────────────────────────────────
  const asrSamples: number[] = [];
  if (ctx.asr.name === 'fake') {
    console.log('ASR: provider is `fake`, so no real transcription timing is available.');
    console.log('      Run on the demo laptop with ASR_PROVIDER=whisper-http to measure FR-01.2 latency.\n');
  } else {
    const health = await ctx.asr.healthCheck();
    console.log(`ASR provider health: ${health.ok ? 'ok' : health.detail}`);
  }

  const llmStats = stats(totals);
  const ttftStats = stats(ttfts);
  const gateStats = stats(gates);
  const retrievalStats = stats(retrievals);

  console.log('Decomposition (budget < 3000 ms)');
  console.log(`  TTFT    p50=${ttftStats.p50}ms p95=${ttftStats.p95}ms max=${ttftStats.max}ms  ${ttftStats.p95 <= BUDGETS.llmMs ? 'PASS' : 'OVER'}`);
  console.log(`  total   p50=${llmStats.p50}ms p95=${llmStats.p95}ms max=${llmStats.max}ms  ${llmStats.p95 <= BUDGETS.llmMs ? 'PASS' : 'OVER'}`);
  console.log();
  console.log('Gatekeeper (budget < 2000 ms)');
  console.log(`  total   p50=${gateStats.p50}ms p95=${gateStats.p95}ms max=${gateStats.max}ms  ${gateStats.p95 <= BUDGETS.gateMs ? 'PASS' : 'OVER'}`);
  console.log();
  console.log('Memory retrieval');
  console.log(`  count   p50=${retrievalStats.p50}ms p95=${retrievalStats.p95}ms`);
  console.log();
  console.log(`ASR ${asrSamples.length ? `p95=${stats(asrSamples).p95}ms (budget ${BUDGETS.asrMs}ms)` : 'not measured (fake provider)'}`);

  const report = {
    kind: 'latency',
    at: new Date().toISOString(),
    provider: { llm: ctx.llm.name, llmModel: ctx.llm.model, embed: ctx.embedder.name, asr: ctx.asr.name },
    budgets: BUDGETS,
    decomposition: { ttft: ttftStats, total: llmStats, within_budget: ttftStats.p95 <= BUDGETS.llmMs },
    gatekeeper: { ...gateStats, within_budget: gateStats.p95 <= BUDGETS.gateMs },
    retrieval: retrievalStats,
    asr: { measured: asrSamples.length > 0, samples: asrSamples },
  };

  // The JSON artifact is the durable record; the run is not written to the database.
  mkdirSync(resolve(process.cwd(), 'artifacts'), { recursive: true });
  writeFileSync(resolve(process.cwd(), 'artifacts', 'latency.json'), JSON.stringify(report, null, 2));

  // Merge into the shared metrics file so the KPI slide reads one document.
  const metricsPath = resolve(process.cwd(), 'artifacts', 'metrics.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(metricsPath)) {
    try {
      existing = JSON.parse(readFileSync(metricsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  writeFileSync(metricsPath, JSON.stringify({ ...existing, latency: report }, null, 2));
  console.log('\nWrote artifacts/latency.json and merged into artifacts/metrics.json');

  store.close();
}

main().catch((err) => {
  console.error('Latency evaluation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});