import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { Store, seedCore } from '@execugate/db';
import { createContext } from '@execugate/orchestration';
import type { AppContext } from '@execugate/orchestration';
import { createFakeEmbedder } from '@execugate/memory';
import { registerRoutes } from '../../apps/api/src/routes';

/**
 * HTTP-level tests via Fastify's inject().
 *
 * These cover the shape of the contract the dashboard and any future client depend
 * on. Several real defects surfaced here that unit tests could not see: query
 * parameters being declared as `z.number()` (unreachable, since query values are
 * always strings), and a body-less POST carrying a JSON content-type.
 */

let app: ReturnType<typeof Fastify>;
let ctx: AppContext;
let store: Store;
let scope: { orgId: string };
let commander: string;
let staff: string;

beforeAll(async () => {
  store = new Store(':memory:');
  store.migrate();
  const refs = seedCore(store);
  scope = { orgId: refs.orgId };
  commander = refs.users.commander!;
  staff = refs.users.budi!;

  ctx = createContext({ store, embedder: createFakeEmbedder(256) });
  app = Fastify({ logger: false });
  await registerRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  store.close();
});

/** `inject` takes Fastify's own request options, which differ from RequestInit. */
type InjectOpts = { method?: string; payload?: unknown; headers?: Record<string, string> };

const asCommander = (url: string, init: InjectOpts = {}) =>
  app.inject({
    url,
    method: (init.method ?? 'GET') as 'GET',
    payload: init.payload as never,
    headers: { 'x-actor-user-id': commander, ...(init.headers ?? {}) },
  });

describe('health', () => {
  it('serves liveness without an actor', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('reports readiness with per-provider detail', async () => {
    const res = await app.inject({ url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toHaveProperty('embedder');
    expect(res.json().checks).toHaveProperty('llm');
    expect(res.json().checks).toHaveProperty('asr');
  });
});

describe('identity', () => {
  it('rejects a request with no actor', async () => {
    const res = await app.inject({ url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('rejects an unknown actor rather than defaulting to a role', async () => {
    const res = await app.inject({ url: '/api/v1/me', headers: { 'x-actor-user-id': 'usr_does_not_exist' } });
    expect(res.statusCode).toBe(401);
  });

  it('requires an actor for the roster, which the actor switcher still satisfies', async () => {
    // This used to be deliberately unauthenticated so the dashboard's actor switcher
    // could populate itself before anyone logged in. That was the wrong trade: it
    // published every staff member's name, role and division to any anonymous caller,
    // and it always returned the *first* organisation rather than the caller's, so on a
    // multi-tenant deployment it leaked another tenant's roster outright.
    //
    // Nothing needs the anonymous behaviour: in dev mode the switcher sends
    // X-Actor-User-Id, and in token mode the user authenticates first.
    const anonymous = await app.inject({ url: '/api/v1/roster' });
    expect(anonymous.statusCode).toBe(401);

    const res = await asCommander('/api/v1/roster');
    expect(res.statusCode).toBe(200);
    const roster = res.json() as Array<{ id: string; role: string }>;
    expect(roster.length).toBeGreaterThan(0);
    // Ids are needed by the client; external ids and emails must not leak.
    expect(roster[0]).toHaveProperty('id');
    expect(JSON.stringify(roster)).not.toContain('external_id');
  });

  it('resolves the role from the stored user, never from the request', async () => {
    const res = await asCommander('/api/v1/me?role=admin');
    expect(res.json().role).toBe('commander');
  });
});

describe('tickets', () => {
  it('accepts a status filter and coerces it', async () => {
    const res = await asCommander('/api/v1/tickets?status=COMPLETED');
    expect(res.statusCode).toBe(200);
    for (const t of res.json() as Array<{ status: string }>) expect(t.status).toBe('COMPLETED');
  });

  it('rejects an unknown status with a 400 rather than silently ignoring it', async () => {
    const res = await asCommander('/api/v1/tickets?status=NONSENSE');
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a ticket from another tenant', async () => {
    const res = await asCommander('/api/v1/tickets/tic_missing');
    expect(res.statusCode).toBe(404);
  });

  it('returns a structured error body, never a stack trace', async () => {
    const res = await asCommander('/api/v1/tickets/tic_missing');
    const body = res.json();
    expect(body).toHaveProperty('code');
    expect(body).toHaveProperty('message');
    expect(JSON.stringify(body)).not.toContain('at Object.');
  });

  it('answers an unknown route with a structured 404', async () => {
    const res = await asCommander('/api/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

describe('numeric query parameters', () => {
  // Regression: query values are always strings, so `z.number()` fails for every caller.
  it('coerces limit on the audit endpoint', async () => {
    const res = await asCommander('/api/v1/audit?limit=60');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('coerces limit on the messages endpoint', async () => {
    const res = await asCommander('/api/v1/messages?limit=10');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('still rejects a limit that is not a number', async () => {
    const res = await asCommander('/api/v1/audit?limit=abc');
    expect(res.statusCode).toBe(400);
  });

  it('rejects an out-of-range limit', async () => {
    expect((await asCommander('/api/v1/audit?limit=100000')).statusCode).toBe(400);
  });
});

describe('intake and approval', () => {
  it('runs FR-01.3 -> FR-03.1 and reports timing', async () => {
    const res = await asCommander('/api/v1/instructions/text', {
      method: 'POST',
      payload: { text: 'Besok pagi deploy payment service ya, sekalian update SOP reconciliation, Mas Budi yang infra' },
    });
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.tickets.length).toBeGreaterThanOrEqual(2);
    for (const t of body.tickets) expect(t.status).toBe('PENDING_APPROVAL');
    expect(body.timing.ttftMs).toBeGreaterThanOrEqual(0);
    expect(body.approvalCard.text).toContain('KARTU OTORISASI');
    expect(body.approvalCard.actions).toHaveLength(3);

    // FR-03.1: nothing may reach ASSIGNED before approval.
    expect(body.tickets.some((t: { status: string }) => t.status === 'ASSIGNED')).toBe(false);
  });

  it('rejects an instruction too short to be actionable', async () => {
    const res = await asCommander('/api/v1/instructions/text', { method: 'POST', payload: { text: 'hi' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a correct decision with no changes attached', async () => {
    const res = await asCommander('/api/v1/instructions/ins_missing/decision', {
      method: 'POST',
      payload: { action: 'correct' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('is idempotent on a repeated approval', async () => {
    const created = await asCommander('/api/v1/instructions/text', {
      method: 'POST',
      payload: { text: 'Tolong update SOP rekonsiliasi besok' },
    });
    const { instructionId } = created.json();

    const first = await asCommander(`/api/v1/instructions/${instructionId}/decision`, {
      method: 'POST', payload: { action: 'approve' },
    });
    expect(first.json().dispatched.length).toBeGreaterThan(0);

    const second = await asCommander(`/api/v1/instructions/${instructionId}/decision`, {
      method: 'POST', payload: { action: 'approve' },
    });
    expect(second.json().alreadyProcessed).toBe(true);
    expect(second.json().dispatched).toHaveLength(0);
  });

  it('refuses approval from a staff account (FR-03.1 governance)', async () => {
    const created = await asCommander('/api/v1/instructions/text', {
      method: 'POST', payload: { text: 'Deploy payment service besok' },
    });
    const { instructionId } = created.json();

    const res = await app.inject({
      url: `/api/v1/instructions/${instructionId}/decision`,
      method: 'POST',
      headers: { 'x-actor-user-id': staff },
      payload: { action: 'approve' } as never,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('body-less POSTs', () => {
  // Regression: a JSON content-type with no body makes Fastify reject the request.
  it('accepts a JSON content-type on an ack with no body', async () => {
    const created = await asCommander('/api/v1/instructions/text', {
      method: 'POST', payload: { text: 'Deploy payment service besok sekalian update SOP rekonsiliasi' },
    });
    const { instructionId } = created.json();
    const approved = await asCommander(`/api/v1/instructions/${instructionId}/decision`, {
      method: 'POST', payload: { action: 'approve' },
    });

    const techDivision = store.get<{ id: string }>(
      "SELECT id FROM divisions WHERE org_id = ? AND kind = 'technical'", scope.orgId,
    )!.id;

    const techTicket = (approved.json().dispatched as Array<{ id: string; divisionId: string }>)
      .find((t) => t.divisionId === techDivision);
    expect(techTicket, 'approval should produce a technical ticket').toBeDefined();

    const res = await app.inject({
      url: `/api/v1/tickets/${techTicket!.id}/ack`,
      method: 'POST',
      headers: { 'x-actor-user-id': staff, 'content-type': 'application/json' },
    });
    expect(res.json()).toMatchObject({ code: expect.any(String) });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('IN_PROGRESS');
  });
});

describe('memory search', () => {
  it('returns query-anchored excerpts, not a chunk prefix', async () => {
    const uploaded = await asCommander('/api/v1/documents', {
      method: 'POST',
      payload: {
        title: 'Dokumen Kapasitas Uji',
        body: '# Kapasitas\n\nPembahasan panjang yang tidak relevan sama sekali.\n\n## Batas Kapasitas\n\n| Parameter | Nilai |\n|---|---|\n| Batas payload request | 512 KB | Body JSON |\n\n## Penutup\n\nTeks penutup yang juga tidak relevan.',
      },
    });
    expect(uploaded.statusCode).toBe(201);

    const res = await asCommander('/api/v1/documents/search', {
      method: 'POST',
      payload: { query: 'batas kapasitas payload request', limit: 4 },
    });
    expect(res.statusCode).toBe(200);

    const chunks = res.json().chunks as Array<{ excerpt: string }>;
    expect(chunks.length).toBeGreaterThan(0);
    // A prefix excerpt would omit the value the query asked about.
    expect(chunks.some((c) => c.excerpt.includes('512 KB'))).toBe(true);
  });

  it('reports which retriever matched each chunk', async () => {
    const res = await asCommander('/api/v1/documents/search', {
      method: 'POST', payload: { query: 'payload', limit: 4 },
    });
    const chunks = res.json().chunks as Array<{ matchedBy: string }>;
    for (const c of chunks) expect(['vector', 'fts', 'both']).toContain(c.matchedBy);
  });

  it('returns nothing rather than inventing results', async () => {
    const res = await asCommander('/api/v1/documents/search', {
      method: 'POST', payload: { query: 'zzzznotpresent' },
    });
    expect(res.json().chunks).toHaveLength(0);
  });
});

describe('reporting and metrics', () => {
  it('builds a walkthrough with a rendered chat message', async () => {
    const res = await asCommander('/api/v1/reports/walkthrough');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rendered).toContain('LAPORAN PROGRES');
    expect(body.counts).toHaveProperty('completed');
  });

  it('rejects a walkthrough trigger phrase that is not one', async () => {
    const res = await asCommander('/api/v1/walkthrough/trigger', { method: 'POST', payload: { text: 'halo' } });
    expect(res.statusCode).toBe(400);
  });

  it('reports a false-completion count of zero', async () => {
    const res = await asCommander('/api/v1/metrics');
    const kpis = res.json().kpis as Record<string, number>;
    expect(kpis['kpi.false_completion_24h']).toBe(0);
  });

  it('never returns secret values, only key names', async () => {
    await asCommander('/api/v1/secrets', { method: 'POST', payload: { key: 'github.token', value: 'ghp_secretvalue1234567890' } });
    const res = await asCommander('/api/v1/secrets');
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('ghp_secretvalue');
    expect(res.json()[0].key_name).toBe('github.token');
  });
});