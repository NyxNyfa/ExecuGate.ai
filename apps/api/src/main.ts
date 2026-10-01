import Fastify from 'fastify';
import { config, AppError, describeRuntime } from '@execugate/core';
import { createContext } from '@execugate/orchestration';
import type { AppContext } from '@execugate/orchestration';
import { createLogger } from '@execugate/observability';
import { registerRoutes } from './routes.ts';
import { assertProductionReady } from './validate.ts';
import { serveDashboard } from './static.ts';

const log = createLogger('api');

/**
 * Production entrypoint.
 *
 * Responsibilities beyond wiring: refuse to start on a bad configuration, serve the
 * built dashboard from the same origin so no CORS surface exists, and drain
 * in-flight requests before exiting so a deploy never truncates a response.
 */
async function main() {
  // Before anything is bound: a misconfigured service must not accept traffic.
  assertProductionReady();

  const app = Fastify({
    logger: false,
    // Voice notes and document uploads arrive here; anything larger belongs on object
    // storage, and the ASR adapter enforces its own 25 MB ceiling per file.
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: config.isProduction,
    // Keep sockets from lingering on shutdown.
    keepAliveTimeout: 72_000,
    requestIdHeader: 'x-request-id',
    genReqId: () => `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  });

  const ctx: AppContext = createContext();

  // Per-request access log with a request id, so one call can be traced end to end.
  app.addHook('onResponse', (req, reply) => {
    log.info('request', {
      requestId: req.id,
      method: req.method,
      url: req.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });

  await registerRoutes(app, ctx);
  await serveDashboard(app);

  // `/health` and `/ready` are registered in routes.ts alongside every other route.
  // Declaring them here too would abort startup: Fastify rejects a duplicate
  // method+path, so the process would die after having bound nothing.

  await app.listen({ port: config.ports.api, host: '0.0.0.0' });
  log.info(`API listening on :${config.ports.api}`, {
    runtime: describeRuntime(),
    auth: config.auth.mode,
    nodeEnv: config.env,
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // Stop accepting connections, let in-flight requests finish, then close the
  // database. Killing the process mid-request truncates a response the client will
  // retry, which on a state-machine endpoint can mean a duplicate ticket.
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown started', { signal });

    // Hard deadline: if a request will not drain, exit anyway rather than hang a
    // deploy pipeline.
    const timer = setTimeout(() => {
      log.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 15_000);
    timer.unref();

    try {
      await app.close();
      ctx.store.close();
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error('shutdown failed', { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });

  process.on('uncaughtException', (err) => {
    // The process state is unknown after this; log, then let the supervisor restart.
    log.error('uncaught exception', { error: err.message, stack: err.stack });
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  log.error('fatal', {
    error: err instanceof Error ? err.message : String(err),
    hint: err instanceof AppError ? JSON.stringify(err.details) : undefined,
  });
  process.exit(1);
});