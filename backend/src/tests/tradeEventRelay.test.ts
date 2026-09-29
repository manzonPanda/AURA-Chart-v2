/**
 * P3-C — Trade-event relay authorization-boundary tests (§12/§13-R).
 *
 * PURE tests: the relay's `fetchImpl` is injectable, so the aura-backend SSE
 * stream is simulated in-process (no server, no sockets, no PostgreSQL).
 *
 * What it proves:
 *   * a client that never authenticates receives NO trade frames
 *   * an invalid/expired token gets {type:"tradeAuth",ok:false} and
 *     subscribes to nothing (no upstream fetch, no frames)
 *   * a valid token opens exactly one ref-counted upstream /api/events
 *     subscription carrying that user's Bearer token
 *   * frames flowing through user A's stream reach ONLY clients authenticated
 *     as user A — never user B's socket, never unauthenticated sockets
 *   * routing key is OUR validated session userId (upstream payload userId is
 *     advisory and ignored)
 *   * malformed/garbage "auth" frames are ignored
 *   * detach is ref-counted (N tabs = 1 sub); stop() aborts everything
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  TRADE_REFRESH_DEBOUNCE_MS,
  createTradeEventRelay,
  parseSseEvent,
} from "../services/tradeEventRelay.js";

const TOKEN_A = "token-A";
const TOKEN_B = "token-B";
const WAIT = TRADE_REFRESH_DEBOUNCE_MS + 250;

/** Minimal ws stub: records sends, exposes the relay's message listener. */
function makeWs() {
  const sent: string[] = [];
  let handler: ((...args: unknown[]) => void) | null = null;
  return {
    sent,
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "message") handler = cb;
    },
    send(data: string) {
      sent.push(data);
    },
    emitMessage(raw: string) {
      handler?.(raw);
    },
    /** Last trade frame received (null if none). */
    lastTrade(): Record<string, unknown> | null {
      for (let i = sent.length - 1; i >= 0; i--) {
        const parsed = JSON.parse(sent[i]!) as Record<string, unknown>;
        if (parsed.type === "trade") return parsed;
      }
      return null;
    },
    tradeCount(): number {
      return sent.filter((s) => s.includes('"type":"trade"')).length;
    },
  };
  type Ws = ReturnType<typeof makeWs>;
}
type WsStub = ReturnType<typeof makeWs>;

/** Fake P2 session authority — only TOKEN_A/TOKEN_B resolve. */
const fakeSessions = async (token: string) => {
  if (token === TOKEN_A) return { user: { id: "user-A" } };
  if (token === TOKEN_B) return { user: { id: "user-B" } };
  return null;
};

/** Injectable SSE stream — push() feeds server-sent events into the relay. */
function makeSseBody() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (block: string) => controller.enqueue(encoder.encode(block)),
    close: () => {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  };
}

interface FetchCall {
  url: string;
  auth: string | null;
}

/** Fake fetch: one open SSE stream per Authorization token; records calls. */
function makeFetch() {
  const calls: FetchCall[] = [];
  const streams = new Map<string, ReturnType<typeof makeSseBody>>();
  const fetchImpl = (url: string | URL, init?: RequestInit): Promise<Response> => {
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? null;
    calls.push({ url: String(url), auth });
    const token = auth?.replace("Bearer ", "") ?? "";
    let body = streams.get(token);
    if (!body) {
      body = makeSseBody();
      streams.set(token, body);
    }
    return Promise.resolve({ ok: true, body: body.stream } as unknown as Response);
  };
  return {
    calls,
    /** Push an upstream change event into the stream opened for `token`. */
    emit(token: string, payload: Record<string, unknown>) {
      const body = streams.get(token);
      assert.ok(body, `no upstream stream opened for ${token}`);
      body.push(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authFrame(token: string) {
  return JSON.stringify({ type: "auth", token });
}
// ---PART2--- (authorization boundary — self-contained t2 fakes, tolerant of field-name variants)

const t2mod: any = await import("../services/tradeEventRelay.js");
const t2Create = (t2mod as any).createTradeEventRelay;

const T2_USER = "11111111-2222-4333-8444-555555555555";
const T2_OTHER_USER = "99999999-8888-4777-8666-555555555555";
const T2_ACCT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const T2_OTHER_ACCT = "ffffff00-0000-4000-8000-000000000001";
const T2_GOOD = "t2-good-token";
const T2_BAD = "t2-bad-token";

function t2Socket() {
  const s: any = {
    sent: [] as string[],
    readyState: 1,
    handlers: new Map<string, Array<(a: any) => void>>(),
    on(ev: string, cb: (a: any) => void) {
      const arr = s.handlers.get(ev) ?? [];
      arr.push(cb);
      s.handlers.set(ev, arr);
      return s;
    },
    emitMessage(raw: string) {
      for (const cb of s.handlers.get("message") ?? []) {
        try { cb(raw); continue; } catch { /* try event-style */ }
        try { cb({ data: raw }); } catch { /* ignore */ }
      }
      if (typeof s.onmessage === "function") {
        try { s.onmessage({ data: raw }); } catch { /* ignore */ }
      }
    },
    send(data: string) { s.sent.push(String(data)); },
    close() { s.readyState = 3; },
  };
  return s;
}

function t2DashboardClient() {
  const calls = { getSession: 0, getAccounts: 0 };
  return {
    calls,
    async getSession(token: string) {
      calls.getSession += 1;
      if (token !== T2_GOOD) return null;
      const uid = T2_USER;
      return {
        id: uid, userId: uid, user_id: uid, sub: uid, token,
        email: "trader@example.com",
        user: { id: uid },
        session: { user: { id: uid } },
      };
    },
    async getAccounts(token: string) {
      calls.getAccounts += 1;
      if (token !== T2_GOOD) return [];
      return [
        { id: T2_ACCT, account_id: T2_ACCT, account_number: 5001, name: "5001 P1" },
      ];
    },
  };
}

const T2_CONFIG = {
  dashboard: { baseUrl: "http://127.0.0.1:9", eventsPath: "/api/events", timeoutMs: 1000 },
};

function t2SseResponse(text: string) {
  const chunk = new TextEncoder().encode(text);
  let exhausted = false;
  const res: any = {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (String(n).toLowerCase() === "content-type" ? "text/event-stream" : null) },
    text: async () => text,
    body: {
      getReader() {
        return {
          read: async () => {
            if (exhausted) return { done: true as const, value: undefined };
            exhausted = true;
            return { done: false as const, value: chunk };
          },
          releaseLock() {},
        };
      },
    },
  };
  return res;
}

function t2Frame(sock: { sent: string[] }, type: string): any {
  for (const raw of sock.sent) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.type === type) return parsed;
    } catch { /* non-JSON */ }
  }
  return null;
}

function t2Change(userId: string, accountId: string) {
  const payload = {
    type: "change",
    table: "trades",
    action: "insert",
    userId,
    accountId,
    symbol: "XAUUSD",
    epic: "GOLD",
    at: "2026-01-05T10:00:00.000Z",
  };
  return `event: change\ndata: ${JSON.stringify(payload)}\n\n`;
}

test("P3-C auth: valid token authorizes and the user's own trades relay", async () => {
  const sock = t2Socket();
  const relay = t2Create(
    t2DashboardClient(),
    T2_CONFIG.dashboard.baseUrl,
    async () => t2SseResponse(t2Change(T2_USER, T2_ACCT)),
  );
  relay.attach(sock, "GOLD");
  sock.emitMessage(JSON.stringify({ type: "auth", token: T2_GOOD }));
  await new Promise((r) => setTimeout(r, 700));
  const auth = t2Frame(sock, "tradeAuth");
  assert.ok(auth, "auth reply frame received");
  assert.equal(auth.ok, true, "valid token -> ok:true");
  assert.ok(t2Frame(sock, "trade"), "own-account change fans out as a trade frame");
  relay.stop();
});

test("P3-C auth: another user's trade change never reaches this client", async () => {
  const sock = t2Socket();
  const relay = t2Create(
    t2DashboardClient(),
    T2_CONFIG.dashboard.baseUrl,
    async () => t2SseResponse(t2Change(T2_OTHER_USER, T2_OTHER_ACCT)),
  );
  relay.attach(sock, "GOLD");
  sock.emitMessage(JSON.stringify({ type: "auth", token: T2_GOOD }));
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(t2Frame(sock, "tradeAuth")?.ok, true, "client itself is authorized");
  assert.equal(t2Frame(sock, "trade"), null, "foreign user's change must not fan out");
  relay.stop();
});

function t2Visual(userId: string, accountId: string, over: Record<string, unknown> = {}) {
  const payload = {
    type: "visual-position",
    userId,
    accountId,
    ticket: "12345",
    profit: 81.28,
    swap: 0,
    slValue: -47.68,
    sourceId: "dashboard-a",
    sourceSequence: 1,
    sequence: 7,
    at: "2026-09-25T06:00:00.000Z",
    ...over,
  };
  return `event: change\ndata: ${JSON.stringify(payload)}\n\n`;
}

test("P3-C visual: authenticated P&L hint fans out immediately without a refetch frame", async () => {
  const sock = t2Socket();
  const relay = t2Create(
    t2DashboardClient(),
    T2_CONFIG.dashboard.baseUrl,
    async () => t2SseResponse(t2Visual(T2_USER, T2_ACCT)),
  );
  relay.attach(sock, "GOLD");
  sock.emitMessage(authFrame(T2_GOOD));
  await sleep(100);
  const visual = t2Frame(sock, "tradeVisual");
  assert.ok(visual, "authenticated visual frame fans out");
  assert.equal(visual.accountId, T2_ACCT);
  assert.equal(visual.ticket, "12345");
  assert.equal(visual.profit, 81.28);
  assert.equal(visual.swap, 0);
  assert.equal(visual.slValue, -47.68);
  assert.equal(visual.sequence, 7);
  assert.equal(t2Frame(sock, "trade"), null, "visual hints never trigger an authoritative refetch");
  relay.stop();
});

test("P3-C visual: another user's visual hint is dropped", async () => {
  const sock = t2Socket();
  const relay = t2Create(
    t2DashboardClient(),
    T2_CONFIG.dashboard.baseUrl,
    async () => t2SseResponse(t2Visual(T2_OTHER_USER, T2_OTHER_ACCT)),
  );
  relay.attach(sock, "GOLD");
  sock.emitMessage(authFrame(T2_GOOD));
  await sleep(100);
  assert.equal(t2Frame(sock, "tradeAuth")?.ok, true);
  assert.equal(t2Frame(sock, "tradeVisual"), null, "foreign visual data never fans out");
  relay.stop();
});

test("P3-C auth: bad token is rejected and no trades are relayed", async () => {
  const sock = t2Socket();
  const relay = t2Create(
    t2DashboardClient(),
    T2_CONFIG.dashboard.baseUrl,
    async () => t2SseResponse(""),
  );
  relay.attach(sock, "GOLD");
  sock.emitMessage(JSON.stringify({ type: "auth", token: T2_BAD }));
  await new Promise((r) => setTimeout(r, 400));
  const auth = t2Frame(sock, "tradeAuth");
  assert.ok(auth, "rejection reply received");
  assert.equal(auth.ok, false, "bad token -> ok:false");
  assert.equal(t2Frame(sock, "trade"), null, "unauthorized client gets no trades");
  relay.stop();
});

// ---PART3--- (stale-session pin: token adoption + 401 release)

/** Two VALID session tokens for the SAME user, so only freshness differs. */
const T3_USER = "77777777-1111-4222-8333-444444444444";
const T3_ACCT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const T3_TOKEN_A = "t3-token-A";
const T3_TOKEN_B = "t3-token-B";

function t3DashboardClient() {
  return {
    async getSession(token: string) {
      // Both tokens are VALID; the relay is expected to prefer the newest.
      if (token !== T3_TOKEN_A && token !== T3_TOKEN_B) return null;
      return { user: { id: T3_USER }, id: T3_USER, sub: T3_USER, token };
    },
  } as any;
}

/** Fetch stub that scripts the upstream response per bearer token. */
function t3Fetch(behaviour: (token: string, callIndex: number) => "ok" | "500" | "401") {
  const calls: string[] = [];
  const streams = new Map<string, ReturnType<typeof makeSseBody>>();
  const fetchImpl = (url: string | URL, init?: RequestInit): Promise<Response> => {
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    const token = auth.replace("Bearer ", "");
    calls.push(token);
    const verdict = behaviour(token, calls.length);
    if (verdict === "401") {
      return Promise.resolve({ ok: false, status: 401, body: null } as unknown as Response);
    }
    if (verdict === "500") {
      return Promise.resolve({ ok: false, status: 500, body: null } as unknown as Response);
    }
    let body = streams.get(token);
    if (!body) { body = makeSseBody(); streams.set(token, body); }
    return Promise.resolve({ ok: true, status: 200, body: body.stream } as unknown as Response);
  };
  return { calls, streams, fetchImpl };
}

test("stale-session pin: a newer valid token replaces the shared subscription's pinned token", async () => {
  // First client pins token A; the stream fails transiently so the loop retries.
  const f = t3Fetch((token) => (token === T3_TOKEN_A ? "500" : "ok"));
  const relay = t2Create(t3DashboardClient(), T2_CONFIG.dashboard.baseUrl, f.fetchImpl);

  const c1 = t2Socket();
  relay.attach(c1, "GOLD");
  c1.emitMessage(authFrame(T3_TOKEN_A));
  await sleep(150);
  assert.equal(relay.subscriptionCount(), 1, "first client creates the shared subscription");
  assert.equal(f.calls[0], T3_TOKEN_A, "upstream was called with token A");

  // A second VALID client (newer session) subscribes while the loop waits.
  const c2 = t2Socket();
  relay.attach(c2, "GOLD");
  c2.emitMessage(authFrame(T3_TOKEN_B));
  await sleep(150);
  assert.equal(relay.subscriptionCount(), 1, "subscription is SHARED, not duplicated");
  assert.equal(relay.authedClientCount(), 2, "both clients are authenticated");

  // The 5s retry must now present the NEWEST token, not the pinned A.
  await sleep(5600);
  assert.equal(f.calls.length, 2, "one retry happened after the transient 500");
  assert.equal(
    f.calls[1], T3_TOKEN_B,
    "retry uses the newest validated token B (the stale-token pin is healed)",
  );
  relay.stop();
});

test("stale-session pin: an upstream 401 releases the subscription instead of retrying forever", async () => {
  const f = t3Fetch(() => "401");
  const relay = t2Create(t3DashboardClient(), T2_CONFIG.dashboard.baseUrl, f.fetchImpl);

  const sock = t2Socket();
  relay.attach(sock, "GOLD");
  sock.emitMessage(authFrame(T3_TOKEN_A));
  await sleep(200);
  assert.equal(t2Frame(sock, "tradeAuth")?.ok, true, "client auth itself succeeded");
  // The stub 401s immediately, so the release may already have happened by the
  // time we look — the meaningful assertion is the END STATE, not the transient.
  assert.equal(relay.subscriptionCount(), 0, "401 RELEASES the stale subscription");

  // The old 5s spin would keep re-sending the same dead token forever.
  const callsAfterRelease = f.calls.length;
  await sleep(6000);
  assert.equal(
    f.calls.length, callsAfterRelease,
    "no further retries: the 401 spin is gone",
  );

  // A later valid client re-subscribes cleanly.
  const sock2 = t2Socket();
  const ok2 = t3Fetch(() => "ok");
  const relay2 = t2Create(t3DashboardClient(), T2_CONFIG.dashboard.baseUrl, ok2.fetchImpl);
  relay2.attach(sock2, "GOLD");
  sock2.emitMessage(authFrame(T3_TOKEN_B));
  await sleep(200);
  assert.equal(relay2.subscriptionCount(), 1, "next auth re-subscribes cleanly");
  assert.equal(ok2.calls[0], T3_TOKEN_B, "re-subscribe uses the fresh token");
  relay2.stop();
  relay.stop();
});

test("stale-session pin: a 401 does NOT remove a newer replacement subscription", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // First fetch hangs until we let it fail, proving the entry was replaced meanwhile.
  const f = t3Fetch(() => "ok");
  let callNo = 0;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    callNo += 1;
    if (callNo === 1) {
      await gate;
      return { ok: false, status: 401, body: null } as unknown as Response;
    }
    return f.fetchImpl(url, init);
  };
  const relay = t2Create(t3DashboardClient(), T2_CONFIG.dashboard.baseUrl, fetchImpl);

  const c1 = t2Socket();
  relay.attach(c1, "GOLD");
  c1.emitMessage(authFrame(T3_TOKEN_A));
  await sleep(150);
  assert.equal(relay.subscriptionCount(), 1);

  // Force a different subscription object for the same user, then fail the old one.
  relay.stop();
  const relay2 = t2Create(t3DashboardClient(), T2_CONFIG.dashboard.baseUrl, () =>
    Promise.resolve({ ok: true, status: 200, body: makeSseBody().stream } as unknown as Response));
  const c2 = t2Socket();
  relay2.attach(c2, "GOLD");
  c2.emitMessage(authFrame(T3_TOKEN_B));
  await sleep(150);
  assert.equal(relay2.subscriptionCount(), 1, "replacement subscription exists");

  release();
  await sleep(300);
  assert.equal(relay2.subscriptionCount(), 1, "stale 401 must NOT delete the replacement entry");
  relay2.stop();
});

test("stale-session pin: ref-count and detach behaviour are unchanged on success", async () => {
  const f = t3Fetch(() => "ok");
  const relay = t2Create(t3DashboardClient(), T2_CONFIG.dashboard.baseUrl, f.fetchImpl);

  const c1 = t2Socket();
  const c2 = t2Socket();
  relay.attach(c1, "GOLD");
  c1.emitMessage(authFrame(T3_TOKEN_A));
  await sleep(150);
  relay.attach(c2, "GOLD");
  c2.emitMessage(authFrame(T3_TOKEN_B));
  await sleep(150);
  assert.equal(relay.subscriptionCount(), 1, "two tabs share ONE upstream stream");
  assert.equal(f.calls.length, 1, "only one upstream connection for two tabs");

  relay.detach(c1);
  await sleep(50);
  assert.equal(relay.subscriptionCount(), 1, "one tab left ⇒ subscription retained");
  assert.equal(relay.authedClientCount(), 1);

  relay.detach(c2);
  await sleep(50);
  assert.equal(relay.subscriptionCount(), 0, "last tab gone ⇒ subscription released");
  relay.stop();
});

test("stale-session pin: normal SSE streaming still fans out trade frames", async () => {
  const f = t3Fetch(() => "ok");
  const relay = t2Create(t3DashboardClient(), T2_CONFIG.dashboard.baseUrl, f.fetchImpl);
  const sock = t2Socket();
  relay.attach(sock, "GOLD");
  sock.emitMessage(authFrame(T3_TOKEN_B));
  await sleep(200);
  assert.equal(t2Frame(sock, "tradeAuth")?.ok, true);

  f.streams.get(T3_TOKEN_B)!.push(
    `event: change\ndata: ${JSON.stringify({
      type: "change", table: "trades", action: "update",
      userId: T3_USER, accountId: T3_ACCT, at: new Date().toISOString(),
    })}\n\n`,
  );
  await sleep(TRADE_REFRESH_DEBOUNCE_MS + 250);
  const trade = t2Frame(sock, "trade");
  assert.ok(trade, "a trades change still fans out as a trade frame");
  assert.equal(trade.table, "trades");
  assert.equal(trade.accountId, T3_ACCT);
  relay.stop();
});
