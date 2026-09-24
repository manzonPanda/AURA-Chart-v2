/**
 * Trading proxy — unit tests (P2). Node test runner via tsx:
 *   npm --prefix backend run test
 *
 * Covers, WITHOUT any running server or database:
 *   1. DashboardClient request construction — exact upstream URL (base URL +
 *      allowlisted path + forwarded query), Bearer header forwarding, JSON
 *      body for auth, timeout → 504, network failure → 502, upstream error
 *      status/message preserved, token never appears in any thrown message.
 *   2. Proxy routes (createTradingRouter) via Hono's app.request() with a
 *      RECORDING stub client — unauthenticated 401, malformed accountId 400,
 *      allowlisted query forwarding + non-allowlisted dropped, upstream
 *      status semantics preserved, no generic path handling.
 *   3. Auth routes (createAuthRouter) — sign-in validation + forwarding,
 *      session/sign-out Bearer forwarding, upstream status preservation.
 *
 * fetch is stubbed in-process (globalThis.fetch); no sockets are opened.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Hono } from "hono";
import {
  DashboardApiError,
  DashboardClient,
  type DashboardAccount,
  type DashboardTradesResponse,
} from "../services/dashboardClient.js";
import { createTradingRouter } from "../routes/trading.js";
import { createAuthRouter } from "../routes/auth.js";

const BASE = "http://dashboard.test:5999";
const TOKEN = "test-token-abc123";

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

/** Install a recording fetch stub; returns { calls, restore }. */
function stubFetch(handler?: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    const headers = init?.headers ?? {};
    const authorization =
      typeof headers?.get === "function"
        ? headers.get("authorization")
        : (headers?.Authorization ?? headers?.authorization ?? null);
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      authorization: authorization ? String(authorization) : null,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (!handler) throw new Error("STUB_NETWORK_DOWN");
    return handler(call);
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ACCOUNT: DashboardAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  account_number: "4190321",
  name: "MT5 Live",
  platform: "MT5",
  phase: "funded",
  status: "active",
  initial_balance: "100000",
  profit_target_percent: "10",
  max_total_drawdown_percent: "10",
  daily_loss_limit_percent: "5",
  start_date: null,
  drawdown_mode: "fixed",
  drawdown_basis: "balance",
  drawdown_stop_at_initial_balance: false,
  drawdown_eod_timezone: "America/New_York",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const TRADES: DashboardTradesResponse = {
  accountId: ACCOUNT.id,
  trades: [
    {
      account_id: ACCOUNT.id,
      ticket: 910001,
      instrument: "XAUUSD",
      buy_sell: "Buy",
      lots: "0.10",
      price_open: "2400.5",
      price_close: "2410.0",
      sl: "2390",
      tp: "2430",
      risk_per_trade: "500",
      rrr: "+1.90R",
      mfe: "19.5",
      mae: "4.0",
      time_open: "2026-02-01 10:00:00",
      time_close: "2026-02-01 11:00:00",
      status: "closed",
    },
  ],
  pagination: {
    limit: 200,
    count: 1,
    hasMore: false,
    from: null,
    to: null,
    instrument: null,
    status: "all",
  },
};

test("DashboardClient builds allowlisted URLs and forwards Bearer", async () => {
  const stub = stubFetch((call) => {
    if (call.url === `${BASE}/api/trading/accounts`) return json(200, { accounts: [ACCOUNT] });
    if (call.url.startsWith(`${BASE}/api/trading/accounts/${ACCOUNT.id}/trades`)) return json(200, TRADES);
    if (call.url === `${BASE}/api/trading/accounts/${ACCOUNT.id}/state`) return json(200, { accountId: ACCOUNT.id });
    return json(404, { error: "unexpected path" });
  });
  try {
    const client = new DashboardClient(BASE, 5000);

    const accounts = await client.listAccounts(TOKEN);
    assert.equal(stub.calls[0].url, `${BASE}/api/trading/accounts`);
    assert.equal(stub.calls[0].method, "GET");
    assert.equal(stub.calls[0].authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(accounts, { accounts: [ACCOUNT] });

    await client.listTrades(TOKEN, ACCOUNT.id, {
      status: "open",
      limit: 50,
      instrument: "XAUUSD",
      from: "2026-02-01",
    });
    assert.equal(
      stub.calls[1].url,
      `${BASE}/api/trading/accounts/${ACCOUNT.id}/trades?from=2026-02-01&instrument=XAUUSD&status=open&limit=50`,
    );
    assert.equal(stub.calls[1].authorization, `Bearer ${TOKEN}`);

    await client.getAccountState(TOKEN, ACCOUNT.id);
    assert.equal(stub.calls[2].url, `${BASE}/api/trading/accounts/${ACCOUNT.id}/state`);
  } finally {
    stub.restore();
  }
});

test("DashboardClient maps network failure → 502 (token and URL never in the message)", async () => {
  const stub = stubFetch(); // no handler ⇒ every call throws (network down)
  try {
    const client = new DashboardClient(BASE, 10_000);
    await assert.rejects(
      client.listAccounts(TOKEN),
      (err: unknown) => err instanceof DashboardApiError && err.status === 502,
    );
    await client.listAccounts(TOKEN).catch((err: DashboardApiError) => {
      assert.ok(!String(err.message).includes(TOKEN));
      assert.ok(!String(err.message).includes(BASE));
    });
  } finally {
    stub.restore();
  }
});

test("DashboardClient preserves upstream error status and message", async () => {
  const stub = stubFetch(() =>
    json(403, { error: "The requested trading account does not belong to the authenticated user." }),
  );
  try {
    const client = new DashboardClient(BASE, 5000);
    await assert.rejects(
      client.listTrades(TOKEN, ACCOUNT.id),
      (err: unknown) =>
        err instanceof DashboardApiError && err.status === 403 && /does not belong/.test(err.message),
    );
  } finally {
    stub.restore();
  }
});

// ── Proxy routes (createTradingRouter) ─────────────────────────

function makeRoot(client: DashboardClient) {
  // Same mounting as src/index.ts: both routers under /api.
  const root = new Hono();
  root.route("/api", createTradingRouter(client));
  root.route("/api", createAuthRouter(client));
  return root;
}

test("proxy: unauthenticated request → 401 before any upstream call", async () => {
  const stub = stubFetch(() => {
    throw new Error("upstream must NOT be called without a token");
  });
  try {
    const root = makeRoot(new DashboardClient(BASE, 5000));
    const res = await root.request("/api/trading/accounts");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Missing authorization token." });
  } finally {
    stub.restore();
  }
});

test("proxy: malformed accountId → 400 before any upstream call", async () => {
  const stub = stubFetch(() => {
    throw new Error("upstream must NOT be called with a malformed id");
  });
  try {
    const root = makeRoot(new DashboardClient(BASE, 5000));
    for (const path of [
      "/api/trading/accounts/not-a-uuid/trades",
      "/api/trading/accounts/;drop/trades",
    ]) {
      const res = await root.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 400, path);
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("proxy: allowlisted query forwarded, non-allowlisted dropped", async () => {
  const stub = stubFetch((call) =>
    call.url.startsWith(`${BASE}/api/trading/accounts/${ACCOUNT.id}/trades`)
      ? json(200, TRADES)
      : json(404, { error: "unexpected" }),
  );
  try {
    const root = makeRoot(new DashboardClient(BASE, 5000));
    const res = await root.request(
      `/api/trading/accounts/${ACCOUNT.id}/trades?status=open&limit=50&instrument=XAUUSD&cursor=EVIL&userId=someone-else`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, TRADES);
    // Only the five P1 params survive; cursor/userId never forwarded. Order
    // follows the allowlist (implementation detail) — assert param SET, not string.
    const upstream = new URL(stub.calls[0].url);
    assert.deepEqual(
      Object.fromEntries(upstream.searchParams).status === undefined ? [] : [...upstream.searchParams.entries()],
      [["instrument", "XAUUSD"], ["status", "open"], ["limit", "50"]],
    );
  } finally {
    stub.restore();
  }
});

test("proxy: upstream error semantics preserved (403), no internals in body", async () => {
  const stub = stubFetch(() => json(403, { error: "The requested trading account does not belong to the authenticated user." }));
  try {
    const root = makeRoot(new DashboardClient(BASE, 5000));
    const res = await root.request(`/api/trading/accounts/${ACCOUNT.id}/trades`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /does not belong/);
    // Foreign account fails at the Dashboard ownership layer — the proxy adds
    // no bypass, and the base URL never appears in the response.
    assert.ok(!JSON.stringify(body).includes(BASE));
  } finally {
    stub.restore();
  }
});

test("proxy: outage (network down) → 502 with fixed message, no internals", async () => {
  const stub = stubFetch(); // always throws
  try {
    const root = makeRoot(new DashboardClient(BASE, 5000));
    const res = await root.request("/api/trading/accounts", { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 502);
    const body = await res.json();
    // The client's fixed outage text — no URL, no token, no internals.
    assert.equal(body.error, "Trading Dashboard is unreachable.");
    assert.ok(!JSON.stringify(body).includes(BASE));
  } finally {
    stub.restore();
  }
});

test("proxy: no generic path handling — unknown /api/trading/* path is 404", async () => {
  const stub = stubFetch(() => {
    throw new Error("upstream must NOT receive unknown paths");
  });
  try {
    const root = makeRoot(new DashboardClient(BASE, 5000));
    for (const path of [
      "/api/trading/anything",
      "/api/trading/accounts/extra/segments",
    ]) {
      const res = await root.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 404, path);
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});


// ── Auth routes (createAuthRouter) ─────────────────────────────

test("DashboardClient maps non-JSON upstream failures to a fixed message", async () => {
  const stub = stubFetch(() => new Response("<html>boom</html>", { status: 502 }));
  try {
    const client = new DashboardClient(BASE, 5000);
    await assert.rejects(
      client.listAccounts(TOKEN),
      (err: unknown) => err instanceof DashboardApiError && err.status === 502 && /HTTP 502/.test(err.message),
    );
  } finally {
    stub.restore();
  }
});

test("auth: sign-in validates body and forwards JSON to the Dashboard", async () => {
  const stub = stubFetch((call) =>
    call.url === `${BASE}/api/auth/sign-in`
      ? json(200, { session: { access_token: "upstream-session-token", user: { id: "u1" } }, user: { id: "u1", email: "a@b.c" } })
      : json(404, { error: "unexpected" }),
  );
  try {
    const root = makeRoot(new DashboardClient(BASE, 5000));
    // Missing password → 400 locally, no upstream call.
    const bad = await root.request("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.c" }),
    });
    assert.equal(bad.status, 400);
    assert.equal(stub.calls.length, 0);

    const ok = await root.request("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.c", password: "secret-pass" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(stub.calls[0].method, "POST");
    assert.equal(stub.calls[0].url, `${BASE}/api/auth/sign-in`);
    assert.deepEqual(stub.calls[0].body, { email: "a@b.c", password: "secret-pass" });
    const body = await ok.json();
    assert.equal(body.session.access_token, "upstream-session-token");
  } finally {
    stub.restore();
  }
});

test("auth: session + sign-out forward the Bearer header", async () => {
  const stub = stubFetch((call) =>
    call.url === `${BASE}/api/auth/session`
      ? json(200, { user: { id: "u1", email: "a@b.c" } })
      : json(200, { ok: true }),
  );
  try {
    const root = makeRoot(new DashboardClient(BASE, 5000));
    const session = await root.request("/api/auth/session", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(session.status, 200);
    assert.equal(stub.calls[0].authorization, `Bearer ${TOKEN}`);

    const out = await root.request("/api/auth/sign-out", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(out.status, 200);
    assert.equal(stub.calls[1].method, "POST");
    assert.equal(stub.calls[1].authorization, `Bearer ${TOKEN}`);

    const noAuth = await root.request("/api/auth/session");
    assert.equal(noAuth.status, 401);
  } finally {
    stub.restore();
  }
});

test("auth: upstream credential failure keeps 401 with fixed message", async () => {
  const stub = stubFetch(() => json(401, { error: "Invalid email or password." }));
  try {
    const root = makeRoot(new DashboardClient(BASE, 5000));
    const res = await root.request("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.c", password: "wrong" }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /Invalid email or password/);
    assert.ok(!JSON.stringify(body).includes(BASE));
  } finally {
    stub.restore();
  }
});
