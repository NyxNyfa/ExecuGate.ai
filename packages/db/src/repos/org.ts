import type { Store } from '../db.ts';
import { newId } from '@execugate/core';
import type { DivisionKind, Role } from '@execugate/core';

const now = () => new Date().toISOString();

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  created_at: string;
}
export interface UserRow {
  id: string;
  org_id: string;
  external_id: string | null;
  display_name: string;
  email: string | null;
  role: Role;
  division_id: string | null;
  specializations: string;
  active: number;
  /** Salted scrypt hash of the user's API secret (migration 002). Never plaintext. */
  auth_secret_hash: string | null;
  auth_secret_salt: string | null;
  created_at: string;
}
export interface DivisionRow {
  id: string;
  org_id: string;
  name: string;
  kind: DivisionKind;
  channel_id: string | null;
  created_at: string;
}
export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  code: string;
  status: string;
  created_at: string;
}

export function orgRepo(store: Store) {
  return {
    insert(o: { name: string; slug: string; timezone?: string; id?: string }) {
      const id = o.id ?? newId('org');
      store.run(
        'INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?,?,?,?,?)',
        id, o.name, o.slug, o.timezone ?? 'Asia/Jakarta', now(),
      );
      return id;
    },
    bySlug(slug: string) {
      return store.get<OrgRow>('SELECT * FROM organizations WHERE slug = ?', slug);
    },
    byId(id: string) {
      return store.get<OrgRow>('SELECT * FROM organizations WHERE id = ?', id);
    },
  };
}

export function divisionRepo(store: Store) {
  return {
    insert(orgId: string, d: { name: string; kind: DivisionKind; channelId?: string | null }) {
      const id = newId('div');
      store.run(
        'INSERT INTO divisions (id, org_id, name, kind, channel_id, created_at) VALUES (?,?,?,?,?,?)',
        id, orgId, d.name, d.kind, d.channelId ?? null, now(),
      );
      return id;
    },
    list(orgId: string) {
      return store.all<DivisionRow>('SELECT * FROM divisions WHERE org_id = ? ORDER BY kind', orgId);
    },
    byKind(orgId: string, kind: DivisionKind) {
      return store.get<DivisionRow>('SELECT * FROM divisions WHERE org_id = ? AND kind = ?', orgId, kind);
    },
    setChannel(orgId: string, id: string, channelId: string) {
      store.run('UPDATE divisions SET channel_id = ? WHERE org_id = ? AND id = ?', channelId, orgId, id);
    },
  };
}

export function userRepo(store: Store) {
  return {
    insert(orgId: string, u: {
      displayName: string;
      role: Role;
      divisionId?: string | null;
      externalId?: string | null;
      email?: string | null;
      specializations?: string[];
    }) {
      const id = newId('usr');
      store.run(
        `INSERT INTO users (id, org_id, external_id, display_name, email, role, division_id, specializations, active, created_at)
         VALUES (?,?,?,?,?,?,?,?,1,?)`,
        id, orgId, u.externalId ?? null, u.displayName, u.email ?? null, u.role,
        u.divisionId ?? null, JSON.stringify(u.specializations ?? []), now(),
      );
      return id;
    },
    list(orgId: string) {
      return store.all<UserRow>('SELECT * FROM users WHERE org_id = ? ORDER BY role', orgId);
    },
    /** Resolves a chat identity from a channel to a user. Tenant-scoped by construction. */
    byExternal(orgId: string, externalId: string) {
      return store.get<UserRow>('SELECT * FROM users WHERE org_id = ? AND external_id = ?', orgId, externalId);
    },
    byId(orgId: string, id: string) {
      return store.get<UserRow>('SELECT * FROM users WHERE org_id = ? AND id = ?', orgId, id);
    },
    setExternal(orgId: string, id: string, externalId: string) {
      store.run('UPDATE users SET external_id = ? WHERE org_id = ? AND id = ?', externalId, orgId, id);
    },
    /** Stores a credential as a salted hash; the plaintext is never persisted. */
    setAuthSecret(orgId: string, id: string, hash: string, salt: string) {
      store.run(
        'UPDATE users SET auth_secret_hash = ?, auth_secret_salt = ? WHERE org_id = ? AND id = ?',
        hash, salt, orgId, id,
      );
    },
    clearAuthSecret(orgId: string, id: string) {
      store.run(
        'UPDATE users SET auth_secret_hash = NULL, auth_secret_salt = NULL WHERE org_id = ? AND id = ?',
        orgId, id,
      );
    },
  };
}

export function projectRepo(store: Store) {
  return {
    insert(orgId: string, p: { name: string; code: string }) {
      const id = newId('prj');
      store.run(
        'INSERT INTO projects (id, org_id, name, code, status, created_at) VALUES (?,?,?,?,?,?)',
        id, orgId, p.name, p.code, 'active', now(),
      );
      return id;
    },
    list(orgId: string) {
      return store.all<ProjectRow>('SELECT * FROM projects WHERE org_id = ? ORDER BY code', orgId);
    },
    byId(orgId: string, id: string) {
      return store.get<ProjectRow>('SELECT * FROM projects WHERE org_id = ? AND id = ?', orgId, id);
    },
    default(orgId: string) {
      return store.get<ProjectRow>(
        "SELECT * FROM projects WHERE org_id = ? AND status = 'active' ORDER BY created_at LIMIT 1",
        orgId,
      );
    },
  };
}
