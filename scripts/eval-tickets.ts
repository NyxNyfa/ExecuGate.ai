import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, seedCore, divisionRepo, userRepo, projectRepo } from '@execugate/db';
import { createContext, loadRoster } from '@execugate/orchestration';
import { createLlmProvider } from '@execugate/llm';
import type { LlmProvider } from '@execugate/llm';
import { AppError } from '@execugate/core';

/**
 * PRD KPI §10.2 — "at least 90% of generated assignment drafts are approved by the
 * leader without rewriting the core job description".
 *
 * The measurement is structural, not subjective: for each labelled instruction we
 * check whether the produced draft matches the expected decomposition on the fields
 * a commander would have to rewrite. A draft passes when the expected tasks are all
 * present with the right division, and the priority/due-date/assignee are right
 * wherever the expectation states one.
 *
 * Output is written to artifacts/metrics.json so the number in the pitch deck is a
 * measurement rather than an assertion.
 */

interface Expectation {
  titleIncludes: string[];
  division: 'technical' | 'operational';
  assignee?: string;
  priority?: 'P0' | 'P1' | 'P2';
  dueWithinDays?: number;
}

interface Case {
  id: string;
  instruction: string;
  expect: Expectation[];
}

const FIXTURE = resolve(process.cwd(), 'fixtures', 'eval', 'instructions.json');

async function loadCases(): Promise<Case[]> {
  if (!existsSync(FIXTURE)) {
    throw new AppError('NOT_FOUND', `Missing evaluation fixture: ${FIXTURE}`);
  }
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Case[];
}

interface Draft {
  title: string;
  description: string;
  division: 'technical' | 'operational';
  assigneeHint: string | null;
  priority: string;
  dueAt: string | null;
  dod: Array<{ check: { type: string } }>;
}

function scoreDraft(testCase: Case, drafts: Draft[]): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const now = Date.now();

  for (const exp of testCase.expect) {
    const match = drafts.find((d) => exp.titleIncludes.every((needle) => d.title.toLowerCase().includes(needle.toLowerCase())));

    if (!match) {
      reasons.push(`missing task: ${exp.titleIncludes.join(' + ')}`);
      continue;
    }
    if (match.division !== exp.division) {
      reasons.push(`"${match.title}" expected ${exp.division}, got ${match.division}`);
    }
    if (exp.assignee && match.assigneeHint?.toLowerCase() !== exp.assignee.toLowerCase()) {
      reasons.push(`"${match.title}" expected assignee ${exp.assignee}, got ${match.assigneeHint ?? 'none'}`);
    }
    if (exp.priority && match.priority !== exp.priority) {
      reasons.push(`"${match.title}" expected priority ${exp.priority}, got ${match.priority}`);
    }
    if (exp.dueWithinDays !== undefined) {
      if (!match.dueAt) {
        reasons.push(`"${match.title}" expected a due date, got none`);
      } else {
        const deltaDays = Math.abs(new Date(match.dueAt).getTime() - now) / 86_400_000;
        if (deltaDays > exp.dueWithinDays) {
          reasons.push(`"${match.title}" due ${match.dueAt} is ${deltaDays.toFixed(1)}d out, expected within ${exp.dueWithinDays}d`);
        }
      }
    }
    // FR-05.1: engineering work must be objectively verifiable, or it can never be
    // gated. Treat a missing machine check as a rewrite-worthy defect.
    if (exp.division === 'technical' && !match.dod.some((d) => d.check.type === 'github_pr')) {
      reasons.push(`"${match.title}" has no github_pr check`);
    }
  }

  // Extra unrequested tasks are also a rewrite: the commander would have to delete them.
  const matched = testCase.expect.filter((exp) =>
    drafts.some((d) => exp.titleIncludes.every((n) => d.title.toLowerCase().includes(n.toLowerCase()))),
  ).length;
  if (drafts.length > matched) {
    reasons.push(`${drafts.length - matched} unexpected extra task(s)`);
  }

  return { passed: reasons.length === 0, reasons };
}

async function main() {
  const cases = await loadCases();

  // In-memory, seeded fresh. Using the live database here meant `npm run verify` on a
  // deployed server injected evaluation tickets into the real audit trail — the same
  // mistake `scripts/demo.ts` had already been corrected for. An evaluation must never
  // write to the thing it is measuring.
  const store = new Store(':memory:');
  store.migrate();
  const refs = seedCore(store);

  const orgId = refs.orgId;
  const scope = { orgId };

  const roster = loadRoster(store);
  if (!roster.length) {
    throw new AppError('VALIDATION_FAILED', 'No staff roster was seeded');
  }

  const ctx = createContext({ store });
  const llm: LlmProvider = createLlmProvider({
    roster, defaultRepo: 'acme/payment-service', opsSource: 'ops-sheets://settlement/daily', now: new Date(),
  });

  console.log(`Ticket-accuracy evaluation — PRD KPI 10.2`);
  console.log(`Provider: ${llm.name} (${llm.model})`);
  console.log(`Cases   : ${cases.length}\n`);

  const results: Array<{ id: string; passed: boolean; reasons: string[]; ttftMs: number; totalMs: number; fallback: boolean }> = [];

  for (const testCase of cases) {
    const outcome = await evaluateOne(ctx, llm, scope, testCase);
    results.push(outcome);
    const status = outcome.passed ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${testCase.id}  (ttft ${outcome.ttftMs}ms, total ${outcome.totalMs}ms${outcome.fallback ? ', heuristic fallback' : ''})`);
    for (const reason of outcome.reasons) console.log(`         - ${reason}`);
  }

  const passed = results.filter((r) => r.passed).length;
  const rate = results.length ? passed / results.length : 0;
  const threshold = 0.9;

  console.log('\n' + '='.repeat(70));
  console.log(`Approved without rewrite: ${passed}/${results.length} = ${(rate * 100).toFixed(1)}%`);
  console.log(`PRD KPI 10.2 threshold : ${(threshold * 100).toFixed(0)}%`);
  console.log(`Result                 : ${rate >= threshold ? 'PASS' : 'BELOW THRESHOLD'}`);
  console.log(`Mean TTFT              : ${Math.round(results.reduce((n, r) => n + r.ttftMs, 0) / (results.length || 1))} ms`);
  console.log(`Mean total             : ${Math.round(results.reduce((n, r) => n + r.totalMs, 0) / (results.length || 1))} ms`);
  console.log('='.repeat(70));

  const report = {
    kind: 'tickets',
    at: new Date().toISOString(),
    provider: { name: llm.name, model: llm.model },
    cases: results.length,
    passed,
    rate,
    threshold,
    passed_threshold: rate >= threshold,
    mean_ttft_ms: Math.round(results.reduce((n, r) => n + r.ttftMs, 0) / (results.length || 1)),
    mean_total_ms: Math.round(results.reduce((n, r) => n + r.totalMs, 0) / (results.length || 1)),
    detail: results,
  };

  // The JSON artifact is the durable record; the run is not written to the database.
  mkdirSync(resolve(process.cwd(), 'artifacts'), { recursive: true });
  writeFileSync(resolve(process.cwd(), 'artifacts', 'metrics.json'), JSON.stringify(report, null, 2));
  console.log('\nWrote artifacts/metrics.json');

  store.close();
  if (rate < threshold) process.exitCode = 1;
}

async function evaluateOne(
  ctx: ReturnType<typeof createContext>,
  llm: LlmProvider,
  scope: { orgId: string },
  testCase: Case,
) {
  const { decomposeInstruction } = await import('@execugate/llm');
  const outcome = await decomposeInstruction(llm, {
    roster: loadRoster(ctx.store),
    defaultRepo: 'acme/payment-service',
    opsSource: 'ops-sheets://settlement/daily',
    now: new Date(),
  }, {
    instruction: testCase.instruction,
    roster: loadRoster(ctx.store),
    projectName: 'Core Platform',
    projectCode: 'CORE',
    retrieved: [],
  });

  const { passed, reasons } = scoreDraft(testCase, outcome.parse.tasks as unknown as Draft[]);
  return {
    id: testCase.id,
    passed,
    reasons,
    ttftMs: outcome.ttftMs,
    totalMs: outcome.totalMs,
    fallback: outcome.usedFallback,
  };
}

main().catch((err) => {
  console.error('Evaluation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});