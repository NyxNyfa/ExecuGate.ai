import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { Store, seedCore } from '@execugate/db';
import { createContext } from '@execugate/orchestration';
import type { AppContext } from '@execugate/orchestration';
import { createFakeEmbedder } from '@execugate/memory';
import { registerRoutes } from '../../apps/api/src/routes';
import { config } from '@execugate/core';

/**
 * HTTP transport contract.
 *
 * Each case here is a mistake a real client makes. The suite's other value is
 * regression: the empty-body parser and the status-code preservation were both wrong
 * in ways that only surfaced when a shell script called the API the way an operator
 * would rather than the way the test helper does.
 */

let app: ReturnType<typeof Fastify>;
let ctx: AppContext;
let store: Store;
let commanderId: string;

const originals = { requireTls: config.requireTls };

beforeAll(async () => {
  store = new Store(':memory:');
  store.migrate();
  const refs = seedCore(store);
  commanderId = refs.users.commander!;
  ctx = createContext({ store, embedder: createFakeEmbedder(128) });
  app = Fastify({ logger: false });
  await registerRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  config.requireTls = originals.requireTls;
  await app.close();
  store.close();
});

describe('bodyless POST is accepted however the client declares it', () => {
  // `curl -X POST .../ack` sends neither a body nor a content-type. Fastify rejects
  // that with 415 by default, which made the most natural way to call these endpoints
  // fail. The web client hit the same class of bug earlier.
  const shapes: Array<[string, Record<string, string>]> = [
    ['no content-type at all', {}],
    ['content-type json, empty body', { 'content-type': 'application/json' }],
    ['content-type json with charset', { 'content-type': 'application/json; charset=utf-8' }],
    ['content-type text/plain, empty', { 'content-type': 'text/plain' }],
  ];

  for (const [label, headers] of shapes) {
    it(label, async () => {
      const res = await app.inject({
        url: '/api/v1/tickets/tkt_missing/ack',
        method: 'POST',
        headers: { 'x-actor-user-id': commanderId, ...headers },
      });
      // 404 (ticket absent) proves the body was parsed, the actor resolved and the
      // handler ran. 415 or a media-type message would mean the request died at the
      // transport layer, which is the bug this test exists for.
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
    });
  }

  it('still rejects malformed JSON rather than swallowing it', async () => {
    const res = await app.inject({
      url: '/api/v1/instructions/text',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-user-id': commanderId },
      payload: '{"text": ',
    });
    // A truncated payload is a client bug, not an empty body: it must not pass.
    expect(res.statusCode).toBe(400);
  });

  it('parses a well-formed JSON body normally', async () => {
    const res = await app.inject({
      url: '/api/v1/instructions/text',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-user-id': commanderId },
      payload: { text: 'besok deploy payment service ya' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('transport errors keep their own HTTP status', () => {
  // Deriving the status purely from the error code collapsed everything into 400:
  // a caller could not tell "send JSON" from "your upload is too big".
  it('preserves 413 for an oversized body instead of flattening it to 400', async () => {
    const local = Fastify({ logger: false, bodyLimit: 1024 });
    await registerRoutes(local, ctx);
    await local.ready();

    const res = await local.inject({
      url: '/api/v1/instructions/text',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-user-id': commanderId },
      payload: 'x'.repeat(4096),
    });

    // Before the fix every transport error became 400, so a client could not tell
    // "send JSON" from "your upload is too big".
    expect(res.statusCode).toBe(413);
    await local.close();
  });

  it('preserves 404 for an unknown route', async () => {
    const res = await app.inject({ url: '/api/v1/not-a-real-endpoint', headers: { 'x-actor-user-id': commanderId } });
    expect(res.statusCode).toBe(404);
  });
});

describe('TLS enforcement', () => {
  it('rejects plain HTTP when TLS is required', async () => {
    const local = Fastify({ logger: false });
    config.requireTls = true;
    try {
      await registerRoutes(local, ctx);
      await local.ready();

      const res = await local.inject({ url: '/api/v1/tickets', headers: { 'x-actor-user-id': commanderId } });
      expect(res.statusCode).toBe(426);
      expect(res.json().message).toMatch(/https/i);
    } finally {
      config.requireTls = false;
      await local.close();
    }
  });

  it('keeps the probes reachable so a deploy can drain traffic', async () => {
    const local = Fastify({ logger: false });
    config.requireTls = true;
    try {
      await registerRoutes(local, ctx);
      await local.ready();

      // A load balancer polling over the internal network must not get a 426, or a
      // rolling deploy would take the instance out of rotation for the wrong reason.
      expect((await local.inject({ url: '/health' })).statusCode).toBe(200);
      expect([200, 503]).toContain((await local.inject({ url: '/ready' })).statusCode);
    } finally {
      config.requireTls = false;
      await local.close();
    }
  });

  it('accepts a request a trusted proxy marked as https', async () => {
    const local = Fastify({ logger: false, trustProxy: true });
    config.requireTls = true;
    try {
      await registerRoutes(local, ctx);
      await local.ready();

      const res = await local.inject({
        url: '/api/v1/tickets',
        headers: { 'x-forwarded-proto': 'https', 'x-actor-user-id': commanderId },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      config.requireTls = false;
      await local.close();
    }
  });

  it('serves plain HTTP when TLS is not required', async () => {
    config.requireTls = false;
    const res = await app.inject({ url: '/api/v1/tickets', headers: { 'x-actor-user-id': commanderId } });
    expect(res.statusCode).toBe(200);
  });
});

