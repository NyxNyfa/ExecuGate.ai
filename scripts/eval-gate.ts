import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, seedCore } from '@execugate/db';
import { GatekeeperEngine, FakeGitHubProvider, OpsProvider, FixtureOpsSource, reworkMessage } from '@execugate/gatekeeper';
import type { CheckOutcome, DodCriterion } from '@execugate/core';

/**
 * Gatekeeper evaluation.
 *
 * Two purposes:
 *  1. Correctness — every scenario must produce the intended verdict, and every
 *     rejection must name the specific artefact (FR-05.2), never a generic failure.
 *  2. Latency — p95 against the 2 s NFR §8.1 budget, including an injected slow
 *     provider to prove the timeout path yields `unverifiable` rather than hanging.
 */

const HEALTHY = {
  state: 'merged' as const,
  prNumber: 7,
  prUrl: 'https://github.com/acme/payment-service/pull/7',
  headSha: 'a1b2c3d4e5f6a7b8',
  mergeable: true,
  checks: [
    { name: 'lint', status: 'completed', conclusion: 'success', url: null },
    { name: 'unit-test', status: 'completed', conclusion: 'success', url: null },
    { name: 'integration-test', status: 'completed', conclusion: 'success', url: null },
    { name: 'security-scan', status: 'completed', conclusion: 'success', url: null },
    { name: 'build-image', status: 'completed', conclusion: 'success', url: null },
  ],
};

const prCheck: DodCriterion['check'] = {
  type: 'github_pr', repo: 'acme/payment-service', branch: 'feat/x',
  requireMerged: true, requireCiGreen: true, requireNoConflicts: true,
};

let seq = 0;
function crit(check: DodCriterion['check'], label = 'kriteria'): DodCriterion {
  return { id: `d${++seq}`, orgId: 'o', ticketId: 't', kind: 'engineering', label, required: true, check, position: 0 };
}

function stats(values: number[]) {
  if (!values.length) return { n: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  return { n: sorted.length, p50: at(50), p95: at(95), max: sorted[sorted.length - 1]! };
}

async function main() {
  interface Scenario {
    id: string;
    expect: 'pass' | 'fail' | 'unverifiable';
    github?: ConstructorParameters<typeof FakeGitHubProvider>[0];
    criteria?: DodCriterion[];
    /** Substring the staff-facing message must contain. */
    messageMustMention?: string;
  }

  /**
   * Mismatched settlement figures, so a reconciliation verdict has something real to
   * catch. A matching dataset would let a check that silently verifies nothing still
   * report "pass", which is the failure mode this scenario exists to prevent.
   */
  const ops = new FixtureOpsSource('eval', {
    rows: {
      '2026-10-01': [{ transaction_count: 120, settlement_count: 118, total_amount: 45_000_000 }],
      matching: [{ transaction_count: 120, settlement_count: 120, total_amount: 45_000_000 }],
    },
    files: { 'reconciliation.csv': 2048, 'empty.pdf': 0 },
  });

  const scenarios: Scenario[] = [
    { id: 'healthy-merged-pr', expect: 'pass', github: [{ match: 'payment-service', evidence: HEALTHY }] },
    {
      id: 'ci-red', expect: 'fail',
      github: [{ match: 'payment-service', evidence: { ...HEALTHY, checks: [{ name: 'integration-test', status: 'completed', conclusion: 'failure', url: null }] } }],
      messageMustMention: 'integration-test',
    },
    {
      id: 'ci-pending', expect: 'fail',
      github: [{ match: 'payment-service', evidence: { ...HEALTHY, checks: [{ name: 'security-scan', status: 'in_progress', conclusion: null, url: null }] } }],
      messageMustMention: 'security-scan',
    },
    {
      id: 'pr-open', expect: 'fail',
      github: [{ match: 'payment-service', evidence: { ...HEALTHY, state: 'open' } }],
      messageMustMention: 'belum ter-merge',
    },
    {
      id: 'merge-conflict', expect: 'fail',
      github: [{ match: 'payment-service', evidence: { ...HEALTHY, mergeable: false } }],
      messageMustMention: 'konflik',
    },
    {
      id: 'no-pr', expect: 'fail',
      github: [{ match: 'payment-service', evidence: { state: 'not_found' } }],
      messageMustMention: 'Pull Request',
    },
    {
      id: 'github-outage', expect: 'unverifiable',
      github: [{ match: 'payment-service', evidence: { error: 'ECONNREFUSED' } }],
      messageMustMention: 'tidak dapat dihubungi',
    },
    {
      id: 'doc-missing', expect: 'fail',
      criteria: [crit({ type: 'document_present', path: 'tidak-ada.pdf', minBytes: 1 }, 'Dokumen wajib')],
      messageMustMention: 'tidak-ada.pdf',
    },
    {
      id: 'doc-empty', expect: 'fail',
      criteria: [crit({ type: 'document_present', path: 'empty.pdf', minBytes: 1 }, 'Dokumen wajib')],
      messageMustMention: '0 byte',
    },
    {
      id: 'recon-mismatch', expect: 'fail',
      criteria: [crit({ type: 'reconciliation', source: 'sheets', key: '2026-10-01', expectedField: 'transaction_count', actualField: 'settlement_count', tolerance: 0.01 }, 'Rekonsiliasi')],
      messageMustMention: 'selisih',
    },
    {
      id: 'recon-matching', expect: 'pass',
      criteria: [crit({ type: 'reconciliation', source: 'sheets', key: 'matching', expectedField: 'transaction_count', actualField: 'settlement_count', tolerance: 0.01 }, 'Rekonsiliasi')],
    },
    {
      id: 'manual-review-only', expect: 'unverifiable',
      criteria: [crit({ type: 'manual_review', reviewerRole: 'commander' }, 'Persetujuan dokumen')],
    },
  ];

  console.log('Gatekeeper evaluation — FR-05.1 / FR-05.2 / NFR §8.1');
  console.log('='.repeat(70));

  const latencies: number[] = [];
  let failures = 0;

  for (const scenario of scenarios) {
    const engine = new GatekeeperEngine({
      github: new FakeGitHubProvider(scenario.github ?? []),
      ops: new OpsProvider(ops),
    });
    const criteria = scenario.criteria ?? [crit(prCheck, 'PR ter-merge dan CI hijau')];

    const started = performance.now();
    const result = await engine.verifyTicket(criteria);
    const elapsed = Math.round(performance.now() - started);
    latencies.push(elapsed);

    const ok = result.verdict === scenario.expect;
    const message = reworkMessage(result);
    const mentions = !scenario.messageMustMention || message.includes(scenario.messageMustMention);

    if (!ok || !mentions) failures++;

    console.log(`[${ok && mentions ? 'PASS' : 'FAIL'}] ${scenario.id.padEnd(22)} verdict=${result.verdict.padEnd(13)} ${String(elapsed).padStart(4)}ms  msg=${result.messageId ?? '-'}`);
    if (!ok) console.log(`         expected verdict ${scenario.expect}, got ${result.verdict}`);
    if (!mentions) console.log(`         message did not mention "${scenario.messageMustMention}": ${message.replace(/\n/g, ' | ')}`);
  }

  // ── Timeout behaviour ──────────────────────────────────────────────────────
  const slow = {
    configured: true,
    verify: (): Promise<CheckOutcome> => new Promise((r) => setTimeout(() => r({ type: 'github_pr', ok: true, detail: 'late', latencyMs: 0 }), 3000)),
  };
  const slowEngine = new GatekeeperEngine({ github: slow as never, timeoutMs: 200 });
  const t0 = performance.now();
  const slowResult = await slowEngine.verifyTicket([crit(prCheck)]);
  const slowMs = Math.round(performance.now() - t0);
  const timeoutOk = slowResult.verdict === 'unverifiable' && slowMs < 1000;
  if (!timeoutOk) failures++;
  console.log(`[${timeoutOk ? 'PASS' : 'FAIL'}] ${'provider-timeout'.padEnd(22)} verdict=${slowResult.verdict.padEnd(13)} ${String(slowMs).padStart(4)}ms  (abandoned at deadline, not awaited)`);

  // ── Latency ────────────────────────────────────────────────────────────────
  const s = stats(latencies);
  const budget = 2000;
  const latencyOk = s.p95 <= budget;
  if (!latencyOk) failures++;

  console.log('='.repeat(70));
  console.log(`Scenarios      : ${scenarios.length + 1}`);
  console.log(`Failures       : ${failures}`);
  console.log(`Latency p50/p95: ${s.p50}ms / ${s.p95}ms (budget ${budget}ms) -> ${latencyOk ? 'PASS' : 'OVER BUDGET'}`);
  console.log('='.repeat(70));

  const report = {
    kind: 'gatekeeper',
    at: new Date().toISOString(),
    scenarios: scenarios.length + 1,
    failures,
    latency: s,
    budget_ms: budget,
    latency_ok: latencyOk,
    timeout_ok: timeoutOk,
  };

  // In-memory: the JSON artifact is the durable record of a run. Recording it in the
  // live database as well meant an evaluation mutated the thing it measures.
  const store = new Store(':memory:');
  store.migrate();
  const orgId = seedCore(store).orgId;
  mkdirSync(resolve(process.cwd(), 'artifacts'), { recursive: true });
  writeFileSync(resolve(process.cwd(), 'artifacts', 'gatekeeper.json'), JSON.stringify(report, null, 2));
  console.log('Wrote artifacts/gatekeeper.json');
  store.close();

  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Gatekeeper evaluation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});