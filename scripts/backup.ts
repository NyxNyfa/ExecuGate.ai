import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, getStore } from '@execugate/db';
import { config } from '@execugate/core';

/**
 * Database backup and restore.
 *
 * SQLite in WAL mode keeps recent writes in a sidecar file, so copying only the `.db`
 * while the service is running produces a backup that is missing committed
 * transactions. `VACUUM INTO` writes a consistent snapshot that is safe to copy
 * without stopping the service.
 *
 * Usage:
 *   npm run backup                       snapshot to ./backups
 *   npm run backup -- --dir D:\backups   choose a destination
 *   npm run restore -- --file <path>     replace the live database (service must be stopped)
 */

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const dbPath = config.databasePath;

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  console.error('Run: npm run setup');
  process.exit(1);
}

// ── Restore ──────────────────────────────────────────────────────────────────
const restoreFrom = arg('file');
if (restoreFrom) {
  if (!existsSync(restoreFrom)) {
    console.error(`Backup not found: ${restoreFrom}`);
    process.exit(1);
  }

  console.log(`\nRestoring ${dbPath}`);
  console.log(`  from  ${restoreFrom}`);

  // Explicit instances rather than `getStore()`: that is a memoized singleton, so the
  // second call would hand back the handle just closed and fail with "database is not
  // open". Verified by actually restoring.
  const before = new Store(dbPath);
  const live = before.all<{ n: number }>('SELECT COUNT(*) AS n FROM tickets')[0]?.n ?? 0;
  before.close();

  // Keep the displaced database rather than overwriting it: a mistaken restore must
  // be recoverable.
  const quarantine = `${dbPath}.replaced-${Date.now()}`;
  copyFileSync(dbPath, quarantine);

  // The WAL sidecars belong to the old database and would corrupt the restored one.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  copyFileSync(restoreFrom, dbPath);

  // Reopened after the copy so the reported count comes from the restored file, not
  // from a cached handle.
  const check = new Store(dbPath);
  const after = check.all<{ n: number }>('SELECT COUNT(*) AS n FROM tickets')[0]?.n ?? 0;
  check.close();

  console.log(`  previous database kept at ${quarantine}`);
  console.log(`  tickets: ${live} -> ${after}`);
  console.log('\nRestored. Start the service.\n');
  process.exit(0);
}

// ── Backup ───────────────────────────────────────────────────────────────────
const outDir = resolve(arg('dir') ?? join(process.cwd(), 'backups'));
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = join(outDir, `execugate-${stamp}.db`);

const store = getStore();
const counts = {
  organisations: store.get<{ n: number }>('SELECT COUNT(*) AS n FROM organizations')?.n ?? 0,
  users: store.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0,
  tickets: store.get<{ n: number }>('SELECT COUNT(*) AS n FROM tickets')?.n ?? 0,
  events: store.get<{ n: number }>('SELECT COUNT(*) AS n FROM ticket_events')?.n ?? 0,
  documents: store.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents')?.n ?? 0,
  chunks: store.get<{ n: number }>('SELECT COUNT(*) AS n FROM doc_chunks')?.n ?? 0,
};
store.close();

// VACUUM INTO takes a consistent snapshot including WAL-committed pages.
const { DatabaseSync } = await import('node:sqlite');
const source = new DatabaseSync(dbPath, { readOnly: true });
try {
  source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  source.close();
}

const size = statSync(target).size;

console.log('\nBackup written');
console.log('='.repeat(60));
console.log(`  file    ${target}`);
console.log(`  size    ${(size / 1048576).toFixed(2)} MB`);
for (const [label, n] of Object.entries(counts)) {
  console.log(`  ${label.padEnd(15)} ${n}`);
}
console.log('='.repeat(60));
console.log('\nThe audit trail is included: every ticket, verification and event.');
