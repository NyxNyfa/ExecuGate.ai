import { spawn } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = process.cwd();

/**
 * Development supervisor.
 *
 * Starts api + bot + worker (+ web when present) in one terminal. On Windows
 * `npm run x` spawns through cmd.exe, so `shell: true` is required for the
 * workspace scripts to resolve; on POSIX the shell is not needed.
 */
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

if (!existsSync(resolve(root, '.env')) && existsSync(resolve(root, '.env.example'))) {
  copyFileSync(resolve(root, '.env.example'), resolve(root, '.env'));
  console.log('[dev] created .env from .env.example');
}

const targets: Array<{ name: string; args: string[]; colour: string }> = [
  { name: 'api   ', args: ['run', 'dev:api'], colour: '\x1b[36m' },
  { name: 'bot   ', args: ['run', 'dev:bot'], colour: '\x1b[35m' },
  { name: 'worker', args: ['run', 'dev:worker'], colour: '\x1b[33m' },
];

if (existsSync(resolve(root, 'apps/web/package.json'))) {
  targets.push({ name: 'web   ', args: ['run', 'dev:web'], colour: '\x1b[32m' });
}

const children: Array<{ name: string; proc: import('node:child_process').ChildProcess }> = [];
let shuttingDown = false;

for (const target of targets) {
  const proc = spawn(npmCmd, target.args, {
    cwd: root,
    env: process.env,
    shell: isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${target.colour}[${target.name}]\x1b[0m`;
  const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    const rl = createInterface({ input: stream });
    rl.on('line', (line) => out.write(`${prefix} ${line}\n`));
  };
  pipe(proc.stdout!, process.stdout);
  pipe(proc.stderr!, process.stderr);

  proc.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`${prefix} exited with code ${code}`);
    shutdown(code ?? 0);
  });

  children.push({ name: target.name, proc });
}

function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { proc } of children) {
    if (!proc.killed) proc.kill();
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`[dev] starting ${children.length} process(es). Ctrl+C to stop.\n`);