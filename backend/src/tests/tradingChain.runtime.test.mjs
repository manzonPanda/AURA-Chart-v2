/**
 * P2 Runtime Chain Test
 *
 * End-to-end verification of the complete request path:
 *
 *   AURA Chart frontend API client
 *   -> AURA Chart Hono backend (/api/trading/*)
 *   -> MyTradingDashboard2 aura-backend (http://localhost:5001)
 *   -> PostgreSQL
 *
 * Tests:
 *   1. Unauthenticated request → 401 at AURA Chart gateway
 *   2. Authenticated client → gets an account from the real dashboard backend
 *   3. Trades list for that account → 200, derived open/closed
 *   4. Account state → 200, static config present, live money null
 *   5. Foreign account UUID → 403 (P1 ownership gate)
 *   6. Bad limit/status → 400
 *   7. Query params forwarded correctly
 *
 * The live `aura-backend` on localhost:5001 serves the real P1 routes + DB.
 * Tokens are minted the same way the P1 runtime test does (HMAC body.sig),
 * so no real password is needed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { DashboardClient } from '../services/dashboardClient.ts';
import { createTradingRouter } from '../routes/trading.ts';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
};

let port = 5000;
let server;
let pgClient = null;
let sessionId = null;

function nextPort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// ── Dashboard .env access (key NAMES read here; VALUES never printed) ──
// The chain test needs a session the REAL dashboard will accept: exactly the
// P1-verified pattern — HMAC mint with the dashboard's own session secret +
// a real public.sessions row. This is TEST-HARNESS-only access; AURA Chart
// application code never touches the dashboard database.
const DASHBOARD_ENV_PATH = fileURLToPath(
  new URL('../../../../MyTradingDashboard2/aura-backend/.env', import.meta.url),
);

function readDashboardEnvKey(key) {
  try {
    const text = fs.readFileSync(DASHBOARD_ENV_PATH, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`));
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* fall through to the auth-local.js dev default below */
  }
  return null;
}

const SESSION_SECRET =
  readDashboardEnvKey('AUTH_SESSION_SECRET') ??
  readDashboardEnvKey('AUTH_TOKEN_SIGNATURE') ??
  'aura-local-dev-signature-do-not-use-in-prod';

// The dashboard .env does NOT carry a DATABASE_URL — it uses the standard
// PG* variable names that node-postgres understands natively. Build the
// client config from those keys (values stay in-process, never printed).
const PG_CONFIG = {
  host: readDashboardEnvKey('PGHOST') ?? 'localhost',
  port: Number(readDashboardEnvKey('PGPORT') ?? '5432'),
  database: readDashboardEnvKey('PGDATABASE') ?? 'postgres',
  user: readDashboardEnvKey('PGUSER') ?? undefined,
  password: readDashboardEnvKey('PGPASSWORD') ?? undefined,
};
const DASHBOARD_HTTP_URL = process.env.DASHBOARD_HTTP_URL || 'http://localhost:5001';

if (!readDashboardEnvKey('PGDATABASE')) {
  console.error('chain test: PGDATABASE not found in the dashboard .env — cannot mint a session.');
  process.exit(1);
}

// ── Token minting: SAME construction as auth-local.js / P1 runtime test ──
function mintToken(sub, sid, email, expiresAt) {
  const payload = { sub, sid, email, aud: 'aura-dashboard', iat: Date.now(), exp: expiresAt.getTime() };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

async function main() {
  // ── Mint a REAL dashboard session (P1-verified pattern) ───────
  pgClient = new pg.Client(PG_CONFIG);
  await pgClient.connect();
  const users = await pgClient.query(
    'select id, email from public.aura_users order by created_at limit 1',
  );
  const userA = users.rows[0];
  if (!userA) {
    console.error('chain test: no aura_users rows in the dashboard database.');
    await pgClient.end();
    process.exit(1);
  }
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const { rows: sessRows } = await pgClient.query(
    'insert into public.sessions (user_id, expires_at) values ($1, $2) returning id',
    [userA.id, expiresAt],
  );
  sessionId = sessRows[0].id;
  const token = mintToken(userA.id, sessionId, userA.email, expiresAt);
  check('session minted for pre-existing dashboard user', typeof token === 'string' && token.includes('.'));

  port = await nextPort();

  // Build a minimal app with just the trading router, using the real DashboardClient.
  // NOTE: positional args (baseUrl, timeoutMs) — mirrors index.ts line 221.
  // An options object would be ignored and the client would fall back to an
  // unreachable default (this exact mistake produced a 502 in the first run).
  const app = new Hono();
  const client = new DashboardClient(DASHBOARD_HTTP_URL, 8000);
  app.route('/api', createTradingRouter(client));

  server = serve({
    fetch: app.fetch,
    port,
  });

  const base = `http://localhost:${port}`;

  // 1. Unauthenticated → 401 at the AURA Chart gateway (never forwarded)
  {
    const r = await fetch(`${base}/api/trading/accounts`);
    check('unauthenticated → 401', r.status === 401, `got ${r.status}`);
  }

  const headers = { 'Authorization': `Bearer ${token}` };

  // 1b. TOKEN PRE-FLIGHT: validate the minted token against the LIVE dashboard
  // process BEFORE the proxy chain, so a secret/env mismatch produces a clear
  // diagnostic instead of an opaque failure three hops later.
  {
    const r = await fetch(`${DASHBOARD_HTTP_URL}/api/auth/session`, { headers });
    const body = r.headers.get('content-type')?.includes('json') ? await r.json().catch(() => ({})) : {};
    check('minted token accepted by live dashboard (/api/auth/session)', r.status === 200,
      r.status === 200 ? '' : `status=${r.status} error=${JSON.stringify(body.error ?? body).slice(0, 120)}`);
  }

  // 2. Authenticated → gets accounts from real dashboard backend
  {
    const r = await fetch(`${base}/api/trading/accounts`, { headers });
    check('authenticated accounts → 200', r.status === 200, `got ${r.status}`);
    const body = await r.json().catch(() => ({}));
    const accounts = body.accounts ?? [];
    check('accounts has array', Array.isArray(body.accounts), Array.isArray(body.accounts) ? '' : `body=${JSON.stringify(body).slice(0, 120)}`);
    check('accounts non-empty (user owns ≥1 account)', accounts.length > 0, `${accounts.length} accounts`);
  }

  // 3. Get a real account ID from the dashboard
  let accountId;
  {
    const r = await fetch(`${base}/api/trading/accounts`, { headers });
    const body = await r.json().catch(() => ({}));
    if (body.accounts?.length > 0) {
      accountId = body.accounts[0].id;
      check('got a real account id', accountId !== undefined);
    }
  }

  if (accountId) {
    // 4. Trades → 200
    {
      const r = await fetch(`${base}/api/trading/accounts/${accountId}/trades`, { headers });
      check('trades → 200', r.status === 200, `got ${r.status}`);
      const body = await r.json();
      check('trades has array', Array.isArray(body.trades));
      check('trades has pagination', body.pagination !== undefined);
    }

    // 5. Foreign account → 403
    const fakeId = '00000000-0000-0000-0000-000000000000';
    {
      const r = await fetch(`${base}/api/trading/accounts/${fakeId}/trades`, { headers });
      check('foreign account → 403', r.status === 403, `got ${r.status}`);
    }

    // 6. State → 200
    {
      const r = await fetch(`${base}/api/trading/accounts/${accountId}/state`, { headers });
      check('state → 200', r.status === 200, `got ${r.status}`);
      const body = await r.json();
      check('state has accountId', body.accountId === accountId, JSON.stringify(body).slice(0, 200));
      check('state has balance=null (live not persisted)', body.state?.balance === null, JSON.stringify(body).slice(0, 200));
    }

    // 7. Bad limit → 400
    {
      const r = await fetch(`${base}/api/trading/accounts/${accountId}/trades?limit=abc`, { headers });
      check('bad limit → 400', r.status === 400, `got ${r.status}`);
    }

    // 8. Bad status → 400
    {
      const r = await fetch(`${base}/api/trading/accounts/${accountId}/trades?status=bogus`, { headers });
      check('bad status → 400', r.status === 400, `got ${r.status}`);
    }

    // 9. Query params forwarded
    {
      const r = await fetch(`${base}/api/trading/accounts/${accountId}/trades?status=open&limit=50`, { headers });
      check('query params forwarded → 200', r.status === 200, `got ${r.status}`);
      const body = await r.json();
      check('pagination shows limit=50', body.pagination?.limit === 50);
    }

    // 10. Dashboard API base URL never leaks to browser
    {
      const r = await fetch(`${base}/api/trading/accounts`, { headers });
      const txt = await r.text();
      check('no dashboard URL in response', !txt.includes('localhost:5001'));
    }
  }

  console.log('\n=== P2 Runtime Chain Test results ===');
  for (const r of results) console.log(r);
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
}

main().catch((err) => {
  console.error('Test error:', err?.message || err);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await server.close();
  if (pgClient && sessionId) {
    try { await pgClient.query('delete from public.sessions where id = $1', [sessionId]); } catch { /* already gone */ }
  }
  if (pgClient) { try { await pgClient.end(); } catch { /* noop */ } }
});
