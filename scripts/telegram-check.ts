import { config } from '@execugate/core';
import { TelegramAdapter } from '@execugate/channels';

/**
 * Pre-flight for a live Telegram run (BUILD_PLAN §15).
 *
 * Validates every external dependency the demo needs and fails loudly with the specific
 * remedy. A bot token that expires mid-demo is the single most likely total-demo
 * failure, so it is checked before the run rather than during it.
 */

const ok = (label: string, detail = '') => console.log(`  \x1b[32mOK\x1b[0m   ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label: string, detail = '') => console.log(`  \x1b[33mWARN\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label: string, detail = '') => console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);

let blocking = 0;

console.log('\nExecuGate.ai — live demo pre-flight\n');

console.log('AI providers');
console.log('-'.repeat(60));
if (config.llm.provider === 'fake') {
  warn('LLM', 'fake/heuristic. Set LLM_PROVIDER=openai + LLM_BASE_URL for the demo laptop.');
} else {
  ok('LLM', `${config.llm.provider} -> ${config.llm.baseUrl || '(default)'} model=${config.llm.model || '(unset)'}`);
}
if (config.embed.provider === 'fake') {
  warn('Embeddings', 'fake/hashed. Set EMBED_PROVIDER + EMBED_BASE_URL on the demo laptop.');
} else {
  ok('Embeddings', `${config.embed.provider} dims=${config.embed.dims}`);
}
if (config.asr.provider === 'fake') {
  warn('ASR', 'fake fixtures. Set ASR_PROVIDER=whisper-http + ASR_BASE_URL for real voice notes.');
} else {
  ok('ASR', `${config.asr.provider} -> ${config.asr.baseUrl} model=${config.asr.model}`);
}

console.log('\nGatekeeper');
console.log('-'.repeat(60));
if (!config.gatekeeper.githubToken && config.gatekeeper.provider === 'github') {
  warn('GitHub', 'No GITHUB_TOKEN. Falling back to the fake connector; the rework demo needs a real repo.');
} else {
  ok('GitHub', `token ${config.gatekeeper.githubToken ? 'present' : 'absent'} (${config.gatekeeper.provider})`);
}
ok('Ops source', config.ops.sourceUrl || 'fixture (in-memory)');

console.log('\nTelegram');
console.log('-'.repeat(60));

const token = config.telegram.token;
if (!token) {
  bad('Bot token', 'TELEGRAM_BOT_TOKEN is empty. Create a bot with @BotFather.');
  blocking++;
} else {
  const adapter = new TelegramAdapter({ token });
  const health = await adapter.healthCheck();
  if (health.ok) {
    ok('Bot token', `reachable as ${health.detail}`);
  } else {
    bad('Bot token', health.detail);
    blocking++;
  }
}

const chats: Array<[string, string]> = [
  ['Commander chat', config.telegram.commanderChatId],
  ['Technical division', config.telegram.techDivisionChatId],
  ['Operational division', config.telegram.opsDivisionChatId],
];

for (const [label, id] of chats) {
  if (!id) {
    warn(label, 'not set. Approval cards and dispatch will be skipped.');
  } else {
    ok(label, id);
  }
}

if (token && config.telegram.commanderChatId) {
  const adapter = new TelegramAdapter({ token });
  try {
    await adapter.send(config.telegram.commanderChatId, {
      target: config.telegram.commanderChatId,
      text: '✅ *ExecuGate.ai tersambung.* Bot siap menerima arahan lisan atau teks.',
      parseMode: 'markdown',
    });
    ok('Send test', 'commander chat acknowledged the message');
  } catch (err) {
    bad('Send test', err instanceof Error ? err.message : String(err));
    blocking++;
  }
}

console.log('\nSecurity');
console.log('-'.repeat(60));
if (config.masterKeyHex) ok('Master key', 'EXECUGATE_MASTER_KEY set');
else warn('Master key', 'unset; a development key was generated under .secrets/');
if (config.isProduction) ok('Environment', 'production');

console.log('\n' + '='.repeat(60));
if (blocking) {
  console.log(`${blocking} blocking issue(s). Fix the items marked FAIL before demoing.\n`);
  process.exitCode = 1;
} else {
  console.log('Ready. Warnings are tolerable; FAIL items are not.\n');
}