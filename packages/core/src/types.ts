/**
 * Core domain types. These mirror PRD_ExecuGate.ai.md and are the single
 * source of truth shared by every package.
 */

// ─── Tenancy & identity ──────────────────────────────────────────────────────

export type Role = 'commander' | 'technical' | 'ops' | 'admin';
export type DivisionKind = 'management' | 'technical' | 'operational';

/**
 * Tenant scope. Deliberately a branded-ish object rather than a bare string so
 * that a repository cannot be called without one (ADR: tenant isolation).
 */
export interface OrgScope {
  orgId: string;
}

export interface Actor extends OrgScope {
  userId: string;
  role: Role;
  divisionId: string | null;
  displayName: string;
}

// ─── Ticket state machine (PRD §6) ──────────────────────────────────────────

export type TicketStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'QA_VERIFICATION'
  | 'REWORK_REQUIRED'
  | 'COMPLETED'
  | 'CANCELLED';

/**
 * DEV-1 (see BUILD_PLAN §17): NFR §8.3 requires a pending-verification path when
 * an external API is unavailable, but PRD §6 defines no state for it. We keep the
 * PRD's state list byte-for-byte and carry this as a parallel field instead.
 */
export type VerificationState = 'none' | 'pending' | 'manual_required';

export type Priority = 'P0' | 'P1' | 'P2';

export interface Ticket extends OrgScope {
  id: string;
  projectId: string;
  code: string;
  title: string;
  description: string;
  divisionId: string;
  assigneeId: string | null;
  priority: Priority;
  dueAt: string | null;
  status: TicketStatus;
  verificationState: VerificationState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TicketEvent extends OrgScope {
  id: string;
  ticketId: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus;
  actorId: string;
  reason: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

// ─── Definition of Done (FR-04.1, FR-05) ────────────────────────────────────

export type DodKind = 'engineering' | 'document' | 'reconciliation' | 'data' | 'review';

/**
 * Every DoD criterion carries a machine-executable `check`. This is what makes
 * the Quality-Gatekeeper automatic (FR-05.1) rather than aspirational.
 */
export type Check =
  | { type: 'github_pr'; repo: string; branch: string; requireMerged: boolean; requireCiGreen: boolean; requireNoConflicts: boolean }
  | { type: 'document_present'; documentId?: string; path?: string; minBytes: number }
  | { type: 'reconciliation'; source: string; key: string; expectedField: string; actualField: string; tolerance: number }
  | { type: 'data_row'; source: string; match: Record<string, string | number> }
  | { type: 'manual_review'; reviewerRole: Role };

export interface DodCriterion extends OrgScope {
  id: string;
  ticketId: string;
  kind: DodKind;
  label: string;
  required: boolean;
  check: Check;
  position: number;
}

// ─── Gatekeeper verdicts (FR-05.1, FR-05.2) ─────────────────────────────────

export type Verdict = 'pass' | 'fail' | 'unverifiable';

export interface CheckOutcome {
  type: Check['type'];
  ok: boolean;
  /**
   * True when the check could not be evaluated at all (external API down, timeout).
   * Distinguishes "not done yet" from "done incorrectly", which is what NFR §8.3's
   * pending-verification queue depends on.
   */
  unverifiable?: boolean;
  /** Specific, human-readable detail. Never a generic "failed". */
  detail: string;
  evidenceUrl?: string;
  latencyMs: number;
}

export interface Verification extends OrgScope {
  id: string;
  ticketId: string;
  lane: 'engineering' | 'operational';
  provider: string;
  verdict: Verdict;
  outcomes: CheckOutcome[];
  messageId: string | null;
  latencyMs: number;
  createdAt: string;
}

// ─── Institutional memory (FR-02) ───────────────────────────────────────────

export interface RetrievedChunk {
  chunkId: string;
  docId: string;
  docTitle: string;
  ordinal: number;
  text: string;
  score: number;
  /** How the chunk was found — useful for tuning and for explaining results. */
  matchedBy: 'vector' | 'fts' | 'both';
}

export interface Citation {
  docId: string;
  docTitle: string;
  ordinal: number;
  excerpt: string;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  /** False when the corpus could not support an answer (anti-hallucination gate). */
  grounded: boolean;
}

// ─── Instruction parsing (FR-01.3) ──────────────────────────────────────────

export interface ParsedTaskDraft {
  title: string;
  description: string;
  division: DivisionKind;
  assigneeHint: string | null;
  priority: Priority;
  dueAt: string | null;
  dod: Array<{ kind: DodKind; label: string; required: boolean; check: Check }>;
}

export interface InstructionParse {
  language: 'id' | 'en' | 'mixed';
  summary: string;
  ambiguities: string[];
  tasks: ParsedTaskDraft[];
}

export interface Instruction extends OrgScope {
  id: string;
  projectId: string;
  sourceMessageId: string | null;
  rawText: string;
  asrConfidence: number | null;
  language: string | null;
  parse: InstructionParse | null;
  createdAt: string;
}

// ─── Channels ───────────────────────────────────────────────────────────────

export type InboundKind = 'text' | 'voice' | 'document' | 'callback' | 'command';

export interface InboundMessage {
  /** Channel-native id, used for idempotency. */
  externalId: string;
  senderExternalId: string;
  kind: InboundKind;
  text?: string;
  /** Local path or remote handle to media (voice note, document). */
  mediaRef?: string;
  /** Present on Telegram-style inline buttons. */
  callbackData?: string;
  rawPayload: unknown;
  receivedAt: string;
}

export interface OutboundMessage {
  target: string;
  text: string;
  /** Inline action buttons, FR-03.3. */
  actions?: Array<{ label: string; callbackData: string }>;
  parseMode?: 'markdown' | 'plain';
}

// ─── Job queue (ADR-5) ──────────────────────────────────────────────────────

export type JobKind =
  | 'asr.transcribe'
  | 'llm.parse'
  | 'llm.clarify'
  | 'memory.ingest'
  | 'gate.verify'
  | 'report.walkthrough'
  | 'retention.sweep';

export interface Job<T = Record<string, unknown>> {
  id: string;
  orgId: string;
  kind: JobKind;
  payload: T;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  runAfter: string;
  lastError: string | null;
}

// ─── Reporting (FR-06) ──────────────────────────────────────────────────────

export interface WalkthroughReport {
  orgId: string;
  date: string;
  generatedAt: string;
  completed: Array<{ code: string; title: string; assignee: string; evidenceUrls: string[] }>;
  blocked: Array<{ code: string; title: string; assignee: string; blocker: string }>;
  reopened: Array<{ code: string; title: string; reason: string }>;
  tomorrow: Array<{ code: string; title: string; priority: Priority; dueAt: string | null }>;
  counts: { completed: number; blocked: number; open: number; passRate: number };
}
