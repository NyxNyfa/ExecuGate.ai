import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, AppError, validationFailed, describeRuntime, toAppError } from '@execugate/core';
import type { Actor, OrgScope, TicketStatus } from '@execugate/core';
import {
  ticketRepo, eventRepo, dodRepo, verificationRepo, clarificationRepo,
  auditRepo, documentRepo, metricsRepo, userRepo, divisionRepo, projectRepo,
  orgRepo, messageRepo, secretRepo, idempotencyRepo, jobRepo,
} from '@execugate/db';
import {
  intakeInstruction, handleApproval, acknowledgeTicket, askClarification,
  submitEvidence, runGatekeeper, manualVerification, buildWalkthrough,
  computeKpis, isWalkthroughRequest, collectDispatchable, referenceDocs, buildTicketCardData,
  loadRoster,
} from '@execugate/orchestration';
import { ingestDocument, retrieve, buildExcerpt } from '@execugate/memory';
import { renderApprovalCard, renderWalkthrough, priorityLabel } from '@execugate/channels';
import {
  createAuthState, resolveActor as resolveActorRequest, assertAuthConfigured,
  login, tokenModeActive, securityHeaders,
} from './auth.ts';
import type { AuthState } from './auth.ts';
import { createLogger } from '@execugate/observability';
import type { AppContext } from '@execugate/orchestration';

const log = createLogger('api:routes');

/**
 * Identity (BUILD_PLAN §10, §11).
 *
 * In token mode this reads a verified bearer token only. The `X-Actor-User-Id` header
 * is consulted *only* when AUTH_MODE=dev, because that header is caller-controlled:
 * trusting it anywhere reachable is how an unauthenticated caller impersonates a
 * commanding officer. See `apps/api/src/auth.ts`.
 */
function resolveActor(ctx: AppContext, req: { headers: Record<string, unknown>; query?: unknown }, state?: AuthState): Actor {
  return resolveActorRequest(req as never, ctx.store, state ?? createAuthState());
}

const scopeOf = (actor: Actor): OrgScope => ({ orgId: actor.orgId });

const TicketQuery = z.object({
  status: z.union([z.enum(['DRAFT', 'PENDING_APPROVAL', 'ASSIGNED', 'IN_PROGRESS', 'QA_VERIFICATION', 'REWORK_REQUIRED', 'COMPLETED', 'CANCELLED']), z.array(z.string())]).optional(),
  divisionId: z.string().optional(),
  assigneeId: z.string().optional(),
});

/**
 * Query parameters always arrive as strings, so numeric bounds must be coerced.
 * Using `z.number()` here makes the endpoint unreachable for every caller.
 */
const LimitSchema = z.coerce.number().int().min(1).max(500);

export async function registerRoutes(app: FastifyInstance, ctx: AppContext, state?: AuthState) {
  const authState = state ?? createAuthState();
  assertAuthConfigured();

  app.addHook('onRequest', securityHeaders);

  /**
   * Transport enforcement (NFR §8.2).
   *
   * `REQUIRE_TLS` was previously a startup promise with nothing behind it: the service
   * accepted plain HTTP while reporting that TLS was required. It is enforced here.
   *
   * The probes are exempt because a load balancer commonly polls them over the internal
   * network, and `/ready` must stay reachable for a rolling deploy to drain traffic.
   *
   * `trustProxy` is on in production, so `req.protocol` reflects X-Forwarded-Proto. If
   * TLS is terminated at a proxy that does not forward that header, every request looks
   * like plain HTTP and this rejects them — the 426 body says exactly that, because the
   * alternative is a deployment that silently serves over HTTP.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (!config.requireTls) return;
    if (req.url === '/health' || req.url === '/ready') return;
    if (req.protocol === 'https') return;

    const forwarded = req.headers['x-forwarded-proto'];
    return reply.status(426).send({
      code: 'VALIDATION_FAILED',
      message: 'HTTPS required',
      details: {
        received: req.protocol,
        forwardedProto: forwarded ?? null,
        hint: forwarded
          ? 'X-Forwarded-Proto says https but the connection is plain HTTP; check the proxy configuration'
          : 'Set X-Forwarded-Proto at the reverse proxy, or terminate TLS in front of this service',
      },
    });
  });
  // Registered here rather than in the entrypoint so the error contract travels with
  // the routes: any embedding of this module (tests, a serverless handler, a second
  // port) gets the same status codes instead of Fastify's default 500.
  app.setErrorHandler((err, _req, reply) => {
    // Every error passes through the redactor, so an upstream body carrying a token
    // cannot escape through an error message.
    const appErr = toAppError(err);

    // Fastify's own transport errors already carry the correct HTTP status. Deriving
    // it from the code alone collapsed distinct failures into 400: an unsupported
    // media type and a payload too large both reported as bad request, so a client
    // could not tell "send JSON" from "your upload is too big".
    const frameworkStatus = (err as { statusCode?: number }).statusCode;
    const status =
      typeof frameworkStatus === 'number' && frameworkStatus >= 400 && frameworkStatus < 600
        ? frameworkStatus
        : appErr.code === 'FORBIDDEN' || appErr.code === 'TENANT_VIOLATION' ? 403
          : appErr.code === 'UNAUTHORIZED' ? 401
            : appErr.code === 'NOT_FOUND' ? 404
              : appErr.code === 'VALIDATION_FAILED' ? 400
                : appErr.code === 'RATE_LIMITED' ? 429
                  : appErr.code === 'CRYPTO_ERROR' ? 500
                    : 500;

    if (status >= 500) log.error('request failed', { code: appErr.code, error: appErr.message });
    else log.warn('request rejected', { code: appErr.code, status, error: appErr.message });

    return reply.status(status).send(appErr.toJSON());
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ code: 'NOT_FOUND', message: 'Route not found' }));

  /**
   * Body parsing.
   *
   * Two traps, both hit in practice:
   *
   * 1. Fastify rejects `content-type: application/json` with an empty body — which is
   *    exactly what a naive `POST /ack` sends.
   * 2. Fastify rejects a POST that declares *no* content-type at all, which is what
   *    `curl -X POST .../ack` sends. That is the most natural way to call these
   *    endpoints and it failed with 415.
   *
   * A regex parser matches any content type, including the empty string an absent
   * header produces. Empty is always "no arguments"; declared JSON is still parsed
   * strictly, so a genuine payload error is not masked.
   *
   * The default JSON parser has to be removed first: Fastify rejects an empty
   * application/json body *before* any parser runs, which is the original failure.
   */
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(/^(?:.*)$/, { parseAs: 'string' }, (req, body, done) => {
    if (typeof body === 'string' && body.trim() === '') return done(null, undefined);

    const declared = String(req.headers['content-type'] ?? '');
    if (declared.includes('application/json')) {
      try {
        return done(null, JSON.parse(body as string));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        return done(err as Error, undefined);
      }
    }

    // Non-JSON payloads are handed on as text; routes that need structure reject them
    // through their own schema rather than at the transport layer.
    done(null, body);
  });

  const actorOf = (req: Parameters<typeof resolveActor>[1]) => resolveActor(ctx, req as never, authState);

  /**
   * Token exchange. Unauthenticated by necessity, so it is the only route that skips
   * the actor requirement, and it is rate limited per remote address.
   */
  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = z.object({
      userId: z.string().min(3),
      secret: z.string().min(8),
    }).parse(req.body ?? {});

    if (!tokenModeActive()) {
      throw new AppError('VALIDATION_FAILED', 'AUTH_MODE is not `token`; login is disabled');
    }

    const result = login(ctx.store, authState, body, req.ip);
    return reply.send(result);
  });

  // ─── Health ────────────────────────────────────────────────────────────────

  app.get('/health', async () => ({ status: 'ok', runtime: describeRuntime() }));

  app.get('/ready', async (_req, reply) => {
    let migrated = true;
    try {
      ctx.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations');
    } catch {
      migrated = false;
    }
    const [embed, llm, asr] = await Promise.all([
      ctx.embedder.healthCheck(),
      ctx.llm.healthCheck(),
      ctx.asr.healthCheck(),
    ]);
    const ok = migrated && embed.ok && llm.ok && asr.ok;
    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ready' : 'degraded',
      checks: { migrations: migrated, embedder: embed, llm, asr },
    });
  });

  app.get('/api/v1/me', async (req) => {
    const actor = actorOf(req);
    return {
      id: actor.userId,
      name: actor.displayName,
      role: actor.role,
      orgId: actor.orgId,
      org: orgRepo(ctx.store).byId(actor.orgId)?.name,
      projects: projectRepo(ctx.store).list(actor.orgId),
      divisions: divisionRepo(ctx.store).list(actor.orgId),
    };
  });

  // ─── FR-01 / FR-03: intake and approval ───────────────────────────────────

  app.post('/api/v1/instructions/text', async (req, reply) => {
    const actor = actorOf(req);
    const body = z.object({
      text: z.string().min(4),
      projectId: z.string().optional(),
      asrConfidence: z.number().min(0).max(1).nullable().optional(),
      sourceMessageId: z.string().nullable().optional(),
    }).parse(req.body);

    const result = await intakeInstruction(ctx, scopeOf(actor), {
      rawText: body.text,
      projectId: body.projectId,
      asrConfidence: body.asrConfidence ?? null,
      sourceMessageId: body.sourceMessageId ?? null,
      actorUserId: actor.userId,
    });

    const scope = scopeOf(actor);
    const tickets = result.ticketIds.map((id) => ticketRepo(ctx.store).get(scope, id));
    const divisions = divisionRepo(ctx.store).list(actor.orgId);
    const users = userRepo(ctx.store).list(actor.orgId);

    const card = renderApprovalCard({
      instructionId: result.instructionId,
      rawText: body.text,
      asrConfidence: body.asrConfidence ?? null,
      parse: result.parse,
      tickets: tickets.map((t) => ({
        ticket: t,
        assigneeName: users.find((u) => u.id === t.assigneeId)?.display_name ?? null,
        divisionName: divisions.find((d) => d.id === t.divisionId)?.name ?? 'Divisi',
      })),
    });

    return reply.status(201).send({
      instructionId: result.instructionId,
      summary: result.parse.summary,
      ambiguities: result.parse.ambiguities,
      ticketIds: result.ticketIds,
      tickets: tickets.map((t) => ({
        id: t.id, code: t.code, title: t.title, status: t.status,
        priority: t.priority, dueAt: t.dueAt, assigneeId: t.assigneeId,
      })),
      timing: { ttftMs: result.ttftMs, totalMs: result.totalMs },
      usedFallback: result.usedFallback,
      approvalCard: card,
    });
  });

  app.post('/api/v1/instructions/:id/decision', async (req) => {
    const actor = actorOf(req);
    const { id } = req.params as { id: string };
    const body = z.object({
      action: z.enum(['approve', 'cancel', 'correct']),
      reason: z.string().optional(),
      assigneeOverrides: z.record(z.string()).optional(),
      changes: z.array(z.object({
        ticketId: z.string(),
        assigneeId: z.string().optional(),
        priority: z.enum(['P0', 'P1', 'P2']).optional(),
        dueAt: z.string().nullable().optional(),
      })).optional(),
    }).parse(req.body);

    if (body.action === 'correct' && !body.changes?.length) {
      throw validationFailed('action=correct requires at least one change');
    }

    const result = await handleApproval(ctx, scopeOf(actor), actor, id, {
      action: body.action,
      reason: body.reason,
      assigneeOverrides: body.assigneeOverrides,
      changes: body.changes,
    } as never);

    return {
      ...result,
      dispatched: result.dispatched.map((t) => ({ id: t.id, code: t.code, title: t.title, status: t.status, divisionId: t.divisionId })),
    };
  });

  app.get('/api/v1/instructions/:id/dispatchable', async (req) => {
    const actor = actorOf(req);
    const { id } = req.params as { id: string };
    return collectDispatchable(scopeOf(actor), id, ctx.store).map((t) => ({ id: t.id, code: t.code, divisionId: t.divisionId, assigneeId: t.assigneeId }));
  });

  // ─── FR-04 / FR-05: ticket lifecycle ─────────────────────────────────────

  app.get('/api/v1/tickets', async (req) => {
    const actor = actorOf(req);
    const q = TicketQuery.parse(req.query ?? {});
    const tickets = ticketRepo(ctx.store).list(scopeOf(actor), {
      status: (q.status ? (Array.isArray(q.status) ? q.status : [q.status]) : undefined) as TicketStatus[] | undefined,
      divisionId: q.divisionId,
      assigneeId: q.assigneeId,
    });
    const users = userRepo(ctx.store).list(actor.orgId);
    const divisions = divisionRepo(ctx.store).list(actor.orgId);
    return tickets.map((t) => ({
      ...t,
      priorityLabel: priorityLabel(t.priority),
      assigneeName: users.find((u) => u.id === t.assigneeId)?.display_name ?? null,
      divisionName: divisions.find((d) => d.id === t.divisionId)?.name ?? null,
    }));
  });

  app.get('/api/v1/tickets/:id', async (req) => {
    const actor = actorOf(req);
    const scope = scopeOf(actor);
    const { id } = req.params as { id: string };
    const ticket = ticketRepo(ctx.store).getStrict(scope, id);
    const card = buildTicketCardData(ctx, scope, ticket);
    return {
      ...ticket,
      priorityLabel: priorityLabel(ticket.priority),
      ...card,
      referenceDocs: referenceDocs(ctx, scope, ticket.projectId, ticket.title),
      dod: dodRepo(ctx.store).list(scope, ticket.id),
      events: eventRepo(ctx.store).listForTicket(scope, ticket.id),
      verifications: verificationRepo(ctx.store).listForTicket(scope, ticket.id),
      thread: clarificationRepo(ctx.store).list(scope, ticket.id),
    };
  });

  app.post('/api/v1/tickets/:id/ack', async (req) => {
    const actor = actorOf(req);
    const { id } = req.params as { id: string };
    return acknowledgeTicket(ctx, scopeOf(actor), actor, id);
  });

  app.post('/api/v1/tickets/:id/clarify', async (req) => {
    const actor = actorOf(req);
    const { id } = req.params as { id: string };
    const { question } = z.object({ question: z.string().min(4) }).parse(req.body);
    return askClarification(ctx, scopeOf(actor), actor, id, question);
  });

  app.post('/api/v1/tickets/:id/evidence', async (req) => {
    const actor = actorOf(req);
    const { id } = req.params as { id: string };
    const body = z.object({ url: z.string().url().optional(), note: z.string().optional() }).parse(req.body ?? {});
    return submitEvidence(ctx, scopeOf(actor), actor, id, body);
  });

  app.post('/api/v1/tickets/:id/resubmit', async (req) => {
    const actor = actorOf(req);
    const { id } = req.params as { id: string };
    const { note } = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    const { resubmit } = await import('@execugate/orchestration/staff');
    return resubmit(ctx, scopeOf(actor), actor, id, note);
  });

  app.post('/api/v1/tickets/:id/verify', async (req) => {
    const actor = actorOf(req);
    const { id } = req.params as { id: string };
    return runGatekeeper(ctx, scopeOf(actor), id, actor);
  });

  app.post('/api/v1/tickets/:id/manual-verification', async (req) => {
    const actor = actorOf(req);
    const { id } = req.params as { id: string };
    const body = z.object({ approve: z.boolean(), reason: z.string().min(5) }).parse(req.body);
    return manualVerification(ctx, scopeOf(actor), actor, id, body);
  });

  // ─── FR-02: project memory ───────────────────────────────────────────────

  app.post('/api/v1/documents', async (req, reply) => {
    const actor = actorOf(req);
    const body = z.object({
      title: z.string().min(3),
      body: z.string().min(10),
      projectId: z.string().optional(),
      mime: z.string().optional(),
    }).parse(req.body);

    const projectId = body.projectId ?? projectRepo(ctx.store).default(actor.orgId)?.id;
    if (!projectId) throw validationFailed('No active project configured');

    const result = await ingestDocument(ctx.store, ctx.embedder, scopeOf(actor), {
      projectId, title: body.title, body: body.body, mime: body.mime ?? 'text/markdown',
    });
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });

  app.get('/api/v1/documents', async (req) => {
    const actor = actorOf(req);
    const q = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
    return documentRepo(ctx.store).list(scopeOf(actor), q.projectId).map((d) => ({
      id: d.id, title: d.title, state: d.ingest_state, chunks: d.chunk_count,
      embedModel: d.embed_model, size: d.size, ingestedAt: d.ingested_at,
    }));
  });

  app.post('/api/v1/documents/search', async (req) => {
    const actor = actorOf(req);
    const body = z.object({ query: z.string().min(2), projectId: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }).parse(req.body);
    const projectId = body.projectId ?? projectRepo(ctx.store).default(actor.orgId)?.id;
    if (!projectId) throw validationFailed('No active project configured');

    const found = await retrieve(ctx.store, ctx.embedder, scopeOf(actor), { query: body.query, projectId, limit: body.limit ?? 6 });
    return {
      // The excerpt is anchored on the matching terms, not the chunk start, so the
      // sentence the user searched for is visible in the preview.
      chunks: found.chunks.map((c) => ({
        docTitle: c.docTitle,
        ordinal: c.ordinal,
        score: c.score,
        matchedBy: c.matchedBy,
        excerpt: buildExcerpt(c.text, body.query),
      })),
      timing: { elapsedMs: found.elapsedMs },
      retrievers: { vector: found.vectorCount, fts: found.ftsCount, degraded: found.degraded },
    };
  });

  // ─── FR-06: reporting ────────────────────────────────────────────────────

  app.get('/api/v1/reports/walkthrough', async (req) => {
    const actor = actorOf(req);
    const q = z.object({ date: z.string().optional(), format: z.enum(['json', 'text']).optional() }).parse(req.query ?? {});
    const report = buildWalkthrough(ctx, scopeOf(actor), q.date);
    if (q.format === 'text') return { text: renderWalkthrough(report) };
    return { ...report, rendered: renderWalkthrough(report) };
  });

  // ─── Audit, metrics, health detail ───────────────────────────────────────

  app.get('/api/v1/audit', async (req) => {
    const actor = actorOf(req);
    const q = z.object({ entity: z.string().optional(), entityId: z.string().optional(), limit: LimitSchema.optional() }).parse(req.query ?? {});
    return auditRepo(ctx.store).list(scopeOf(actor), q);
  });

  app.get('/api/v1/metrics', async (req) => {
    const actor = actorOf(req);
    const kpis = computeKpis(ctx, scopeOf(actor));
    return {
      kpis,
      ticketStatus: ticketRepo(ctx.store).countsByStatus(scopeOf(actor)),
      jobs: jobRepo(ctx.store).stats(actor.orgId),
      provider: { llm: ctx.llm.name, llmModel: ctx.llm.model, embed: ctx.embedder.name, embedModel: ctx.embedder.model, asr: ctx.asr.name, asrModel: ctx.asr.model },
    };
  });

  app.get('/api/v1/messages', async (req) => {
    const actor = actorOf(req);
    const q = z.object({ since: z.string().optional(), limit: LimitSchema.optional() }).parse(req.query ?? {});
    return messageRepo(ctx.store).listSince(scopeOf(actor), q.since ?? new Date(Date.now() - 86400_000).toISOString(), q.limit ?? 50);
  });

  /**
   * Roster with user ids.
   *
   * Readable without an actor header: the dashboard needs it to populate the
   * "act as" switcher before anyone is selected. Only non-sensitive fields are
   * returned — no external ids, no email.
   *
   * Authentication is required and the result is scoped to the caller's own
   * organisation. It previously did neither: it was reachable anonymously and always
   * returned the *first* organisation, so any caller — including one in a different
   * tenant — received a complete staff list with names, roles and divisions. That is
   * precisely the targeting information needed to abuse the dev identity header, and
   * it broke tenant isolation on a multi-tenant deployment.
   */
  app.get('/api/v1/roster', async (req) => {
    const actor = actorOf(req);

    const divisions = new Map(divisionRepo(ctx.store).list(actor.orgId).map((d) => [d.id, d.kind]));
    return userRepo(ctx.store).list(actor.orgId).map((u) => {
      let specializations: string[] = [];
      try {
        const parsed = JSON.parse(u.specializations);
        specializations = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch { /* malformed column degrades to empty */ }

      return {
        id: u.id,
        name: u.display_name,
        role: u.role,
        division: divisions.get(u.division_id ?? '') ?? 'management',
        specializations,
        bound: !!u.external_id,
      };
    });
  });

  app.get('/api/v1/secrets', async (req) => {
    const actor = actorOf(req);
    // Key names only. Values are never returned over HTTP.
    return secretRepo(ctx.store).list(scopeOf(actor));
  });

  app.post('/api/v1/secrets', async (req) => {
    const actor = actorOf(req);
    const body = z.object({ key: z.string().min(3), value: z.string().min(1) }).parse(req.body);
    secretRepo(ctx.store).set(scopeOf(actor), body.key, body.value);
    return { stored: body.key };
  });

  app.get('/api/v1/webhooks/dedupe', async (req) => {
    const q = z.object({ channelId: z.string(), externalId: z.string() }).parse(req.query ?? {});
    return { claimed: idempotencyRepo(ctx.store).claim(q.channelId, q.externalId) };
  });

  app.post('/api/v1/walkthrough/trigger', async (req) => {
    const actor = actorOf(req);
    const text = z.object({ text: z.string().default('') }).parse(req.body ?? {});
    if (!isWalkthroughRequest(text.text)) throw validationFailed('Text does not contain a walkthrough trigger phrase');
    return buildWalkthrough(ctx, scopeOf(actor));
  });

  /**
   * Unauthenticated on purpose: provider names, timeouts and size limits, with no
   * secrets, keys or tenant data. The dashboard reads it before login to show which
   * engines are active. Anything identifying belongs behind `actorOf` — see the roster
   * above for what happens when that rule is skipped.
   */
  app.get('/api/v1/config', async () => ({
    telegram: { configured: !!config.telegram.token, mode: config.telegram.mode },
    gatekeeper: { provider: config.gatekeeper.provider, timeoutMs: config.gatekeeper.timeoutMs },
    limits: { asrMaxBytes: config.asr.maxBytes },
  }));

  log.info('routes registered');
}