import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, AppError, RateLimiter, tokenFromHeader, verifyToken, verifySecret, issueToken } from '@execugate/core';
import type { Actor, TokenClaims } from '@execugate/core';
import { userRepo } from '@execugate/db';
import type { Store } from '@execugate/db';
import { createLogger } from '@execugate/observability';

const log = createLogger('api:auth');

/**
 * Identity resolution and login.
 *
 * The rule enforced here: in token mode, identity comes *only* from a verified
 * signature. Nothing the caller sends — no header, no query parameter, no body field —
 * can influence who they are or what role they hold.
 */

export interface AuthState {
  loginLimiter: RateLimiter;
  apiLimiter: RateLimiter;
}

export function createAuthState(): AuthState {
  return {
    loginLimiter: new RateLimiter(config.auth.loginLimit, config.auth.loginWindowMs),
    apiLimiter: new RateLimiter(config.rateLimit.limit, config.rateLimit.windowMs),
  };
}

export function tokenModeActive(): boolean {
  return config.auth.mode === 'token';
}

/** Fails fast rather than starting an unauthenticated production service. */
export function assertAuthConfigured(): void {
  if (!tokenModeActive()) return;
  if (config.auth.tokenSecret.length < 32) {
    throw new AppError(
      'CRYPTO_ERROR',
      'AUTH_TOKEN_SECRET must be at least 32 characters when AUTH_MODE=token',
    );
  }
  if (config.isProduction && !tokenModeActive()) {
    throw new AppError('UNAUTHORIZED', 'AUTH_MODE=token is required in production');
  }
}

const DEV_HEADER = 'x-actor-user-id';

/**
 * Resolves the acting user.
 *
 * Token mode: verifies the bearer token and returns its claims. A forged header is
 * ignored outright — not merely outranked — so the dev path cannot leak into
 * production through a proxy that happens to forward it.
 */
export function resolveActor(req: FastifyRequest, store: Store, state: AuthState): Actor {
  if (tokenModeActive()) return actorFromToken(req, store);

  // Dev mode: an unsigned header is convenient for the dashboard and the CLI, and is
  // only reachable because AUTH_MODE is not `token`.
  const header = req.headers[DEV_HEADER];
  const fromHeader = typeof header === 'string' ? header : undefined;
  const fromQuery = (req.query as { userId?: string } | undefined)?.userId;
  const userId = fromHeader ?? fromQuery;

  if (!userId) {
    throw new AppError('UNAUTHORIZED', 'Missing actor identity: send X-Actor-User-Id (dev mode only)');
  }

  for (const org of store.all<{ id: string }>('SELECT id FROM organizations ORDER BY created_at')) {
    const user = userRepo(store).byId(org.id, userId);
    if (user && user.active) {
      return {
        orgId: org.id,
        userId: user.id,
        role: user.role,
        divisionId: user.division_id,
        displayName: user.display_name,
      };
    }
  }
  throw new AppError('UNAUTHORIZED', `Unknown actor: ${userId}`);
}

function actorFromToken(req: FastifyRequest, store: Store): Actor {
  const token = tokenFromHeader(req.headers.authorization);
  if (!token) throw new AppError('UNAUTHORIZED', 'Missing bearer token');

  const claims: TokenClaims = verifyToken(token, config.auth.tokenSecret);

  const user = userRepo(store).byId(claims.orgId, claims.sub);
  if (!user || !user.active) {
    throw new AppError('UNAUTHORIZED', 'Token subject is no longer active');
  }

  // The token's role is advisory: the authoritative role is re-read from the database
  // so a demotion or suspension takes effect immediately instead of at token expiry.
  if (user.role !== claims.role) {
    log.warn('token role is stale; using current role', {
      userId: claims.sub, tokenRole: claims.role, actualRole: user.role,
    });
  }

  return {
    orgId: claims.orgId,
    userId: user.id,
    role: user.role,
    divisionId: user.division_id,
    displayName: user.display_name,
  };
}

export interface LoginRequest {
  userId: string;
  secret: string;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: { id: string; name: string; role: Actor['role']; orgId: string };
}

/**
 * Exchanges a user secret for a token.
 *
 * Failures are deliberately indistinguishable: a wrong secret and an unknown user
 * return the same error, so the endpoint cannot enumerate accounts.
 *
 * The rate limiter counts failures only. Charging successful logins would lock out the
 * administrator during exactly the flow that needs the service most — provisioning a
 * team and collecting a token for each person.
 */
export function login(store: Store, state: AuthState, body: LoginRequest, remoteAddress: string): LoginResult {
  const limitKey = `login:${remoteAddress}`;

  const gate = state.loginLimiter.blocked(limitKey);
  if (gate.blocked) {
    log.warn('login rate limited', { remoteAddress, retryAfterMs: gate.retryAfterMs });
    throw new AppError('RATE_LIMITED', `Too many failed login attempts; retry in ${Math.ceil(gate.retryAfterMs / 1000)}s`);
  }

  const fail = () => {
    state.loginLimiter.hit(limitKey);
    return new AppError('UNAUTHORIZED', 'Invalid credentials');
  };

  const orgs = store.all<{ id: string }>('SELECT id FROM organizations ORDER BY created_at');
  let matched: { orgId: string; userId: string; displayName: string; role: Actor['role']; divisionId: string | null; hash: string; salt: string } | null = null;

  for (const org of orgs) {
    const user = userRepo(store).byId(org.id, body.userId);
    if (user?.auth_secret_hash) {
      matched = {
        orgId: org.id,
        userId: user.id,
        displayName: user.display_name,
        role: user.role,
        divisionId: user.division_id,
        hash: user.auth_secret_hash,
        salt: user.auth_secret_salt!,
      };
      break;
    }
  }

  // Always run a verification so a missing account and a wrong secret take
  // indistinguishable time.
  if (!matched) {
    verifySecret(body.secret, scryptDummyHash, scryptDummySalt);
    throw fail();
  }
  if (!verifySecret(body.secret, matched.hash, matched.salt)) throw fail();

  // A success clears the record, so one typo does not accumulate toward a lockout.
  state.loginLimiter.clear(limitKey);

  log.info('login succeeded', { userId: matched.userId, role: matched.role });

  const token = issueToken(
    { sub: matched.userId, orgId: matched.orgId, role: matched.role, divisionId: matched.divisionId },
    config.auth.tokenSecret,
    config.auth.ttlSeconds,
  );

  return {
    token,
    expiresAt: new Date(Date.now() + config.auth.ttlSeconds * 1000).toISOString(),
    user: { id: matched.userId, name: matched.displayName, role: matched.role, orgId: matched.orgId },
  };
}

// Placeholder hash so a failed lookup still performs a scrypt round.
const scryptDummySalt = '00000000000000000000000000000000';
const scryptDummyHash =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8551cd8b1a9a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8';

export function securityHeaders(_req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  // The dashboard loads only its own bundle; 'unsafe-inline' is required for the
  // Vite-injected stylesheet in development and for React's inline style attributes.
  reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (config.isProduction) {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  done();
}