import { defineConfig } from 'vitest/config';
import { resolve, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

/**
 * Alias list generated from the packages directory rather than hand-listed.
 *
 * Two resolution rules are needed because tsx/tsc (via tsconfig `paths`) and Vite
 * disagree on subpath imports:
 *   `@execugate/<pkg>`          -> packages/<pkg>/src/index.ts
 *   `@execugate/<pkg>/<file>`  -> packages/<pkg>/src/<file>.ts (or /<file>/index.ts)
 *
 * Entries are emitted as anchored RegExps in most-specific-first order. A plain
 * object cannot express this: an exact-match key such as
 * `@execugate/orchestration` also prefix-matches
 * `@execugate/orchestration/intake` and rewrites it to `index.ts/intake`.
 */
function buildAliases(): Array<{ find: RegExp; replacement: string }> {
  const bare: Array<{ find: RegExp; replacement: string }> = [];
  const deep: Array<{ find: RegExp; replacement: string }> = [];

  for (const entry of readdirSync(resolve('packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkg = entry.name;
    const srcDir = resolve('packages', pkg, 'src');
    if (!existsSync(srcDir)) continue;

    bare.push({ find: new RegExp(`^@execugate/${pkg}$`), replacement: join(srcDir, 'index.ts') });

    const walk = (dir: string, prefix: string) => {
      for (const child of readdirSync(dir, { withFileTypes: true })) {
        if (child.isDirectory()) {
          walk(join(dir, child.name), `${prefix}${child.name}/`);
          continue;
        }
        if (!child.name.endsWith('.ts') || child.name.endsWith('.d.ts')) continue;
        const base = child.name.replace(/\.ts$/, '');
        const specifier = base === 'index' ? prefix.slice(0, -1) : `${prefix}${base}`;
        if (!specifier) continue;
        deep.push({
          find: new RegExp(`^@execugate/${pkg}/${specifier}$`),
          replacement: join(dir, child.name),
        });
      }
    };
    walk(srcDir, '');
  }

  if (!bare.some((a) => a.find.test('@execugate/core'))) {
    throw new Error('alias generation failed: @execugate/core not found');
  }
  // Deepest (most specific) first.
  return [...deep, ...bare];
}

export default defineConfig({
  resolve: { alias: buildAliases() },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // SQLite is single-writer per file; suites use independent in-memory stores,
    // but this machine is small so keep concurrency modest.
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});