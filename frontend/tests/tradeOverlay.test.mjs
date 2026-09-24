/**
 * P3-B — MT5 trade overlay mapping tests (pure, no chart/DOM).
 * Runs with Node's type stripping:  npm --prefix frontend run test
 *
 * Covers the P3-B test matrix:
 *   A. Europe/Helsinki SUMMER conversion (EEST = UTC+3)
 *   B. Europe/Helsinki WINTER conversion (EET  = UTC+2)
 *   C. 1m bucket mapping          D. 3m bucket mapping
 *   E. entry/exit independent mapping
 *   F. XAUUSD → GOLD              G. "GOLD" (Barrick stock) NOT mapped
 *   H. unresolved DAX symbol (DE40) behavior
 *   I. open trade behavior        J. missing exit time
 *   K. missing SL/TP              L. trades sharing the same candle
 *   (M — existing P2 auth/proxy behavior — is covered by the untouched
 *    p2AuthTrading.test.mjs / backend tradingProxy.test.ts suites.)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  mt5ServerWallToUtcMs,
  mt5ServerWallToBucketMs,
  parseMt5WallClock,
} from "../src/services/mt5Time.ts";
import {
  buildTradeOverlays,
  formingBucketToMs,
  normalizeMt5Symbol,
} from "../src/services/tradeOverlay.ts";

// ── A/B: Europe/Helsinki per-timestamp DST conversion ─────────────────────────
test("A: summer timestamp resolves through EEST (UTC+3), not naive UTC", () => {
  // 2026-07-31 19:42:21 server wall clock = 16:42:21 UTC in EEST.
  const utcMs = mt5ServerWallToUtcMs("2026-07-31 19:42:21");
  assert.equal(utcMs, Date.UTC(2026, 6, 31, 16, 42, 21));
});

test("B: winter timestamp resolves through EET (UTC+2)", () => {
  // 2026-01-15 19:42:21 server wall clock = 17:42:21 UTC in EET.
  const utcMs = mt5ServerWallToUtcMs("2026-01-15 19:42:21");
  assert.equal(utcMs, Date.UTC(2026, 0, 15, 17, 42, 21));
});

test("offset is resolved per timestamp — nothing hard-coded", () => {
  // Compare the RESOLVED OFFSET directly: (wall clock as UTC) − (resolved instant).
  // Summer must resolve through EEST (+3h), winter through EET (+2h).
  const summerOffset =
    Date.UTC(2026, 6, 1, 12, 0, 0) - mt5ServerWallToUtcMs("2026-07-01 12:00:00");
  const winterOffset =
    Date.UTC(2026, 0, 1, 12, 0, 0) - mt5ServerWallToUtcMs("2026-01-01 12:00:00");
  assert.equal(summerOffset, 3 * 60 * 60 * 1000);
  assert.equal(winterOffset, 2 * 60 * 60 * 1000);
});

test("unparsable timestamps resolve to null (never 'now'/0)", () => {
  assert.equal(mt5ServerWallToUtcMs(null), null);
  assert.equal(mt5ServerWallToUtcMs(""), null);
  assert.equal(mt5ServerWallToUtcMs("garbage"), null);
  assert.equal(parseMt5WallClock("1969-01-01 00:00:00"), null);
});

// ── C/D: bucket alignment ─────────────────────────────────────────────────────
test("C: 1m bucket floors to the minute", () => {
  // 16:42:21 UTC → 16:42:00 bucket.
  const bucket = mt5ServerWallToBucketMs("2026-07-31 19:42:21", 60);
  assert.equal(bucket, Date.UTC(2026, 6, 31, 16, 42, 0));
});

test("D: 3m bucket uses the authoritative 180s grid (not re-aggregated)", () => {
  // 16:42:21 UTC → 16:42 belongs to the 16:42 (42 = 14*3) 3m slot.
  assert.equal(
    mt5ServerWallToBucketMs("2026-07-31 19:42:21", 180),
    Date.UTC(2026, 6, 31, 16, 42, 0),
  );
  // 16:44:59 → floor(44/3)=14 → 16:42 slot (3m grid is a multiple of 1m).
  assert.equal(
    mt5ServerWallToBucketMs("2026-07-31 19:44:59", 180),
    Date.UTC(2026, 6, 31, 16, 42, 0),
  );
  // 16:45:00 → 16:45 slot (15*3).
  assert.equal(
    mt5ServerWallToBucketMs("2026-07-31 19:45:00", 180),
    Date.UTC(2026, 6, 31, 16, 45, 0),
  );
});

// ── Symbol normalization (F/G/H) ──────────────────────────────────────────────
test("F: XAUUSD maps exactly to AURA GOLD", () => {
  const n = normalizeMt5Symbol("XAUUSD");
  assert.deepEqual(n, { mt5Symbol: "XAUUSD", epic: "GOLD", resolved: true });
});

test("G: 'GOLD' (Nasdaq Barrick stock) is NEVER mapped to AURA GOLD", () => {
  const n = normalizeMt5Symbol("GOLD");
  assert.equal(n.resolved, false); // raw preserved — unresolved ⇒ never renders
  // A loose-substring/suffixed symbol must NOT resolve either.
  assert.equal(normalizeMt5Symbol("XAUUSD_R").resolved, false);
  assert.equal(normalizeMt5Symbol("GOLDmicro").resolved, false);
});

test("H: unresolved DAX symbol (DE40) preserves the raw symbol unresolved", () => {
  const n = normalizeMt5Symbol("DE40");
  assert.equal(n.resolved, false); // candidate only — never silently mapped
  assert.equal(n.mt5Symbol, "DE40");
  assert.equal(n.epic, "DE40");
});

// ── Overlay mapping (E/I/J/K/L) ───────────────────────────────────────────────
function row(overrides) {
  return {
    account_id: "11111111-1111-4111-8111-111111111111",
    ticket: null,
    instrument: "XAUUSD",
    buy_sell: "Buy",
    lots: "0.10",
    price_open: "2400.00",
    price_close: null,
    sl: null,
    tp: null,
    risk_per_trade: null,
    rrr: null,
    mfe: null,
    mae: null,
    time_open: "2026-07-31 19:42:21",
    time_close: "2026-07-31 20:10:00",
    pnl: null,
    status: "closed",
    ...overrides,
  };
}

test("E: entry and exit map independently to their own candles", () => {
  const [overlay] = buildTradeOverlays(
    [row({ time_open: "2026-07-31 19:42:21", time_close: "2026-07-31 20:10:00" })],
    60,
  );
  assert.equal(overlay.entryBucketMs, Date.UTC(2026, 6, 31, 16, 42, 0));
  assert.equal(overlay.exitBucketMs, Date.UTC(2026, 6, 31, 17, 10, 0));
});

test("I: open trade — exitBucket null, status open, direction preserved", () => {
  const [overlay] = buildTradeOverlays(
    [row({ time_close: null, status: "open", buy_sell: "Sell" })],
    60,
  );
  assert.equal(overlay.status, "open");
  assert.equal(overlay.exitBucketMs, null);
  assert.equal(overlay.direction, "Sell");
});

test("J: closed row with missing exit time degrades to open status", () => {
  const [overlay] = buildTradeOverlays([row({ time_close: null, status: "closed" })], 60);
  assert.equal(overlay.status, "open");
});

test("K: missing SL/TP stay null (never invented), present values parse", () => {
  const [missing] = buildTradeOverlays([row({ sl: null, tp: null })], 60);
  assert.equal(missing.sl, null);
  assert.equal(missing.tp, null);
  const [present] = buildTradeOverlays(
    [row({ sl: "2390.50", tp: "2430.00", pnl: "-12.34" })],
    60,
  );
  assert.equal(present.sl, 2390.5);
  assert.equal(present.tp, 2430.0);
  assert.equal(present.pnl, -12.34); // string → number (P3-B whitelist column)
});

test("L: two trades sharing one candle remain separate overlay events", () => {
  const overlays = buildTradeOverlays(
    [
      row({ ticket: 111, time_open: "2026-07-31 19:42:21", buy_sell: "Buy" }),
      row({ ticket: 222, time_open: "2026-07-31 19:42:50", buy_sell: "Sell" }),
    ],
    180, // even the same 3m slot must not collapse them
  );
  assert.equal(overlays.length, 2);
  assert.equal(overlays[0].entryBucketMs, overlays[1].entryBucketMs);
  assert.equal(overlays[0].key, "t:111");
  assert.equal(overlays[1].key, "t:222");
  assert.notEqual(overlays[0].direction, overlays[1].direction);
});

test("ticketless rows use a composite key — tickets are never invented", () => {
  const [overlay] = buildTradeOverlays([row({ ticket: null })], 60);
  assert.equal(overlay.key, "t:2026-07-31 19:42:21|XAUUSD|2400.00|Buy");
});

test("rows with unparsable entry times are skipped (unmappable)", () => {
  const overlays = buildTradeOverlays([row({ time_open: "garbage" })], 60);
  assert.equal(overlays.length, 0);
});

test("formingBucketToMs normalizes seconds and ms", () => {
  assert.equal(formingBucketToMs(1785506520), 1785506520000);
  assert.equal(formingBucketToMs(1785506520000), 1785506520000);
  assert.equal(formingBucketToMs(null), null);
  assert.equal(formingBucketToMs(undefined), null);
});

// ── Post-P3-D positioning fix: exact ms preservation + price authority ────────
// References are the AUDIT'S verification trades (P3D_TRADE_TIME_POSITIONING_
// AUDIT.md §2) — verification data only, never production constants.

test("exact entry timestamp is preserved (seconds survive; bucket still floors)", () => {
  // DB digits (naive Helsinki wall clock) — the OID-1114-fixed API shape.
  const [overlay] = buildTradeOverlays(
    [row({ time_open: "2026-09-23 15:10:55", time_close: "2026-09-23 15:13:07" })],
    60,
  );
  // 15:10:55 EEST (UTC+3) → 12:10:55Z exactly — NOT floored to 12:10:00.
  assert.equal(overlay.entryExactMs, Date.UTC(2026, 8, 23, 12, 10, 55));
  assert.equal(overlay.entryBucketMs, Date.UTC(2026, 8, 23, 12, 10, 0));
  // Entry keeps :55 while the bucket floors to :00 — both fields coexist.
  assert.equal(overlay.entryExactMs - overlay.entryBucketMs, 55_000);
});

test("exact exit timestamp is preserved independently of entry", () => {
  const [overlay] = buildTradeOverlays(
    [row({ time_open: "2026-09-23 13:33:56", time_close: "2026-09-23 13:35:47" })],
    60,
  );
  // 13:33:56 EEST → 10:33:56Z; 13:35:47 EEST → 10:35:47Z.
  assert.equal(overlay.entryExactMs, Date.UTC(2026, 8, 23, 10, 33, 56));
  assert.equal(overlay.exitExactMs, Date.UTC(2026, 8, 23, 10, 35, 47));
  assert.equal(overlay.exitBucketMs, Date.UTC(2026, 8, 23, 10, 35, 0));
  assert.equal((overlay.exitExactMs ?? 0) - (overlay.exitBucketMs ?? 0), 47_000);
});

test("bucket fields remain available alongside exact fields (both grids)", () => {
  const r = [row({ time_open: "2026-09-23 15:10:55", time_close: "2026-09-23 15:13:07" })];
  const [m1] = buildTradeOverlays(r, 60);
  const [m3] = buildTradeOverlays(r, 180);
  // 1m grid: 12:10 bucket. 3m grid: floor(12:10:55 → 180s) = 12:09 bucket.
  assert.equal(m1.entryBucketMs, Date.UTC(2026, 8, 23, 12, 10, 0));
  assert.equal(m3.entryBucketMs, Date.UTC(2026, 8, 23, 12, 9, 0));
  // Exact ms is timeframe-INDEPENDENT — bucket choice never touches it.
  assert.equal(m1.entryExactMs, m3.entryExactMs);
  assert.equal(m1.entryExactMs, Date.UTC(2026, 8, 23, 12, 10, 55));
  assert.notEqual(m1.entryBucketMs, m3.entryBucketMs);
});

test("open trade: exitExactMs null ⇔ exitBucketMs null (status stays open)", () => {
  const [open] = buildTradeOverlays([row({ time_close: null, status: "open" })], 60);
  assert.equal(open.exitBucketMs, null);
  assert.equal(open.exitExactMs, null);
  assert.equal(open.status, "open");
  assert.ok(Number.isFinite(open.entryExactMs)); // entry exact still present
});

test("price remains the raw execution price — never an OHLC substitute", () => {
  const [overlay] = buildTradeOverlays(
    [row({ price_open: "4315.11", price_close: "4317.08" })],
    60,
  );
  assert.equal(overlay.entryPrice, 4315.11);
  assert.equal(overlay.exitPrice, 4317.08);
});

test("8h reference: DB digits 15:10:55 → 12:10:55Z (post OID-1114 contract)", () => {
  // The API now returns the NAIVE digits (pool.js OID-1114 identity parser);
  // mt5Time re-reads them as Helsinki. The old false-Z string
  // "2026-09-23T07:10:55.000Z" produced 04:10:55Z — exactly 28 800s early.
  const fixed = mt5ServerWallToUtcMs("2026-09-23 15:10:55");
  const broken = mt5ServerWallToUtcMs("2026-09-23T07:10:55.000Z"); // old API shape
  assert.equal(fixed, Date.UTC(2026, 8, 23, 12, 10, 55));
  assert.equal((fixed ?? 0) - (broken ?? 0), 28_800_000); // the uniform 8h displacement, gone
});

test("DAX40 remains unresolved (never mapped to DAX)", () => {
  const n = normalizeMt5Symbol("DAX40");
  assert.equal(n.resolved, false);
  assert.equal(n.epic, "DAX40");
  assert.equal(n.mt5Symbol, "DAX40");
});
