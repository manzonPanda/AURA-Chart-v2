/**
 * Capital.com WebSocket provider tests — frame parsing, OHLC midpoint
 * conversion, tick-burst semantics, ping/pong keepalive and quiet-skip rules.
 *
 * Frame-parse tests use the raw documented Capital.com streaming shape:
 *   { destination: "OHLCMarketData.subscribe"|"marketData.subscribe", payload: { candles: [...] } }
 * plus `#ping` keepalives.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPITAL_HEARTBEAT_INTERVAL_MS,
  CAPITAL_STREAMING_DEFAULT_URL,
  CapitalStreamClient,
  capitalMid,
  parseStreamFrame,
  type CapitalStreamDeps,
  type ParsedFrame,
  type WebSocketLike,
} from "../capital/capitalStream.js";
import type { IngTick } from "../streaming/types.js";

const GOLD = 2;

// ── capitalMid: midpoint on the Gold 2dp grid ────────────────────────────────

test("1. capitalMid is (bid+ask)/2 rounded to the 2dp Gold grid", () => {
  assert.equal(capitalMid(4460.0, 4460.2, GOLD), 4460.1);
  assert.equal(capitalMid(4461.0, 4461.3, GOLD), 4461.15);
  assert.equal(capitalMid(4459.0, 4459.0, GOLD), 4459.0);
  assert.equal(capitalMid(1.0, 1.02, GOLD), 1.01); // already on-grid → identity
  assert.equal(capitalMid(5.0, 5.0, GOLD), 5.0);
});

// ── parseStreamFrame: piped OHLC frames → tick bursts ─────────────────────────

function frameWith(candles: unknown[], dest = "OHLCMarketData.subscribe") {
  return JSON.stringify({ destination: dest, payload: { candles } });
}

/** One documented Capital candle with explicit bid/ask on every field. */
function candle(over: Record<string, unknown> = {}) {
  return {
    snapshotTimeUTC: "2024-01-02T00:00:00",
    openPrice: { openBid: "4460.00", openAsk: "4460.20" },
    highPrice: { highBid: "4461.00", highAsk: "4461.30" },
    lowPrice: { lowBid: "4459.00", lowAsk: "4459.00" },
    closePrice: { closeBid: "4460.50", closeAsk: "4460.50" },
    lastTradedVolume: "123",
    ...over,
  };
}

test("2. an OHLC candle frame becomes a [open, high, low, close] tick burst", () => {
  const p = parseStreamFrame(frameWith([candle()]), { symbol: "GOLD", decimals: GOLD });
  assert.equal(p.kind, "tick-burst");
  if (p.kind !== "tick-burst") return;
  assert.equal(p.tsMs, 1704153600000);
  assert.equal(p.cumVolume, 123);
  assert.equal(p.ticks.length, 4);
  const [o, h, l, c] = p.ticks as IngTick[];
  assert.equal(o?.price, 4460.1);
  assert.equal(h?.price, 4461.15);
  assert.equal(l?.price, 4459.0);
  assert.equal(c?.price, 4460.5);
  // All burst ticks share the forming bucket's UTC ts.
  assert.ok((p.ticks as IngTick[]).every((t) => t.tsMs === 1704153600000));
});

test("3. generic {bid,ask} field shapes parse identically", () => {
  const gen = {
    snapshotTimeUTC: "2024-01-02T00:00:00",
    open: { bid: "10.00", ask: "10.10" },
    high: { bid: "10.20", ask: "10.20" },
    low: { bid: "9.90", ask: "9.90" },
    close: { bid: "10.05", ask: "10.15" },
    volume: "50",
  };
  const p = parseStreamFrame(frameWith([gen]), { symbol: "GOLD", decimals: GOLD });
  assert.equal(p.kind, "tick-burst");
  if (p.kind !== "tick-burst") return;
  const [o, , , c] = p.ticks as IngTick[];
  assert.equal(o?.price, 10.05);
  assert.equal(c?.price, 10.1);
});

test("4. malformed candles are ignored, never crash", () => {
  const noTs = parseStreamFrame(frameWith([candle({ snapshotTimeUTC: null })]), {
    symbol: "GOLD",
    decimals: GOLD,
  });
  assert.equal(noTs.kind, "ignored");
  const noSide = parseStreamFrame(
    frameWith([{ snapshotTimeUTC: "2024-01-02T00:00:00", openPrice: null, highPrice: null, lowPrice: null, closePrice: null }]),
    { symbol: "GOLD", decimals: GOLD },
  );
  assert.equal(noSide.kind, "ignored");
  const notJson = parseStreamFrame("not-json", { symbol: "GOLD", decimals: GOLD });
  assert.equal(notJson.kind, "ignored");
});

// ── ping/pong keepalive ───────────────────────────────────────────────────────

test("5. #ping and ping-destination frames map to pong", () => {
  assert.equal("pong", parseStreamFrame("#ping", { symbol: "GOLD", decimals: GOLD }).kind);
  assert.equal(
    "pong",
    parseStreamFrame(JSON.stringify({ destination: "ping", payload: {} }), {
      symbol: "GOLD",
      decimals: GOLD,
    }).kind,
  );
});

// ── Quote/quote-only frames never tick material ───────────────────────────────

test("6. quote-only payloads are ignored (liveness only, no ticks)", () => {
  const q = parseStreamFrame(
    JSON.stringify({ destination: "marketData.subscribe", payload: { bid: "4460.0", ask: "4460.2" } }),
    { symbol: "GOLD", decimals: GOLD },
  );
  assert.equal(q.kind, "ignored");
});

// ── Mocked WebSocket seam (deterministic, no network) ─────────────────────────

interface MockSocket {
  ws: WebSocketLike;
  sent: string[];
  emitOpen(): void;
  emitMessage(data: string): void;
  emitClose(code: number, reason: string): void;
  emitError(message: string): void;
}

function createMockSocket(): MockSocket {
  const sent: string[] = [];
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const ws: WebSocketLike = {
    readyState: 1,
    on(ev: string, fn: (...a: unknown[]) => void) {
      (listeners[ev] = listeners[ev] || []).push(fn);
      return ws;
    },
    send(data: string) {
      sent.push(data);
    },
    close() {
      /* mock transport: nothing to tear down */
    },
    terminate() {
      /* mock transport: nothing to tear down */
    },
  };
  return {
    ws,
    sent,
    emitOpen: () => (listeners.open || []).forEach((f) => f()),
    emitMessage: (data: string) => (listeners.message || []).forEach((f) => f(data)),
    emitClose: (code: number, reason: string) =>
      (listeners.close || []).forEach((f) => f(code, reason)),
    emitError: (message: string) =>
      (listeners.error || []).forEach((f) => f(new Error(message))),
  };
}

function clientDeps(mock: MockSocket, over: Partial<CapitalStreamDeps> = {}): CapitalStreamDeps {
  return {
    symbol: "GOLD",
    decimals: GOLD,
    streamingUrl: "wss://api-streaming-capital.backend-capital.com/connect",
    authHeaders: () => ({
      "X-CAP-API-KEY": "KEY",
      CST: "SECRET-CST",
      "X-SECURITY-TOKEN": "SECRET-XST",
    }),
    sessionProvider: async () => ({ cst: "SECRET-CST", xSecurityToken: "SECRET-XST" }),
    onTick: () => {},
    idleTimeoutMs: 0,
    wsFactory: (_url, _headers) => mock.ws,
    ...over,
  };
}

const settle = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

const T = 1789365840000; // 2026-09-14T06:04:00.000Z — clean minute boundary (bucket open)
const ASK = { o: 4336.25, h: 4336.87, l: 4334.69, c: 4334.89 };

function baseOhlc(priceType: string, over: Record<string, unknown> = {}) {
  return {
    destination: "ohlc.event",
    payload: {
      resolution: "MINUTE",
      epic: "GOLD",
      type: "classic",
      priceType,
      t: T,
      o: 4335.75,
      h: 4336.37,
      l: 4334.19,
      c: 4334.39,
      lastTradedVolume: 344,
      ...over,
    },
  };
}

// ── 7. streaming URL includes /connect ────────────────────────────────────────

test("7. streaming URL default includes /connect", () => {
  assert.equal(
    CAPITAL_STREAMING_DEFAULT_URL,
    "wss://api-streaming-capital.backend-capital.com/connect",
  );
  assert.ok(CAPITAL_STREAMING_DEFAULT_URL.endsWith("/connect"));
});

// ── 8. WS handshake headers ───────────────────────────────────────────────────

test("8. WS handshake headers include X-CAP-API-KEY, CST, X-SECURITY-TOKEN", async () => {
  const mock = createMockSocket();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const stream = new CapitalStreamClient(
    clientDeps(mock, {
      wsFactory: (url, headers) => {
        calls.push({ url, headers });
        return mock.ws;
      },
    }),
  );
  stream.connect();
  await settle();
  const info = calls[0];
  assert.ok(info, "wsFactory must be called with url + headers");
  assert.ok(info.url.endsWith("/connect"), `got url=${info.url}`);
  assert.equal(info.headers["X-CAP-API-KEY"], "KEY");
  assert.equal(info.headers["CST"], "SECRET-CST");
  assert.equal(info.headers["X-SECURITY-TOKEN"], "SECRET-XST");
  stream.disconnect();
});

// ── 9. subscription envelope ──────────────────────────────────────────────────

test("9. subscribe uses epics/resolutions/type + correlationId + cst/securityToken", async () => {
  const mock = createMockSocket();
  const stream = new CapitalStreamClient(clientDeps(mock));
  stream.connect();
  await settle();
  mock.emitOpen();
  await settle(5);
  const sent = JSON.parse(mock.sent[0]) as Record<string, unknown>;
  assert.equal(sent.destination, "OHLCMarketData.subscribe");
  assert.ok(typeof sent.correlationId === "string" && String(sent.correlationId).length > 0);
  assert.equal(sent.cst, "SECRET-CST");
  assert.equal(sent.securityToken, "SECRET-XST");
  assert.deepEqual(sent.payload, {
    epics: ["GOLD"],
    resolutions: ["MINUTE"],
    type: "classic",
  });
  const payload = sent.payload as Record<string, unknown>;
  assert.equal(payload.markets, undefined, "must not use markets");
  assert.equal(payload.periods, undefined, "must not use periods");
  stream.disconnect();
});

// ── 10./11. ohlc.event parsing ────────────────────────────────────────────────

test("10. ohlc.event bid frame parses as ohlc-side", () => {
  const p = parseStreamFrame(JSON.stringify(baseOhlc("bid")), { symbol: "GOLD", decimals: GOLD });
  assert.equal(p.kind, "ohlc-side");
  if (p.kind !== "ohlc-side") return;
  assert.equal(p.side, "bid");
  assert.equal(p.tsMs, T);
  assert.equal(p.open, 4335.75);
  assert.equal(p.high, 4336.37);
  assert.equal(p.low, 4334.19);
  assert.equal(p.close, 4334.39);
  assert.equal(p.volume, 344);
});

test("11. ohlc.event ask frame parses as ohlc-side", () => {
  const p = parseStreamFrame(JSON.stringify(baseOhlc("ask", ASK)), { symbol: "GOLD", decimals: GOLD });
  assert.equal(p.kind, "ohlc-side");
  if (p.kind !== "ohlc-side") return;
  assert.equal(p.side, "ask");
  assert.equal(p.tsMs, T);
  assert.equal(p.open, 4336.25);
  assert.equal(p.high, 4336.87);
  assert.equal(p.low, 4334.69);
  assert.equal(p.close, 4334.89);
  assert.equal(p.volume, 344);
});

// ── 12. bid + ask pairing -> midpoint burst ───────────────────────────────────

test("12. bid + ask same bucket produce ONE midpoint OHLC burst", async () => {
  const mock = createMockSocket();
  const ticks: IngTick[] = [];
  const stream = new CapitalStreamClient(clientDeps(mock, { onTick: (t) => ticks.push(t) }));
  stream.connect();
  await settle();
  mock.emitOpen();
  await settle(5);
  mock.emitMessage(JSON.stringify(baseOhlc("bid")));
  await settle(5);
  assert.equal(ticks.length, 0, "a lone bid side must not emit any tick");
  mock.emitMessage(JSON.stringify(baseOhlc("ask", ASK)));
  await settle(5);
  assert.equal(ticks.length, 4, "pairing emits a 4-tick midpoint burst");
  const [o, h, l, c] = ticks;
  assert.equal(o.price, capitalMid(4335.75, 4336.25, GOLD));
  assert.equal(h.price, capitalMid(4336.37, 4336.87, GOLD));
  assert.equal(l.price, capitalMid(4334.19, 4334.69, GOLD));
  assert.equal(c.price, capitalMid(4334.39, 4334.89, GOLD));
  assert.equal(o.price, 4336.0);
  assert.equal(h.price, 4336.62);
  assert.equal(l.price, 4334.44);
  assert.equal(c.price, 4334.64);
  assert.ok(ticks.every((t) => t.tsMs === T), "all burst ticks share the bucket-open ts");
  assert.equal(ticks[3].volume, 344, "bucket-cumulative volume lands on the closing tick");
  stream.disconnect();
});

// ── 13. timestamp semantics ───────────────────────────────────────────────────

test("13. ohlc.event timestamp stays the bucket-open instant (no +1min shift)", () => {
  const p = parseStreamFrame(JSON.stringify(baseOhlc("ask", ASK)), { symbol: "GOLD", decimals: GOLD });
  assert.equal(p.kind, "ohlc-side");
  if (p.kind !== "ohlc-side") return;
  assert.equal(p.tsMs, T);
  assert.equal(p.tsMs % 60_000, 0, "clean minute boundary (bucket open)");
  assert.notEqual(p.tsMs, T + 60_000, "must NOT be shifted forward");
});

// ── 14. malformed/unknown frames ──────────────────────────────────────────────

test("14. malformed/unknown frames are safely ignored", () => {
  const opts = { symbol: "GOLD", decimals: GOLD };
  assert.equal(parseStreamFrame(JSON.stringify(baseOhlc("bid", { c: undefined })), opts).kind, "ignored");
  assert.equal(parseStreamFrame(JSON.stringify(baseOhlc("mid")), opts).kind, "ignored");
  assert.equal(parseStreamFrame(JSON.stringify({ destination: "who.cares", payload: {} }), opts).kind, "ignored");
});

// ── 15. close/error diagnostics redact credentials ────────────────────────────

test("15. WS close diagnostics redact CST & X-SECURITY-TOKEN", async () => {
  const mock = createMockSocket();
  const stream = new CapitalStreamClient(clientDeps(mock, { backoffBaseMs: 60_000, backoffMaxMs: 60_000 }));
  const warned: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warned.push(a.map(String).join(" "));
  };
  try {
    stream.connect();
    await settle();
    mock.emitClose(1011, "token SECRET-CST / SECRET-XST rejected");
    await settle(5);
    const joined = warned.join("\n");
    assert.ok(joined.length > 0, "expected a diagnostic log");
    assert.ok(!joined.includes("SECRET-CST"), "CST must not leak");
    assert.ok(!joined.includes("SECRET-XST"), "X-SECURITY-TOKEN must not leak");
    assert.ok(joined.includes("<REDACTED>"), "secrets are redacted");
    assert.ok(joined.includes("code=1011"), "close code is reported");
    assert.ok(joined.includes("GOLD"), "epic is reported");
  } finally {
    console.warn = origWarn;
    stream.disconnect();
  }
});

// ── 16. reconnect does not leak/duplicate subscriptions ─────────────────────────

test("16. reconnect sends exactly ONE subscribe per socket (no dup/leak)", async () => {
  const mocks: MockSocket[] = [];
  const dummy = createMockSocket();
  const stream = new CapitalStreamClient(
    clientDeps(dummy, {
      backoffBaseMs: 0,
      backoffMaxMs: 1,
      wsFactory: (_url, _headers) => {
        const m = createMockSocket();
        mocks.push(m);
        return m.ws;
      },
    }),
  );
  stream.connect();
  await settle(30);
  assert.equal(mocks.length, 1, "initial connect creates one socket");
  mocks[0].emitOpen();
  await settle(5);
  assert.equal(mocks[0].sent.length, 1, "first socket gets exactly one subscribe");
  mocks[0].emitClose(1006, "abrupt");
  await settle(40);
  assert.equal(mocks.length, 2, "reconnect creates a fresh socket");
  mocks[1].emitOpen();
  await settle(5);
  assert.equal(mocks[1].sent.length, 1, "reconnected socket gets exactly one subscribe");
  assert.equal(mocks[0].sent.length, 1, "old socket was never re-subscribed");
  stream.disconnect();
});

// ── 17-25. application-level heartbeat (Capital keepalive fix) ────────────────
//
// Production evidence (2026-09-14 journal): Capital's edge terminated the GOLD
// socket ~60s after the last frame with close code 1006, ~every 2 minutes,
// because only once-per-minute OHLC frames flowed. The fix: a 30s
// application-level `ping` while OPEN. These tests use ms-scale intervals
// (deterministic, no real 30s waits); node timers never fire early, so
// settle() windows always bound the expected ping counts from below.

/** Extract application-level pings from a mock socket's sent frames. */
function sentPings(m: MockSocket): Record<string, unknown>[] {
  return m.sent
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((p): p is Record<string, unknown> => p?.destination === "ping");
}

test("17. default heartbeat interval is the documented 30s constant", () => {
  assert.equal(CAPITAL_HEARTBEAT_INTERVAL_MS, 30_000);
});

test("18. heartbeat starts after OPEN and emits VALID Capital pings", async () => {
  const mock = createMockSocket();
  const stream = new CapitalStreamClient(clientDeps(mock, { heartbeatIntervalMs: 15 }));
  stream.connect();
  await settle();
  mock.emitOpen();
  await settle(80); // ≥ 5 heartbeat intervals — timers never fire early
  const pings = sentPings(mock);
  assert.ok(pings.length >= 3, `expected ≥3 heartbeats in 80ms, got ${pings.length}`);
  for (const p of pings) {
    assert.equal(p.destination, "ping");
    assert.ok(
      typeof p.correlationId === "string" && (p.correlationId as string).length > 0,
      "correlationId present",
    );
    assert.equal(p.cst, "SECRET-CST", "ping carries the CURRENT session cst");
    assert.equal(p.securityToken, "SECRET-XST", "ping carries the CURRENT session securityToken");
    assert.equal(p.payload, undefined, "documented ping shape carries no payload");
  }
  const ids = pings.map((p) => p.correlationId as string);
  assert.equal(new Set(ids).size, ids.length, "correlationIds are unique (monotonic)");
  assert.equal(stream.stats.heartbeats, pings.length, "heartbeat counter matches sends");
  stream.disconnect();
});

test("19. heartbeat stops after CLOSE (no orphaned timer)", async () => {
  const mock = createMockSocket();
  const stream = new CapitalStreamClient(
    clientDeps(mock, {
      heartbeatIntervalMs: 10,
      backoffBaseMs: 60_000,
      backoffMaxMs: 60_000,
    }),
  );
  stream.connect();
  await settle();
  mock.emitOpen();
  await settle(60);
  const before = sentPings(mock).length;
  assert.ok(before >= 3, `expected pings before close, got ${before}`);
  mock.emitClose(1006, "edge idle timeout");
  await settle(60);
  assert.equal(sentPings(mock).length, before, "no heartbeat fires after the socket closed");
  stream.disconnect();
});

test("20. heartbeat stops on disconnect()", async () => {
  const mock = createMockSocket();
  const stream = new CapitalStreamClient(clientDeps(mock, { heartbeatIntervalMs: 10 }));
  stream.connect();
  await settle();
  mock.emitOpen();
  await settle(60);
  const before = sentPings(mock).length;
  assert.ok(before >= 3, `expected pings before disconnect, got ${before}`);
  stream.disconnect();
  await settle(60);
  assert.equal(sentPings(mock).length, before, "disconnect clears the heartbeat timer");
});

test("21. reconnect arms exactly ONE heartbeat timer for the new socket", async () => {
  const mocks: MockSocket[] = [];
  const stream = new CapitalStreamClient(
    clientDeps(createMockSocket(), {
      heartbeatIntervalMs: 10,
      backoffBaseMs: 0,
      backoffMaxMs: 1,
      wsFactory: (_url, _headers) => {
        const m = createMockSocket();
        mocks.push(m);
        return m.ws;
      },
    }),
  );
  stream.connect();
  await settle();
  mocks[0].emitOpen();
  await settle(60);
  const first = sentPings(mocks[0]).length;
  assert.ok(first >= 3, `first socket heartbeats, got ${first}`);
  mocks[0].emitClose(1006, "drop");
  await settle(40); // backoff ≤1ms → fresh socket
  assert.equal(mocks.length, 2, "reconnect created a fresh socket");
  mocks[1].emitOpen();
  await settle(60);
  const second = sentPings(mocks[1]).length;
  assert.ok(second >= 3, `reconnected socket heartbeats, got ${second}`);
  assert.ok(
    second <= 9,
    `ONE 10ms timer over 60ms, got ${second} pings (a leaked extra timer would double this)`,
  );
  assert.equal(sentPings(mocks[0]).length, first, "old socket receives no pings after close");
  stream.disconnect();
});

test("22. incoming OHLC frames keep resetting the idle watchdog (still intact)", async () => {
  const mock = createMockSocket();
  let terminated = false;
  mock.ws.terminate = () => {
    terminated = true;
  };
  const stream = new CapitalStreamClient(clientDeps(mock, { idleTimeoutMs: 100 }));
  stream.connect();
  await settle();
  mock.emitOpen();
  await settle(5);
  for (let i = 0; i < 6; i++) {
    mock.emitMessage(JSON.stringify(baseOhlc("bid")));
    await settle(25); // 25ms ≪ 100ms idle window → watchdog keeps re-arming
  }
  assert.equal(terminated, false, "live OHLC frames keep the watchdog quiet");
  await settle(250); // silence ≫ 100ms idle window
  assert.equal(terminated, true, "silent socket is hard-terminated by the watchdog");
  stream.disconnect();
});

test("23. a live socket answering pings with frames is NEVER idle-terminated", async () => {
  const mock = createMockSocket();
  let terminated = false;
  mock.ws.terminate = () => {
    terminated = true;
  };
  const stream = new CapitalStreamClient(
    clientDeps(mock, {
      idleTimeoutMs: 100, // ≙ production 120s watchdog
      heartbeatIntervalMs: 15, // ≙ production 30s heartbeat
      backoffBaseMs: 60_000,
      backoffMaxMs: 60_000,
    }),
  );
  stream.connect();
  await settle();
  mock.emitOpen();
  await settle(5);
  // ~180ms ≫ the 100ms idle window: only the periodic heartbeat responses
  // keep this socket alive (mirrors the production 30s-ping/120s-watchdog ratio).
  for (let i = 0; i < 12; i++) {
    await settle(15);
    mock.emitMessage(JSON.stringify({ destination: "ping", payload: {} }));
  }
  assert.ok(stream.stats.heartbeats >= 3, "client kept pinging throughout");
  assert.equal(terminated, false, "periodic responses keep the idle watchdog quiet");
  stream.disconnect();
});

test("24. server keepalive frame triggers a VALID application ping (no bare payload)", async () => {
  const mock = createMockSocket();
  const stream = new CapitalStreamClient(
    clientDeps(mock, { heartbeatIntervalMs: 0 }), // 0 disables periodic ping — isolate reactive path
  );
  stream.connect();
  await settle();
  mock.emitOpen();
  await settle(5);
  mock.emitMessage("#ping"); // Capital's bare keepalive → pong branch
  await settle(5);
  const pings = sentPings(mock);
  assert.equal(pings.length, 1, "exactly one reactive ping");
  const p = pings[0];
  assert.equal(p.destination, "ping");
  assert.ok(
    typeof p.correlationId === "string" && (p.correlationId as string).length > 0,
    "correlationId present",
  );
  assert.equal(p.cst, "SECRET-CST", "valid session cst");
  assert.equal(p.securityToken, "SECRET-XST", "valid session securityToken");
  assert.equal(stream.stats.heartbeats, 1);
  stream.disconnect();
});

test("25. no heartbeat while CONNECTING (pre-OPEN)", async () => {
  const mock = createMockSocket();
  const stream = new CapitalStreamClient(clientDeps(mock, { heartbeatIntervalMs: 10 }));
  stream.connect(); // CONNECTING — emitOpen never called
  await settle(70); // ≥ 6 heartbeat intervals
  assert.equal(sentPings(mock).length, 0, "no ping before the socket is OPEN");
  mock.emitOpen();
  await settle(60);
  assert.ok(sentPings(mock).length >= 3, "pings flow once OPEN");
  stream.disconnect();
});
