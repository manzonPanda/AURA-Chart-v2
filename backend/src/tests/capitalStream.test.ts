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
  capitalMid,
  parseStreamFrame,
  type ParsedFrame,
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