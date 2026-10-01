import { config, AppError } from '@execugate/core';
import { createLogger } from '@execugate/observability';

const log = createLogger('config');

export interface Check {
  name: string;
  ok: boolean;
  severity: 'blocking' | 'warning';
  detail: string;
}

/**
 * Startup validation.
 *
 * Every failure mode here is one that would otherwise surface mid-demo or, worse,
 * mid-operation: a service that boots without a master key, or a production instance
 * running with the dev identity header. Failing at boot is always cheaper than
 * discovering it later.
 */
export function validateConfig(env = process.env.NODE_ENV ?? 'development'): Check[] {
  const checks: Check[] = [];
  const prod = env === 'production';

  const push = (name: string, ok: boolean, severity: Check['severity'], detail: string) =>
    checks.push({ name, ok, severity, detail });

  // Master key: required to decrypt anything in the secrets table.
  const masterKey = config.masterKeyHex;
  push(
    'master key',
    masterKey.length >= 64,
    prod ? 'blocking' : 'warning',
    masterKey ? `${masterKey.length / 2} bytes` : 'EXECUGATE_MASTER_KEY not set (a dev key would be generated)',
  );

  if (masterKey && !/^[0-9a-fA-F]{64,}$/.test(masterKey)) {
    push('master key format', false, 'blocking', 'must be hexadecimal, 32 bytes (64 hex characters)');
  }

  // Authentication. Dev mode trusts X-Actor-User-Id, which any caller can set, so it
  // is only acceptable on a loopback and is a hard stop in production.
  const tokenAuth = config.auth.mode === 'token';
  push(
    'authentication',
    prod ? tokenAuth : true,
    prod ? 'blocking' : 'warning',
    tokenAuth
      ? 'AUTH_MODE=token — identity comes from a signed bearer token'
      : 'AUTH_MODE=dev — the X-Actor-User-Id header is trusted and is caller-controlled',
  );

  if (config.auth.mode === 'token') {
    push(
      'token secret',
      config.auth.tokenSecret.length >= 32,
      'blocking',
      config.auth.tokenSecret ? `${config.auth.tokenSecret.length} chars` : 'AUTH_TOKEN_SECRET not set',
    );
    push('token ttl', config.auth.ttlSeconds >= 300, 'warning', `${config.auth.ttlSeconds}s`);
  }

  // Transport: a production service must not be reachable over plain HTTP.
  push(
    'tls',
    !prod || config.requireTls,
    prod ? 'blocking' : 'warning',
    prod
      ? (config.requireTls
        ? 'REQUIRE_TLS=true — terminate TLS here or at a trusted proxy'
        : 'no TLS requirement set; terminate TLS at the reverse proxy and forward X-Forwarded-Proto')
      : 'not enforced outside production',
  );

  // Gatekeeper. With no token the engine silently falls back to FakeGitHubProvider.
  // That is the intended offline behaviour and what the whole test suite runs on, so
  // it is a warning here — but in production it means the gate is not actually
  // verifying anything, which defeats the product's central claim.
  const realVerification = config.gatekeeper.provider !== 'fake' && !!config.gatekeeper.githubToken;
  push(
    'gatekeeper verification source',
    prod ? realVerification : true,
    prod ? 'blocking' : 'warning',
    realVerification
      ? `GITHUB_TOKEN set; provider=${config.gatekeeper.provider}`
      : 'GITHUB_TOKEN absent — verification will be SIMULATED by the fake provider, not performed against GitHub',
  );

  // Database location must be a writable path, not an ephemeral one.
  // `:memory:` is resolved to an absolute path at config load, so compare the raw
  // value: an in-memory database loses every ticket on restart, which in production
  // means losing the audit trail.
  const rawDatabasePath = process.env.DATABASE_PATH ?? '';
  const inMemory = rawDatabasePath.trim() === ':memory:';
  push(
    'database path',
    !inMemory,
    prod ? 'blocking' : 'warning',
    inMemory ? ':memory: — data would vanish on restart' : config.databasePath,
  );

  // Providers. `local` and `ollama` adapters have their own defaults (llama.cpp on a
  // fixed port, sentence-transformers in-process), so requiring an explicit base URL
  // for them would reject a working configuration.
  if (config.llm.provider !== 'fake') {
    const llmOk = !!config.llm.baseUrl || config.llm.provider === 'ollama';
    push('llm endpoint', llmOk, 'blocking', config.llm.baseUrl || `provider=${config.llm.provider} uses its built-in default`);
  }
  if (config.embed.provider !== 'fake') {
    const embedOk = !!config.embed.baseUrl || config.embed.provider === 'local';
    push('embed endpoint', embedOk, 'blocking', config.embed.baseUrl || `provider=${config.embed.provider} runs in-process`);
  }
  if (config.asr.provider !== 'fake') {
    const asrOk = !!config.asr.baseUrl || config.asr.provider === 'cloud';
    push('asr endpoint', asrOk, 'blocking', config.asr.baseUrl || 'no ASR_BASE_URL');
  }

  // VRAM budget must admit the largest single model.
  const largest = 2560;
  push(
    'vram budget',
    config.vram.budgetMb >= largest,
    'warning',
    `${config.vram.budgetMb} MiB budget vs ~${largest} MiB for the largest model`,
  );

  // Telegram is optional, but a half-configured bot fails confusingly at runtime.
  const chats = [config.telegram.commanderChatId, config.telegram.techDivisionChatId, config.telegram.opsDivisionChatId].filter(Boolean).length;
  if (config.telegram.token) {
    push('telegram chats', chats > 0, 'warning', `${chats}/3 chat ids configured`);
  }

  return checks;
}

/** Throws when any blocking check fails. Call before binding a port. */
export function assertProductionReady(env = process.env.NODE_ENV ?? 'development'): void {
  const checks = validateConfig(env);
  const blocking = checks.filter((c) => !c.ok && c.severity === 'blocking');

  for (const c of checks) {
    if (c.ok) log.info(`ok   ${c.name} — ${c.detail}`);
    else if (c.severity === 'blocking') log.error(`FAIL ${c.name} — ${c.detail}`);
    else log.warn(`warn ${c.name} — ${c.detail}`);
  }

  if (blocking.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Refusing to start: ${blocking.length} blocking configuration problem(s): ${blocking.map((b) => b.name).join(', ')}`,
      { blocking: blocking.map((b) => ({ name: b.name, detail: b.detail })) },
    );
  }
}