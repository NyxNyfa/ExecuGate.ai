import { DatabaseSync } from 'node:sqlite';
import { readdirSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '@execugate/core';

export type Db = DatabaseSync;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * All repositories take this. Constructing it once per process keeps `org_id`
 * mandatory by construction rather than by convention (BUILD_PLAN §11).
 */
export class Store {
  readonly db: Db;

  constructor(path: string = config.databasePath) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA temp_store = MEMORY;');
  }

  migrate(): string[] {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL
       ) STRICT;`,
    );
    const applied = new Set(
      this.db.prepare('SELECT name FROM schema_migrations').all().map((r) => (r as { name: string }).name),
    );
    const files = existsSync(MIGRATIONS_DIR)
      ? readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
      : [];

    const executed: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      // Each migration is one atomic unit: a failure leaves the DB untouched.
      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this.db
          .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
          .run(file, new Date().toISOString());
        this.db.exec('COMMIT');
        executed.push(file);
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return executed;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Rows come back with a null prototype; normalise so `?.` and spread behave. */
  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])).map((r) => ({ ...(r as object) })) as T[];
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.db.prepare(sql).get(...(params as never[]));
    return row === undefined ? undefined : ({ ...(row as object) } as T);
  }

  run(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).run(...(params as never[]));
  }

  close(): void {
    this.db.close();
  }
}

let singleton: Store | undefined;

export function getStore(): Store {
  if (!singleton) singleton = new Store();
  return singleton;
}

/** Test helper: in-memory store with migrations already applied. */
export function createTestStore(): Store {
  const store = new Store(':memory:');
  store.migrate();
  return store;
}
