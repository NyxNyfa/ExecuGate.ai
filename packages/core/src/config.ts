import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Typed configuration. Providers default to `fake` so the whole stack boots and
 * demos with zero API keys (BUILD_PLAN §2).
 */

function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  try {
    // Node >= 20.12 exposes this natively; no dotenv dependency needed.
    (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(path);
  } catch {
    /* a malformed .env must not stop the process from starting */
  }
}
loadDotEnv();

const str = (key: string, fallback = ''): string => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};
const num = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  const v = str(key) as T;
  return allowed.includes(v) ? v : fallback;
};

/**
 * Runtime configuration.
 *
 * Deliberately mutable rather than `as const`: tests need to switch `AUTH_MODE` and
 * the provider selectors in-process, and an immutable literal object would force every
 * test to spawn a child process just to flip one flag.
 */
export const config = {
  env: str('NODE_ENV', 'development'),
  isProduction: str('NODE_ENV') === 'production',
  databasePath: resolve(process.cwd(), str('DATABASE_PATH', './data/execugate.db')),
  masterKeyHex: str('EXECUGATE_MASTER_KEY'),

  telegram: {
    token: str('TELEGRAM_BOT_TOKEN'),
    mode: oneOf('TELEGRAM_MODE', ['polling', 'webhook'] as const, 'polling'),
    commanderChatId: str('TELEGRAM_COMMANDER_CHAT_ID'),
    techDivisionChatId: str('TELEGRAM_TECH_DIVISION_CHAT_ID'),
    opsDivisionChatId: str('TELEGRAM_OPS_DIVISION_CHAT_ID'),
  },

  llm: {
    provider: oneOf('LLM_PROVIDER', ['fake', 'openai', 'ollama'] as const, 'fake'),
    baseUrl: str('LLM_BASE_URL'),
    apiKey: str('LLM_API_KEY'),
    model: str('LLM_MODEL'),
    temperature: Number(str('LLM_TEMPERATURE', '0')),
    timeoutMs: num('LLM_TIMEOUT_MS', 3000),
    maxTokens: num('LLM_MAX_TOKENS', 900),
  },

  embed: {
    provider: oneOf('EMBED_PROVIDER', ['fake', 'openai', 'local'] as const, 'fake'),
    baseUrl: str('EMBED_BASE_URL'),
    apiKey: str('EMBED_API_KEY'),
    model: str('EMBED_MODEL'),
    dims: num('EMBED_DIMS', 384),
  },

  asr: {
    provider: oneOf('ASR_PROVIDER', ['fake', 'whisper-http', 'cloud'] as const, 'fake'),
    baseUrl: str('ASR_BASE_URL', 'http://127.0.0.1:9000'),
    apiKey: str('ASR_API_KEY'),
    model: str('ASR_MODEL', 'small'),
    language: str('ASR_LANGUAGE'),
    maxBytes: num('ASR_MAX_BYTES', 25 * 1024 * 1024),
  },

  gatekeeper: {
    provider: oneOf('GATEKEEPER_PROVIDER', ['github', 'fake'] as const, 'github'),
    githubToken: str('GITHUB_TOKEN'),
    githubApiBase: str('GITHUB_API_BASE', 'https://api.github.com'),
    timeoutMs: num('GATEKEEPER_TIMEOUT_MS', 1500),
  },

  ops: {
    sourceUrl: str('OPS_SOURCE_URL'),
    sourceToken: str('OPS_SOURCE_TOKEN'),
    tolerance: Number(str('OPS_TOLERANCE', '0.01')),
  },

  ports: {
    api: num('API_PORT', 3000),
    web: num('WEB_PORT', 5173),
  },

  /**
   * Usable VRAM on the demo laptop, in MiB. The arbiter serialises GPU-resident
   * roles against this; set it to ~3800 on a 4 GB card.
   */
  vram: {
    budgetMb: num('VRAM_BUDGET_MB', 4096),
  },

  /**
   * Authentication mode.
   *
   * `dev` trusts an X-Actor-User-Id header, which any caller can set. That is fine on
   * a loopback demo and unacceptable anywhere else, so production refuses to start
   * unless `token` is selected explicitly.
   */
  auth: {
    mode: oneOf('AUTH_MODE', ['dev', 'token'] as const, 'dev'),
    /** HMAC key for token signing. Required in token mode. */
    tokenSecret: str('AUTH_TOKEN_SECRET'),
    ttlSeconds: num('AUTH_TOKEN_TTL_SECONDS', 8 * 60 * 60),
    /** Login attempts per window per identity. */
    loginLimit: num('AUTH_LOGIN_LIMIT', 8),
    loginWindowMs: num('AUTH_LOGIN_WINDOW_MS', 5 * 60_000),
  },

  /** Rate limit for ordinary API traffic, per identity. */
  rateLimit: {
    limit: num('API_RATE_LIMIT', 600),
    windowMs: num('API_RATE_WINDOW_MS', 60_000),
  },

  /**
   * Serve the built dashboard from the API process. One origin in production removes
   * a whole class of proxy and CORS misconfiguration.
   */
  serveWeb: str('SERVE_WEB', 'auto') === 'true',
  webDist: str('WEB_DIST_DIR', './apps/web/dist'),

  /** Terminate TLS at a reverse proxy in production; required when serving directly. */
  requireTls: str('REQUIRE_TLS', 'auto') === 'true',
};

/** True when every AI dependency can run with no network and no keys. */
export function isOfflineMode(): boolean {
  return config.llm.provider === 'fake' && config.embed.provider === 'fake' && config.asr.provider === 'fake';
}

export function describeRuntime(): string {
  return [
    `llm=${config.llm.provider}`,
    `embed=${config.embed.provider}`,
    `asr=${config.asr.provider}`,
    `gate=${config.gatekeeper.provider}`,
    `telegram=${config.telegram.token ? config.telegram.mode : 'disabled'}`,
  ].join(' ');
}

