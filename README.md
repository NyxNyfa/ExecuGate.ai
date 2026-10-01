# ExecuGate.ai

Conversational agentic workflow middleware that converts a commander's spoken or
typed instruction into verified, audited work tickets. Built from
[`PRD_ExecuGate.ai.md`](./PRD_ExecuGate.ai.md) v1.1.0 for the ANGEL Innovation
Hackathon 2026.

The differentiator is not the chatbot. It is the **Automated Quality-Gatekeeper** —
a second QA layer that refuses to mark work complete until an external system of
record objectively confirms it.

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

## Quick start

No Docker, no API keys, no database server. The whole stack boots offline against
deterministic providers.

```bash
npm install
npm run setup     # migrate + seed reference data and project memory
npm run dev       # api + bot + worker (+ web if present)
```

Then:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

To watch the full journey without Telegram or network:

```bash
npm run demo            # clean pass
npm run demo:failure    # CI red → REWORK_REQUIRED → green → COMPLETED
npm run demo:outage     # GitHub unreachable → pending verification
```

## Verification

```bash
npm run verify         # typecheck + tests + ticket eval + gatekeeper eval
```

| Command | Measures | Target |
|---|---|---|
| `npm test` | 274 unit and integration tests | all green |
| `npm run eval:tickets` | draft accuracy (PRD KPI §10.2) | ≥ 90% |
| `npm run eval:gate` | gatekeeper verdicts + latency | 0 failures, p95 < 2 s |
| `npm run eval:asr` | WER on Indonesian clips (PRD FR-01.2) | < 10% |
| `npm run eval:latency` | NFR §8.1 budgets | report, don't fail |
| `npm run stress` | concurrency, races, fault injection, hostile input | 0 failures |
| `npm run check:config -- --prod` | production configuration | exits 1 on blockers |
| `npm run smoke -- --base=<url>` | a deployed instance, end to end over HTTP | exits 1 on failure |
| `npm run check:telegram` | Telegram token + chat id reachability | exits 1 on blockers |
| `npm run check:gpu` | local LLM/embedding/ASR reachability + VRAM budget | exits 1 on blockers |
| `npm run test:tenancy` | cross-tenant isolation | all green |
| `npm run test:security` | encryption + log redaction | all green |

Results are written to `artifacts/*.json` so the numbers in a pitch deck are
measurements rather than claims.

## Architecture

```
packages/
  core/            types, ticket state machine, RBAC, config, errors
  db/              SQLite schema (node:sqlite), repositories, AES-256-GCM secrets
  llm/             provider adapter, structured output, prompts, heuristic fallback
  asr/             ASR adapter (whisper-http / cloud / fake) + WER metric
  memory/          chunking, embeddings, hybrid retrieval (vector + FTS5), answers
  channels/        channel interface, Telegram adapter, card rendering
  gatekeeper/      rule engine, GitHub connector, ops connectors
  orchestration/   intake, approval, staff loop, gate invocation, reporting
  observability/   structured logging, secret redaction

apps/
  api/             Fastify REST + health
  bot/             Telegram long-poll runtime
  worker/          job queue: retries + scheduled walkthrough
```

Three decisions shape everything else:

**SQLite via built-in `node:sqlite`.** No Docker on the target machine. SQLite 3.50
with FTS5, json1, BLOB and WAL covers relational integrity, lexical search and vector
storage. The upgrade path to Postgres is a repository-layer change.

**Brute-force cosine over float32 BLOB.** At demo scale (≤10k chunks) a linear scan is
2–5 ms — faster than a round-trip to a vector database, and it needs no native
compilation. Hybrid retrieval fuses it with BM25 via reciprocal-rank fusion, because
Indonesian organisational text is identifier-heavy and vector-only misses exact codes.

**Provider adapters with a working `fake` implementation.** Every AI dependency
(LLM, embeddings, ASR) has a deterministic offline implementation. This is not
mock scaffolding: the `fake` LLM performs real clause splitting, division
classification, assignee matching, date resolution and DoD synthesis, so CI is
deterministic and the demo laptop swaps in llama.cpp and faster-whisper by changing
environment variables alone.

## Configuration

Copy `.env.example` to `.env`. Every AI provider defaults to `fake`, so nothing is
required to run.

### Demo laptop (RTX 3050, 4 GB VRAM)

```bash
# Terminal 1 — LLM
llama-server -m qwen2.5-3b-instruct-q4_k_m.gguf --host 127.0.0.1 --port 8080 --ctx-size 8192 --jinja
LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:8080/v1
LLM_MODEL=<alias>

# Terminal 2 — ASR (~1 GB VRAM)
pip install "faster-whisper[cu12]"
python -m faster_whisper.server --model small --device cuda --compute_type int8_float16 --port 9000
ASR_PROVIDER=whisper-http
ASR_BASE_URL=http://127.0.0.1:9000

# Terminal 3 — embeddings (~470 MB)
python -m sentence_transformers.server --model intfloat/multilingual-e5-small --port 8081
EMBED_PROVIDER=openai
EMBED_BASE_URL=http://127.0.0.1:8081/v1
EMBED_DIMS=384
```

ASR and embeddings are loaded on demand and released between roles; if VRAM runs
short, drop the reranker first, then shorten the LLM context to 4096.

Check the laptop before you demo:

```bash
npm run check:gpu    # probes every endpoint, prints the remedy for each failure
npm run bench:gpu    # additionally times a real completion and embedding round trip
```

Full walkthrough, including model downloads and an OOM fallback order, is in
[`docs/DEMO_LAPTOP.md`](docs/DEMO_LAPTOP.md).

For the GitHub gatekeeper, set `GITHUB_TOKEN` with `read:contents` and `read:checks`.
A 60-request/hour unauthenticated limit will otherwise fail mid-demo; the provider
also caches with ETags and backs off on 403/429.

### Telegram

Set `TELEGRAM_BOT_TOKEN` and the three chat ids. The bot uses long polling, so no
public URL or tunnel is needed. `TELEGRAM_MODE=webhook` switches to webhook mode and
is served by `POST /api/v1/webhooks/telegram`.

## State machine

Eight states, exactly as the PRD specifies, encoded as a transition table in
`packages/core/src/state-machine.ts`. Nothing assigns `tickets.status` directly; every
write goes through `assertTransition` and records an audit row. Illegal transitions
throw.

```
DRAFT → PENDING_APPROVAL → ASSIGNED → IN_PROGRESS → QA_VERIFICATION → COMPLETED
                     ↓                    ↑              ↓
                 CANCELLED            REWORK_REQUIRED ←┘
```

Two properties are enforced structurally rather than by discipline:

- **No dispatch before approval.** `handleApproval` is the only writer of `ASSIGNED`,
  and the dispatcher selects `WHERE status = 'ASSIGNED'`. There is no code path from a
  draft to a division channel without an approval record.
- **Three distinct gate verdicts.** `pass` completes, `fail` demands rework,
  `unverifiable` leaves the ticket in `QA_VERIFICATION` with
  `verification_state = 'pending'` and requeues it. An external outage never fails a
  ticket and never completes one.

### Deviations from the PRD

Raised proactively; see `docs/BUILD_PLAN.md` §17.

| # | Deviation | Rationale |
|---|---|---|
| DEV-1 | `verification_state` alongside `QA_VERIFICATION` | NFR §8.3 requires a pending path that PRD §6 has no state for |
| DEV-2 | TTFT reported separately from total latency | A 3B model on a 4 GB GPU cannot meet a 3 s total; streaming meets a ~300 ms TTFT |
| DEV-3 | Brute-force vector scan | No Docker; identical behaviour at demo scale |
| DEV-4 | Manual verification is an explicit audited override | Commander-only, reason required, never a silent bypass of FR-05 |

## Security

- **Authentication:** signed bearer tokens (`AUTH_MODE=token`). Identity, role and
  organisation are derived *only* from a verified signature — nothing a client sends can
  influence them. Credentials are stored as salted scrypt hashes; the plaintext is shown
  once at provisioning and is not recoverable.
  - `AUTH_MODE=dev` trusts an `X-Actor-User-Id` request header. That header is
    caller-controlled: with it, anyone could act as a commanding officer, including
    writing secrets. This was verified against a running instance and fixed. It remains
    available for local development because it makes the dashboard easy to drive, and
    **the service refuses to start in production with it enabled.**
- **Secrets at rest:** AES-256-GCM, key from `EXECUGATE_MASTER_KEY`, stored in a
  dedicated table. Plaintext is never written to a column or returned over HTTP.
- **Transport:** `REQUIRE_TLS=true` is enforced per request, not just checked at boot —
  plain HTTP is answered with `426` and a body naming the likely cause. The reverse proxy
  must send `X-Forwarded-Proto`.
- **Logs:** every string passes through a redactor that masks bot tokens, PATs, API
  keys, and authorization headers.
- **Tenancy:** `org_id` is a required parameter of every repository function, enforced
  by the TypeScript signature. `getStrict` distinguishes "absent" from "belongs to
  another tenant" so breaches are alarmed on rather than logged as 404s.
  `npm run test:tenancy` asserts this across all repositories.
- **RBAC:** a single `authorize` chokepoint. Staff may only act on tickets in their own
  division; approval authority and execution authority are separate.
- **Audit completeness:** every ticket transition is mirrored into the organisation-level
  audit log inside the same transaction that writes the state change, so the trail
  cannot silently omit staff actions the way a per-call-site write had.
- **Rate limiting:** in-process, per identity, counting failures only. Adequate for a
  single node; a multi-instance deployment needs a shared store.
- **Prompt injection:** retrieved chunks are wrapped in delimiters and labelled
  untrusted data; the system prompt forbids following instructions found inside them.

### Deploying

[`DEPLOY.md`](DEPLOY.md) is the step-by-step guide: configuration, TLS termination,
database creation, credentials, systemd units, containers, backups, upgrades and
monitoring.

```bash
npm run check:config -- --prod   # validate configuration before starting
npm run build                    # bundle services to dist/
npm run smoke -- --base=https://host   # verify a deployment end to end
```

## Documentation

| Document | Contents |
|---|---|
| `DEPLOY.md` | Step-by-step production deployment: config, TLS, systemd, containers, backups, upgrades |
| `docs/BUILD_PLAN.md` | Full build plan: constraints, ADRs, scope cut, module specs, schedule, risks |
| `docs/TELEGRAM_RUNBOOK.md` | Step-by-step live Telegram setup, demo script, failure drills |
| `docs/DEMO_LAPTOP.md` | Local GPU inference on a 4 GB card: models, VRAM plan, OOM fallbacks |
| `PRD_ExecuGate.ai.md` | Source requirements document |
| `fixtures/eval/` | Evaluation corpora for ticket accuracy and ASR WER |

## Going live with Telegram

```bash
cp .env.example .env          # add your bot token and the three chat ids
npm run check:telegram        # validates the token, chats, and providers
npm run bind:staff -- <telegram_id> commander
npm run dev
```

Full walkthrough, including how to read chat ids and the failure drills, is in
[`docs/TELEGRAM_RUNBOOK.md`](./docs/TELEGRAM_RUNBOOK.md).