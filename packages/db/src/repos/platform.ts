import type { Store } from '../db.ts';
import { newId } from '@execugate/core';
import type { InboundKind, JobKind, OrgScope, TicketStatus } from '@execugate/core';

const now = () => new Date().toISOString();

export function channelRepo(store: Store) {
  return {
    upsert(orgId: string, c: { kind: 'telegram' | 'web'; externalId: string; config?: Record<string, unknown> }) {
      const existing = store.get<{ id: string }>(
        'SELECT id FROM channels WHERE org_id = ? AND kind = ? AND external_id = ?', orgId, c.kind, c.externalId,
      );
      if (existing) return existing.id;
      const id = newId('chn');
      store.run(
        'INSERT INTO channels (id, org_id, kind, external_id, config_json, status, created_at) VALUES (?,?,?,?,?,?,?)',
        id, orgId, c.kind, c.externalId, JSON.stringify(c.config ?? {}), 'active', now(),
      );
      return id;
    },
    list(orgId: string) {
      return store.all<{ id: string; kind: string; external_id: string; status: string }>(
        'SELECT id, kind, external_id, status FROM channels WHERE org_id = ?', orgId,
      );
    },
  };
}

/**
 * Idempotency guard. Telegram replays updates when a long-poll request times out;
 * without this, one voice note could become two instructions and two ticket sets.
 */
export function idempotencyRepo(store: Store) {
  return {
    claim(channelId: string, externalId: string): boolean {
      const res = store.run(
        'INSERT OR IGNORE INTO inbound_seen (channel_id, external_id, seen_at) VALUES (?,?,?)',
        channelId, externalId, now(),
      );
      return res.changes > 0;
    },
    release(channelId: string, externalId: string) {
      store.run('DELETE FROM inbound_seen WHERE channel_id = ? AND external_id = ?', channelId, externalId);
    },
  };
}

export function messageRepo(store: Store) {
  return {
    record(scope: OrgScope, m: {
      channelId: string; externalId?: string | null; direction: 'inbound' | 'outbound';
      senderId?: string | null; kind: InboundKind | 'system' | 'card_action'; body?: string;
      mediaRef?: string | null; transcript?: unknown;
    }) {
      const id = newId('msg');
      store.run(
        `INSERT INTO messages (id, org_id, channel_id, external_id, direction, sender_id, kind, body, media_ref, transcript_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id, scope.orgId, m.channelId, m.externalId ?? null, m.direction, m.senderId ?? null,
        m.kind, m.body ?? null, m.mediaRef ?? null, m.transcript ? JSON.stringify(m.transcript) : null, now(),
      );
      return id;
    },
    listSince(scope: OrgScope, sinceIso: string, limit = 100) {
      return store.all<{
        id: string; direction: string; kind: string; body: string | null;
        sender_id: string | null; created_at: string;
      }>('SELECT id, direction, kind, body, sender_id, created_at FROM messages WHERE org_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?',
        scope.orgId, sinceIso, limit);
    },
  };
}

export function instructionRepo(store: Store) {
  return {
    insert(scope: OrgScope, i: {
      projectId: string; sourceMessageId?: string | null; rawText: string;
      asrConfidence?: number | null; language?: string | null;
    }) {
      const id = newId('ins');
      store.run(
        `INSERT INTO instructions (id, org_id, project_id, source_message_id, raw_text, asr_confidence, language, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        id, scope.orgId, i.projectId, i.sourceMessageId ?? null, i.rawText,
        i.asrConfidence ?? null, i.language ?? null, now(),
      );
      return id;
    },
    setParse(scope: OrgScope, id: string, parse: unknown, language: string | null) {
      store.run('UPDATE instructions SET parse_json = ?, language = ? WHERE org_id = ? AND id = ?',
        JSON.stringify(parse), language, scope.orgId, id);
    },
    get(scope: OrgScope, id: string) {
      return store.get<{
        id: string; org_id: string; project_id: string; raw_text: string;
        asr_confidence: number | null; language: string | null; parse_json: string | null; created_at: string;
      }>('SELECT * FROM instructions WHERE org_id = ? AND id = ?', scope.orgId, id);
    },
    list(orgId: string, limit = 50) {
      return store.all<{ id: string; raw_text: string; created_at: string }>(
        'SELECT id, raw_text, created_at FROM instructions WHERE org_id = ? ORDER BY created_at DESC LIMIT ?', orgId, limit,
      );
    },
  };
}

// ─── Job queue (ADR-5) ──────────────────────────────────────────────────────

export function jobRepo(store: Store) {
  interface JobRow {
    id: string; org_id: string; kind: JobKind; payload_json: string; status: string;
    attempts: number; max_attempts: number; run_after: string; last_error: string | null;
  }

  return {
    enqueue(orgId: string, kind: JobKind, payload: unknown, opts: { delayMs?: number; maxAttempts?: number } = {}) {
      const id = newId('job');
      const ts = now();
      store.run(
        `INSERT INTO job_queue (id, org_id, kind, payload_json, status, attempts, max_attempts, run_after, created_at, updated_at)
         VALUES (?,?,?,?,?,0,?,?,?,?)`,
        id, orgId, kind, JSON.stringify(payload), 'queued', opts.maxAttempts ?? 3,
        new Date(Date.now() + (opts.delayMs ?? 0)).toISOString(), ts, ts,
      );
      return id;
    },

    /**
     * Atomic claim. `UPDATE ... WHERE status='queued' RETURNING *` guarantees a job
     * cannot be picked up twice even if api/bot/worker all poll the same table.
     */
    claim(limit = 1) {
      return store.all<JobRow>(
        `UPDATE job_queue SET status = 'running', attempts = attempts + 1, updated_at = ?
          WHERE id IN (SELECT id FROM job_queue WHERE status = 'queued' AND run_after <= ? ORDER BY run_after LIMIT ?)
          RETURNING *`,
        now(), now(), limit,
      );
    },

    complete(id: string) {
      store.run("UPDATE job_queue SET status = 'done', updated_at = ? WHERE id = ?", now(), id);
    },

    /** Exponential backoff with a dead-letter terminal state surfaced in the UI. */
    fail(row: JobRow, error: string) {
      const exhausted = row.attempts >= row.max_attempts;
      const delay = Math.min(2 ** row.attempts * 1000, 5 * 60_000);
      store.run(
        'UPDATE job_queue SET status = ?, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?',
        exhausted ? 'failed' : 'queued', error.slice(0, 500),
        new Date(Date.now() + delay).toISOString(), now(), row.id,
      );
    },

    /** Requeue everything stuck in `running` — the crash-recovery path. */
    recoverStale(olderThanMs = 60_000) {
      return store.run(
        "UPDATE job_queue SET status = 'queued' WHERE status = 'running' AND updated_at < ?",
        new Date(Date.now() - olderThanMs).toISOString(),
      ).changes;
    },

    stats(orgId: string) {
      return store.all<{ status: string; n: number }>(
        'SELECT status, COUNT(*) AS n FROM job_queue WHERE org_id = ? GROUP BY status', orgId,
      );
    },
  };
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export function auditRepo(store: Store) {
  return {
    log(scope: OrgScope, a: { actorId?: string | null; action: string; entity?: string; entityId?: string; meta?: unknown }) {
      store.run(
        'INSERT INTO audit_log (id, org_id, actor_id, action, entity, entity_id, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
        newId('aud'), scope.orgId, a.actorId ?? null, a.action, a.entity ?? null, a.entityId ?? null,
        JSON.stringify(a.meta ?? {}), now(),
      );
    },
    list(scope: OrgScope, filter: { entity?: string; entityId?: string; limit?: number } = {}) {
      const where = ['org_id = ?'];
      const params: unknown[] = [scope.orgId];
      if (filter.entity) { where.push('entity = ?'); params.push(filter.entity); }
      if (filter.entityId) { where.push('entity_id = ?'); params.push(filter.entityId); }
      params.push(filter.limit ?? 100);
      return store.all<{
        id: string; actor_id: string | null; action: string; entity: string | null;
        entity_id: string | null; meta_json: string; created_at: string;
      // `rowid` breaks ties deliberately. Ordering an audit trail by timestamp alone is
      // non-deterministic when several rows land in the same millisecond — which is the
      // normal case for one approval or one gate decision — and in a trail whose entire
      // value is the order of events, an unstable order is a defect.
      }>(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`, ...params)
        .map((r) => ({
          id: r.id, actorId: r.actor_id, action: r.action, entity: r.entity, entityId: r.entity_id,
          meta: JSON.parse(r.meta_json), createdAt: r.created_at,
        }));
    },
  };
}

// ─── Metrics (PRD §10) ──────────────────────────────────────────────────────

export function metricsRepo(store: Store) {
  return {
    incr(orgId: string, name: string, by = 1) {
      store.run(
        `INSERT INTO metrics (org_id, name, value, updated_at) VALUES (?,?,?,?)
         ON CONFLICT (org_id, name) DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at`,
        orgId, name, by, now(),
      );
    },
    set(orgId: string, name: string, value: number) {
      store.run(
        `INSERT INTO metrics (org_id, name, value, updated_at) VALUES (?,?,?,?)
         ON CONFLICT (org_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        orgId, name, value, now(),
      );
    },
    get(orgId: string, name: string) {
      return store.get<{ value: number }>('SELECT value FROM metrics WHERE org_id = ? AND name = ?', orgId, name)?.value ?? 0;
    },
    all(orgId: string) {
      return Object.fromEntries(
        store.all<{ name: string; value: number }>('SELECT name, value FROM metrics WHERE org_id = ?', orgId)
          .map((r) => [r.name, r.value]),
      ) as Record<string, number>;
    },
  };
}

export function evalRunRepo(store: Store) {
  return {
    record(orgId: string, kind: string, metrics: unknown) {
      store.run('INSERT INTO eval_runs (id, org_id, kind, metrics_json, created_at) VALUES (?,?,?,?,?)',
        newId('evl'), orgId, kind, JSON.stringify(metrics), now());
    },
    latest(orgId: string, kind: string) {
      return store.get<{ metrics_json: string; created_at: string }>(
        'SELECT metrics_json, created_at FROM eval_runs WHERE org_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
        orgId, kind,
      );
    },
  };
}

export type { TicketStatus };
