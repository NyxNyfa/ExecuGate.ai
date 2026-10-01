/**
 * Secret redaction. Every log line and every outbound error message passes through
 * this, because a leaked bot token or PAT invalidates the demo.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '[TELEGRAM_TOKEN]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[GITHUB_TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[API_KEY]'],
  [/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi, '$1[REDACTED]'],
  [/(x-api-key\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]'],
  [/(api[_-]?key\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]'],
  [/(password\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]'],
];

const SENSITIVE_KEYS = new Set([
  'token', 'apikey', 'api_key', 'secret', 'password', 'passwd', 'authorization',
  'masterkey', 'master_key', 'ciphertext', 'cookie', 'session', 'privatekey', 'private_key',
]);

export function redactString(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Depth-limited, key-aware redaction for structured log payloads. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}
