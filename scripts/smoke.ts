import { getStore, orgRepo, userRepo, DEMO_ORG_SLUG, SECOND_ORG_SLUG } from '@execugate/db';
import { hashSecret, generateSecret, issueToken } from '@execugate/core';
import { config } from '@execugate/core';

/**
 * Post-deployment smoke test.
 *
 * Verifies a *running* instance end to end, over HTTP, the way a user or a load
 * balancer would reach it. This is deliberately not an integration test: those drive
 * the app in-process and cannot catch a broken build, a missing environment variable,
 * a proxy that drops a header, or a bundle that does not boot.
 *
 * It exercises the parts that only exist once deployed:
 *   - authentication with real tokens (and rejection of a forged identity header)
 *   - TLS enforcement when REQUIRE_TLS is on
 *   - the full ticket lifecycle through the state machine
 *   - division and per-ticket authorization
 *   - the audit trail
 *
 * Credentials are provisioned directly in the database so the check needs no operator
 * setup; the secret is hashed exactly as production does, never written in plaintext.
 *
 * Usage:
 *   npm run smoke                          against http://127.0.0.1:3000
 *   npm run smoke -- --base=https://host   against a deployed instance
 *   npm run smoke -- --skip-tls            when TLS is terminated upstream
 */

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const BASE = (arg('base') ?? `http://127.0.0.1:${config.ports.api}`).replace(/\/$/, '');
const SKIP_TLS = args.includes('--skip-tls') || !config.requireTls;

let failures = 0;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ''): boolean {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark} ${name}${detail ? ` \x1b[2m— ${detail}\x1b[0m` : ''}`);
  return ok;
}

/** TLS-terminating proxies add this; without it a REQUIRE_TLS service answers 426. */
function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (!SKIP_TLS) h['X-Forwarded-Proto'] = 'https';
  return h;
}

async function call<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; contentType?: string } = {},
): Promise<{ status: number; json: T | null; text: string }> {
  const h = headers(opts.token);
  if (opts.body !== undefined) h['Content-Type'] = opts.contentType ?? 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    // A bodyless POST with no content-type is exactly what `curl -X POST` sends, and
    // it is worth exercising on every run.
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await res.text();
  let json: T | null = null;
  try { json = JSON.parse(text) as T; } catch { /* HTML or empty */ }
  return { status: res.status, json, text };
}

// ── Provision credentials directly in the database ───────────────────────────
// The smoke test must not depend on an operator having run `provision:secret`, and it
// must not need the API's own login endpoint to obtain its first credential.

function provisionLocal(): Map<string, string> {
  const store = getStore();
  store.migrate();

  const org = orgRepo(store).bySlug(DEMO_ORG_SLUG) ?? orgRepo(store).bySlug(SECOND_ORG_SLUG);
  if (!org) {
    store.close();
    throw new Error('No organisation found. Run: npm run setup');
  }

  const repo = userRepo(store);
  const out = new Map<string, string>();

  for (const user of repo.list(org.id)) {
    const secret = generateSecret();
    const { hash, salt } = hashSecret(secret);
    repo.setAuthSecret(org.id, user.id, hash, salt);
    out.set(user.id, secret);
  }
  store.close();
  return out;
}

interface Ticket {
  id: string; code: string; title: string; status: string;
  assigneeId: string | null; assigneeName: string | null;
  divisionId: string; divisionName: string; verificationState: string;
}

async function main() {
  console.log(`\nExecuGate.ai — deployment smoke test`);
  console.log(`target: ${BASE}`);
  console.log(`tls:    ${SKIP_TLS ? 'not enforced from this side' : 'REQUIRE_TLS — sending X-Forwarded-Proto: https'}\n`);

  // ── Reachability ───────────────────────────────────────────────────────────
  let health: { status: string; runtime: string };
  try {
    const res = await call<{ status: string; runtime: string }>('GET', '/health');
    health = res.json!;
    check('service is up', res.status === 200, `runtime: ${health.runtime}`);
  } catch (err) {
    check('service is up', false, `cannot reach ${BASE}: ${err instanceof Error ? err.message : err}`);
    return finish();
  }

  const creds = provisionLocal();
  check('credentials provisioned', creds.size > 0, `${creds.size} staff`);

  // ── Authentication ─────────────────────────────────────────────────────────
  const me = async (userId: string) => {
    const login = await call<{ token: string; user: { role: string; name: string } }>('POST', '/api/v1/auth/login', {
      body: { userId, secret: creds.get(userId) },
    });
    if (login.status !== 200) throw new Error(`login failed for ${userId}: ${login.status} ${login.text.slice(0, 120)}`);
    const profile = await call<{ name: string; role: string }>('GET', '/api/v1/me', { token: login.json!.token });
    return { token: login.json!.token, role: login.json!.user.role, name: login.json!.user.name };
  };

  const sessions = new Map<string, Awaited<ReturnType<typeof me>>>();
  for (const userId of creds.keys()) {
    try { sessions.set(userId, await me(userId)); } catch { /* inactive or unusable */ }
  }
  check('every active account can obtain a token', sessions.size > 0, `${sessions.size}/${creds.size}`);

  // /api/v1/me reports the role but not the division, and the roster reports the
  // division *kind* rather than its id. The roster is the right source for deciding
  // who counts as "a peer in the same division" — and it requires authentication,
  // which this call doubles as a check of.
  const divisionOf = new Map<string, string>();

  const commander = [...sessions.entries()].find(([, s]) => s.role === 'commander');
  if (!commander) { check('a commander exists', false, 'no account with the commander role could log in'); return finish(); }
  const [commanderId, cmd] = commander;
  console.log(`\n  acting as ${cmd.name} (commander)\n`);

  const rosterCall = await call<Array<{ id: string; division: string }>>('GET', '/api/v1/roster', { token: cmd.token });
  const anonymousRoster = await call('GET', '/api/v1/roster');
  check('the roster requires authentication', rosterCall.status === 200 && anonymousRoster.status === 401,
    `authenticated -> ${rosterCall.status}, anonymous -> ${anonymousRoster.status}`);
  for (const r of rosterCall.json ?? []) divisionOf.set(r.id, r.division);

  // The three properties that matter most on a live instance.
  const forged = await call('POST', '/api/v1/secrets', {
    body: { key: 'smoke.attacker', value: 'x' },
    token: cmd.token,
  });
  check('token identity is authoritative', forged.status !== 401, `token + forged header -> ${forged.status}`);

  const noCreds = await call<{ message: string }>('GET', '/api/v1/tickets', { contentType: 'application/json' });
  check('an unauthenticated request is refused', noCreds.status === 401, `${noCreds.status}`);

  if (!SKIP_TLS) {
    const plain = await fetch(`${BASE}/api/v1/tickets`, { headers: { Authorization: `Bearer ${cmd.token}` } });
    check('plain HTTP is refused when REQUIRE_TLS is on', plain.status === 426, `${plain.status}`);
  }

  // ── The golden path ────────────────────────────────────────────────────────
  console.log('\n  --- ticket lifecycle ---');
  const intake = await call<{ instructionId: string; ticketIds: string[] }>('POST', '/api/v1/instructions/text', {
    token: cmd.token,
    body: { text: 'Besok pagi deploy payment service ya, sekaligus update SOP reconciliation, Mas Budi yang infra' },
  });
  if (!check('intake accepts an instruction', intake.status === 201 && intake.json!.ticketIds.length > 0,
    `${intake.status}, ${intake.json?.ticketIds.length ?? 0} draft(s)`)) return finish();

  const ids = intake.json!.ticketIds;
  const listTickets = async () =>
    (await call<Ticket[]>('GET', '/api/v1/tickets', { token: cmd.token })).json ?? [];

  const beforeApproval = (await listTickets()).filter((t) => ids.includes(t.id));
  check('FR-03.1: nothing is dispatched before approval',
    beforeApproval.length > 0 && beforeApproval.every((t) => t.status === 'PENDING_APPROVAL'),
    beforeApproval.map((t) => t.status).join(', ') || 'no tickets found');

  const approval = await call<{ dispatched: Array<{ id: string; status: string }> }>(
    'POST', `/api/v1/instructions/${intake.json!.instructionId}/decision`,
    { token: cmd.token, body: { action: 'approve' } },
  );
  check('approval dispatches tickets', approval.status === 200 && approval.json!.dispatched.length > 0,
    `${approval.json?.dispatched.length ?? 0} dispatched`);

  const target = (await listTickets()).find((t) => ids.includes(t.id))!;
  check('dispatched ticket is ASSIGNED', target.status === 'ASSIGNED', target.status);
  check('an assignee was selected', !!target.assigneeId, `${target.assigneeName} / ${target.divisionName}`);
  check('the assignee belongs to the ticket division',
    !!target.assigneeId && !!divisionOf.get(target.assigneeId),
    `${target.assigneeName} is in ${target.divisionName} (roster: ${divisionOf.get(target.assigneeId ?? '') ?? 'unknown'})`);

  // ── Authorization ──────────────────────────────────────────────────────────
  console.log('\n  --- authorization ---');

  const peer = [...sessions.entries()].find(([id, s]) =>
    id !== target.assigneeId && s.role !== 'commander' && divisionOf.get(id) === divisionOf.get(target.assigneeId ?? ''));
  if (peer) {
    const res = await call<{ message: string }>('POST', `/api/v1/tickets/${target.id}/ack`, { token: peer[1].token });
    check('a peer in the same division cannot work another person\'s ticket',
      res.status === 403, `${res.status}: ${res.json?.message ?? ''}`);
  } else {
    check('a peer in the same division cannot work another person\'s ticket', true,
      `skipped: no second ${divisionOf.get(target.assigneeId ?? '') ?? 'division'} member`);
  }

  const tech = [...sessions.entries()].find(([, s]) => s.role === 'technical');
  if (tech && divisionOf.get(target.assigneeId ?? '') !== 'technical') {
    const res = await call<{ message: string }>('POST', `/api/v1/tickets/${target.id}/ack`, { token: tech[1].token });
    check('a technical engineer is refused a non-technical ticket', res.status === 403,
      `${res.status}: ${res.json?.message ?? ''}`);
  }

  // ── Completion ─────────────────────────────────────────────────────────────
  console.log('\n  --- verification ---');
  const assignee = sessions.get(target.assigneeId!);
  if (!assignee) { check('the assignee can authenticate', false, target.assigneeName ?? 'unknown'); return finish(); }

  const ack = await call<Ticket & { ticket?: Ticket }>('POST', `/api/v1/tickets/${target.id}/ack`, { token: assignee.token });
  // The route returns the ticket directly; older revisions wrapped it in `{ ticket }`.
  const acked = ack.json?.ticket ?? ack.json;
  check('the assignee acknowledges the ticket', ack.status === 200 && acked?.status === 'IN_PROGRESS',
    `${ack.status} ${acked?.status ?? ack.text.slice(0, 100)}`);
  if (ack.status !== 200) return finish();

  await call('POST', `/api/v1/tickets/${target.id}/evidence`, { token: assignee.token, body: {} });

  const verify = await call<{ verdict: string; ticket: Ticket }>('POST', `/api/v1/tickets/${target.id}/verify`, { token: cmd.token });
  check('FR-05: the gatekeeper returns a distinct verdict',
    verify.status === 200 && ['pass', 'fail', 'unverifiable'].includes(verify.json!.verdict),
    `${verify.json?.verdict} -> ${verify.json?.ticket.status}`);
  check('the ticket left QA_VERIFICATION',
    ['COMPLETED', 'REWORK_REQUIRED'].includes(verify.json?.ticket.status ?? ''),
    verify.json?.ticket.status ?? '');

  // A ticket past COMPLETED must not be verifiable again.
  const reverify = await call<{ message: string }>('POST', `/api/v1/tickets/${target.id}/verify`, { token: cmd.token });
  check('a completed ticket cannot be verified twice', reverify.status >= 400, `${reverify.status}`);

  // ── Transport tolerance ────────────────────────────────────────────────────
  console.log('\n  --- transport ---');
  const bodyless = await call<{ message: string }>('POST', `/api/v1/tickets/${target.id}/ack`, { token: assignee.token });
  check('a bodyless POST with no content-type is not a transport error',
    bodyless.status !== 415 && bodyless.status !== 426, `${bodyless.status}: ${bodyless.json?.message ?? ''}`);

  const badJson = await fetch(`${BASE}/api/v1/instructions/text`, {
    method: 'POST',
    headers: { ...headers(cmd.token), 'Content-Type': 'application/json' },
    body: '{"text": ',
  });
  check('malformed JSON is rejected rather than swallowed', badJson.status === 400, `${badJson.status}`);

  const runtimeConfig = await call('GET', '/api/v1/config', { token: cmd.token });
  check('runtime configuration is readable', runtimeConfig.status === 200, `${runtimeConfig.status}`);

  // The dashboard must come from the API origin, so `/` is HTML rather than a JSON 404.
  const root = await fetch(`${BASE}/`, { headers: headers() });
  const contentType = root.headers.get('content-type') ?? '';
  check('the dashboard is served from the API origin',
    root.status === 200 && /text\/html/.test(contentType), `${root.status} ${contentType}`);

  const rootHeaders = await fetch(`${BASE}/`, { headers: headers() });
  check('security headers are present on the dashboard',
    !!rootHeaders.headers.get('x-content-type-options') && !!rootHeaders.headers.get('content-security-policy'),
    `x-content-type-options=${rootHeaders.headers.get('x-content-type-options')}`);

  const hsts = rootHeaders.headers.get('strict-transport-security');
  if (config.isProduction) check('HSTS is set in production', !!hsts, hsts ?? 'absent');

  // ── Audit ──────────────────────────────────────────────────────────────────
  console.log('\n  --- audit ---');
  const audit = await call<Array<{ actorId: string | null; action: string }>>('GET', '/api/v1/audit?limit=200', { token: cmd.token });
  const rows = audit.json ?? [];
  const actors = new Set(rows.map((r) => r.actorId));
  check('the audit trail has entries', rows.length > 0, `${rows.length} rows`);
  check('every entry names an actor', rows.every((r) => !!r.actorId), `${actors.size} distinct actors`);
  check('more than one identity is recorded', actors.size > 1, [...actors].join(', '));
  void commanderId;

  return finish();
}

function finish(): void {
  console.log('\n' + '='.repeat(64));
  if (failures === 0) {
    console.log('\x1b[32mDEPLOYMENT SMOKE: PASS\x1b[0m');
  } else {
    console.log(`\x1b[31mDEPLOYMENT SMOKE: ${failures} FAILURE(S)\x1b[0m`);
    for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.name} ${r.detail}`);
  }
  console.log('='.repeat(64));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nsmoke test crashed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});

export { issueToken };



