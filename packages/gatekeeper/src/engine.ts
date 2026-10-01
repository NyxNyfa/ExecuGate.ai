import type { CheckOutcome, DodCriterion, Verdict, Verification, Check } from '@execugate/core';
import { config } from '@execugate/core';
import { createLogger } from '@execugate/observability';
import { GitHubProvider, FakeGitHubProvider } from './github.ts';
import { OpsProvider, FixtureOpsSource } from './ops.ts';

const log = createLogger('gatekeeper');

type GithubCheck = Extract<Check, { type: 'github_pr' }>;
type OpsCheck = Extract<Check, { type: 'document_present' | 'reconciliation' | 'data_row' }>;

export interface EngineeringProvider {
  configured: boolean;
  verify(check: GithubCheck): Promise<CheckOutcome>;
}

export interface GatekeeperResult {
  verdict: Verdict;
  lane: 'engineering' | 'operational';
  provider: string;
  outcomes: CheckOutcome[];
  messageId: string | null;
  latencyMs: number;
}

export interface EngineOptions {
  github?: EngineeringProvider;
  ops?: OpsProvider;
  timeoutMs?: number;
}

/**
 * FR-05.2 transition rule.
 *
 * Three distinct outcomes, because collapsing them would be the exact failure the
 * PRD is designed to prevent:
 *   pass          — all required criteria satisfied -> COMPLETED
 *   fail          — a criterion was evaluated and is not met -> REWORK_REQUIRED
 *   unverifiable  — an external system could not be reached -> stay in
 *                   QA_VERIFICATION with verification_state = 'pending' (NFR §8.3)
 */
export class GatekeeperEngine {
  private readonly github: EngineeringProvider;
  private readonly ops: OpsProvider;
  private readonly timeoutMs: number;

  constructor(opts: EngineOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? config.gatekeeper.timeoutMs;
    this.github =
      opts.github ??
      (config.gatekeeper.provider === 'fake' || !config.gatekeeper.githubToken
        ? new FakeGitHubProvider()
        : new GitHubProvider(config.gatekeeper.githubToken));
    this.ops = opts.ops ?? new OpsProvider(new FixtureOpsSource('default', { rows: {}, files: {} }));
  }

  get configured(): boolean {
    return this.github.configured;
  }

  async verifyTicket(criteria: DodCriterion[]): Promise<GatekeeperResult> {
    const started = performance.now();
    const required = criteria.filter((c) => c.required);

    if (!required.length) {
      return {
        verdict: 'pass',
        lane: 'engineering',
        provider: 'engine',
        outcomes: [],
        messageId: null,
        latencyMs: Math.round(performance.now() - started),
      };
    }

    const engineering = required.some((c) => c.check.type === 'github_pr');
    const lane: GatekeeperResult['lane'] = engineering ? 'engineering' : 'operational';
    const outcomes: CheckOutcome[] = [];
    let sawUnverifiable = false;
    let sawFailure = false;

    // Each distinct (provider, target) is evaluated once and the result shared across
    // every criterion that asks the same question. Without this, a ticket whose DoD
    // contains both "PR merged" and "CI green" for the same branch reports the same
    // failure twice and sends the staff two identical correction lines.
    const results = new Map<string, CheckOutcome>();
    let manualPending = false;

    for (const criterion of required) {
      const check = criterion.check;

      if (check.type === 'manual_review') {
        manualPending = true;
        const outcome: CheckOutcome = {
          type: 'manual_review',
          ok: false,
          unverifiable: true,
          detail: `Kriteria "${criterion.label}" memerlukan persetujuan manual commanding officer.`,
          latencyMs: 0,
        };
        outcomes.push(outcome);
        sawUnverifiable = true;
        continue;
      }

      const key = cacheKey(check);
      let outcome = results.get(key);

      if (!outcome) {
        const pending = check.type === 'github_pr' ? this.github.verify(check) : this.ops.verify(check as OpsCheck);
        try {
          // The promise (not its awaited value) is what withTimeout races, so a hung
          // provider is abandoned at the deadline rather than blocking the loop.
          outcome = await withTimeout(pending, this.timeoutMs);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          outcome = {
            type: check.type,
            ok: false,
            unverifiable: true,
            detail: `Verifikasi '${criterion.label}' tidak dapat diselesaikan (${message}).`,
            latencyMs: this.timeoutMs,
          };
          log.warn('check threw', { criterionId: criterion.id, error: message });
        }
        results.set(key, outcome);
      }

      outcomes.push(outcome);

      if (outcome.unverifiable) {
        sawUnverifiable = true;
      } else if (!outcome.ok) {
        sawFailure = true;
      }
    }

    // A real failure outranks an outage: if the work is known to be wrong, say so now
    // rather than making staff wait for a retry.
    const verdict: Verdict = sawFailure ? 'fail' : sawUnverifiable || manualPending ? 'unverifiable' : 'pass';

    return {
      verdict,
      lane,
      provider: engineering ? 'github' : 'ops',
      // Report the deduplicated set so each real problem is named exactly once.
      outcomes: dedupeOutcomes(outcomes),
      messageId: verdict === 'pass' ? null : classifyMessage(outcomes, verdict),
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

/** Identity of an external question, so duplicate DoD criteria share one lookup. */
function cacheKey(check: Check): string {
  switch (check.type) {
    case 'github_pr':
      // Branch + repo identify the artefact. The require* flags select which aspects
      // are asserted, but they do not change what the external system reports, so they
      // are deliberately excluded from the key.
      return `github:${check.repo}@${check.branch}`;
    case 'document_present':
      return `doc:${check.path ?? check.documentId ?? ''}`;
    case 'reconciliation':
      return `recon:${check.source}:${check.key}:${check.expectedField}:${check.actualField}`;
    case 'data_row':
      return `row:${check.source}:${JSON.stringify(check.match)}`;
    case 'manual_review':
      return `manual:${check.reviewerRole}`;
  }
}

function dedupeOutcomes(outcomes: CheckOutcome[]): CheckOutcome[] {
  const seen = new Set<string>();
  const out: CheckOutcome[] = [];
  for (const o of outcomes) {
    const key = `${o.type}|${o.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

function classifyMessage(outcomes: CheckOutcome[], verdict: Verdict): string {
  const failed = outcomes.find((o) => !o.ok && !o.unverifiable);
  if (failed) {
    if (failed.type === 'github_pr') {
      if (/gagal|pengujian/i.test(failed.detail)) return 'rework.gh.ci_failed';
      if (/konflik/i.test(failed.detail)) return 'rework.gh.conflict';
      if (/belum ter-merge/i.test(failed.detail)) return 'rework.gh.not_merged';
      if (/tidak ditemukan/i.test(failed.detail)) return 'rework.gh.no_pr';
      return 'rework.gh.generic';
    }
    if (failed.type === 'document_present') return 'rework.doc.missing';
    if (failed.type === 'reconciliation') return 'rework.recon.mismatch';
    if (failed.type === 'data_row') return 'rework.data.missing';
    return 'rework.generic';
  }
  if (verdict === 'unverifiable') {
    const first = outcomes.find((o) => o.unverifiable);
    if (first?.type === 'manual_review') return 'pending.manual_review';
    return 'pending.external_unavailable';
  }
  return 'pending.generic';
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout setelah ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** FR-05.2 requires specific correction text, never a generic failure. */
export function reworkMessage(result: GatekeeperResult): string {
  const lines: string[] = [];
  const hard = result.outcomes.filter((o) => !o.ok && !o.unverifiable);
  const soft = result.outcomes.filter((o) => o.unverifiable);

  if (hard.length) {
    lines.push('Pengajuan tugas belum dapat diterima:');
    hard.forEach((o, i) => {
      lines.push(`${i + 1}. ${o.detail}`);
      if (o.evidenceUrl) lines.push(`   Bukti: ${o.evidenceUrl}`);
    });
  }
  if (soft.length) {
    lines.push('');
    lines.push('Verifikasi otomatis belum dapat dijalankan:');
    soft.forEach((o, i) => lines.push(`${i + 1}. ${o.detail}`));
    lines.push('Tugas tetap berstatus menunggu verifikasi dan akan diperiksa ulang otomatis.');
  }
  if (!hard.length && !soft.length) lines.push('Tidak ada kriteria yang dapat diverifikasi.');
  return lines.join('\n');
}

export function verificationPendingMessage(result: GatekeeperResult): string {
  const soft = result.outcomes.filter((o) => o.unverifiable);
  return [
    'Status ditahan di QA_VERIFICATION — sistem eksternal belum dapat diverifikasi (NFR 8.3).',
    '',
    ...soft.map((o) => `• ${o.detail}`),
    '',
    'Tugas akan diperiksa ulang otomatis. Bila tetap tidak dapat diverifikasi, commanding officer dapat memutuskan verifikasi manual.',
  ].join('\n');
}

export function toVerificationRecord(result: GatekeeperResult): Omit<Verification, 'id' | 'orgId' | 'ticketId' | 'createdAt'> {
  return {
    lane: result.lane,
    provider: result.provider,
    verdict: result.verdict,
    outcomes: result.outcomes,
    messageId: result.messageId,
    latencyMs: result.latencyMs,
  };
}

export { GitHubProvider, FakeGitHubProvider, OpsProvider, FixtureOpsSource };