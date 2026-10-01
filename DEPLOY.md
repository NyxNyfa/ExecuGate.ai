# DEPLOY.md — ExecuGate.ai

Step-by-step instructions for putting ExecuGate.ai into production.

Read §0 first. Two of the steps are not optional, and one of them is a security defect
that was present in earlier revisions of this codebase.

---

## 0. What you need before you start

| | |
|---|---|
| **Node.js** | 22 or newer. The project uses the built-in `node:sqlite` module; it does not need a database server, a native build toolchain, or Docker to run. |
| **A place to run it** | Any Linux VM, VPS, or container host. A 2 vCPU / 4 GB machine is enough. |
| **A TLS-terminating reverse proxy** | nginx, Caddy, Traefik, or a cloud load balancer. Required — see §3. |
| **A Telegram bot token** *(optional)* | Only for the Telegram channel. The web dashboard works without it. |
| **A GitHub token** *(required for real verification)* | Without it the gatekeeper **simulates** verification. Production refuses to start without it. |

There is no Docker requirement. §6 covers containers; §1–§5 are a plain Node deployment
and are the recommended path.

---

## 1. Get the code and install

```bash
git clone <your-repo-url> execugate
cd execugate
npm ci
```

Verify the checkout is sound before deploying anything:

```bash
npm run verify
```

This runs the typechecker, 274 tests, the ticket-extraction evaluation and the gatekeeper
evaluation. **Do not deploy if this is not green.** It is the same command CI runs.

---

## 2. Create the production configuration

```bash
cp .env.example .env
```

Generate the two secrets. Never reuse a value from development, and never commit `.env`.

```bash
# Master key: encrypts secrets at rest (AES-256-GCM). 32 bytes, hex.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Token signing key: 32+ characters.
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Now set at least these in `.env`:

```ini
NODE_ENV=production
DATABASE_PATH=/var/lib/execugate/execugate.db

EXECUGATE_MASTER_KEY=<first value>
AUTH_TOKEN_SECRET=<second value>

# Authentication. `dev` trusts a caller-supplied header and MUST NOT be used here.
AUTH_MODE=token

# Terminate TLS at the reverse proxy and forward X-Forwarded-Proto.
REQUIRE_TLS=true
```

> ### ⚠ Why `AUTH_MODE=token` is not optional
>
> `AUTH_MODE=dev` reads the acting user from an `X-Actor-User-Id` **request header**.
> Any client can set that header. With it, an unauthenticated caller can act as a
> commanding officer — approving instructions and reading and writing stored secrets.
>
> This was verified against a running instance before the fix: setting the header to a
> commander's user id and sending **no credential at all** was sufficient to store a
> secret. The service refuses to start in production with `AUTH_MODE=dev`.

### Optional: Telegram

```ini
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_COMMANDER_CHAT_ID=<your chat id>
TELEGRAM_TECH_DIVISION_CHAT_ID=<technical division chat id>
TELEGRAM_OPS_DIVISION_CHAT_ID=<operational division chat id>
TELEGRAM_MODE=polling
```

Long polling needs no public URL and no tunnel. To find your chat id, message the bot and
run:

```bash
npm run check:telegram
```

### Optional: real AI providers

The defaults (`LLM_PROVIDER=fake`, `EMBED_PROVIDER=fake`, `ASR_PROVIDER=fake`) run
entirely offline with no API keys. They are deterministic and fine for a demo, and they
are what the test suite runs against. For real inference, see `docs/DEMO_LAPTOP.md`.

### Check the configuration before starting anything

The service validates its own configuration at boot and refuses to start on a blocking
problem. To see what it thinks without binding a port:

```bash
npm run check:config -- --prod
```

Anything marked `FAIL` must be fixed before the service will start. `warn` lines are
advisory. The command exits non-zero when a blocking problem exists, so it works as a
deploy gate.

---

## 3. Put a reverse proxy in front

The application serves plain HTTP and refuses to serve anything but `/health` and `/ready`
over it when `REQUIRE_TLS=true`. It expects the proxy to terminate TLS and to send
`X-Forwarded-Proto`.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name execugate.example.com;

    ssl_certificate     /etc/letsencrypt/live/execugate.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/execugate.example.com/privkey.pem;

    # Voice notes and documents arrive here.
    client_max_body_size 12m;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Required: without these the application sees plain HTTP and answers 426.
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Real-IP         $remote_addr;

        proxy_read_timeout 60s;
    }

    # Health checks do not need TLS and must stay reachable for a rolling deploy.
    location = /health { proxy_pass http://127.0.0.1:3000/health; access_log off; }
    location = /ready  { proxy_pass http://127.0.0.1:3000/ready;  access_log off; }
}

server {
    listen 80;
    server_name execugate.example.com;
    return 301 https://$host$request_uri;
}
```

### Caddy

```
execugate.example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-Proto {scheme}
    }
}
```

> **If every request returns `426 HTTPS required`:** the proxy is not sending
> `X-Forwarded-Proto`. The 426 response body names this exact cause.

---

## 4. Create the database

```bash
mkdir -p /var/lib/execugate
npm run db:migrate      # applies migrations/*.sql; safe to re-run
npm run seed            # demo organisation, staff, project documents
```

> `npm run seed` inserts demo data. **Skip it for a real deployment** and create your
> organisation and staff through your own process. It is here so a fresh server has
> something to authenticate against while you set things up.

### Create credentials

There is no user-facing signup. Each person gets a secret, shown **once**:

```bash
npm run provision:secret -- all          # one per active staff member
npm run provision:secret -- budi         # just one person
npm run provision:secret -- budi --revoke
```

Only a salted scrypt hash is stored; the plaintext cannot be recovered. Treat the printed
secret like a password.

### Verify the installation before exposing it

With the service running (§5):

```bash
npm run smoke -- --base=https://execugate.example.com
```

This drives a real ticket end to end over HTTP and checks authentication, the state
machine, division authorization and the audit trail. It prints `DEPLOYMENT SMOKE: PASS`
or lists what failed.

---

## 5. Run it as a service

### Build

```bash
npm run build
```

This bundles each service into a single ESM file in `dist/` (`api.js`, `bot.js`,
`worker.js`, plus `migrate.js`, `seed.js`, `backup.js`, `provision-secret.js`) and copies
the built dashboard to `dist/web`. There is no `tsc` emit: the workspace packages expose
raw `.ts` entry points, so the runtime could not load them unbundled.

### systemd

`/etc/systemd/system/execugate.service`:

```ini
[Unit]
Description=ExecuGate.ai
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=execugate
Group=execugate
WorkingDirectory=/opt/execugate
EnvironmentFile=/opt/execugate/.env
ExecStart=/usr/bin/node dist/api.js

# Node handles SIGTERM and drains in-flight requests before exiting. Give it room:
# the handler forces an exit after 15 seconds.
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure
RestartSec=5

# Hardening.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/execugate

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/execugate --shell /usr/sbin/nologin execugate
sudo chown -R execugate:execugate /opt/execugate /var/lib/execugate

sudo systemctl daemon-reload
sudo systemctl enable --now execugate
sudo systemctl status execugate
sudo journalctl -u execugate -f
```

### The worker and the bot

The retry queue (NFR §8.3) needs the worker to run continuously. Without it, a ticket
whose verification was `unverifiable` stays pending forever.

```ini
# /etc/systemd/system/execugate-worker.service — same shape, different ExecStart
ExecStart=/usr/bin/node dist/worker.js
```

Run `dist/bot.js` as well if you configured Telegram.

---

## 6. Containers (optional)

```bash
docker build -t execugate:1.0.0 .

docker volume create execugate-data

docker run -d --name execugate \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v execugate-data:/data \
  --env-file .env \
  -e DATABASE_PATH=/data/execugate.db \
  -e WEB_DIST_DIR=/app/dist/web \
  execugate:1.0.0

# Migrations run before the service starts, not on every boot.
docker exec execugate node dist/migrate.js
```

`127.0.0.1` on the port mapping is deliberate: the container should not be reachable
directly, only through the proxy.

The image uses `tini` as PID 1 so `SIGTERM` reaches Node and the graceful shutdown in
`apps/api/src/main.ts` can drain in-flight requests.

### docker compose

```yaml
services:
  api:
    image: execugate:1.0.0
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000"]
    env_file: .env
    environment:
      DATABASE_PATH: /data/execugate.db
      WEB_DIST_DIR: /app/dist/web
    volumes: ["execugate-data:/data"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

  worker:
    image: execugate:1.0.0
    restart: unless-stopped
    command: ["node", "dist/worker.js"]
    env_file: .env
    environment:
      DATABASE_PATH: /data/execugate.db
    volumes: ["execugate-data:/data"]
    depends_on:
      api: { condition: service_healthy }

volumes:
  execugate-data:
```

---

## 7. Backups

The database holds the audit trail. Back it up.

```bash
npm run backup                              # -> ./backups/execugate-<timestamp>.db
npm run backup -- --dir=/var/backups/execugate
```

This uses SQLite's `VACUUM INTO`, which produces a consistent snapshot **including
transactions still in the write-ahead log**. Copying the `.db` file on its own while the
service is running would silently lose recent writes.

Daily, from cron:

```bash
0 2 * * * cd /opt/execugate && /usr/bin/npm run backup -- --dir=/var/backups/execugate >> /var/log/execugate-backup.log 2>&1
```

Restore (service stopped):

```bash
sudo systemctl stop execugate execugate-worker
npm run restore -- --file=/var/backups/execugate/execugate-2026-10-01T02-00-00.db
sudo systemctl start execugate
```

The displaced database is kept alongside as `.replaced-<timestamp>` rather than
overwritten, so a mistaken restore is recoverable.

---

## 8. Upgrading

```bash
cd /opt/execugate
npm run backup -- --dir=/var/backups/execugate     # 1. back up first
git pull                                        # 2. new code
npm ci                                          # 3. dependencies
npm run verify                                  # 4. must be green
npm run build                                   # 5. bundle
sudo systemctl restart execugate                # 6. restart
npm run smoke -- --base=https://execugate.example.com   # 7. verify
```

`db:migrate` is safe to run on every deploy and applies only unapplied migrations.

### Zero-downtime notes

`SIGTERM` starts a graceful drain: the process stops accepting connections, lets
in-flight requests finish, closes the database and exits, with a 15-second hard deadline.
Give your supervisor at least 30 seconds of stop timeout (the systemd unit above does).

On Windows this path cannot be exercised — `Stop-Process` terminates the process without
delivering a signal, so the handler never runs. Verify it on Linux, which is where the
container and systemd paths run.

---

## 9. Monitoring

| Endpoint | Use |
|---|---|
| `GET /health` | Liveness. 200 if the process is running. |
| `GET /ready` | Readiness. 503 while starting, or when a dependency the request path needs is unavailable. **Point your load balancer here.** |
| `GET /api/v1/audit` | The audit trail. Every ticket transition, with the actor who performed it. |
| `GET /api/v1/metrics` | Ticket counts by status, queue depth, and which model providers are active. |

Logs are JSON lines on stdout, one per request with a request id, method, path, status and
duration:

```json
{"ts":"2026-10-01T08:17:21.366Z","level":"info","scope":"api","msg":"request","requestId":"req_m1a2b3c4","method":"POST","url":"/api/v1/tickets/tic_x/verify","status":200,"ms":412}
```

Worth alerting on:

- `/ready` returning 503 for more than a minute
- `verification_state` stuck at `pending` (the worker is not draining the retry queue)
- any 5xx rate above zero
- `RATE_LIMITED` responses to `/api/v1/auth/login` (credential stuffing)

---

## 10. Security checklist

Before you call it done:

- [ ] `NODE_ENV=production`
- [ ] `AUTH_MODE=token` — **not** `dev`
- [ ] `EXECUGATE_MASTER_KEY` set to a fresh 32-byte hex value
- [ ] `AUTH_TOKEN_SECRET` set to a fresh 32+ character value
- [ ] `REQUIRE_TLS=true` and the proxy sends `X-Forwarded-Proto`
- [ ] `GITHUB_TOKEN` set — otherwise verification is *simulated*, and the service says so and refuses to start
- [ ] `DATABASE_PATH` on a persistent volume, not `:memory:`
- [ ] `.env` is not in version control, and is not readable by other users (`chmod 600`)
- [ ] The service runs as an unprivileged user
- [ ] Backups are running and **a restore has been tested**
- [ ] `npm run smoke` passes against the deployed URL

### What is deliberately *not* claimed

- **Rate limiting is in-process.** It resets on restart and is not shared between
  instances. Adequate for a single node; behind a load balancer, move it to the proxy or
  a shared store.
- **`unverifiable` is not a failure.** If the gatekeeper cannot reach its source, the
  ticket is queued for retry rather than failed. That is the designed behaviour (NFR
  §8.3) and it needs the worker running.
- **Manual verification is a human override**, recorded as such in the audit trail. It is
  an escape hatch with an audit trail, not an automated pass.
- **The ASR word-error-rate target is unmeasured.** `npm run eval:asr` reports skipped
  cases rather than a fabricated score, because no reference audio is recorded yet. See
  §11.

---

## 11. Command reference

```bash
# Verify before deploying — the gate for every release.
npm run verify            # typecheck + 274 tests + eval:tickets + eval:gate

# Build
npm run build             # bundle all services to dist/
npm run build:web         # dashboard only

# Database
npm run db:migrate        # apply migrations
npm run seed              # demo data
npm run backup            # consistent snapshot via VACUUM INTO
npm run restore -- --file=<path>

# People
npm run provision:secret -- all       # issue API secrets
npm run bind:staff -- <id> commander  # link a Telegram account to a role

# Verify a deployment
npm run check:config -- --prod       # configuration, before starting
npm run smoke -- --base=https://host # drives a real ticket end to end
npm run stress                       # concurrency, faults, hostile input
npm run eval:tickets                 # instruction parsing accuracy
npm run eval:gate                    # gatekeeper verdicts
npm run eval:asr                     # speech recognition WER (needs recorded audio)
npm run demo:pass | demo:failure | demo:outage

# Operations
npm run check:telegram
npm run check:gpu                    # demo-laptop VRAM plan
npm run bench:gpu
```

---

## 12. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Refusing to start: N blocking configuration problem(s)` | The startup validator found a problem it will not run with. The message lists each one by name. |
| Every request returns `426 HTTPS required` | The proxy is not sending `X-Forwarded-Proto`. See §3. |
| `401` on every request | `AUTH_MODE=token` but no valid token. Obtain one via `POST /api/v1/auth/login`. |
| `401` and a message about `X-Actor-User-Id` | `AUTH_MODE=dev`. Expected outside production; it will not start in production. |
| `429 Too many failed login attempts` | The per-address failure limit was reached. It resets after `AUTH_LOGIN_WINDOW_MS`, and a successful login clears it. |
| `EADDRINUSE` | Another process holds the port. `ss -lptn 'sport = :3000'` |
| Tickets stay in `QA_VERIFICATION` with `verification_state: pending` | The worker is not running. Start `dist/worker.js`. |
| `SQLITE_BUSY` under load | Only one process may write. Run exactly one API instance against a database file; SQLite serialises writers but does not scale across hosts. |
| Database looks empty after a restart | `DATABASE_PATH` is `:memory:`, or it points somewhere without a persistent volume. The validator blocks this in production. |
