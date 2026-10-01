# Live Telegram Runbook

How to run ExecuGate.ai against a real Telegram bot. Follow this end to end and the
golden path works; skip a step and the bot will look broken in a way that is not obvious
(missing configuration masquerading as a bug).

Estimated time: 15 minutes of setup, then a 4-minute demo.

---

## 1. Create the bot

1. Message **@BotFather** in Telegram → `/newbot`.
2. Choose a name and a username ending in `bot`.
3. Copy the token. It looks like `123456789:AAHq...`.

> The token is a credential. It is never written to the repository: put it in `.env`
> only, which is gitignored, and the app encrypts anything it stores in the database.

## 2. Create the three chats

You need four chat ids. Simplest approach for a demo:

| Purpose | How to get it |
|---|---|
| Commander chat | Your own DM to the bot |
| Technical division | A group with the bot added; post a message, read the id from the bot log |
| Operational division | Another group, same method |

Group ids are negative numbers like `-1001234567890`. **Add the bot as a member** of
each group, otherwise it receives nothing.

To read an id quickly, send any message in the group and run `npm run dev:bot` — the
bot logs `update from unknown sender` with the sender id, and `scripts/bind-staff.ts`
lists what is bound.

## 3. Configure

```bash
cp .env.example .env
```

Set in `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456789:AAHq...
TELEGRAM_MODE=polling
TELEGRAM_COMMANDER_CHAT_ID=<your dm chat id>
TELEGRAM_TECH_DIVISION_CHAT_ID=<technical group id>
TELEGRAM_OPS_DIVISION_CHAT_ID=<ops group id>
```

Long polling is the default, so **no public URL or tunnel is needed**.

## 4. Bind staff accounts

The bot maps an inbound Telegram user id to a tenant and a role. Until that mapping
exists, messages are rejected as unknown senders.

```bash
npm run bind:staff                        # show the roster and current bindings
npm run bind:staff -- <telegram_id> commander
npm run bind:staff -- <telegram_id> budi
npm run bind:staff -- <telegram_id> sari
```

You need your own Telegram user id (message **@userinfobot**) for at least the
commander. For a convincing demo, bind a second Telegram account as the staff member so
one person plays both roles.

## 5. Pre-flight

```bash
npm run check:telegram
```

Everything must be `OK`. Anything marked `FAIL` blocks the demo; `WARN` is tolerable.
The check sends a real message to the commander chat, which proves the token *and* the
chat id in one step.

## 6. Start

```bash
npm run dev
```

Watch for:

```
[api   ] API listening on :3000
[bot   ] Telegram adapter starting (long polling)   identity=@your_bot
[bot   ] bot started
```

## 7. Run the golden path

**Step 1 — send a voice note** (or text) in the commander chat:

> *"Besok pagi deploy payment service ya, sekalian update SOP reconciliation, Mas Budi yang infra, deadline Kamis."*

**Expect** an approval card: the original instruction, two tickets grouped by division,
assignee, deadline, the Definition of Done, and three buttons.

> Nothing has been distributed. That is the point — say it out loud to the judges.

**Step 2 — press "Lapor Selesai" as Budi** (in the technical group, or via the API).

**Expect** either:
- CI red → `REWORK_REQUIRED` naming the failing job and commit, or
- `unverifiable` → "menunggu verifikasi", which proves the outage path.

**Step 3 — fix and resubmit.** If CI is now green:

```bash
curl -X POST "http://localhost:3000/api/v1/tickets/TKT-2026-0001/resubmit?userId=<BUDI_ID>" \
  -H "content-type: application/json" -d '{"note":"CI hijau"}'
curl -X POST "http://localhost:3000/api/v1/tickets/TKT-2026-0001/verify?userId=<BUDI_ID>"
```

**Expect** `COMPLETED` with the artefact link recorded in the audit trail.

**Step 4 — ask for the report:** send *"tampilkan progres hari ini"*.

**Expect** the Executive Evening Walkthrough with completions, blockers, and tomorrow's
projection.

---

## Failure drills

Run these before the demo. Each has a rehearsed path.

| Drill | How | Expect |
|---|---|---|
| GitHub down | `GITHUB_TOKEN=bogus npm run dev` | `unverifiable`, ticket stays `QA_VERIFICATION`, retried automatically |
| Rate limited | Point at a repo that 403s | Same path; provider backs off, does not fail the task |
| Bad token | `TELEGRAM_BOT_TOKEN=x` | `npm run check:telegram` exits 1 immediately |
| Local model down | Stop `llama-server` | `PROVIDER_UNAVAILABLE`, `/ready` returns 503 |
| Demo entirely offline | `LLM_PROVIDER=fake EMBED_PROVIDER=fake ASR_PROVIDER=fake` | Full path still works with fixtures |

## Manual fallback

If Telegram is down at demo time, the whole journey is scriptable over HTTP:

```bash
curl -X POST "http://localhost:3000/api/v1/instructions/text?userId=<COMMANDER_ID>" \
  -H "content-type: application/json" \
  -d '{"text":"Besok pagi deploy payment service ya, sekalian update SOP reconciliation"}'

curl -X POST "http://localhost:3000/api/v1/instructions/<INSTRUCTION_ID>/decision?userId=<COMMANDER_ID>" \
  -H "content-type: application/json" -d '{"action":"approve"}'

curl "http://localhost:3000/api/v1/reports/walkthrough?format=text"
```

Or run the scripted rehearsal with no services at all:

```bash
npm run demo:failure
```

## Notes

- **Voice notes must be ≤ 300 s and ≤ 25 MB**; the adapter rejects anything larger
  before contacting ASR.
- **Telegram caps `callback_data` at 64 bytes.** Ticket and instruction ids are short
  by design; if you lengthen id generation, button presses will silently stop working.
- **The bot answers every callback immediately**, before the handler runs, so the
  Telegram spinner never sticks.
- **Update idempotency**: Telegram replays updates after a poll timeout. Each update id
  is claimed before processing, so one voice note cannot become two instructions.