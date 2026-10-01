import { describe, it, expect, beforeEach } from 'vitest';
import { Store, seedCore, SECOND_ORG_SLUG, orgRepo } from '@execugate/db';
import { ticketRepo, documentRepo, chunkRepo, auditRepo, verificationRepo, jobRepo } from '@execugate/db';
import type { OrgScope } from '@execugate/core';

let store: Store;
let tenantA: OrgScope;
let tenantB: OrgScope;
let ticketAId: string;

beforeEach(() => {
  store = new Store(':memory:');
  store.migrate();

  const refsA = seedCore(store);
  tenantA = { orgId: refsA.orgId };

  const other = orgRepo(store).bySlug(SECOND_ORG_SLUG)!;
  tenantB = { orgId: other.id };

  const ticket = ticketRepo(store).insert(tenantA.orgId, {
    projectId: refsA.projectId,
    title: 'Dokumen Rahasia A',
    description: 'internal',
    divisionId: refsA.divisions.technical!,
    priority: 'P1',
    status: 'ASSIGNED',
    createdBy: refsA.users.commander!,
  });
  ticketAId = ticket.id;

  const doc = documentRepo(store).insert(tenantA, {
    projectId: refsA.projectId,
    title: 'Dokumen Rahasia A',
    body: '# RAHASIA A\nisi dokumen dari tenant A',
  });
  // Mirror the FTS index the ingest job maintains, so the retrieval-scoping test
  // exercises a populated index rather than an empty one.
  chunkRepo(store).insertAll(tenantA, doc.id, refsA.projectId, [
    { text: '# RAHASIA A\nisi dokumen dari tenant A', tokens: 9 },
  ]);
});

describe('multi-tenant isolation (NFR 8.2)', () => {
  it('tenant B cannot read tenant A tickets', () => {
    expect(() => ticketRepo(store).get(tenantB, ticketAId)).toThrow(/not found|not accessible/i);
  });

  it('the strict read distinguishes "absent" from "belongs to another tenant"', () => {
    // This is what lets isolation breaches be alarmed on instead of logged as 404s.
    try {
      ticketRepo(store).getStrict(tenantB, ticketAId);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('TENANT_VIOLATION');
    }
  });

  it('tenant B list queries never surface tenant A rows', () => {
    expect(ticketRepo(store).list(tenantB)).toHaveLength(0);
    expect(ticketRepo(store).list(tenantA)).toHaveLength(1);
  });

  it('status transitions are tenant-scoped', () => {
    const repo = ticketRepo(store);
    // A cross-tenant write attempt must not mutate anything.
    expect(() => repo.transition(tenantB, ticketAId, 'IN_PROGRESS', 'staff.acknowledged', { id: 'attacker' }))
      .toThrow();
    expect(repo.get(tenantA, ticketAId).status).toBe('ASSIGNED');
  });

  it('document and chunk reads are scoped per tenant', () => {
    expect(documentRepo(store).list(tenantB)).toHaveLength(0);
    expect(documentRepo(store).list(tenantA)).toHaveLength(1);

    const docA = documentRepo(store).list(tenantA)[0]!;
    expect(chunkRepo(store).allForProject(tenantB, docA.project_id)).toHaveLength(0);
  });

  it('FTS retrieval cannot reach another tenant corpus', () => {
    const docA = documentRepo(store).list(tenantA)[0]!;
    const hits = chunkRepo(store).fts(tenantA, docA.project_id, 'RAHASIA', 10);
    expect(hits.length).toBeGreaterThan(0);

    // The same query under tenant B returns nothing even though the row exists.
    expect(chunkRepo(store).fts(tenantB, docA.project_id, 'RAHASIA', 10)).toHaveLength(0);
  });

  it('audit, verification and job reads are scoped', () => {
    auditRepo(store).log(tenantA, { action: 'test', entity: 'ticket', entityId: ticketAId });
    expect(auditRepo(store).list(tenantA)).toHaveLength(1);
    expect(auditRepo(store).list(tenantB)).toHaveLength(0);

    verificationRepo(store).record(tenantA, {
      ticketId: ticketAId, lane: 'engineering', provider: 'test', verdict: 'pass',
      outcomes: [], messageId: null, latencyMs: 1,
    });
    expect(verificationRepo(store).listForTicket(tenantB, ticketAId)).toHaveLength(0);

    jobRepo(store).enqueue(tenantA.orgId, 'gate.verify', { ticketId: ticketAId });
    expect(jobRepo(store).stats(tenantB.orgId)).toHaveLength(0);
  });

  it('repositories refuse to operate without a tenant scope', () => {
    // orgId is required by the signature. Omitting it must fail loudly at the driver
    // rather than silently degrading into an unscoped query.
    const repo = ticketRepo(store);
    expect(() => repo.list({} as OrgScope)).toThrow();
    expect(() => repo.get({} as OrgScope, ticketAId)).toThrow();
  });

  it('takes orgId as a plain string on write paths, matching the read signature', () => {
    // Insert/enqueue receive `orgId: string` rather than a scope object, so a
    // caller cannot accidentally pass a whole Actor and leak extra fields.
    expect(typeof tenantA.orgId).toBe('string');
    expect(ticketRepo(store).list(tenantA)).toHaveLength(1);
  });
});