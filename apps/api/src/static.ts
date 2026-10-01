import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '@execugate/core';
import { createLogger } from '@execugate/observability';

const log = createLogger('api:static');

/**
 * Serves the built dashboard from the API process.
 *
 * One origin in production removes an entire class of deployment mistake: no CORS
 * configuration, no proxy path rewriting, no second process to supervise, and no
 * possibility of the dashboard being served from a different release than the API.
 */
export async function serveDashboard(app: FastifyInstance): Promise<void> {
  const distDir = resolve(process.cwd(), config.webDist);
  const indexFile = resolve(distDir, 'index.html');

  if (!existsSync(indexFile)) {
    log.warn('dashboard bundle not found; serving API only', {
      expected: indexFile,
      hint: 'Run: npm run build:web',
    });
    return;
  }

  // `@fastify/static` is not a dependency; Fastify's wildcard route serves the few
  // files a Vite build emits without pulling in a plugin for the sake of it.
  const { readFile } = await import('node:fs/promises');
  const { extname, join, normalize } = await import('node:path');

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
  };

  // Hashed asset filenames are immutable; the entry HTML must never be cached or a
  // deploy leaves browsers on a stale bundle that references deleted assets.
  const immutable = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2|png|svg)$/;

  app.get('/*', async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url === '/health' || req.url === '/ready') {
      return reply.callNotFound();
    }

    const requested = decodeURIComponent(req.url.split('?')[0] ?? '/');
    // Normalise then verify containment, so `../../.env` cannot escape distDir.
    const candidate = normalize(join(distDir, requested === '/' ? 'index.html' : requested));
    const target = candidate.startsWith(distDir) ? candidate : indexFile;

    const serve = async (file: string, cacheControl: string) => {
      const body = await readFile(file);
      return reply
        .header('content-type', MIME[extname(file)] ?? 'application/octet-stream')
        .header('cache-control', cacheControl)
        .send(body);
    };

    if (existsSync(target) && !target.endsWith('\\') && extname(target)) {
      return serve(target, immutable.test(requested) ? 'public, max-age=31536000, immutable' : 'no-cache');
    }

    // SPA fallback: unknown paths render the app shell and let the client route.
    return serve(indexFile, 'no-cache');
  });

  log.info('dashboard served from API origin', { distDir });
}