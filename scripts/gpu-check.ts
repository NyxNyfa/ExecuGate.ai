import { config } from '@execugate/core';
import { createLlmProvider } from '@execugate/llm';
import { createAsrProvider } from '@execugate/asr';
import { createEmbeddingProvider } from '@execugate/memory';
import { ModelArbiter } from '@execugate/orchestration';

/**
 * Demo-laptop pre-flight for local GPU inference (BUILD_PLAN §9.1, Appendix B).
 *
 * The build machine has no GPU, so this is the check that has to be trusted blind.
 * It probes each configured endpoint for real, times a round trip, and reports the
 * exact remedy for anything missing. Exits non-zero when a provider the demo needs is
 * unreachable, so "the laptop is ready" is a measured claim rather than a hope.
 *
 * Usage:
 *   npm run check:gpu            probe whatever .env points at
 *   npm run check:gpu -- --bench also time a real completion and a real embedding
 */

const bench = process.argv.includes('--bench');

const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[31m';
const D = '\x1b[90m';
const X = '\x1b[0m';

const ok = (m: string) => console.log(`  ${G}OK${X}   ${m}`);
const warn = (m: string) => console.log(`  ${Y}WARN${X} ${m}`);
const bad = (m: string) => console.log(`  ${R}FAIL${X} ${m}`);
const info = (m: string) => console.log(`  ${D}·${X}    ${m}`);

let blocking = 0;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  remedy: string;
  blocking: boolean;
}

const checks: Check[] = [];

function record(c: Check) {
  checks.push(c);
  if (c.ok) ok(`${c.name} — ${c.detail}`);
  else if (c.blocking) { bad(`${c.name} — ${c.detail}`); blocking++; }
  else warn(`${c.name} — ${c.detail}`);
  if (!c.ok) info(`  ↳ ${c.remedy}`);
}

const ms = (t0: number) => `${Math.round(performance.now() - t0)}ms`;

console.log('\nExecuGate.ai — demo laptop GPU pre-flight\n');

// ── Environment ──────────────────────────────────────────────────────────────
console.log('Konfigurasi');
console.log('-'.repeat(64));
info(`llm     = ${config.llm.provider} ${config.llm.model || '(model unset)'} -> ${config.llm.baseUrl || 'default'}`);
info(`embed   = ${config.embed.provider} ${config.embed.model || '(model unset)'} -> ${config.embed.baseUrl || 'default'}`);
info(`asr     = ${config.asr.provider} ${config.asr.model || '(model unset)'} -> ${config.asr.baseUrl}`);
info(`vram    = ${config.vram.budgetMb} MiB budget`);

// ── VRAM budget ──────────────────────────────────────────────────────────────
console.log('\nAnggaran VRAM (ModelArbiter)');
console.log('-'.repeat(64));
const arbiter = new ModelArbiter({ budgetMb: config.vram.budgetMb });
const foot = arbiter.status().footprintMb;
const largest = Math.max(...Object.values(foot));
const total = Object.values(foot).reduce((a, b) => a + b, 0);

if (largest > config.vram.budgetMb) {
  bad(`model terbesar ${largest} MiB melebihi anggaran ${config.vram.budgetMb} MiB`);
  info('  ↳ Turunkan ke model lebih kecil, atau naikkan VRAM_BUDGET_MB jika kartu memang cukup.');
} else {
  ok(`model terbesar muat (${largest} MiB <= ${config.vram.budgetMb} MiB)`);
}
info(`gabungan ketiga role = ${total} MiB ${total > config.vram.budgetMb ? '> anggaran, jadi harus diserialisasi' : '<= anggaran'}`);
info('ModelArbiter akan memuat satu role pada satu waktu.');

// ── Provider probes ──────────────────────────────────────────────────────────
console.log('\nProbe provider');
console.log('-'.repeat(64));

const llm = createLlmProvider({
  roster: [],
  defaultRepo: 'acme/payment-service',
  opsSource: 'ops',
  now: new Date(),
});

const llmHealth = await llm.healthCheck();
record({
  name: 'LLM',
  ok: llmHealth.ok,
  detail: llmHealth.detail,
  blocking: config.llm.provider !== 'fake',
  remedy: 'Start llama-server:  llama-server -m <model>.gguf --host 127.0.0.1 --port 8080 --ctx-size 8192 --jinja',
});

const embedder = createEmbeddingProvider();
const embedHealth = await embedder.healthCheck();
record({
  name: 'Embeddings',
  ok: embedHealth.ok,
  detail: embedHealth.detail,
  blocking: config.embed.provider !== 'fake',
  remedy: 'Start:  python -m sentence_transformers.server --model intfloat/multilingual-e5-small --port 8081',
});

const asr = createAsrProvider();
const asrHealth = await asr.healthCheck();
record({
  name: 'ASR',
  ok: asrHealth.ok,
  detail: asrHealth.detail,
  blocking: config.asr.provider !== 'fake',
  remedy: 'Start:  python -m faster_whisper.server --model small --device cuda --compute_type int8_float16 --port 9000',
});

// ── Optional: real work, not just reachability ───────────────────────────────
if (bench && !blocking) {
  console.log('\nBenchmark nyata (bukan sekadar jangkauan)');
  console.log('-'.repeat(64));

  // Round-trip through the arbiter so this also exercises role switching.
  const live = new ModelArbiter({ asr, llm, embed: embedder, budgetMb: config.vram.budgetMb });

  const t0 = performance.now();
  const llmOut = await live.withRole('llm', async () => {
    const res = await llm.complete({
      messages: [
        { role: 'system', content: 'You answer with JSON only.' },
        { role: 'user', content: 'Return {"ok":true}' },
      ],
      maxTokens: 64,
    });
    return res;
  });
  ok(`LLM completion ${ms(t0)} (TTFT ${llmOut.ttftMs}ms, ${llmOut.usage.completionTokens} tok)`);
  info(`  sample: ${llmOut.text.slice(0, 120).replace(/\n/g, ' ')}`);
  if (llmOut.totalMs > config.llm.timeoutMs) {
    warn(`total ${llmOut.totalMs}ms melebihi LLM_TIMEOUT_MS=${config.llm.timeoutMs}`);
    info('  ↔ Naikkan LLM_TIMEOUT_MS, atau turunkan --ctx-size, atau beralih ke mode cloud.');
  }

  const t1 = performance.now();
  const vecs = await live.withRole('embed', () => embedder.embed(['uji embedding batch kecil']));
  ok(`Embedding ${ms(t1)} (${vecs[0]?.length ?? 0} dimensi)`);
  if ((vecs[0]?.length ?? 0) !== config.embed.dims) {
    bad(`dimensi embedding ${vecs[0]?.length} tidak cocok dengan EMBED_DIMS=${config.embed.dims}`);
    info('  ↳ Set EMBED_DIMS sesuai output model, lalu jalankan ulang seeding (npm run setup).');
    blocking++;
  }

  // ASR needs a real clip; the eval fixture is the honest source of truth.
  info('ASR latency diukur oleh: npm run eval:asr (butuh rekaman di fixtures/eval/audio/)');
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(64));
const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.log(`${failed.length} pemeriksaan gagal (${blocking} blocking).`);
  for (const c of failed) console.log(`  - ${c.name}: ${c.remedy}`);
} else {
  console.log('Semua provider terjangkau.');
}
console.log('='.repeat(64));

process.exit(blocking ? 1 : 0);