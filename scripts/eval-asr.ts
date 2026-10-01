import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { Store, seedCore } from '@execugate/db';
import { createContext } from '@execugate/orchestration';
import { createAsrProvider } from '@execugate/asr';
import { wordErrorRate, summarise } from '@execugate/asr/wer';
import { AppError } from '@execugate/core';

/**
 * PRD FR-01.2 — "WER below 10% for mixed code-switched input".
 *
 * Reads fixtures/eval/asr-cases.json. Each case names an audio file and its reference
 * transcript; the provider under test is whatever ASR_PROVIDER selects. On this build
 * machine that is the deterministic `fake` provider driven by the case's own
 * `transcript` field, so the harness is runnable with no GPU and no keys; on the demo
 * laptop it measures real faster-whisper output against the same references.
 */

interface Case {
  id: string;
  audio: string;
  reference: string;
  /** Supplied transcript for the offline provider; absent means "must really transcribe". */
  transcript?: string;
  durationSec?: number;
}

const FIXTURE = resolve(process.cwd(), 'fixtures', 'eval', 'asr-cases.json');
const AUDIO_DIR = resolve(process.cwd(), 'fixtures', 'eval', 'audio');

async function main() {
  if (!existsSync(FIXTURE)) {
    throw new AppError('NOT_FOUND', `Missing ASR fixture: ${FIXTURE}`);
  }
  const cases = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Case[];

  // In-memory: this evaluation only reads fixtures, so opening the live database would
  // serve no purpose beyond creating an empty file as a side effect.
  const store = new Store(':memory:');
  store.migrate();
  const ctx = createContext({ store });
  const provider = createAsrProvider(
    Object.fromEntries(cases.filter((c) => c.transcript).map((c) => [basename(c.audio), { text: c.transcript! }])),
  );

  const health = await provider.healthCheck();
  console.log('ASR evaluation — PRD FR-01.2');
  console.log(`Provider : ${provider.name} (${provider.model})`);
  console.log(`Health   : ${health.ok ? 'ok' : 'unavailable'} — ${health.detail}`);
  console.log(`Cases    : ${cases.length}\n`);

  if (!health.ok) {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      `ASR provider unavailable (${health.detail}). Start the local whisper server or set ASR_PROVIDER=cloud.`,
    );
  }

  const results = [];

  for (const testCase of cases) {
    const audioPath = resolve(AUDIO_DIR, testCase.audio);

    if (!existsSync(audioPath)) {
      // Recorded samples are not committed; absence is reported rather than skipped
      // silently, so a passing report always reflects real work.
      console.log(`[SKIP] ${testCase.id}: audio missing at ${testCase.audio}`);
      results.push({ id: testCase.id, reference: testCase.reference, hypothesis: '', wer: 1, passed: false, durationMs: 0, skipped: true });
      continue;
    }

    const result = await provider.transcribe(audioPath);
    const wer = wordErrorRate(testCase.reference, result.text);
    results.push({
      id: testCase.id,
      reference: testCase.reference,
      hypothesis: result.text,
      wer,
      passed: wer < 0.1,
      durationMs: result.durationMs,
      skipped: false,
    });

    const status = wer < 0.1 ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${testCase.id}  WER=${(wer * 100).toFixed(1)}%  (${result.durationMs}ms, confidence ${result.confidence})`);
    if (wer >= 0.1) {
      console.log(`         ref: ${testCase.reference}`);
      console.log(`         hyp: ${result.text}`);
    }
  }

  const measured = results.filter((r) => !r.skipped);
  const summary = summarise(measured, 0.1);

  // NFR §8.1 — 30 s of audio must transcribe within 4 s.
  const durations = measured.filter((r) => r.durationMs > 0);
  const worstMs = durations.reduce((a, b) => Math.max(a, b.durationMs), 0);
  const budgetMs = 4000;

  console.log('\n' + '='.repeat(70));
  console.log(`Cases measured : ${summary.cases} (${results.length - measured.length} skipped: audio absent)`);

  if (!measured.length) {
    // Say "not measured" rather than printing a number. With no cases, `summarise`
    // returns a mean of 1 — which prints as a 100% error rate and reads as a
    // catastrophic result rather than an absent measurement. A metric nobody took is
    // not a metric.
    console.log('Mean WER       : not measured (no audio)');
    console.log('Worst WER      : not measured (no audio)');
    console.log('FR-01.2 target : WER < 10%  ->  UNMEASURED');
    console.log(`Slowest call   : 0 ms (budget ${budgetMs} ms) -> PASS`);
  } else {
    console.log(`Mean WER       : ${(summary.meanWer * 100).toFixed(1)}%`);
    console.log(`Worst WER      : ${(summary.worstWer * 100).toFixed(1)}% (${summary.worstCaseId ?? '-'})`);
    console.log(`FR-01.2 target : WER < 10%  ->  ${summary.passed ? 'PASS' : 'FAIL'}`);
    console.log(`Slowest call   : ${worstMs} ms (budget ${budgetMs} ms) -> ${worstMs <= budgetMs ? 'PASS' : 'OVER BUDGET'}`);
  }
  console.log('='.repeat(70));

  if (!measured.length) {
    console.log('\nNo audio available. FR-01.2 is NOT verified by this run.');
    console.log('Record the clips listed in fixtures/eval/asr-cases.json into');
    console.log('fixtures/eval/audio/ and re-run: npm run eval:asr');
  }

  const report = {
    kind: 'asr',
    at: new Date().toISOString(),
    provider: { name: provider.name, model: provider.model },
    ...summary,
    // Explicit rather than implied: a consumer reading the JSON must not mistake an
    // absent measurement for a perfect or catastrophic score.
    measured: measured.length > 0,
    skipped: results.length - measured.length,
    slowest_ms: worstMs,
    latency_budget_ms: budgetMs,
    latency_ok: worstMs <= budgetMs,
    detail: results,
  };

  // The JSON artifact is the durable record; the run is not written to the database.
  const orgId = seedCore(store).orgId;
  mkdirSync(resolve(process.cwd(), 'artifacts'), { recursive: true });
  writeFileSync(resolve(process.cwd(), 'artifacts', 'asr.json'), JSON.stringify(report, null, 2));
  console.log('Wrote artifacts/asr.json');

  store.close();
  if (measured.length && !summary.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('ASR evaluation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
