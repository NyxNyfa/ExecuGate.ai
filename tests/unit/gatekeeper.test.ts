import { describe, it, expect, vi } from 'vitest';
import { GatekeeperEngine, FakeGitHubProvider, OpsProvider, FixtureOpsSource, reworkMessage } from '@execugate/gatekeeper';
import type { CheckOutcome, DodCriterion } from '@execugate/core';

const scope = { orgId: 'org1' };
let seq = 0;
const criterion = (c: DodCriterion['check'], required = true, label = 'kriteria'): DodCriterion => ({
  id: `dod${++seq}`, orgId: 'org1', ticketId: 't1', kind: 'engineering', label, required, check: c, position: 0,
});

const prCheck = (over: Partial<Extract<DodCriterion['check'], { type: 'github_pr' }>> = {}): DodCriterion['check'] => ({
  type: 'github_pr', repo: 'acme/payment-service', branch: 'feat/deploy', requireMerged: true, requireCiGreen: true, requireNoConflicts: true, ...over,
});

describe('FR-05.2 transition rules', () => {
  it('passes only when every required criterion passes', async () => {
    const engine = new GatekeeperEngine({ github: new FakeGitHubProvider() });
    const result = await engine.verifyTicket([criterion(prCheck())]);
    expect(result.verdict).toBe('pass');
    expect(result.messageId).toBeNull();
  });

  it('fails when the PR is not merged and names the branch', async () => {
    const engine = new GatekeeperEngine({
      github: new FakeGitHubProvider([{ match: 'payment-service', evidence: { state: 'open', prNumber: 7, prUrl: 'https://gh/pr/7' } }]),
    });
    const result = await engine.verifyTicket([criterion(prCheck())]);
    expect(result.verdict).toBe('fail');
    expect(result.messageId).toBe('rework.gh.not_merged');
    expect(result.outcomes[0]!.detail).toMatch(/feat\/deploy/);
  });

  it('fails and names the failing job and commit when CI is red', async () => {
    const engine = new GatekeeperEngine({
      github: new FakeGitHubProvider([{
        match: 'payment-service',
        evidence: {
          state: 'merged', prNumber: 7, headSha: 'a1b2c3d4e5f6a7b8',
          checks: [{ name: 'integration-test', status: 'completed', conclusion: 'failure', url: 'https://gh/run/1' }],
        },
      }]),
    });
    const result = await engine.verifyTicket([criterion(prCheck())]);
    expect(result.verdict).toBe('fail');
    expect(result.messageId).toBe('rework.gh.ci_failed');
    expect(result.outcomes[0]!.detail).toContain('integration-test');
    expect(result.outcomes[0]!.detail).toContain('a1b2c3d');
    expect(result.outcomes[0]!.evidenceUrl).toBe('https://gh/run/1');
  });

  it('rejects a PR with merge conflicts', async () => {
    const engine = new GatekeeperEngine({
      github: new FakeGitHubProvider([{ match: 'payment-service', evidence: { state: 'merged', mergeable: false, prNumber: 7 } }]),
    });
    const result = await engine.verifyTicket([criterion(prCheck())]);
    expect(result.verdict).toBe('fail');
    expect(result.messageId).toBe('rework.gh.conflict');
  });

  it('treats a missing PR as a failure, not an outage', async () => {
    const engine = new GatekeeperEngine({
      github: new FakeGitHubProvider([{ match: 'payment-service', evidence: { state: 'not_found' } }]),
    });
    const result = await engine.verifyTicket([criterion(prCheck())]);
    expect(result.verdict).toBe('fail');
    expect(result.messageId).toBe('rework.gh.no_pr');
  });

  it('treats neutral and skipped checks as non-failures', async () => {
    const engine = new GatekeeperEngine({
      github: new FakeGitHubProvider([{
        match: 'payment-service',
        evidence: {
          state: 'merged',
          checks: [
            { name: 'lint', status: 'completed', conclusion: 'success', url: null },
            { name: 'windows', status: 'completed', conclusion: 'neutral', url: null },
            { name: 'docs', status: 'completed', conclusion: 'skipped', url: null },
          ],
        },
      }]),
    });
    expect((await engine.verifyTicket([criterion(prCheck())])).verdict).toBe('pass');
  });

  it('NFR 8.3: an unreachable API is unverifiable, never fail', async () => {
    const engine = new GatekeeperEngine({
      github: new FakeGitHubProvider([{ match: 'payment-service', evidence: { error: 'ECONNREFUSED' } }]),
    });
    const result = await engine.verifyTicket([criterion(prCheck())]);
    expect(result.verdict).toBe('unverifiable');
    expect(result.outcomes[0]!.unverifiable).toBe(true);
    expect(result.messageId).toBe('pending.external_unavailable');
  });

  it('prefers a real failure over an outage when both are present', async () => {
    const engine = new GatekeeperEngine({
      github: new FakeGitHubProvider([{ match: 'a-repo', evidence: { state: 'open' } }, { match: 'b-repo', evidence: { error: 'down' } }]),
    });
    const result = await engine.verifyTicket([
      criterion(prCheck({ repo: 'org/a-repo' })),
      criterion(prCheck({ repo: 'org/b-repo' })),
    ]);
    // Knowing the work is wrong should not be delayed behind a retry.
    expect(result.verdict).toBe('fail');
  });

  it('never auto-satisfies a manual_review criterion', async () => {
    const engine = new GatekeeperEngine({ github: new FakeGitHubProvider() });
    const result = await engine.verifyTicket([criterion({ type: 'manual_review', reviewerRole: 'commander' })]);
    expect(result.verdict).toBe('unverifiable');
    expect(result.messageId).toBe('pending.manual_review');
  });

  it('reports a failing check once even when several criteria depend on it', async () => {
    const engine = new GatekeeperEngine({
      github: new FakeGitHubProvider([{
        match: 'payment-service',
        evidence: { state: 'merged', headSha: 'abc1234', checks: [{ name: 'integration-test', status: 'completed', conclusion: 'failure', url: null }] },
      }]),
    });

    // Both criteria ask about the same PR: the first requires merge, the second CI.
    // Two identical correction lines would read as two separate problems.
    const result = await engine.verifyTicket([
      criterion(prCheck(), true, 'PR ter-merge'),
      criterion(prCheck({ requireMerged: false }), true, 'CI hijau'),
    ]);

    expect(result.verdict).toBe('fail');
    const hard = result.outcomes.filter((o) => !o.ok && !o.unverifiable);
    expect(hard).toHaveLength(1);
    expect(hard[0]!.detail).toContain('integration-test');
  });

  it('queries the provider once per distinct artefact', async () => {
    let calls = 0;
    const counting = {
      configured: true,
      verify: async (_c: never): Promise<CheckOutcome> => {
        calls++;
        return { type: 'github_pr', ok: true, detail: 'ok', latencyMs: 0 };
      },
    };
    const engine = new GatekeeperEngine({ github: counting });
    await engine.verifyTicket([criterion(prCheck()), criterion(prCheck({ requireCiGreen: false }))]);
    expect(calls).toBe(1);
  });

  it('still queries the provider separately for different branches', async () => {
    let calls = 0;
    const counting = {
      configured: true,
      verify: async (_c: never): Promise<CheckOutcome> => {
        calls++;
        return { type: 'github_pr', ok: true, detail: 'ok', latencyMs: 0 };
      },
    };
    const engine = new GatekeeperEngine({ github: counting });
    await engine.verifyTicket([criterion(prCheck({ branch: 'feat/a' })), criterion(prCheck({ branch: 'feat/b' }))]);
    expect(calls).toBe(2);
  });

  it('ignores optional criteria when all required ones pass', async () => {
    const engine = new GatekeeperEngine({ github: new FakeGitHubProvider() });
    const result = await engine.verifyTicket([
      criterion(prCheck()),
      criterion({ type: 'document_present', minBytes: 1, path: 'missing.pdf' }, false),
    ]);
    expect(result.verdict).toBe('pass');
  });

  it('returns unverifiable when a connector exceeds the timeout', async () => {
    const slow = {
      configured: true,
      verify: (_c: never) => new Promise((r) => setTimeout(() => r({ type: 'github_pr', ok: true, detail: 'late', latencyMs: 0 }), 500)),
    };
    const engine = new GatekeeperEngine({ github: slow as never, timeoutMs: 30 });
    const result = await engine.verifyTicket([criterion(prCheck())]);
    expect(result.verdict).toBe('unverifiable');
    expect(result.outcomes[0]!.detail).toMatch(/timeout/);
  });
});

describe('FR-05.1 operational lane', () => {
  const build = (source: FixtureOpsSource) => new GatekeeperEngine({ github: new FakeGitHubProvider(), ops: new OpsProvider(source) });

  it('rejects a missing required document', async () => {
    const source = new FixtureOpsSource('t', { files: {} });
    const result = await build(source).verifyTicket([criterion({ type: 'document_present', path: 'sop.pdf', minBytes: 1 }, true, 'Dokumen SOP')]);
    expect(result.verdict).toBe('fail');
    expect(result.messageId).toBe('rework.doc.missing');
  });

  it('rejects an empty document', async () => {
    const source = new FixtureOpsSource('t', { files: { 'sop.pdf': 0 } });
    const result = await build(source).verifyTicket([criterion({ type: 'document_present', path: 'sop.pdf', minBytes: 1 })]);
    expect(result.verdict).toBe('fail');
    expect(result.outcomes[0]!.detail).toMatch(/0 byte/);
  });

  it('accepts a present, non-empty document', async () => {
    const source = new FixtureOpsSource('t', { files: { 'sop.pdf': 2048 } });
    expect((await build(source).verifyTicket([criterion({ type: 'document_present', path: 'sop.pdf', minBytes: 1 })])).verdict).toBe('pass');
  });

  it('accepts matching reconciliation figures', async () => {
    const source = new FixtureOpsSource('t', { rows: { d: [{ transaction_count: 100, settlement_count: 100 }] } });
    const result = await build(source).verifyTicket([
      criterion({ type: 'reconciliation', source: 'sheets', key: 'd', expectedField: 'transaction_count', actualField: 'settlement_count', tolerance: 0.01 }),
    ]);
    expect(result.verdict).toBe('pass');
  });

  it('rejects reconciliation with a mismatch, quoting both values', async () => {
    const source = new FixtureOpsSource('t', { rows: { d: [{ transaction_count: 100, settlement_count: 87 }] } });
    const result = await build(source).verifyTicket([
      criterion({ type: 'reconciliation', source: 'sheets', key: 'd', expectedField: 'transaction_count', actualField: 'settlement_count', tolerance: 0.01 }),
    ]);
    expect(result.verdict).toBe('fail');
    expect(result.messageId).toBe('rework.recon.mismatch');
    expect(result.outcomes[0]!.detail).toContain('100');
    expect(result.outcomes[0]!.detail).toContain('87');
  });

  it('finds a matching data row', async () => {
    const source = new FixtureOpsSource('t', { rows: { k: [{ id: 'INV-1', status: 'paid' }] } });
    const result = await build(source).verifyTicket([
      criterion({ type: 'data_row', source: 'erp', match: { id: 'INV-1', status: 'paid' } }),
    ]);
    expect(result.verdict).toBe('pass');
  });

  it('treats an unreachable ops source as unverifiable', async () => {
    const source = {
      name: 'broken',
      fetch: () => { throw new Error('ECONNREFUSED'); },
      fileSize: () => { throw new Error('ECONNREFUSED'); },
    };
    const result = await build(source as never).verifyTicket([criterion({ type: 'document_present', path: 'a.pdf', minBytes: 1 })]);
    expect(result.verdict).toBe('unverifiable');
  });
});

describe('FR-05.2 rejection messages', () => {
  it('names every failing artefact rather than saying "failed"', async () => {
    const engine = new GatekeeperEngine({
      github: new FakeGitHubProvider([{ match: 'payment-service', evidence: { state: 'merged', checks: [{ name: 'security-scan', status: 'completed', conclusion: 'failure', url: null }] } }]),
      ops: new OpsProvider(new FixtureOpsSource('t', { files: {} })),
    });
    const result = await engine.verifyTicket([
      criterion(prCheck()),
      criterion({ type: 'document_present', path: 'bukti.pdf', minBytes: 1 }, true, 'Bukti upload'),
    ]);
    const message = reworkMessage(result);
    expect(message).not.toMatch(/^gagal$/i);
    expect(message).toMatch(/security-scan/);
    expect(message).toMatch(/bukti\.pdf/);
    expect(message).toMatch(/Pengajuan tugas belum dapat diterima/);
  });

  it('explains the pending-verification path on an outage', async () => {
    const engine = new GatekeeperEngine({ github: new FakeGitHubProvider([{ match: 'x', evidence: { error: 'timeout' } }]) });
    const result = await engine.verifyTicket([criterion(prCheck({ repo: 'org/x' }))]);
    const message = reworkMessage(result);
    expect(message).toMatch(/dijadwalkan ulang|belum dapat dijalankan/i);
  });
});

describe('GitHub provider HTTP behaviour', () => {
  it('honours ETag-style 304s by reusing the cached value', async () => {
    const { GitHubProvider } = await import('@execugate/gatekeeper/github');
    const provider = new GitHubProvider('token', 'https://api.example.test', 1000);

    let calls = 0;
    provider.fetchImpl = vi.fn(async (input) => {
      calls++;
      const url = String(input);
      if (url.includes('/pulls')) {
        return new Response(JSON.stringify([{ number: 3, html_url: 'u', state: 'closed', merged_at: '2026-01-01', mergeable: true, head: { sha: 'abc1234', ref: 'b' } }]), { status: 200 });
      }
      return new Response(JSON.stringify({ total_count: 1, check_runs: [{ name: 'lint', status: 'completed', conclusion: 'success', html_url: null }] }), { status: 200 });
    }) as never;

    await provider.inspect('acme/repo', 'feat/x');
    await provider.inspect('acme/repo', 'feat/x');
    // Second call served from cache: GitHub's 60 req/hr budget is not burnt.
    expect(calls).toBe(2);
  });

  it('reports a 404 branch as not_found rather than throwing', async () => {
    const { GitHubProvider } = await import('@execugate/gatekeeper/github');
    const provider = new GitHubProvider('token', 'https://api.example.test', 1000);
    provider.fetchImpl = vi.fn(async () => new Response('{}', { status: 404 })) as never;

    const evidence = await provider.inspect('acme/repo', 'feat/missing');
    expect(evidence.state).toBe('not_found');
  });

  it('surfaces a rate limit as a retryable condition', async () => {
    const { GitHubProvider } = await import('@execugate/gatekeeper/github');
    const provider = new GitHubProvider('token', 'https://api.example.test', 1000);
    provider.fetchImpl = vi.fn(async () => new Response('rate limited', { status: 403 })) as never;

    const outcome = await provider.verify(prCheck() as never);
    expect(outcome.ok).toBe(false);
    expect(outcome.unverifiable).toBe(true);
  });
});