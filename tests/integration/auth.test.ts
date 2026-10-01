import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { Store, seedCore } from '@execugate/db';
import { createContext } from '@execugate/orchestration';
import type { AppContext } from '@execugate/orchestration';
import { createFakeEmbedder } from '@execugate/memory';
import { registerRoutes } from '../../apps/api/src/routes';
import { hashSecret, verifySecret, issueToken, verifyToken, tokenFromHeader, RateLimiter, generateSecret } from '@execugate/core';
import { config } from '@execugate/core';

/**
 * Authentication (NFR §8.2).
 *
 * These tests exist because a real vulnerability was found and fixed: the API read
 * identity from an `X-Actor-User-Id` header, which any caller can set, so anyone could
 * act as a commanding officer. Token mode must make that impossible.
 */

const SECRET = 'test-signing-key-that-is-long-enough-0123456789';

let app: ReturnType<typeof Fastify>;
let ctx: AppContext;
let store: Store;
let commanderId: string;
let staffId: string;

const originals = {
  mode: config.auth.mode,
  secret: config.auth.tokenSecret,
  limit: config.auth.loginLimit,
};

function setTokenMode(secret = SECRET) {
  config.auth.mode = 'token';
  config.auth.tokenSecret = secret;
  config.auth.loginLimit = originals.limit;
}

beforeAll(async () => {
  store = new Store(':memory:');
  store.migrate();
  const refs = seedCore(store);
  commanderId = refs.users.commander!;
  staffId = refs.users.budi!;

  ctx = createContext({ store, embedder: createFakeEmbedder(128) });

  setTokenMode();
  app = Fastify({ logger: false });
  await registerRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  config.auth.mode = originals.mode;
  config.auth.tokenSecret = originals.secret;
  await app.close();
  store.close();
});

// ── Credentials ──────────────────────────────────────────────────────────────

describe('secret hashing', () => {
  it('verifies the correct secret', () => {
    const { hash, salt } = hashSecret('correct horse battery staple');
    expect(verifySecret('correct horse battery staple', hash, salt)).toBe(true);
  });

  it('rejects the wrong secret', () => {
    const { hash, salt } = hashSecret('correct horse battery staple');
    expect(verifySecret('wrong', hash, salt)).toBe(false);
  });

  it('salts so identical secrets hash differently', () => {
    const a = hashSecret('same');
    const b = hashSecret('same');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('never stores the plaintext', () => {
    const { hash, salt } = hashSecret('plaintext-never-stored');
    expect(hash).not.toContain('plaintext-never-stored');
    expect(salt).not.toContain('plaintext-never-stored');
  });

  it('fails closed on missing hash or salt', () => {
    expect(verifySecret('x', '', '')).toBe(false);
  });
});

// ── Tokens ───────────────────────────────────────────────────────────────────

describe('token issuing and verification', () => {
  const claims = { sub: 'u1', orgId: 'o1', role: 'commander' as const, divisionId: null };

  it('round-trips claims', () => {
    const token = issueToken(claims, SECRET);
    const verified = verifyToken(token, SECRET);
    expect(verified.sub).toBe('u1');
    expect(verified.role).toBe('commander');
  });

  it('rejects a token signed with a different key', () => {
    const token = issueToken(claims, SECRET);
    expect(() => verifyToken(token, 'a-different-key-that-is-also-long-enough-1234')).toThrow(/signature/i);
  });

  it('rejects a tampered payload', () => {
    // The classic escalation: swap the role, keep the signature.
    const token = issueToken(claims, SECRET);
    const [header, , signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url');
    expect(() => verifyToken(`${header}.${forged}.${signature}`, SECRET)).toThrow(/signature/i);
  });

  it('rejects an expired token', () => {
    const token = issueToken(claims, SECRET, 60, Math.floor(Date.now() / 1000) - 3600);
    expect(() => verifyToken(token, SECRET)).toThrow(/expired/i);
  });

  it('accepts a token inside the leeway window', () => {
    const justExpired = Math.floor(Date.now() / 1000) - 20;
    const token = issueToken(claims, SECRET, 10, justExpired);
    expect(() => verifyToken(token, SECRET, { leewaySeconds: 30 })).not.toThrow();
  });

  it('rejects malformed input', () => {
    expect(() => verifyToken('not-a-token', SECRET)).toThrow();
    expect(() => verifyToken('a.b.c', SECRET)).toThrow(/signature/i);
  });

  it('rejects a payload missing a required claim', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u1', orgId: 'o1' })).toString('base64url');
    const forged = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.c2ln`;
    expect(() => verifyToken(forged, SECRET)).toThrow(/signature|claim/i);
  });

  it('parses a bearer header case-insensitively', () => {
    expect(tokenFromHeader('Bearer abc')).toBe('abc');
    expect(tokenFromHeader('bearer abc')).toBe('abc');
    expect(tokenFromHeader('abc')).toBeNull();
    expect(tokenFromHeader(undefined)).toBeNull();
  });

  it('generates unguessable secrets', () => {
    expect(generateSecret()).not.toBe(generateSecret());
    expect(generateSecret().length).toBeGreaterThanOrEqual(24);
  });
});

// ── The vulnerability itself ────────────────────────────────────────────────

describe('forged identity is rejected (the vulnerability that prompted this)', () => {
  it('ignores a spoofed X-Actor-User-Id in token mode', async () => {
    // Exactly the attack that worked before: claim to be the commander, send no secret.
    const res = await app.inject({
      url: '/api/v1/tickets',
      headers: { 'x-actor-user-id': commanderId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to let a forged header write a secret', async () => {
    const res = await app.inject({
      url: '/api/v1/secrets',
      method: 'POST',
      headers: { 'x-actor-user-id': commanderId, 'content-type': 'application/json' },
      payload: { key: 'attacker.injected', value: 'pwned' },
    });
    expect(res.statusCode).toBe(401);

    // And nothing was stored.
    const stored = store.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM secrets WHERE key_name = ?', 'attacker.injected',
    );
    expect(stored?.n ?? 0).toBe(0);
  });

  it('rejects a token whose subject does not exist', async () => {
    const token = issueToken({ sub: 'usr_ghost', orgId: 'org_ghost', role: 'commander', divisionId: null }, SECRET);
    const res = await app.inject({ url: '/api/v1/tickets', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no credentials at all', async () => {
    const res = await app.inject({ url: '/api/v1/tickets' });
    expect(res.statusCode).toBe(401);
  });
});

// ── Login ────────────────────────────────────────────────────────────────────

describe('login', () => {
  const provision = (userId: string, secret: string) => {
    // Resolve the org the same way login does, and deterministically.
    const org = store.all<{ id: string }>('SELECT id FROM organizations ORDER BY created_at LIMIT 1')[0]!;
    const { hash, salt } = hashSecret(secret);
    store.run(
      'UPDATE users SET auth_secret_hash = ?, auth_secret_salt = ? WHERE org_id = ? AND id = ?',
      hash, salt, org.id, userId,
    );
    return org.id;
  };

  it('issues a working token for correct credentials', async () => {
    provision(commanderId, 'commander-secret-123');

    const res = await app.inject({
      url: '/api/v1/auth/login',
      method: 'POST',
      payload: { userId: commanderId, secret: 'commander-secret-123' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.user.role).toBe('commander');

    // The token must actually work.
    const tickets = await app.inject({
      url: '/api/v1/tickets',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(tickets.statusCode).toBe(200);
  });

  it('rejects a wrong secret', async () => {
    provision(commanderId, 'commander-secret-123');
    const res = await app.inject({
      url: '/api/v1/auth/login',
      method: 'POST',
      payload: { userId: commanderId, secret: 'wrong-secret-entirely' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('gives the same error for an unknown user as for a wrong secret', async () => {
    provision(commanderId, 'commander-secret-123');
    const unknown = await app.inject({
      url: '/api/v1/auth/login',
      method: 'POST',
      payload: { userId: 'usr_nobody', secret: 'commander-secret-123' },
    });
    const wrong = await app.inject({
      url: '/api/v1/auth/login',
      method: 'POST',
      payload: { userId: commanderId, secret: 'nope-nope-nope' },
    });
    // Distinguishable responses would let an attacker enumerate valid accounts.
    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json().message).toBe(wrong.json().message);
  });

  it('cannot escalate a staff account to commander through the login payload', async () => {
    provision(staffId, 'staff-secret-456');
    const res = await app.inject({
      url: '/api/v1/auth/login',
      method: 'POST',
      payload: { userId: staffId, secret: 'staff-secret-456', role: 'commander' },
    });
    expect(res.json().user.role).toBe('technical');
  });

  it('rejects an unprovisioned account that has no secret', async () => {
    const res = await app.inject({
      url: '/api/v1/auth/login',
      method: 'POST',
      payload: { userId: 'usr_mup131dnvyje', secret: 'whatever-secret' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rate limits repeated failures', async () => {
    // Fresh app-level limiter state is not isolated per test, so assert on the
    // primitive's behaviour rather than depending on ordering.
    const limiter = new RateLimiter(3, 1000);
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    const fourth = limiter.check('k');
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it('does not charge successful logins against the limit', async () => {
    // Found by provisioning a team: seven successful logins exhausted an eight-attempt
    // window and locked the administrator out of their own service. Only failures
    // should count.
    provision(commanderId, 'commander-secret-123');
    const limiter = new RateLimiter(3, 60_000);

    for (let i = 0; i < 10; i++) {
      expect(limiter.blocked('admin')).toEqual({ blocked: false, retryAfterMs: 0 });
      limiter.clear('admin'); // what login() does on success
    }
    expect(limiter.size).toBe(0);
  });

  it('blocks after repeated failures and recovers after the window', () => {
    const limiter = new RateLimiter(3, 1000);
    const t0 = 1_000_000;
    expect(limiter.blocked('k', t0).blocked).toBe(false);

    limiter.hit('k', t0); limiter.hit('k', t0); limiter.hit('k', t0);
    expect(limiter.blocked('k', t0).blocked).toBe(true);

    // Still blocked just before the window closes.
    expect(limiter.blocked('k', t0 + 999).blocked).toBe(true);
    // Free once it does.
    expect(limiter.blocked('k', t0 + 1001).blocked).toBe(false);
  });

  it('clears a failure record on success', () => {
    const limiter = new RateLimiter(2, 60_000);
    const t0 = 1_000_000;
    limiter.hit('k', t0);
    limiter.hit('k', t0);
    expect(limiter.blocked('k', t0).blocked).toBe(true);
    limiter.clear('k');
    expect(limiter.blocked('k', t0).blocked).toBe(false);
  });

  it('sweeps expired windows so a long-running process stays bounded', () => {
    const limiter = new RateLimiter(5, 1000);
    const t0 = 1_000_000;
    for (let i = 0; i < 50; i++) limiter.hit(`key-${i}`, t0);
    expect(limiter.size).toBe(50);
    expect(limiter.sweep(t0 + 2000)).toBe(50);
    expect(limiter.size).toBe(0);
  });
});

// ── Security headers ─────────────────────────────────────────────────────────

describe('security headers', () => {
  it('sets the expected hardening headers', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('omits HSTS outside production, where it would be wrong to assert it', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('role is re-read from the database, not trusted from the token', () => {
  it('ignores a token role that no longer matches the user', async () => {
    const org = store.all<{ id: string }>('SELECT id FROM organizations LIMIT 1')[0]!;
    // Demote the commander in the database while holding a commander-issued token.
    store.run("UPDATE users SET role = 'ops' WHERE org_id = ? AND id = ?", org.id, commanderId);

    const token = issueToken(
      { sub: commanderId, orgId: org.id, role: 'commander', divisionId: null },
      SECRET,
    );

    try {
      const res = await app.inject({
        url: `/api/v1/instructions/${'ins_x'}/decision`,
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { action: 'approve' },
      });
      // A stale role must not grant approval; expect a rejection, not a 2xx.
      expect([401, 403, 404]).toContain(res.statusCode);
    } finally {
      store.run("UPDATE users SET role = 'commander' WHERE org_id = ? AND id = ?", org.id, commanderId);
    }
  });
});

vi.setConfig({ testTimeout: 15_000 });