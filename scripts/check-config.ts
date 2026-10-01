import { validateConfig } from '../apps/api/src/validate.ts';
import { describeRuntime, isOfflineMode } from '@execugate/core';

/**
 * Configuration check.
 *
 * Runs the same validation the API performs at boot, without starting it, so a
 * deployment can be verified before anything binds a port.
 *
 *   npm run check:config              validate for development
 *   npm run check:config -- --prod    validate for production
 *
 * Exits non-zero when a blocking problem exists, which makes it usable as a deploy gate.
 */

const PROD = process.argv.includes('--prod') || process.argv.includes('--production');
const env = PROD ? 'production' : 'development';

console.log(`\nExecuGate.ai — configuration check (${env})`);
console.log(`runtime: ${describeRuntime()}${isOfflineMode() ? '  [fully offline: no API keys required]' : ''}\n`);

const checks = validateConfig(env);

const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  const mark = c.ok ? '\x1b[32m  ok  \x1b[0m' : c.severity === 'blocking' ? '\x1b[31m FAIL \x1b[0m' : '\x1b[33m warn \x1b[0m';
  console.log(`${mark} ${c.name.padEnd(width)}  ${c.detail}`);
}

const blocking = checks.filter((c) => !c.ok && c.severity === 'blocking');
const warnings = checks.filter((c) => !c.ok && c.severity === 'warning');

console.log('');
if (blocking.length) {
  console.log(`\x1b[31m${blocking.length} blocking problem(s) — the service will refuse to start.\x1b[0m`);
  for (const c of blocking) console.log(`  - ${c.name}: ${c.detail}`);
  console.log('\nSee DEPLOY.md §2.');
} else {
  console.log('\x1b[32mConfiguration is valid.\x1b[0m');
}

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s) — allowed, but worth reading:`);
  for (const c of warnings) console.log(`  - ${c.name}: ${c.detail}`);
}

console.log('');
process.exit(blocking.length ? 1 : 0);
