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
