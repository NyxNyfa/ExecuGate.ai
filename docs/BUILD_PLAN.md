# ExecuGate.ai — Build Plan

**Derived from:** `PRD_ExecuGate.ai.md` v1.1.0
**Plan date:** 2026-10-01
**Target:** ANGEL Innovation Hackathon 2026 — Prototype Alpha (Track A, Conversational AI for Business Process Execution)
**Constraints:** Solo developer, 2–3 weeks. Build machine: Win11, 7.8 GB RAM, i5-8250U, no Docker. Demo machine: laptop with RTX 3050 (4 GB VRAM).

---

## 1. Executive Summary

ExecuGate.ai is a middleware that converts a commander's unstructured instruction (voice or text) into verified, audited work tickets. The differentiator is not the chatbot — it is the **Automated Quality-Gatekeeper**: a second QA layer that refuses to mark work complete until an external system of record objectively confirms it.

The build reduces to one **golden path** that must be demonstrably end-to-end:

```
Voice/text in Telegram
  → ASR transcript
  → LLM decomposition into tickets + Definition of Done (RAG-grounded)
  → HITL approval card  [Setujui] [Koreksi] [Batalkan]
  → tickets dispatched to division chats
  → staff acks, asks clarifying questions (answered from project memory)
  → staff submits evidence
  → Gatekeeper hits GitHub / ops source-of-truth
  → COMPLETED (audit recorded)  or  REWORK_REQUIRED (specific correction message)
  → "tampilkan progres hari ini" → Executive Evening Walkthrough
```

Everything in the plan is ordered so that each day ends with a runnable increment. If the schedule slips, phases are cut from the back (§13), never from the spine.

---

## 2. Constraint Reality Check

The build machine shapes the architecture more than the PRD does. Each constraint is answered deliberately rather than ignored.

| Constraint | Consequence | Decision |
|---|---|---|
| No Docker | No Postgres, no pgvector, no Redis | Embedded SQLite via built-in `node:sqlite`. Verified: SQLite 3.50.4 with **FTS5, json1, BLOB, WAL, STRICT, window functions, recursive CTEs** — everything the persistence + RAG layer needs. |
| 7.8 GB RAM, 4-core i5-8250U | No local LLM/ASR during build | All AI behind **provider adapters**. Build runs on a deterministic `fake` provider with zero API keys; real providers plug in by env var. |
| Solo, 2–3 weeks | Cannot build 6 modules deeply | Hard scope cut to one golden path (§4). Other paths stubbed with real interfaces. |
| Demo machine = RTX 3050 4 GB | Can host small models, not large ones | Adapter must accept a **local OpenAI-compatible server** (llama.cpp / Ollama / LM Studio). Plan §9 specifies the exact models that fit 4 GB VRAM. |
| GitHub API 60 req/hr unauthenticated | Gatekeeper would rate-limit instantly | Require a scoped PAT; add conditional-request caching, bounded concurrency, and exponential backoff (§11). |
| No public URL / no tunnel | Webhook-based Telegram is awkward | Telegram adapter uses **long polling** in dev — needs no inbound port. Webhook path is still implemented for production. |

### What "fake provider" means (important for the demo)

The build machine cannot run a model, but the demo machine can. Rather than writing throwaway mock code, every AI dependency is a real interface with two implementations:

- `fake` — deterministic, seeded, instant. Used for tests, CI, and local dev on the build machine.
- `openai-compatible` — points at any of: OpenAI, Anthropic-via-gateway, Groq, OpenRouter, Ollama, llama.cpp server, LM Studio.

This means **the demo laptop runs real inference**, and CI on the build machine runs the same test suite with no network. This is the single highest-leverage architectural decision in the plan.

---

## 3. Architecture

### 3.1 Layering (maps to PRD §7)

```
┌──────────────────────────────────────────────────────────────────┐
│ CHANNELS            Telegram (primary) · Web control center     │
├──────────────────────────────────────────────────────────────────┤
│ ORCHESTRATION       Instruction intake · Approval · Dispatch     │
│                     Staff loop · Gate invocation · Reporting      │
├───────────────┬───────────────┬───────────────┬──────────────────┤
│ ASR           │ LLM           │ MEMORY (RAG)  │ GATEKEEPER       │
│ whisper/cloud │ cloud/local   │ chunk+embed   │ rule engine      │
│ adapter       │ adapter       │ hybrid search │ + connectors     │
├───────────────┴───────────────┴───────────────┴──────────────────┤
│ PERSISTENCE   SQLite (node:sqlite) · FTS5 · float32 vector BLOB │
├──────────────────────────────────────────────────────────────────┤
│ PLATFORM       auth · RBAC · audit log · job queue · metrics     │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Key decisions (ADRs)

| # | Decision | Alternatives rejected | Why |
|---|---|---|---|
| ADR-1 | SQLite (`node:sqlite`) as the only datastore | Postgres+pgvector, MongoDB+Atlas | No Docker. SQLite covers relational integrity, FTS5 lexical search, and BLOB vectors. Upgrade path to Postgres is a repository-layer change only (§17.3). |
| ADR-2 | Brute-force cosine over float32 BLOB | sqlite-vec, Qdrant, Pinecone | At demo scale (≤10k chunks × 384 dims ≈ 1.5 MB) a linear scan is ~2–5 ms in JS — faster than a vector DB round-trip. Zero native compilation on a machine without build tools. |
| ADR-3 | Hybrid retrieval: FTS5 BM25 + vector, fused with RRF | Vector-only | Indonesian org jargon ("j Bridging", "SOP Q3", "batch reconciliation") is lexical-heavy. Vector-only retrieval misses exact identifiers; BM25-only misses paraphrase. |
| ADR-4 | Long-polling Telegram transport | Webhook + tunnel | No inbound port on the build machine; one fewer moving part in a 2-week build. |
| ADR-5 | In-process job queue backed by a SQLite table | BullMQ + Redis, Cloud Tasks | No Redis. A `job_queue` table with `run_after`/`attempts` survives restarts — better than in-memory timers, which is what a demo laptop restart would destroy. |
| ADR-6 | Provider adapters with a `fake` implementation everywhere | Direct SDK calls | Enables zero-key local dev, deterministic CI, and cloud↔local swap on the demo machine. |
| ADR-7 | Telegram is the *only* channel in Alpha; web is read-mostly | Multi-channel | PRD §9 explicitly scopes Alpha to one messaging platform. |

### 3.3 Repository layout

```
execugate/
├─ package.json                  npm workspaces (pnpm unavailable)
├─ tsconfig.base.json
├─ apps/
│  ├─ api/          Fastify HTTP server (REST + health + webhooks)
│  ├─ bot/          Telegram long-poll worker
│  ├─ worker/       Job-queue processor (ASR, embedding, gatekeeper, reports)
│  └─ web/          React + Vite control center
├─ packages/
│  ├─ core/         Types, ticket state machine, errors, ids, result type
│  ├─ db/           Migrations, connection, repositories, seed
│  ├─ llm/          Provider adapter, structured output, prompts
│  ├─ asr/          ASR adapter (whisper-http, cloud, fake)
│  ├─ memory/       Chunking, embedding, hybrid retrieval, cited answers
│  ├─ channels/     Channel interface, Telegram, markdown/card rendering
│  ├─ gatekeeper/   Rule engine + provider connectors
│  ├─ orchestration/Workflow services (the spine)
│  └─ observability/ Structured logging, redaction, metrics
├─ fixtures/
│  ├─ seed/         Demo org, SOPs, architecture docs, staff roster
│  └─ eval/         Instruction + audio eval sets for KPI measurement
└─ docs/            This plan, ADRs, API contract, demo script
```

Dependency rule: `core` ← `db` ← everything else. `orchestration` is the only package allowed to know about more than one other package.

---

## 4. Scope Cut (MoSCoW)

The PRD describes a product. The hackathon needs a demonstration. This is the honest line between them.

### Must — the golden path, non-negotiable
1. Telegram inbound: text + voice note
2. ASR → transcript (adapter; local whisper server + cloud + fake)
3. LLM decomposition → structured tickets with DoD criteria
4. RAG retrieval → RAG-grounded decomposition and staff answers, with citations
5. HITL approval card with `[Setujui & Distribusikan]` / `[Koreksi Parameter]` / `[Batalkan]`
6. Ticket dispatch into per-division chats; staff acknowledge → `IN_PROGRESS`
7. Staff clarifying questions answered from project memory without escalating to the commander
8. Evidence submission → `QA_VERIFICATION`
9. Gatekeeper: engineering lane (PR merged, CI green, no conflicts) + ops lane (reconciliation/document checks)
10. `COMPLETED` / `REWORK_REQUIRED` transitions with specific correction messages
11. Evening Walkthrough on voice/text trigger (FR-06)
12. Append-only audit trail

### Should — makes it credible in a judging room
13. Web control center: ticket board, approval, document upload, walkthrough history
14. Multi-tenant isolation + RBAC (commander / tech / ops / admin)
15. Pending-verification queue when an external API is down (NFR §8.3)
16. KPI instrumentation so the PRD §10 metrics are *measured*, not asserted
17. `FAKE` gatekeeper provider for offline demo rehearsals

### Could — build only if ahead of schedule
18. Indonesian/English code-switched ASR tuning
19. Cross-encoder reranking of retrieved chunks
20. Structured JSON-schema-constrained decoding on the local model

### Won't (Alpha) — documented, not built
- Slack / WhatsApp / Teams channels (channel interface exists; adapters don't)
- Graphical analytics dashboards with workload forecasting
- ERP / inventory-system connectors beyond a generic form+reconciliation one
- Multi-project management UI with tiered access control
- Native mobile apps

---

## 5. Data Model

SQLite, `STRICT` tables, `org_id` on every tenant-scoped row. Full DDL in `packages/db/migrations/`.

```
organizations(id, name, slug, timezone, created_at)

users(id, org_id, external_id,            -- telegram user id
      display_name, email, role,           -- commander|technical|ops|admin
      division_id, specializations_json, status, created_at)

divisions(id, org_id, name, kind, channel_id)   -- kind: technical|operational|management
projects(id, org_id, name, code, status, created_at)
project_members(project_id, user_id, role)

channels(id, org_id, kind, external_id, config_json, status)  -- telegram|web

messages(id, org_id, channel_id, external_id, direction, sender_id,
         kind,           -- text|voice|document|card_action|system
         body, media_ref, transcript_json, created_at)

instructions(id, org_id, project_id, source_message_id, raw_text,
             asr_confidence, language, parse_json, created_at)

tickets(id, org_id, project_id, code, title, description,
        division_id, assignee_id, priority, due_at, status,
        verification_state,             -- none|pending|manual_required
        created_by, created_at, updated_at, completed_at)

ticket_events(id, org_id, ticket_id, from_status, to_status, actor_id,
              reason, meta_json, created_at)      -- append-only, audit spine

dod_criteria(id, ticket_id, kind, label, required, spec_json, position)
verifications(id, org_id, ticket_id, lane, provider, verdict,
              evidence_json, latency_ms, created_at)
clarifications(id, org_id, ticket_id, asked_by, question, answer,
               citations_json, created_at)

documents(id, org_id, project_id, title, source_path, mime, size,
          checksum, ingest_state, ingested_at)
doc_chunks(id, org_id, project_id, doc_id, ordinal, text,
           embedding BLOB, dims, tokens)     -- float32 little-endian
doc_terms(id, org_id, project_id, term, canonical, definition)

job_queue(id, org_id, kind, payload_json, status, attempts,
          run_after, last_error, created_at, updated_at)
audit_log(id, org_id, actor_id, action, entity, entity_id,
          meta_json, created_at)             -- append-only
secrets(id, org_id, key, ciphertext, iv, tag, created_at)  -- AES-256-GCM
```

**Indexes:** every `org_id`; `tickets(org_id,status)`, `tickets(assignee_id,status)`, `ticket_events(ticket_id,created_at)`, `job_queue(status,run_after)`, FTS5 virtual table over `doc_chunks.text` with `content=doc_chunks` for external-content sync.

**Vector storage:** `embedding BLOB` holds little-endian float32. Retrieved with a single `SELECT ... ORDER BY created_at` scan per project and scored in JS. A `dims` column guards against mixing embedding models inside one index.

---

## 6. Ticket State Machine

Implemented as an explicit transition table in `packages/core/state-machine.ts` — data, not scattered `if` statements. Illegal transitions throw; nothing mutates `tickets.status` directly.

```
                 ┌──────────────┐
  intake ───────►│    DRAFT     │
                 └──────┬───────┘
                        │ parse complete
                 ┌──────▼─────────────┐
        ┌────────│ PENDING_APPROVAL  │
        │        └──────┬─────┬──────┘
        │ approve       │     │ cancel
   ┌────▼────┐          │  ┌──▼────────┐
   │ASSIGNED │          │  │ CANCELLED │◄──────┐
   └────┬────┘          │  └───────────┘       │
        │ ack           └──────────────────────►│ (also from DRAFT)
   ┌────▼─────────┐                              │
   │ IN_PROGRESS  │                              │
   └────┬─────────┘                              │
        │ submit evidence                         │
   ┌────▼───────────┐                            │
   │QA_VERIFICATION │                            │
   └────┬────────┬─┘                            │
  pass  │        │  fail                         │
   ┌────▼───┐  ┌─▼──────────────┐                │
   │COMPLETED│  │REWORK_REQUIRED │──── resubmit ──┘ (→ IN_PROGRESS)
   └────────┘  └────────────────┘
```

**Transition table** (trigger is the PRD §6 "Pemicu Transisi"):

| From | To | Trigger | Guard |
|---|---|---|---|
| DRAFT | PENDING_APPROVAL | parse completed | ≥1 ticket produced |
| PENDING_APPROVAL | ASSIGNED | `[Setujui]` | actor role = commander/admin |
| PENDING_APPROVAL | DRAFT | `[Koreksi Parameter]` | actor = original approver |
| PENDING_APPROVAL | CANCELLED | `[Batalkan]` | actor = commander/admin |
| ASSIGNED | IN_PROGRESS | staff acks | assignee matches |
| IN_PROGRESS | QA_VERIFICATION | evidence submitted | ≥1 DoD criterion satisfied |
| QA_VERIFICATION | COMPLETED | gatekeeper verdict `pass` | all required criteria pass |
| QA_VERIFICATION | REWORK_REQUIRED | gatekeeper verdict `fail` | specific failing criterion recorded |
| REWORK_REQUIRED | IN_PROGRESS | staff resubmits | rework feedback acknowledged |

### Proposed PRD deviation (flag for judges)

The PRD §6 state list has no representation for **external API outage**, yet NFR §8.3 requires the system not to fail a task and instead queue it for pending verification. Rather than invent a ninth state, this plan keeps `QA_VERIFICATION` and adds a parallel field:

```
verification_state ∈ { none, pending, manual_required }
```

- `pending` — external check enqueued or retrying; UI shows "Menunggu verifikasi", the ticket is **not** completed.
- `manual_required` — retries exhausted; a commander-facing action offers `[Verifikasi Manual] [Tolak]` (FR-05 stays enforced — manual verification is an explicit human override, audited with actor and reason, never silent).

This preserves the PRD's state machine exactly while satisfying NFR §8.3. Raised as a formal deviation in §17.

---

## 7. Module Specifications

Each module: requirement → design → done-when.

### FR-01 · Ingestion (text + voice)

- **Channel interface** — `packages/channels/src/types.ts`: `start()`, `stop()`, `onInbound(handler)`, `send(target, message)`. Normalized inbound carries `externalId`, `senderId`, `kind`, `text?`, `mediaRef?`, `rawPayload`.
- **Telegram adapter** — long polling; handles `message.text`, `message.voice`/`message.audio` (downloads to a temp file), `callback_query` for approval buttons. Idempotency on `update_id` via an `inbound_seen` table so Telegram's retry-on-timeout cannot create duplicate instructions.
- **ASR** — `packages/asr`. Downloads voice, enforces a 25 MB / 300 s guard, then:
  - `whisper-http`: POSTs multipart to a local `whisper.cpp`/`faster-whisper-server` endpoint (the demo machine). Language auto-detect enabled for code-switching.
  - `cloud`: OpenAI-style `/audio/transcriptions`.
  - `fake`: returns a fixture transcript.
- **ASR confidence** — recorded on the instruction. Below 0.55, the approval card leads with a caution line ("transkripsi mungkin kurang tepat — mohon konfirmasi") rather than silently trusting it.
- **FR-01.3 intent parsing** — LLM returns a strict JSON object:

```jsonc
{
  "language": "id",
  "summary": "intisari arahan",
  "ambiguities": ["butir yang perlu diklarifikasi"],
  "tasks": [{
    "title": "...",
    "description": "...",
    "division": "technical|operational",
    "assignee_hint": "nama dari roster",
    "priority": "P0|P1|P2",
    "due_at": "ISO-8601 | null",
    "dod": [{
      "kind": "engineering|document|reconciliation|data|review",
      "label": "kriteria selesai manusia",
      "required": true,
      "check": { "type": "github_pr", "repo": "org/repo", "branch": "...", "require_ci_green": true, "require_no_conflicts": true }
    }]
  }]
}
```

  Every `check` is machine-executable — that is what makes FR-05 automatic rather than aspirational. `kind: engineering` always produces a `github_pr` check; the gatekeeper has no other way to verify engineering work objectively.

- **Done when** — a voice note from the commander produces a draft with correct division assignment and at least one executable check per engineering task.

### FR-02 · Institutional Project Memory

- **Ingestion** — accept `.md`/`.txt`/`.pdf`/`.docx`; chunk by heading-aware recursive splitting (target 700 tokens, 100 overlap, never split a code fence or a table row); embed; store; register in FTS5. Checksum + `ingest_state` make re-upload idempotent.
- **Embedding adapter** — `fake` (deterministic hashed vectors, for CI) / `openai-compatible` / local `multilingual-e5-small` on the demo machine. `dims` is recorded per chunk; a model change forces re-embedding rather than silently corrupting the index.
- **Retrieval** — top-k vector (cosine) ∪ top-k BM25 (FTS5) → reciprocal-rank fusion (k=60) → optional cross-encoder rerank → 6 chunks into the prompt. Multi-tenant filter is applied in SQL, never after the fact.
- **Grounding contract** — retrieved chunks are injected with `source_id` + `title` + `ordinal`. The prompt forbids asserting facts absent from the provided chunks. Answers return `citations[]`, and the Telegram reply renders them as numbered source lines — this is the visible anti-hallucination proof for FR-02.3.
- **Done when** — a staff member asks "batas payload modul pembayaran?" and gets an answer quoting the ingested architecture doc, with a citation. A question the corpus cannot answer returns "tidak ditemukan dalam memori proyek" plus an escalation hint rather than a guess.

### FR-03 · HITL Approval Gate

- **FR-03.1** — distribution is physically impossible without an approval record: ticket creation writes `PENDING_APPROVAL` only, and the dispatcher selects `WHERE status='ASSIGNED'`. There is no code path that posts to a division channel from `PENDING_APPROVAL`.
- **Card layout** — original instruction (and its transcript with confidence), per-task summary grouped by division, per-task DoD, assignee proposal. One card, scrollable, ≤3 actions.
- **Actions** — `[Setujui & Distribusikan]` → fan-out. `[Koreksi Parameter]` → inline stepper: assignee ←→ / priority ↑↓ / due date, then re-confirm. `[Batalkan]` → tickets to `CANCELLED` with reason, nothing dispatched.
- **Idempotency** — `callback_query` carries the instruction id; a repeat press is answered with "sudah diproses" and mutates nothing.
- **Timeout** — approval pending >24 h raises a nudge to the commander and an audit entry. Optional auto-expire is off by default; silently expiring authority is the wrong default for a governance control.
- **Done when** — three taps to distribute; a double-tap creates nothing extra; cancel dispatches nothing.

### FR-04 · Two-way Conversational Execution

- **Dispatch** — ticket card: code, title, technical description, priority, due, required reference documents (resolved from project memory, not retyped), and the DoD checklist rendered as plain language so staff know what "done" means.
- **Ack** — `[Terima]` / `[Mulai]` buttons → `IN_PROGRESS`.
- **Clarification loop** — any staff message in a ticket thread is treated as a question against project memory. Answer is RAG-grounded with citations and an explicit confidence flag. `[Tanya keaji` (escalate) forwards the question to the commander with the thread context attached, and blocks the ticket until answered.
- **Guard against loop** — max 6 clarification rounds per ticket per hour, then auto-escalate. Prevents an LLM from politely chatting forever and stalling a ticket.
- **Done when** — staff gets an answer without the commander typing a word; the commander sees only what genuinely needs a human.

### FR-05 · Automated Quality-Gatekeeper

- **Rule engine** — `packages/gatekeeper/src/engine.ts`. Loads a ticket's `dod_criteria`, dispatches by `check.type`, evaluates with a 1.5 s per-provider timeout, produces a `Verdict`:

```jsonc
{ "lane": "engineering", "verdict": "pass|fail|unverifiable",
  "checks": [{ "type":"github_pr", "ok":false, "detail":"CI check 'integration' failed on commit a1b2c3d" }],
  "message_id": "rework.gh.ci_failed" }
```

- **Engineering connector (GitHub)** — for a branch → find PR → confirm mergeable and not conflicting → list check-runs for head SHA → all `conclusion ∈ {success, neutral, skipped}`. Uses a token scoped `read:contents`+`read:checks`; honors `ETag`/`If-None-Match` for 304s, caps concurrency at 4, backs off on 403/429.
- **Ops connector** — generic, three check types so it generalizes without a bespoke integration:
  - `document_present` — required artifact exists and is non-empty
  - `reconciliation` — a declared numeric field matches a source-of-truth within tolerance
  - `data_row` — a record exists matching declared criteria
  Source is a seeded table or a Google Sheets range. Demonstrates "spreadsheet cloud" from FR-05.1 without an ERP integration.
- **Rejection messages** — PRD FR-05.2 requires *specific* correction text. Messages are templated per `message_id` and filled with live values: *"Pengajuan belum diterima: build #482 gagal pada langkah 'integration-tests' (commit a1b2c3d)."* Never a generic "gagal".
- **Done when** — a PR with a red CI job produces `REWORK_REQUIRED` with the failing job named; the same PR after a green re-run passes and writes an audit row.

### FR-06 · Evening Walkthrough

- **Trigger** — "tampilkan progres hari ini", on voice or text, from a commander; also a scheduled 17:00 job.
- **Aggregation** — ticket_events within the local day boundary (org timezone): completed w/ artifact links, blocked w/ blocker text, reopened today, and tomorrow's priority projection = open tickets sorted by (due_at, priority).
- **Rendering** — a single scrollable Telegram message (works with no dashboard) plus an HTML page in the control center. Includes artifact deep links — the "tautan bukti artefak" requirement.
- **Done when** — the phrase alone produces a correct, cited report with links.

---

## 8. Job Queue

SQLite-backed (`packages/orchestration/src/jobs.ts`). Claims work with an atomic `UPDATE ... WHERE status='queued' RETURNING *` so two processes can't double-claim.

Kinds: `asr.transcribe`, `memory.ingest`, `memory.embed`, `llm.parse`, `llm.clarify`, `gate.verify`, `report.walkthrough`, `retention.sweep`.

Each has `max_attempts`, exponential backoff with jitter, and a dead-letter state surfaced in the control center. Retry policy is what makes NFR §8.3 achievable: a GitHub outage becomes a queued retry, never a lost task.

---

## 9. AI Layer Strategy

### 9.1 Provider matrix

The same interface, three deployments. `LLM_BASE_URL` is the only thing that changes between the build laptop and the demo laptop.

| Role | Build laptop (this machine) | Demo laptop (RTX 3050 4 GB) | Cloud fallback |
|---|---|---|---|
| Decomposition | `fake` (deterministic fixtures) | **Qwen2.5-3B-Instruct** Q4_K_M via llama.cpp / Ollama | `gpt-4o-mini` / Qwen-Max via OpenAI-compatible |
| Clarification answers | `fake` | same 3B model | cloud |
| Embeddings | `fake` (hashed vectors) | **`intfloat/multilingual-e5-small`** (384d, ~471 MB) | `text-embedding-3-small` |
| ASR | `fake` (fixture transcript) | **faster-whisper `small`** (int8_float16, ~1 GB VRAM) | OpenAI `whisper-1` / Groq |
| Optional rerank | — | `bge-reranker-base` (~1.1 GB) *only if VRAM allows* | — |

VRAM budget on a 4 GB card (~3.8 GB usable):

| Role | Model | Footprint |
|---|---|---|
| ASR | whisper `small` int8_float16 | ~1.1 GB |
| LLM | Qwen2.5-3B-Instruct Q4_K_M + 8k KV cache | ~2.6 GB |
| Embeddings | multilingual-e5-small | ~0.6 GB |
| **combined** | | **~4.2 GB — exceeds the card** |

`ModelArbiter` (`packages/orchestration/src/arbiter.ts`) therefore enforces **one resident
role at a time**, releasing the outgoing model before the incoming one is used. This is
implemented and tested (`tests/unit/arbiter.test.ts`), not left to operational
discipline: without it the first request of each kind loads a model and keeps it
resident, and the card dies partway through a demo.

`VRAM_BUDGET_MB` (default 4096, set to 3800 on the laptop) is what the arbiter
validates the largest single footprint against.

Verification: `npm run check:gpu` probes all three endpoints and exits non-zero if any
is unreachable; `npm run bench:gpu` additionally times a real completion and embedding
round trip.

### 9.2 The latency problem, stated honestly

PRD NFR §1 wants instruction decomposition under 3 s. On an RTX 3050, Qwen2.5-3B Q4 decodes at roughly 30–50 tok/s. A 300-token structured output therefore takes **6–10 s** — the 3 s target is not reachable with a local 3B model on that GPU.

Three-part response, implemented rather than hand-waved:

1. **Stream the card.** Tokens stream into the Telegram message as they are produced. Time-to-first-token is ~300 ms, so the commander sees an answer forming immediately. The plan reports **TTFT** as the user-perceived metric and **TTFT-complete** separately — both measured, both shown on the dashboard. This is honest engineering, not metric-gaming.
2. **Grammar-constrained decoding.** llama.cpp/Ollama guide the decode with a JSON schema, so a 3B model cannot emit invalid structure. Cuts output length (~200 tokens) and eliminates parse failures.
3. **Cloud mode meets the literal target.** With `LLM_PROVIDER=cloud`, structured decomposition lands at 1–2 s and the NFR is satisfied as written. The dashboard states which mode produced each result.

Documented as deviation DEV-2 (§17).

### 9.3 Prompt strategy

- Decomposition prompt carries: org + project identity, staff roster with specializations, DoD grammar (valid `check` types with examples), retrieved project memory, the raw instruction, and an explicit "ask rather than assume" clause that populates `ambiguities[]`.
- Every ticket's DoD is generated in the same call as the ticket — separate calls would double latency and allow drift between the ticket and its criteria.
- Prompt and parse schema are **versioned in the DB** so a KPI regression can be attributed to a prompt change.
- `temperature=0` for decomposition (reproducibility matters more than variety); `0.3` for clarification answers.

---

## 10. API Surface

REST, JSON, `/api/v1`. Auth via short-lived JWT; role and `org_id` claims come from the token, never from the request body.

```
GET    /health                         liveness (no deps)
GET    /ready                          dependency readiness
GET    /api/v1/me

POST   /api/v1/instructions/text       internal/test hook (same path as bot)
POST   /api/v1/tickets/:id/ack
POST   /api/v1/tickets/:id/evidence
POST   /api/v1/tickets/:id/clarify     { question }  → { answer, citations }
POST   /api/v1/tickets/:id/verify      force a gatekeeper run
POST   /api/v1/tickets/:id/manual-verification  { verdict, reason }  (audited)

GET    /api/v1/tickets?status=&division=&assignee=
GET    /api/v1/tickets/:id             ticket + DoD + events + verifications
GET    /api/v1/tickets/:id/thread

POST   /api/v1/documents               upload → ingest job
GET    /api/v1/documents               list + ingest_state
POST   /api/v1/documents/search        { query, projectId } → chunks + scores

GET    /api/v1/reports/walkthrough?date=
GET    /api/v1/audit?entity=ticket&entityId=
GET    /api/v1/metrics                 KPI counters (PRD §10)
```

Telegram updates arrive on the bot's long-poll, not through HTTP, in dev; a `POST /api/v1/webhooks/telegram` route exists for webhook mode.

---

## 11. Security & Multi-Tenancy

| Control | Implementation |
|---|---|
| Secrets at rest | `secrets` table, AES-256-GCM, key from `EXECUGATE_MASTER_KEY`. Dev fallback keyfile generated on first run with 0600 perms and a loud warning. |
| Transport | TLS 1.3 terminates at the reverse proxy in production; the app refuses non-TLS when `NODE_ENV=production` and no proxy header is present. |
| Tenant isolation | `org_id` is a **required first argument of every repository function** (enforced by the TypeScript signature, not by convention). An integration test asserts that entity IDs from org B are invisible to org A on all 11 repositories. |
| RBAC | Commander: approve/cancel/manual-verify/report. Tech/Ops: ack/submit evidence/clarify on own tickets. Admin: documents, members, replay. Enforced in a single `authorize()` chokepoint. |
| Media | Voice/downloads streamed to a temp dir, size-capped, deleted after transcription. Never persisted raw audio beyond the job. |
| Prompt injection | Retrieved chunks are wrapped in delimiters and labelled untrusted; the system prompt forbids following instructions found inside them. A `jailbreak` eval case is in the fixture set. |
| Audit | `audit_log` + `ticket_events` are append-only. No UPDATE or DELETE grant path exists in the repository layer. |

---

## 12. NFR Budgets & How Each Is Met

| NFR | Target | Mechanism | Verified by |
|---|---|---|---|
| ASR 30 s → text | < 4 s | whisper `small` on CUDA int8_float16; larger model / cloud if the demo shows a miss | `npm run eval:asr` |
| Decomposition | < 3 s | cloud mode; local mode reports TTFT ~300 ms / TTFT-complete ~8 s | `npm run eval:latency` |
| External check | < 2 s | 1.5 s provider timeout, 4-way concurrency, ETag cache | `npm run eval:gate` |
| AES-256 / TLS 1.3 | required | §11 | `npm run test:security` |
| Tenant isolation | required | §11 | `npm run test:tenancy` |
| API fault tolerance | queue + manual | §8 job retries, `verification_state` | fault-injection test with a stubbed 503 |

Every row is a script, not an aspiration. A latency report is written to `artifacts/metrics.json` on each eval run for the KPI slide.

---

## 13. Schedule — Solo, 15 working days

Each day ends runnable. Days 16+ is the buffer the plan assumes exists.

### Week 1 — Foundation and the approval spine (D1–D5)

| Day | Deliverable | Ends runnable because |
|---|---|---|
| D1 | Monorepo, tsconfig, workspaces, `node:sqlite` boot, migration runner, `/health` | `GET /health` returns 200 |
| D2 | `core`: types, ids, result type, **state machine + transition tests** | `npm test` green on transition table |
| D3 | `db`: full schema, repositories, `FACTORY_RESET` seed (org, staff, divisions, project) | `npm run seed` prints a roster |
| D4 | `llm` adapter (`fake` + OpenAI-compatible), strict parse schema, prompt v1, JSON repair | unit test: fixture → valid ticket objects |
| D5 | `channels` interface + Telegram long-poll, inbound normalization, idempotency | real Telegram message lands in DB |

**Week 1 gate:** type "kirim laporan ke tim teknis" in Telegram → see a parsed draft in the DB.

### Week 2 — Memory, dispatch, gatekeeper (D6–D10)

| Day | Deliverable |
|---|---|
| D6 | Approval card + 3 actions + idempotent callbacks + ticket creation |
| D7 | `memory`: chunking, embedding adapter, FTS5 index, vector store, RRF hybrid retrieval |
| D8 | Document upload + ingest + cited retrieval; clarification Q&A loop |
| D9 | `gatekeeper`: rule engine + GitHub connector + `fake` connector + pass/fail/rework transitions |
| D10 | Ops connector (`document_present`, `reconciliation`, `data_row`), pending-verification queue, retry/backoff |

**Week 2 gate:** one ticket goes `ASSIGNED → IN_PROGRESS → QA_VERIFICATION → REWORK_REQUIRED` against the seeded demo repo with a deliberately red CI job, then `COMPLETED` after green.

### Week 3 — Voice, walkthrough, web, hardening (D11–D15)

| Day | Deliverable |
|---|---|
| D11 | `asr` adapter: `whisper-http`, cloud, fake; voice-note path end-to-end |
| D12 | FR-06 walkthrough aggregation + Telegram rendering + scheduled job |
| D13 | Web control center: board, approve, documents, walkthrough, metrics |
| D14 | Auth + RBAC + tenant isolation tests + secret manager + redaction |
| D15 | Evals (ASR WER, ticket accuracy, latency), KPI report, seed demo data, **demo dry run** |

**Week 3 gate:** the full golden path runs from a voice note to a completed, audited ticket, in under 3 minutes of wall clock for the script.

### Cut order if behind schedule
1. Web control center → replace with a richer Telegram UI (saves ~1.5 days, small judging impact)
2. Cross-encoder rerank (saves ~0.25 day, quality only)
3. Ops connector beyond `document_present` (saves ~0.5 day)
4. Multi-tenant depth → single tenant with the isolation tests kept as a documented next step (saves ~0.5 day)

Never cut: state machine, gatekeeper, audit log, or the streaming approval card.

---

## 14. Test & Evaluation Strategy

```
packages/core        state machine — every legal + illegal transition
packages/memory      chunking invariants; RRF ordering; tenant filter
packages/gatekeeper  each check type; timeout → unverifiable; fail → specific message
packages/llm         parse schema validation; JSON repair; hallucination refusal
```

| Suite | Command | Gate |
|---|---|---|
| Unit | `npm test` | ≥85% line coverage on `core`, `memory`, `gatekeeper` |
| Integration | `npm run test:integration` | golden path with fake providers, end to end, zero network |
| Tenancy | `npm run test:tenancy` | org A cannot read any org B row, all repositories |
| Security | `npm run test:security` | secrets never plaintext; redaction scrubs tokens from logs |
| ASR eval | `npm run eval:asr` | 30 code-switched Indonesian clips → **WER < 10%** (PRD FR-01.2) |
| Ticket eval | `npm run eval:tickets` | 30 instructions → **≥90% approved unedited** (PRD KPI 2) |
| Gate eval | `npm run eval:gate` | seeded pass/fail/unverifiable cases, p95 < 2 s |
| Latency | `npm run eval:latency` | writes `artifacts/metrics.json` for the KPI slide |

The ticket eval is the one that matters most: it runs a fixed instruction set through the real prompt, has a human label "would the commander have approved this without editing?", and reports the rate. That is a measured number for PRD KPI §10.2 rather than a claim.

---

## 15. Demo Script (draft)

The 4-minute judge-facing narrative:

1. **0:00 — The problem.** Show the three frictions as text: voice memo, ambiguous broadcast, unverifiable "sudah selesai".
2. **0:40 — Voice in.** Commander sends a 25-second voice note in Telegram, in Indonesian, casually: *"Besok pagi deploy payment service ya, sekalian update SOP reconciliation, Mas Budi yang infra, deadline Kamis."*
3. **1:10 — The approval card appears.** Two tickets, correctly split tech/ops, named assignee, deadline parsed, and DoD shown as concrete checks — including the CI gate. Ask the judges to notice it was *not* dispatched yet.
4. **1:40 — Approve.** One tap. Two cards land in the two division chats.
5. **2:00 — Staff self-serve.** A staff member asks a clarifying question; answered from project memory with a citation; the commander never types.
6. **2:20 — False completion attempt.** Staff submits "selesai" early. Gatekeeper calls GitHub, finds the CI job red, rejects with the exact failing step, ticket goes `REWORK_REQUIRED`.
7. **2:50 — Verified completion.** Re-run goes green → `COMPLETED`, artifact link recorded in the audit trail.
8. **3:20 — The payoff.** "Tampilkan progres hari ini" → walkthrough with completions, blockers, and tomorrow's projection.
9. **3:50 — Proof.** Dashboard shows the KPI counters and the audit trail.

Failure rehearsals run before the demo: GitHub token revoked (pending-verification path), local model down (cloud fallback), Telegram webhook (long-poll retry).

---

## 16. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Indonesian ASR misses the 10% WER bar | Medium | High — first 40 seconds of the demo | Evaluate `small` vs `medium` on the demo GPU early (D11 morning); cloud fallback is one env var; run the eval on real recorded samples, not synthetic TTS |
| 3B local model produces weak ticket drafts | Medium | High — hits KPI 2 | Grammar-constrained decoding; few-shot examples in the prompt; cloud fallback; the 30-instruction eval runs on D14 with time left to iterate the prompt |
| GitHub API rate limit mid-demo | Low | High | PAT + ETag caching + pre-warmed cache; `fake` connector as a last-resort demo mode |
| Telegram bot token expires / wrong chat | Low | Total demo failure | Token + chat id in `secrets`; a startup self-check pings `getMe` and fails loudly; a recorded fallback clip |
| 4 GB VRAM contention (ASR + LLM) | Medium | Medium | Explicit model load/unload; sequential jobs; reranker dropped first |
| Scope creep past Week 3 | High | High | §13 cut order is decided in advance and non-negotiable |
| Solo burnout | Medium | High | Days 16+ are buffer, not feature time; the golden path is complete by D12 |

---

## 17. PRD Deviations and Open Questions

Raised proactively rather than discovered in Q&A.

**DEV-1 · Pending verification state.** NFR §8.3 requires a queue for external-API outages, but PRD §6 has no state for it. Using `verification_state` alongside `QA_VERIFICATION` (§6). *Alternative: add a 9th state `PENDING_VERIFICATION`.*

**DEV-2 · 3-second reasoning budget.** Not reachable with a 3B model on an RTX 3050. Addressed by streaming (TTFT ~300 ms), grammar-constrained decoding, and cloud mode for the literal target (§9.2).

**DEV-3 · Vector search implementation.** Brute-force cosine instead of a dedicated vector database, justified by corpus size and the no-Docker constraint (ADR-2). Behaviour is identical at this scale; the upgrade trigger is >50k chunks.

**DEV-4 · Manual verification is an explicit human override.** When automated verification is impossible after retries, a commander may mark complete with a recorded reason. This is audited and visible; it is never a silent bypass of FR-05.

**Open questions for the supervisor / industry partner:**
1. Which messaging platform does the industry problem owner actually use daily? If it is WhatsApp, Meta business verification is on the critical path and must start now.
2. Is a real source of truth available for the ops lane (a spreadsheet, an ERP sandbox), or should the demo use a seeded fixture?
3. Which repository should the gatekeeper verify against during the demo — can a demo repo be provisioned with intentionally failing CI?
4. Is the demo network reliable enough for cloud AI, or must the run be fully offline?

---

## 18. Definition of Done — Prototype Alpha

The build is done when a stranger can run it and all of the following hold:

- [ ] `npm install && npm run setup && npm run dev` starts API, bot, worker, and web with **no API keys** (fake providers)
- [ ] The full golden path completes end-to-end via Telegram, from voice note to audited `COMPLETED`
- [ ] A deliberately failing CI job produces `REWORK_REQUIRED` with a message naming the failing job and commit
- [ ] `verification_state = manual_required` is reachable via fault injection, and the ticket is *not* completed
- [ ] A clarification question is answered with at least one citation to an ingested document
- [ ] `npm run eval:tickets` reports ≥90%; `npm run eval:asr` reports WER < 10% (or the gap is documented with a stated cause)
- [ ] `npm run test:tenancy` passes for all repositories
- [ ] Every PRD §6 state is reachable in the running system, asserted by tests
- [ ] Audit trail reconstructs every state change with actor, reason, and timestamp
- [ ] The demo script in §15 has been rehearsed end-to-end twice, including one failure drill
- [ ] A `README.md` explains setup, env vars, provider switching, and the local-GPU deployment

---

## Appendix A — Environment Variables

```
# Core
EXECUGATE_MASTER_KEY=            # 32-byte hex; AES-256-GCM secret encryption
DATABASE_PATH=./data/execugate.db
NODE_ENV=development

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_COMMANDER_CHAT_ID=
TELEGRAM_TECH_DIVISION_CHAT_ID=
TELEGRAM_OPS_DIVISION_CHAT_ID=
TELEGRAM_MODE=polling            # polling | webhook

# LLM — point these at cloud or at the demo laptop
LLM_PROVIDER=fake                # fake | openai | ollama
LLM_BASE_URL=                    # e.g. http://127.0.0.1:8080/v1 for llama.cpp
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_MS=3000

# Embeddings
EMBED_PROVIDER=fake              # fake | openai | local
EMBED_MODEL=
EMBED_DIMS=384

# ASR
ASR_PROVIDER=fake                # fake | whisper-http | cloud
ASR_BASE_URL=http://127.0.0.1:9000
ASR_MODEL=small

# Gatekeeper
GITHUB_TOKEN=
GITHUB_WEBHOOK_SECRET=
GATEKEEPER_PROVIDER=github       # github | fake
GATEKEEPER_TIMEOUT_MS=1500

# Ops
OPS_SOURCE_URL=                  # sheet or fixture endpoint
OPS_SOURCE_TOKEN=

# Control centre
WEB_PORT=5173
API_PORT=3000
```

## Appendix B — Model Deployment on the Demo Laptop

**Local LLM (llama.cpp):**
```bash
# GGUF Qwen2.5-3B-Instruct Q4_K_M (~2.0 GB)
llama-server -m qwen2.5-3b-instruct-q4_k_m.gguf \
             --host 127.0.0.1 --port 8080 \
             --ctx-size 8192 --jinja --alias qwen-local
# then: LLM_PROVIDER=openai  LLM_BASE_URL=http://127.0.0.1:8080/v1  LLM_MODEL=qwen-local
```

**Local ASR (faster-whisper):**
```bash
pip install faster-whisper[cu12]
python -m faster_whisper.server --model small --device cuda --compute_type int8_float16 --port 9000
# then: ASR_PROVIDER=whisper-http  ASR_BASE_URL=http://127.0.0.1:9000
```

**Local embeddings:**
```bash
python -m sentence_transformers.server --model intfloat/multilingual-e5-small --port 8081
# then: EMBED_PROVIDER=openai  EMBED_BASE_URL=http://127.0.0.1:8081/v1
```

VRAM is released between roles — the worker calls `asr.free()` after transcription and loads embeddings only for ingest batches. If the 4 GB card runs out, the first knobs are: drop the reranker, shorten context to 4096, move ASR to CPU int8.

## Appendix C — PRD Traceability

| Requirement | Where implemented | Verified by |
|---|---|---|
| FR-01.1 text + audio input | `channels/telegram`, `channels/types` | integration golden path |
| FR-01.2 ASR, WER < 10% | `asr/*` | `eval:asr` |
| FR-01.3 intent parsing | `llm/prompts`, `orchestration/intake` | `eval:tickets` |
| FR-02.1 tenant/project RAG | `memory/*`, `db/repos.memory` | `test:tenancy` |
| FR-02.2 canonical docs ingested | `memory/chunk`, seed SOP corpus | unit tests |
| FR-02.3 vector context injection | `memory/retrieve`, `memory/answer` | citation assertions |
| FR-03.1 no auto-distribution | `orchestration/approval`, dispatcher guard | test: state machine |
| FR-03.2 summary card | `channels/cards` | screenshot/manual |
| FR-03.3 three one-tap actions | `orchestration/approval` | idempotency test |
| FR-04.1 structured ticket | `orchestration/dispatch` | integration |
| FR-04.2 staff clarification | `orchestration/staff` | integration |
| FR-04.3 memory-grounded answer | `memory/answer` | citation assertions |
| FR-05.1 engineering + ops verification | `gatekeeper/providers/*` | `eval:gate` |
| FR-05.2 pass → COMPLETED, fail → REWORK | `gatekeeper/engine` | state machine tests |
| FR-06.1 on-demand trigger | `orchestration/report` | integration |
| FR-06.2 daily aggregation | `orchestration/report` | integration |
| §6 state machine | `core/state-machine` | exhaustive transition tests |
| §7 layering | repo layout §3.3 | — |
| §8.1 latency | §12 | `eval:latency` |
| §8.2 AES-256 / TLS 1.3 | §11 | `test:security` |
| §8.3 fault tolerance | §8 job queue, `verification_state` | fault injection |
| §10 KPIs | `observability/metrics` | eval reports |
