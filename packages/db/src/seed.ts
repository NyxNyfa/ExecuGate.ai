import type { Store } from './db.ts';
import { orgRepo, divisionRepo, userRepo, projectRepo } from './repos/org.ts';
import { channelRepo } from './repos/platform.ts';
import type { DivisionKind, Role } from '@execugate/core';

/**
 * Core reference data only. Document ingestion lives in the memory package, so
 * this module stays free of any dependency above `db` in the layering.
 */
export interface SeedRefs {
  orgId: string;
  projectId: string;
  divisions: Record<DivisionKind, string>;
  users: Record<string, string>;
}

export const DEMO_ORG_SLUG = 'execugate-demo';
export const SECOND_ORG_SLUG = 'acme-partner';

const STAFF: Array<{ key: string; name: string; role: Role; division: DivisionKind; specs: string[] }> = [
  { key: 'commander', name: 'Rahma Dewi', role: 'commander', division: 'management', specs: ['project owner', 'executive reporting'] },
  { key: 'budi', name: 'Budi Santoso', role: 'technical', division: 'technical', specs: ['payment service', 'core-gateway', 'backend'] },
  { key: 'rina', name: 'Rina Kartika', role: 'technical', division: 'technical', specs: ['CI/CD', 'docker', 'kubernetes'] },
  { key: 'dimas', name: 'Dimas Prakoso', role: 'technical', division: 'technical', specs: ['integration testing', 'test automation'] },
  { key: 'sari', name: 'Sari Wijaya', role: 'ops', division: 'operational', specs: ['reconciliation', 'settlement', 'financial reporting'] },
  { key: 'agus', name: 'Agus Setiawan', role: 'ops', division: 'operational', specs: ['data entry', 'compliance forms', 'document archive'] },
  { key: 'maya', name: 'Maya Puspita', role: 'ops', division: 'operational', specs: ['inventory', 'warehouse stock'] },
];

export function seedCore(store: Store, opts: { channels?: Record<DivisionKind, string> } = {}): SeedRefs {
  const orgs = orgRepo(store);
  const divisions = divisionRepo(store);
  const users = userRepo(store);
  const projects = projectRepo(store);
  const channels = channelRepo(store);

  const orgId = orgs.bySlug(DEMO_ORG_SLUG)?.id ?? orgs.insert({ name: 'ExecuGate Demo (Acme Corp)', slug: DEMO_ORG_SLUG, timezone: 'Asia/Jakarta' });

  // A second tenant exists so isolation tests have a real counterpart (BUILD_PLAN §11).
  if (!orgs.bySlug(SECOND_ORG_SLUG)) {
    orgs.insert({ name: 'Acme Partner Industries', slug: SECOND_ORG_SLUG });
  }

  const divisionIds: Record<string, string> = {};
  for (const [kind, name] of [['management', 'Manajemen'], ['technical', 'Divisi Teknikal'], ['operational', 'Divisi Operasional']] as const) {
    const existing = divisions.byKind(orgId, kind as DivisionKind);
    divisionIds[kind] = existing?.id ?? divisions.insert(orgId, { name, kind: kind as DivisionKind });
    const chat = opts.channels?.[kind as DivisionKind];
    if (chat) divisions.setChannel(orgId, divisionIds[kind]!, chat);
  }

  const userIds: Record<string, string> = {};
  for (const s of STAFF) {
    const list = users.list(orgId);
    const found = list.find((u) => u.display_name === s.name);
    userIds[s.key] = found?.id ?? users.insert(orgId, {
      displayName: s.name, role: s.role, divisionId: divisionIds[s.division] ?? null,
      specializations: s.specs,
    });
  }

  const projectId = projects.default(orgId)?.id ?? projects.insert(orgId, { name: 'Core Platform', code: 'CORE' });

  if (opts.channels) {
    for (const [kind, chat] of Object.entries(opts.channels)) {
      channels.upsert(orgId, { kind: 'telegram', externalId: chat });
    }
  }

  return { orgId, projectId, divisions: divisionIds as Record<DivisionKind, string>, users: userIds };
}

/** Resolves chat ids to staff so inbound messages map to real users. */
export function bindExternalIds(store: Store, refs: SeedRefs, map: Record<string, string>): void {
  const users = userRepo(store);
  for (const [userKey, externalId] of Object.entries(map)) {
    const userId = refs.users[userKey];
    if (userId) users.setExternal(refs.orgId, userId, externalId);
  }
}
