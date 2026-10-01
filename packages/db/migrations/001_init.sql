-- ExecuGate.ai initial schema (ADR-1: embedded SQLite via node:sqlite).
-- Every tenant-scoped table carries org_id as the first indexed column so that
-- repository queries cannot accidentally cross tenant boundaries (BUILD_PLAN §11).

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS divisions (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('management','technical','operational')),
  channel_id  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, name)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_divisions_org ON divisions(org_id);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id),
  external_id     TEXT,
  display_name    TEXT NOT NULL,
  email           TEXT,
  role            TEXT NOT NULL CHECK (role IN ('commander','technical','ops','admin')),
  division_id     TEXT REFERENCES divisions(id),
  specializations TEXT NOT NULL DEFAULT '[]',
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  UNIQUE (org_id, external_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_ext ON users(org_id, external_id);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,
  code        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, code)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
) STRICT;

CREATE TABLE IF NOT EXISTS channels (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id),
  kind         TEXT NOT NULL CHECK (kind IN ('telegram','web')),
  external_id  TEXT NOT NULL,
  config_json  TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_channels_org ON channels(org_id, kind);

-- ─── Ingestion (FR-01) ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inbound_seen (
  channel_id   TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  seen_at      TEXT NOT NULL,
  PRIMARY KEY (channel_id, external_id)
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  channel_id    TEXT NOT NULL,
  external_id   TEXT,
  direction     TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_id     TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('text','voice','document','card_action','system')),
  body          TEXT,
  media_ref     TEXT,
  transcript_json TEXT,
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_messages_org_time ON messages(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_ext ON messages(org_id, external_id);

CREATE TABLE IF NOT EXISTS instructions (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id),
  project_id        TEXT NOT NULL REFERENCES projects(id),
  source_message_id TEXT,
  raw_text          TEXT NOT NULL,
  asr_confidence    REAL,
  language          TEXT,
  parse_json        TEXT,
  created_at        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_instructions_org_time ON instructions(org_id, created_at);

-- ─── Tickets (PRD §6) ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tickets (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id),
  project_id         TEXT NOT NULL REFERENCES projects(id),
  instruction_id     TEXT REFERENCES instructions(id),
  seq                INTEGER NOT NULL,
  code               TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL,
  division_id        TEXT NOT NULL REFERENCES divisions(id),
  assignee_id        TEXT REFERENCES users(id),
  priority           TEXT NOT NULL CHECK (priority IN ('P0','P1','P2')),
  due_at             TEXT,
  status             TEXT NOT NULL CHECK (status IN
                       ('DRAFT','PENDING_APPROVAL','ASSIGNED','IN_PROGRESS',
                        'QA_VERIFICATION','REWORK_REQUIRED','COMPLETED','CANCELLED')),
  verification_state TEXT NOT NULL DEFAULT 'none'
                     CHECK (verification_state IN ('none','pending','manual_required')),
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  completed_at       TEXT,
  UNIQUE (org_id, code)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_tickets_org_status ON tickets(org_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(org_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_due ON tickets(org_id, due_at);

-- Append-only audit spine. No UPDATE or DELETE path exists in the repository layer.
CREATE TABLE IF NOT EXISTS ticket_events (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  ticket_id   TEXT NOT NULL REFERENCES tickets(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  reason      TEXT NOT NULL,
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_org_time ON ticket_events(org_id, created_at);

CREATE TABLE IF NOT EXISTS dod_criteria (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  ticket_id  TEXT NOT NULL REFERENCES tickets(id),
  kind       TEXT NOT NULL CHECK (kind IN ('engineering','document','reconciliation','data','review')),
  label      TEXT NOT NULL,
  required   INTEGER NOT NULL DEFAULT 1,
  check_json TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS idx_dod_ticket ON dod_criteria(ticket_id, position);

CREATE TABLE IF NOT EXISTS verifications (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  ticket_id   TEXT NOT NULL REFERENCES tickets(id),
  lane        TEXT NOT NULL CHECK (lane IN ('engineering','operational')),
  provider    TEXT NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('pass','fail','unverifiable')),
  outcomes_json TEXT NOT NULL DEFAULT '[]',
  message_id  TEXT,
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_verifications_ticket ON verifications(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS clarifications (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id),
  ticket_id       TEXT NOT NULL REFERENCES tickets(id),
  asked_by        TEXT NOT NULL,
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  citations_json  TEXT NOT NULL DEFAULT '[]',
  grounded        INTEGER NOT NULL DEFAULT 1,
  escalated       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_clarifications_ticket ON clarifications(ticket_id, created_at);

-- ─── Institutional memory (FR-02) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  project_id    TEXT NOT NULL REFERENCES projects(id),
  title         TEXT NOT NULL,
  source_path   TEXT,
  mime          TEXT NOT NULL DEFAULT 'text/markdown',
  size          INTEGER NOT NULL DEFAULT 0,
  checksum      TEXT NOT NULL,
  ingest_state  TEXT NOT NULL DEFAULT 'pending'
                CHECK (ingest_state IN ('pending','embedding','ready','failed')),
  embed_model   TEXT,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  ingested_at   TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (org_id, checksum)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_documents_org_project ON documents(org_id, project_id);

-- `embedding` is little-endian float32; `dims` guards against mixing models in one index.
CREATE TABLE IF NOT EXISTS doc_chunks (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  doc_id     TEXT NOT NULL REFERENCES documents(id),
  ordinal    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  embedding  BLOB,
  dims       INTEGER,
  tokens     INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS idx_chunks_project ON doc_chunks(org_id, project_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON doc_chunks(doc_id, ordinal);

-- ADR-3: lexical half of hybrid retrieval.
CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  text,
  content='doc_chunks',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS doc_terms (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  term       TEXT NOT NULL,
  canonical  TEXT NOT NULL,
  definition TEXT NOT NULL,
  UNIQUE (org_id, project_id, term)
) STRICT;

-- ─── Platform ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_queue (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  kind       TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','running','done','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after  TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON job_queue(status, run_after);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  actor_id   TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  meta_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(org_id, entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(org_id, created_at);

-- AES-256-GCM. iv and tag are stored separately (BUILD_PLAN §11).
CREATE TABLE IF NOT EXISTS secrets (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  key_name   TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv         BLOB NOT NULL,
  tag        BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, key_name)
) STRICT;

-- Append-only KPI counters backing PRD §10.
CREATE TABLE IF NOT EXISTS metrics (
  org_id     TEXT NOT NULL,
  name       TEXT NOT NULL,
  value      REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, name)
) STRICT;

-- Run history for the evaluation scripts (PRD §10 evidence).
CREATE TABLE IF NOT EXISTS eval_runs (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_eval_runs_kind ON eval_runs(org_id, kind, created_at);
