import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.ts';

/**
 * Token authentication (NFR §8.2).
 *
 * Why this exists: the API originally read identity from an `X-Actor-User-Id` header.
 * That header is caller-controlled, so anyone could claim to be a commanding officer —
 * which is exactly the privilege this product is built to gate. Identity now comes
 * only from a signed token, and every authorisation decision reads `role`/`orgId`
 * from the verified payload rather than from anything the client supplied.
 *
 * Implemented as compact HS256-style tokens over node:crypto: no extra dependency, and
 * the verification path is short enough to audit by eye.
 */

export interface TokenClaims {
  /** User id. */
  sub: string;
  orgId: string;
  role: 'commander' | 'technical' | 'ops' | 'admin';
  divisionId: string | null;
  /** Issued-at and expiry, seconds since epoch. */
  iat: number;
  exp: number;
  /** Token id, for revocation lists and audit correlation. */
  jti: string;
}

const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

// ─── Credentials ─────────────────────────────────────────────────────────────

/**
 * Salted scrypt hash. A database copy must not be replayable as credentials, so the
 * plaintext secret is never stored — only the hash and its salt.
 */
export function hashSecret(secret: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  return { hash: scryptSync(secret, salt, 64).toString('hex'), salt };
}

export function verifySecret(secret: string, hash: string, salt: string): boolean {
  if (!hash || !salt) return false;
  const candidate = scryptSync(secret, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  // Length must match before timingSafeEqual, which throws on a mismatch.
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function generateSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(`${HEADER}.${payload}`).digest('base64url');
}

export function issueToken(
  claims: Omit<TokenClaims, 'iat' | 'exp' | 'jti'>,
  key: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = Math.floor(Date.now() / 1000),
): string {
  const full: TokenClaims = {
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
    jti: randomBytes(8).toString('hex'),
  };
  const payload = b64url(JSON.stringify(full));
  return `${HEADER}.${payload}.${sign(payload, key)}`;
}

export interface VerifyOptions {
  now?: number;
  /** Tolerated clock skew, in seconds. */
  leewaySeconds?: number;
}

/**
 * Verifies signature and expiry, then returns the claims.
 *
 * The signature is checked before the payload is parsed or trusted, and comparison is
 * constant-time so the endpoint cannot be used as a signature oracle.
 */
export function verifyToken(token: string, key: string, opts: VerifyOptions = {}): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AppError('UNAUTHORIZED', 'Malformed token');

  const [header, payload, signature] = parts as [string, string, string];

  const expected = Buffer.from(sign(payload, key), 'base64url');
  const provided = Buffer.from(signature, 'base64url');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new AppError('UNAUTHORIZED', 'Invalid token signature');
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('UNAUTHORIZED', 'Malformed token payload');
  }

  for (const field of ['sub', 'orgId', 'role', 'iat', 'exp', 'jti'] as const) {
    if (claims[field] === undefined || claims[field] === null) {
      throw new AppError('UNAUTHORIZED', `Token missing claim: ${field}`);
    }
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (claims.exp + (opts.leewaySeconds ?? 30) < now) {
    throw new AppError('UNAUTHORIZED', 'Token expired');
  }

  return claims;
}

export function tokenFromHeader(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

// ─── Rate limiting ───────────────────────────────────────────────────────────

/**
 * Fixed-window limiter, keyed per identity.
 *
 * Its purpose is narrow: make credential stuffing against `/auth/login` impractical.
 * It is in-process, so a multi-instance deployment needs a shared store — stated
 * plainly rather than implied to be distributed.
 *
 * Login uses `blocked` + `hit` rather than `check`, because **only failures should
 * count**. A limiter that charges every attempt punishes the legitimate flow it is
 * supposed to protect: provisioning seven staff and collecting seven tokens would
 * exhaust the budget and lock the administrator out of their own service.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Records an attempt and reports whether it is over budget. */
  check(key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const existing = this.hits.get(key);

    if (!existing || existing.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfterMs: 0 };
    }

    existing.count++;
    if (existing.count > this.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now };
    }
    return { allowed: true, remaining: this.limit - existing.count, retryAfterMs: 0 };
  }

  /** Reports whether the key is over budget, without recording an attempt. */
  blocked(key: string, now = Date.now()): { blocked: boolean; retryAfterMs: number } {
    const existing = this.hits.get(key);
    if (!existing || existing.resetAt <= now) return { blocked: false, retryAfterMs: 0 };
    if (existing.count >= this.limit) return { blocked: true, retryAfterMs: existing.resetAt - now };
    return { blocked: false, retryAfterMs: 0 };
  }

  /** Records one *failed* attempt against a key. */
  hit(key: string, now = Date.now()): void {
    const existing = this.hits.get(key);
    if (!existing || existing.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    existing.count++;
  }

  /** Clears the failure record, for a successful authentication. */
  clear(key: string): void {
    this.hits.delete(key);
  }

  /** Drops expired windows so a long-running process does not grow without bound. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) {
        this.hits.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.hits.size;
  }

  reset(): void {
    this.hits.clear();
  }
}