import type { Store } from '../db.ts';
import { newId, AppError } from '@execugate/core';
import type { OrgScope } from '@execugate/core';
import { seal, open } from '../crypto.ts';

const now = () => new Date().toISOString();

/** Third-party API keys, encrypted at rest with AES-256-GCM (NFR §8.2). */
export function secretRepo(store: Store) {
  return {
    set(scope: OrgScope, keyName: string, value: string) {
      const s = seal(value);
      store.run(
        `INSERT INTO secrets (id, org_id, key_name, ciphertext, iv, tag, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (org_id, key_name) DO UPDATE SET
           ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`,
        newId('sec'), scope.orgId, keyName, s.ciphertext, s.iv, s.tag, now(), now(),
      );
    },
    get(scope: OrgScope, keyName: string): string | null {
      const row = store.get<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }>(
        'SELECT ciphertext, iv, tag FROM secrets WHERE org_id = ? AND key_name = ?', scope.orgId, keyName,
      );
      if (!row) return null;
      return open({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
    },
    has(scope: OrgScope, keyName: string) {
      return !!store.get('SELECT 1 AS ok FROM secrets WHERE org_id = ? AND key_name = ?', scope.orgId, keyName);
    },
    /** Key names only — plaintext must never reach a log or an API response. */
    list(scope: OrgScope) {
      return store.all<{ key_name: string; updated_at: string }>(
        'SELECT key_name, updated_at FROM secrets WHERE org_id = ? ORDER BY key_name', scope.orgId,
      );
    },
    remove(scope: OrgScope, keyName: string) {
      store.run('DELETE FROM secrets WHERE org_id = ? AND key_name = ?', scope.orgId, keyName);
    },
    /** Boot helper: accepts a plaintext env value on first run, then stores it encrypted. */
    seedFromEnv(scope: OrgScope, keyName: string, envValue: string | undefined) {
      if (!envValue) return false;
      if (this.has(scope, keyName)) return false;
      this.set(scope, keyName, envValue);
      return true;
    },
  };
}

export { AppError };
