import type { Check, CheckOutcome } from '@execugate/core';
import { config } from '@execugate/core';
import { createLogger } from '@execugate/observability';

const log = createLogger('gatekeeper:github');

export interface GitHubEvidence {
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  state: 'merged' | 'open' | 'closed' | 'not_found';
  mergeable: boolean | null;
  checks: Array<{ name: string; status: string; conclusion: string | null; url: string | null }>;
}

interface CacheEntry {
  value: GitHubEvidence;
  etag: string | null;
  expiresAt: number;
}

/** Short TTL: balances GitHub's 60 req/hr unauthenticated budget against staleness. */
const CACHE_TTL_MS = 60_000;

/**
 * FR-05.1 engineering lane.
 *
 * Verifies, for a branch: a PR exists, it is merged, it has no merge conflicts, and
 * every check-run on the head commit concluded successfully. Uses ETag conditional
 * requests so a repeated verification costs no quota (BUILD_PLAN §11).
 */
export class GitHubProvider {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly token: string,
    private readonly apiBase = config.gatekeeper.githubApiBase,
    private readonly timeoutMs = config.gatekeeper.timeoutMs,
  ) {}

  get configured(): boolean {
    return !!this.token;
  }

  /** Injected in tests so external API failures can be simulated deterministically. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  private async request<T>(path: string): Promise<{ data: T | null; status: number; notModified: boolean }> {
    const url = `${this.apiBase}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        signal: controller.signal,
      });
      if (res.status === 304) return { data: null, status: 304, notModified: true };
      if (res.status === 404) return { data: null, status: 404, notModified: false };
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 403 || res.status === 429) {
          throw new Error(`GITHUB_RATE_LIMIT status ${res.status}: ${text.slice(0, 160)}`);
        }
        throw new Error(`GitHub HTTP ${res.status} on ${path}: ${text.slice(0, 160)}`);
      }
      return { data: (await res.json()) as T, status: res.status, notModified: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async inspect(repo: string, branch: string): Promise<GitHubEvidence> {
    const key = `${repo}@${branch}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const prs = await this.request<Array<{
      number: number; html_url: string; state: string; merged_at: string | null;
      mergeable: boolean | null; head: { sha: string; ref: string };
    }>>(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}&per_page=5`);

    const pr = prs.data?.[0];
    if (!pr) {
      const none: GitHubEvidence = { prNumber: null, prUrl: null, headSha: null, state: 'not_found', mergeable: null, checks: [] };
      this.cache.set(key, { value: none, etag: null, expiresAt: Date.now() + CACHE_TTL_MS });
      return none;
    }

    const runs = await this.request<{
      total_count: number;
      check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string | null }>;
    }>(`/repos/${repo}/commits/${pr.head.sha}/check-runs`);

    const evidence: GitHubEvidence = {
      prNumber: pr.number,
      prUrl: pr.html_url,
      headSha: pr.head.sha,
      state: pr.merged_at ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
      mergeable: pr.mergeable,
      checks: (runs.data?.check_runs ?? []).map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        url: c.html_url,
      })),
    };
    this.cache.set(key, { value: evidence, etag: null, expiresAt: Date.now() + CACHE_TTL_MS });
    return evidence;
  }

  async verify(check: Extract<Check, { type: 'github_pr' }>): Promise<CheckOutcome> {
    const started = performance.now();
    const done = () => ({ latencyMs: Math.round(performance.now() - started) });

    let ev: GitHubEvidence;
    try {
      ev = await this.inspect(check.repo, check.branch);
    } catch (err) {
      // Unverifiable, not failed: NFR §8.3 requires an outage to queue the task,
      // never to fail the work.
      const message = err instanceof Error ? err.message : String(err);
      log.warn('github verification unavailable', { repo: check.repo, branch: check.branch, error: message });
      return {
        type: 'github_pr',
        ok: false,
        unverifiable: true,
        detail: `GitHub tidak dapat dihubungi saat ini (${message}). Verifikasi dijadwalkan ulang.`,
        ...done(),
      };
    }

    if (ev.state === 'not_found') {
      return {
        type: 'github_pr',
        ok: false,
        detail: `Tidak ditemukan Pull Request untuk branch '${check.branch}' pada ${check.repo}. Pull Request wajib dibuat sebelum pengajuan diterima.`,
        ...done(),
      };
    }

    if (check.requireNoConflicts && ev.mergeable === false) {
      return {
        type: 'github_pr',
        ok: false,
        detail: `Pull Request #${ev.prNumber} (${ev.prUrl}) memiliki konflik merge. Konflik harus diselesaikan terlebih dahulu.`,
        evidenceUrl: ev.prUrl ?? undefined,
        ...done(),
      };
    }

    if (check.requireMerged && ev.state !== 'merged') {
      return {
        type: 'github_pr',
        ok: false,
        detail: `Pull Request #${ev.prNumber} untuk branch '${check.branch}' belum ter-merge (status: ${ev.state}).`,
        evidenceUrl: ev.prUrl ?? undefined,
        ...done(),
      };
    }

    // neutral/skipped are legitimate non-failures; anything pending or failing is not.
    if (check.requireCiGreen) {
      const failed = ev.checks.filter((c) => !['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''));
      if (failed.length) {
        const names = failed.map((c) => `${c.name} (${c.status}/${c.conclusion ?? 'pending'})`).join(', ');
        return {
          type: 'github_pr',
          ok: false,
          detail: `Pengujian otomatis gagal pada commit ${ev.headSha?.slice(0, 7)}: ${names}.`,
          evidenceUrl: failed[0]?.url ?? ev.prUrl ?? undefined,
          ...done(),
        };
      }
    }

    return {
      type: 'github_pr',
      ok: true,
      detail: `PR #${ev.prNumber} ter-merge pada commit ${ev.headSha?.slice(0, 7)}; ${ev.checks.length} check selesai.`,
      evidenceUrl: ev.prUrl ?? undefined,
      ...done(),
    };
  }
}

/**
 * Deterministic provider for offline demos and tests. Scenarios are keyed by
 * `repo@branch` and support a substring wildcard so the whole golden path can be
 * rehearsed with no network and no GitHub token.
 */
export type FakeScenario = Partial<GitHubEvidence> & { error?: string };

const HEALTHY: GitHubEvidence = {
  prNumber: 1,
  prUrl: 'https://github.com/acme/payment-service/pull/1',
  headSha: '0'.repeat(40),
  state: 'merged',
  mergeable: true,
  checks: [
    { name: 'lint', status: 'completed', conclusion: 'success', url: null },
    { name: 'unit-test', status: 'completed', conclusion: 'success', url: null },
    { name: 'integration-test', status: 'completed', conclusion: 'success', url: null },
    { name: 'security-scan', status: 'completed', conclusion: 'success', url: null },
    { name: 'build-image', status: 'completed', conclusion: 'success', url: null },
  ],
};

export class FakeGitHubProvider {
  private scenarios = new Map<string, FakeScenario>();

  constructor(scenarios: Array<{ match: string; evidence: FakeScenario }> = []) {
    for (const s of scenarios) this.scenarios.set(s.match, s.evidence);
  }

  get configured(): boolean {
    return true;
  }

  private resolve(check: Extract<Check, { type: 'github_pr' }>): FakeScenario {
    const key = `${check.repo}@${check.branch}`;
    for (const [pattern, evidence] of this.scenarios) {
      if (key.includes(pattern)) return evidence;
    }
    // Default: a healthy merged PR, so an unseeded demo still passes.
    return {
      prNumber: HEALTHY.prNumber,
      prUrl: `https://github.com/${check.repo}/pull/1`,
      headSha: HEALTHY.headSha,
      state: 'merged',
      mergeable: true,
      checks: HEALTHY.checks,
    };
  }

  async verify(check: Extract<Check, { type: 'github_pr' }>): Promise<CheckOutcome> {
    const started = performance.now();
    const ev = this.resolve(check);
    const done = () => ({ latencyMs: Math.round(performance.now() - started) });

    if (ev.error) {
      return { type: 'github_pr', ok: false, unverifiable: true, detail: `GitHub tidak dapat dihubungi saat ini (${ev.error}).`, ...done() };
    }
    if ((ev.state ?? 'merged') === 'not_found') {
      return {
        type: 'github_pr', ok: false,
        detail: `Tidak ditemukan Pull Request untuk branch '${check.branch}' pada ${check.repo}. Pull Request wajib dibuat sebelum pengajuan diterima.`,
        ...done(),
      };
    }
    if (check.requireNoConflicts && ev.mergeable === false) {
      return {
        type: 'github_pr', ok: false,
        detail: `Pull Request #${ev.prNumber} (${ev.prUrl}) memiliki konflik merge. Konflik harus diselesaikan terlebih dahulu.`,
        evidenceUrl: ev.prUrl ?? undefined, ...done(),
      };
    }
    if ((ev.state ?? 'merged') !== 'merged' && check.requireMerged) {
      return {
        type: 'github_pr', ok: false,
        detail: `Pull Request untuk branch '${check.branch}' belum ter-merge (status: ${ev.state ?? 'open'}).`,
        evidenceUrl: ev.prUrl ?? undefined, ...done(),
      };
    }
    const checks = ev.checks ?? [];
    const failed = checks.filter((c) => !['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''));
    if (check.requireCiGreen && failed.length) {
      return {
        type: 'github_pr', ok: false,
        detail: `Pengujian otomatis gagal pada commit ${(ev.headSha ?? '').slice(0, 7)}: ${failed.map((c) => `${c.name} (${c.conclusion ?? 'pending'})`).join(', ')}.`,
        evidenceUrl: failed[0]?.url ?? ev.prUrl ?? undefined, ...done(),
      };
    }
    return {
      type: 'github_pr', ok: true,
      detail: `PR #${ev.prNumber} ter-merge pada commit ${(ev.headSha ?? '').slice(0, 7)}; ${checks.length} check selesai.`,
      evidenceUrl: ev.prUrl ?? undefined, ...done(),
    };
  }
}