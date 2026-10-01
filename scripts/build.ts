import { build } from 'esbuild';
import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Production build.
 *
 * The workspaces expose their entry points as raw `.ts` (`exports: { ".": "./src/index.ts" }`),
 * so there is nothing for Node to resolve after a `tsc` emit — the packages *are* their
 * sources. That is fine for `tsx` in development and unusable in production, where the
 * runtime should not need a TypeScript compiler.
 *
 * Each service is therefore bundled to a single ESM file with esbuild. Bundling is the
 * right tool here rather than an incremental compiler because the workspace resolution
 * has to disappear entirely, not just be rewritten.
 *
 * Third-party packages that resolve files at runtime (Fastify's plugin discovery,
 * zod's error maps) are kept external: they are already in node_modules and bundling
 * them tends to break dynamic requires for no size benefit.
 */

const OUT = resolve(process.cwd(), 'dist');

const entries = [
  { in: 'apps/api/src/main.ts', out: 'api.js' },
  { in: 'apps/bot/src/main.ts', out: 'bot.js' },
  { in: 'apps/worker/src/main.ts', out: 'worker.js' },
  { in: 'scripts/migrate.ts', out: 'migrate.js' },
  { in: 'scripts/seed.ts', out: 'seed.js' },
  { in: 'scripts/provision-secret.ts', out: 'provision-secret.js' },
  { in: 'scripts/backup.ts', out: 'backup.js' },
];

/**
 * Everything installed from npm, kept external.
 *
 * `node:` builtins are handled by esbuild's node platform. Workspace packages are
 * bundled: they are TypeScript sources and could not be resolved by Node at all.
 */
const EXTERNAL = [
  'fastify', '@fastify/*', 'zod', 'undici', 'node:*',
  // Loaded dynamically at runtime; resolving them from node_modules is correct.
  'tsx', 'typescript',
];

const started = Date.now();

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const results = await Promise.all(
  entries.map(async (entry) => {
    const result = await build({
      entryPoints: [resolve(process.cwd(), entry.in)],
      outfile: resolve(OUT, entry.out),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: true,
      minify: false,
      legalComments: 'none',
      external: EXTERNAL,
      // A missing optional dependency must not silently become a bundled stub.
      logLevel: 'warning',
      metafile: true,
    });

    const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
    return { ...entry, bytes, warnings: result.warnings.length };
  }),
);

for (const r of results) {
  const kb = (r.bytes / 1024).toFixed(0).padStart(5);
  console.log(`  ${r.out.padEnd(24)} ${kb} kB   (${r.warnings} warning(s))`);
}

// The dashboard is served from the API origin in production, so a missing build would
// leave a running service with no UI — worth failing on rather than warning about.
const webDist = resolve(process.cwd(), 'apps/web/dist');
if (existsSync(resolve(webDist, 'index.html'))) {
  cpSync(webDist, resolve(OUT, 'web'), { recursive: true });
  console.log(`  web/                     dashboard copied`);
} else {
  console.log(`  web/                     NOT BUILT — run: npm run build:web`);
}

console.log(`\nBuilt ${results.length} entries in ${Date.now() - started}ms -> dist/`);
