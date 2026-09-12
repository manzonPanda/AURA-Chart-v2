/**
 * Capital.com provider tests — timestamps, historical parsing, pagination,
 * authentication and error mapping. All contracts verified against the
 * documented Capital.com REST semantics (snapshotTimeUTC = authoritative UTC).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCapitalTimestampAsUtc,
  formatCapitalUtcIso,
  capitalRowTimestamp,
} from "../capital/time.js";
import {
  parseCapitalPrice,
  parseCapitalPrices,
  fetchOneMinuteWindow,
  fetchPricePages,
  roundToGrid,
} from "../capital/historical.js";
import { createSession, CAPITAL_API_KEY_HEADER } from "../capital/auth.js";
import { CapitalApiError, toHttpError } from "../capital/errors.js";
import type { CapitalPrice } from "../capital/types.js";

// ── Timestamps: tz-less strings MUST parse as UTC (never account-local) ──────

test("1. tz-less snapshotTimeUTC parses as UTC wall clock (not local UTC+8)", () => {
  // 2024-01-02T00:00:00 UTC == epoch 1704153600000. In a UTC+8 environment a
  // naive Date.parse would yield 1704124800000 (local midnight = 16:00 UTC).
  const ms = parseCapitalTimestampAsUtc("2024-01-02T00:00:00");
  assert.equal(ms, 1704153600000);
  // The same string must equal the explicit-offset form.
  assert.equal(ms, Date.parse("2024-01-02T00:00:00Z"));
});

test("2. seconds and fractional seconds are honored in tz-less parsing", () => {
  assert.equal(parseCapitalTimestampAsUtc("2024-01-02T00:01:30"), 1704153690000);
  assert.equal(parseCapitalTimestampAsUtc("2024-01-02T00:01:30.250"), 1704153690250);
  // Space-separated variant (snapshotTime's documented style).
  assert.equal(parseCapitalTimestampAsUtc("2024/01/02 00:01:30"), 1704153690000);
});

test("3. strings WITH an explicit offset go through Date.parse unchanged", () => {
  assert.equal(parseCapitalTimestampAsUtc("2024-01-02T00:00:00Z"), 1704153600000);
  assert.equal(parseCapitalTimestampAsUtc("2024-01-02T05:30:00+05:30"), 1704153600000);
});

test("4. formatCapitalUtcIso is the exact inverse of the tz-less parse", () => {
  const ms = 1704153690000;
  const iso = formatCapitalUtcIso(ms);
  assert.equal(iso, "2024-01-02T00:01:30");
  assert.equal(parseCapitalTimestampAsUtc(iso), ms);
});

test("5. capitalRowTimestamp prefers snapshotTimeUTC over snapshotTime", () => {
  const row: { snapshotTimeUTC?: string | null; snapshotTime?: string | null } = {
    snapshotTime: "2024/01/02 08:00:00", // account-local display time (UTC+8)
    snapshotTimeUTC: "2024-01-02T00:00:00",
  };
  assert.equal(capitalRowTimestamp(row), 1704153600000);
  // Fallback to snapshotTime when UTC is absent — same tz-less UTC rule.
  assert.equal(capitalRowTimestamp({ snapshotTime: "2024/01/02 00:00:00" }), 1704153600000);
  // Malformed → NaN, never a guess.
  assert.ok(Number.isNaN(capitalRowTimestamp({})));
});

// ── Historical parsing: midpoint OHLC on the 2dp Gold grid ───────────────────

const GOLD = 2;

function bar(over: Partial<CapitalPrice> = {}): CapitalPrice {
  return { snapshotTimeUTC: "2024-01-02T00:00:00", ...over };
}

test("6. parseCapitalPrice computes per-field midpoint OHLC and rounds to 2dp", () => {
  const p = bar({
    openPrice: { openBid: "4460.00", openAsk: "4460.20" },
    highPrice: { highBid: "4461.00", highAsk: "4461.30" }, // mid 4461.15
    lowPrice: { lowBid: "4459.00", lowAsk: "4459.00" },
    closePrice: { closeBid: "4460.50", closeAsk: "4460.50" },
    lastTradedVolume: "123",
  });
  const c = parseCapitalPrice(p, GOLD);
  assert.ok(c);
  assert.equal(c.ts, 1704153600000);
  assert.equal(c.open, 4460.1);
  assert.equal(c.high, 4461.15);
  assert.equal(c.low, 4459.0);
  assert.equal(c.close, 4460.5);
  assert.equal(c.volume, 123);
});

test("7. parseCapitalPrice tolerates generic {bid,ask} shapes and rejects unusable rows", () => {
  const generic = bar({
    openPrice: { bid: "10.00", ask: "10.10" },
    highPrice: { bid: "10.20", ask: "10.20" },
    lowPrice: { bid: "9.90", ask: "9.90" },
    closePrice: { bid: "10.05", ask: "10.15" },
  });
  const c = parseCapitalPrice(generic, GOLD);
  assert.ok(c);
  assert.equal(c.open, 10.05);
  assert.equal(c.close, 10.1);
  // Malformed: no usable timestamp → null (skipped, never guessed).
  assert.equal(parseCapitalPrice({ ...bar(), snapshotTimeUTC: null, snapshotTime: null }, GOLD), null);
  // Malformed: a missing side everywhere → null.
  assert.equal(parseCapitalPrice(bar({ openPrice: null, highPrice: null, lowPrice: null, closePrice: null }), GOLD), null);
});

test("8. parseCapitalPrices sorts ascending and tolerates a missing prices array", () => {
  // A bar with a full bid/ask OHLC shape (parseCapitalPrice drops rows that
  // lack every price field — bare timestamps yield zero candles).
  const full = (ts: string): CapitalPrice =>
    bar({
      snapshotTimeUTC: ts,
      openPrice: { openBid: "1", openAsk: "1" },
      highPrice: { highBid: "1", highAsk: "1" },
      lowPrice: { lowBid: "1", lowAsk: "1" },
      closePrice: { closeBid: "1", closeAsk: "1" },
    });
  const body = {
    prices: [full("2024-01-02T00:02:00"), full("2024-01-02T00:01:00")],
  };
  const out = parseCapitalPrices(body, GOLD);
  assert.equal(out.length, 2);
  assert.ok(out[0].ts < out[1].ts);
  // Malformed rows are dropped silently.
  const withBad = parseCapitalPrices({ prices: [full("2024-01-02T00:00:00"), { snapshotTimeUTC: "garbage" }] }, GOLD);
  assert.equal(withBad.length, 1);
  assert.deepEqual(parseCapitalPrices({}, GOLD), []);
});

test("9. roundToGrid matches Math.round parity on the Gold 2dp grid", () => {
  assert.equal(roundToGrid(4460.125, GOLD), 4460.13);
  assert.equal(roundToGrid(4460.124, GOLD), 4460.12);
  assert.equal(roundToGrid(4460.13, GOLD), 4460.13); // already on-grid → identity
  assert.equal(roundToGrid(4460.1267, GOLD), 4460.13);
});
