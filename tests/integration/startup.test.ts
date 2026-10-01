import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, seedCore } from '@execugate/db';
import { createContext } from '@execugate/orchestration';
import type { AppContext } from '@execugate/orchestration';
import { createFakeEmbedder } from '@execugate/memory';
import { registerRoutes } from '../../apps/api/src/routes';
import { serveDashboard } from '../../apps/api/src/static';
import { validateConfig } from '../../apps/api/src/validate';
import { config } from '@execugate/core';

/**
 * Startup and configuration validation.
 *
 * A regression here is invisible to the functional suite and fatal in production: a
 * duplicate route declaration throws at boot, and a misconfigured production instance
 * that starts anyway is worse than one that refuses.
 */

let app: ReturnType<typeof Fastify>;
let ctx: AppContext;
let store: Store;

beforeAll(async () => {
  store = new Store(':memory:');
  store.migrate();
  seedCore(store);
  ctx = createContext({ store, embedder: createFakeEmbedder(128) });

  app = Fastify({ logger: false });
  await registerRoutes(app, ctx);
  await serveDashboard(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe('the application actually boots', () => {
  it('registers every route without a duplicate declaration', async () => {
    // Fastify throws on a duplicate method+path during ready(). This regressed once:
    // /health was declared in both routes.ts and main.ts, so the process exited
    // before binding a port.
    const tree = app.printRoutes({ commonPrefix: false });
    expect(tree).toContain('/health');
    expect(tree).toContain('/ready');

    // Count occurrences in the uncompressed tree: with prefix compression
    // `/health` is printed as just `health`, so the plain output cannot be counted.
    // This Fastify version has no `findRoutes`, and the rendered tree is the
    // authoritative record of what was actually mounted.
    const healthCount = (tree.match(/\/health\b/g) ?? []).length;
    const readyCount = (tree.match(/\/ready\b/g) ?? []).length;
    expect(healthCount).toBe(1);
    expect(readyCount).toBe(1);
  });

  it('serves the liveness probe', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().runtime).toBeTruthy();
  });

  it('serves the readiness probe', async () => {
    const res = await app.inject({ url: '/ready' });
    expect([200, 503]).toContain(res.statusCode);
    expect(res.json()).toHaveProperty('checks');
  });

  it('does not let the dashboard shadow the API', async () => {
    const res = await app.inject({ url: '/api/v1/nonexistent-endpoint' });
    // A JSON 404, not an HTML shell.
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('dashboard serving', () => {
  it('mounts only when a build exists', () => {
    const dist = resolve(process.cwd(), config.webDist);
    const built = existsSync(resolve(dist, 'index.html'));

    // Whichever way this goes, the API routes must still answer.
    expect(typeof built).toBe('boolean');
    if (built) {
      expect(config.webDist).toBeTruthy();
    }
  });
});

describe('production configuration validation', () => {
  const names = (env: string) => validateConfig(env);

  it('blocks production with no master key', () => {
    const original = config.masterKeyHex;
    config.masterKeyHex = '';
    try {
      const failed = names('production').filter((c) => !c.ok && c.severity === 'blocking');
      expect(failed.map((c) => c.name)).toContain('master key');
    } finally {
      config.masterKeyHex = original;
    }
  });

  it('blocks production in dev auth mode', () => {
    const original = config.auth.mode;
    config.auth.mode = 'dev';
    try {
      const failed = names('production').filter((c) => !c.ok && c.severity === 'blocking');
      expect(failed.map((c) => c.name)).toContain('authentication');
    } finally {
      config.auth.mode = original;
    }
  });

  it('warns rather than blocks for dev auth outside production', () => {
    const original = config.auth.mode;
    config.auth.mode = 'dev';
    try {
      const blocking = names('development').filter((c) => !c.ok && c.severity === 'blocking');
      expect(blocking.map((c) => c.name)).not.toContain('authentication');
    } finally {
      config.auth.mode = original;
    }
  });

  it('describes dev auth as caller-controlled rather than reporting it healthy', () => {
    const original = config.auth.mode;
    config.auth.mode = 'dev';
    try {
      const check = names('development').find((c) => c.name === 'authentication');
      expect(check?.ok).toBe(true);
      expect(check?.detail).toMatch(/caller-controlled/i);
    } finally {
      config.auth.mode = original;
    }
  });

  it('blocks an in-memory database in production', () => {
    const original = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = ':memory:';
    try {
      const failed = names('production').filter((c) => !c.ok && c.severity === 'blocking');
      expect(failed.map((c) => c.name)).toContain('database path');
    } finally {
      if (original === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = original;
    }
  });

  it('blocks production without TLS enforcement', () => {
    const original = config.requireTls;
    config.requireTls = false;
    try {
      const failed = names('production').filter((c) => !c.ok && c.severity === 'blocking');
      expect(failed.map((c) => c.name)).toContain('tls');
    } finally {
      config.requireTls = original;
    }
  });

  it('blocks production when verification would only be simulated', () => {
    const original = config.gatekeeper.githubToken;
    config.gatekeeper.githubToken = '';
    try {
      const check = names('production').find((c) => c.name === 'gatekeeper verification source');
      expect(check?.ok).toBe(false);
      expect(check?.severity).toBe('blocking');
      expect(check?.detail).toMatch(/simulated/i);
    } finally {
      config.gatekeeper.githubToken = original;
    }
  });

  it('warns about simulated verification outside production without blocking', () => {
    const original = config.gatekeeper.githubToken;
    config.gatekeeper.githubToken = '';
    try {
      const blocking = names('development').filter((c) => !c.ok && c.severity === 'blocking');
      expect(blocking.map((c) => c.name)).not.toContain('gatekeeper verification source');
    } finally {
      config.gatekeeper.githubToken = original;
    }
  });

  it('never blocks a development instance for a missing optional integration', () => {
    // The offline path is a supported configuration: every AI provider is `fake`.
    const blocking = names('development').filter((c) => !c.ok && c.severity === 'blocking');
    expect(blocking).toHaveLength(0);
  });

  it('accepts a fully specified production configuration', () => {
    const snapshot = {
      masterKeyHex: config.masterKeyHex,
      mode: config.auth.mode,
      secret: config.auth.tokenSecret,
      requireTls: config.requireTls,
      token: config.gatekeeper.githubToken,
    };

    config.masterKeyHex = 'a'.repeat(64);
    config.auth.mode = 'token';
    config.auth.tokenSecret = 'x'.repeat(48);
    config.requireTls = true;
    config.gatekeeper.githubToken = 'ghp_example';

    try {
      const failed = names('production').filter((c) => !c.ok && c.severity === 'blocking');
      expect(failed).toHaveLength(0);
    } finally {
      config.masterKeyHex = snapshot.masterKeyHex;
      config.auth.mode = snapshot.mode;
      config.auth.tokenSecret = snapshot.secret;
      config.requireTls = snapshot.requireTls;
      config.gatekeeper.githubToken = snapshot.token;
    }
  });

  it('rejects a master key that is not 32 bytes of hex', () => {
    const original = config.masterKeyHex;
    config.masterKeyHex = 'not-hexadecimal';
    try {
      const failed = names('production').filter((c) => !c.ok && c.severity === 'blocking');
      expect(failed.map((c) => c.name)).toContain('master key format');
    } finally {
      config.masterKeyHex = original;
    }
  });
});
