/**
 * Typed API client.
 *
 * Every call takes the acting user id explicitly. An earlier version cached it in a
 * module-level variable set from a parent effect, which is fragile: React runs child
 * effects before parent effects, so a page mounted on first render issued its request
 * before the identity existed and failed with 401. Passing the actor through as an
 * argument removes both the ordering hazard and the shared mutable state.
 *
 * The dashboard has no session of its own: it is an operator console, and the server is
 * the single authority on who may do what.
 */

export interface Actor {
  id: string;
  name: string;
  role: 'commander' | 'technical' | 'ops' | 'admin';
  orgId: string;
  org?: string;
}

export interface RosterMember {
  id: string;
  name: string;
  role: Actor['role'];
  division: 'management' | 'technical' | 'operational';
  specializations: string[];
  /** True when a Telegram account is bound to this person. */
  bound: boolean;
}

export type TicketStatus =
  | 'DRAFT' | 'PENDING_APPROVAL' | 'ASSIGNED' | 'IN_PROGRESS'
  | 'QA_VERIFICATION' | 'REWORK_REQUIRED' | 'COMPLETED' | 'CANCELLED';

export interface Ticket {
  id: string;
  code: string;
  title: string;
  description: string;
  status: TicketStatus;
  verificationState: 'none' | 'pending' | 'manual_required';
  priority: 'P0' | 'P1' | 'P2';
  priorityLabel?: string;
  dueAt: string | null;
  assigneeId: string | null;
  assigneeName?: string | null;
  divisionId: string;
  divisionName?: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DodCriterion {
  id: string;
  kind: string;
  label: string;
  required: boolean;
  check: { type: string };
}

export interface CheckOutcome {
  type: string;
  ok: boolean;
  unverifiable?: boolean;
  detail: string;
  evidenceUrl?: string;
  latencyMs: number;
}

export interface Verification {
  id: string;
  lane: string;
  provider: string;
  verdict: 'pass' | 'fail' | 'unverifiable';
  outcomes: CheckOutcome[];
  messageId: string | null;
  latencyMs: number;
  createdAt: string;
}

export interface TicketEvent {
  id: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus;
  reason: string;
  createdAt: string;
}

export interface Citation {
  docTitle: string;
  ordinal: number;
  excerpt: string;
}

export interface TicketDetail extends Ticket {
  dod: DodCriterion[];
  events: TicketEvent[];
  verifications: Verification[];
  thread: Array<{ question: string; answer: string; grounded: boolean; citations: Citation[]; createdAt: string }>;
  referenceDocs: Array<{ title: string }>;
}

export interface DocumentRow {
  id: string;
  title: string;
  state: 'pending' | 'embedding' | 'ready' | 'failed';
  chunks: number;
  embedModel: string | null;
  size: number;
  ingestedAt: string | null;
}

export interface Metrics {
  kpis: Record<string, number>;
  ticketStatus: Partial<Record<TicketStatus, number>>;
  jobs: Array<{ status: string; n: number }>;
  provider: Record<string, string>;
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface Walkthrough {
  date: string;
  completed: Array<{ code: string; title: string; assignee: string; evidenceUrls: string[] }>;
  blocked: Array<{ code: string; title: string; assignee: string; blocker: string }>;
  tomorrow: Array<{ code: string; title: string; priority: string; dueAt: string | null }>;
  counts: { completed: number; blocked: number; open: number; passRate: number };
  rendered: string;
}

export interface IntakeResult {
  instructionId: string;
  summary: string;
  ambiguities: string[];
  ticketIds: string[];
  tickets: Array<{ id: string; code: string; title: string; status: string; priority: string; dueAt: string | null; assigneeId: string | null }>;
  timing: { ttftMs: number; totalMs: number };
  usedFallback: boolean;
  approvalCard: { text: string; actions: Array<{ label: string; callbackData: string }> };
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST';

async function request<T>(actor: string, path: string, method: Method = 'GET', body?: unknown): Promise<T> {
  const url = new URL(path, window.location.origin);
  // The id travels in the header; the query parameter is a convenience for curl.
  url.searchParams.set('userId', actor);

  // The content-type header is only meaningful when there is a body. Declaring
  // application/json on a body-less POST makes Fastify reject the request outright.
  const headers: Record<string, string> = actor ? { 'X-Actor-User-Id': actor } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    // The API answers every failure with a structured { code, message } body.
    const payload = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ApiError(res.status, payload.code ?? 'ERROR', payload.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string; runtime: string }>('', '/health'),
  ready: () => request<{ status: string; checks: Record<string, unknown> }>('', '/ready'),

  /** Readable without an actor: needed to populate the "act as" switcher. */
  roster: () => request<RosterMember[]>('', '/api/v1/roster'),
  me: (actor: string) => request<Actor & {
    divisions: Array<{ id: string; name: string; kind: string }>;
    projects: Array<{ id: string; name: string; code: string }>;
  }>(actor, '/api/v1/me'),

  tickets: (actor: string, status?: TicketStatus) =>
    request<Ticket[]>(actor, `/api/v1/tickets${status ? `?status=${status}` : ''}`),
  ticket: (actor: string, id: string) => request<TicketDetail>(actor, `/api/v1/tickets/${id}`),
  ack: (actor: string, id: string) => request<Ticket>(actor, `/api/v1/tickets/${id}/ack`, 'POST'),
  verify: (actor: string, id: string) =>
    request<{ verdict: string; staffMessage: string; latencyMs: number }>(actor, `/api/v1/tickets/${id}/verify`, 'POST'),
  /**
   * IN_PROGRESS -> QA_VERIFICATION: the staff member claims the work is done.
   * Distinct from `resubmit`, which is the REWORK_REQUIRED -> IN_PROGRESS transition.
   * Calling the wrong one is rejected by the state machine rather than accepted.
   */
  submitEvidence: (actor: string, id: string, url?: string, note?: string) =>
    request<Ticket>(actor, `/api/v1/tickets/${id}/evidence`, 'POST', { url, note }),
  resubmit: (actor: string, id: string, note?: string) =>
    request<Ticket>(actor, `/api/v1/tickets/${id}/resubmit`, 'POST', { note }),
  manualVerification: (actor: string, id: string, approve: boolean, reason: string) =>
    request<Ticket>(actor, `/api/v1/tickets/${id}/manual-verification`, 'POST', { approve, reason }),
  clarify: (actor: string, id: string, question: string) =>
    request<{ answer: string; grounded: boolean; citations: Citation[] }>(
      actor, `/api/v1/tickets/${id}/clarify`, 'POST', { question },
    ),

  intake: (actor: string, text: string) => request<IntakeResult>(actor, '/api/v1/instructions/text', 'POST', { text }),
  decide: (actor: string, instructionId: string, action: 'approve' | 'cancel' | 'correct', extra: Record<string, unknown> = {}) =>
    request<{
      decision: string;
      dispatched: Array<{ id: string; code: string; title: string; status: string }>;
      skipped: Array<{ code: string; reason: string }>;
      alreadyProcessed: boolean;
    }>(actor, `/api/v1/instructions/${instructionId}/decision`, 'POST', { action, ...extra }),

  documents: (actor: string) => request<DocumentRow[]>(actor, '/api/v1/documents'),
  uploadDocument: (actor: string, title: string, body: string) =>
    request<{ documentId: string; chunkCount: number; deduplicated: boolean }>(actor, '/api/v1/documents', 'POST', { title, body }),
  search: (actor: string, query: string) =>
    request<{
      chunks: Array<{ docTitle: string; ordinal: number; score: number; matchedBy: string; excerpt: string }>;
      retrievers: { vector: number; fts: number; degraded: string };
    }>(actor, '/api/v1/documents/search', 'POST', { query, limit: 6 }),

  metrics: (actor: string) => request<Metrics>(actor, '/api/v1/metrics'),
  audit: (actor: string, entityId?: string) =>
    request<AuditRow[]>(actor, `/api/v1/audit?limit=60${entityId ? `&entity=ticket&entityId=${entityId}` : ''}`),
  walkthrough: (actor: string, date?: string) =>
    request<Walkthrough>(actor, `/api/v1/reports/walkthrough${date ? `?date=${date}` : ''}`),
};