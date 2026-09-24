/**
 * P3-C — LIVE MT5 TRADE EVENT OVERLAY tests (pure, no chart/DOM, no network).
 * Runs with Node's type stripping:  npm --prefix frontend run test
 *
 * Tests the live lifecycle path:
 *   MT5 write → backend SSE → /ws {type:"trade"} frame → frontend refetch →
 *   buildTradeOverlays + reconcileTradeOverlays → TradeOverlayBridge/Primitive.
 *
 * The browser NEVER trusts the advisory frame payload — it refetches real rows
 * through the unchanged P2 REST chain. These tests verify the merge/reconcile
 * logic that turns refetched TradeRecord rows into a stable, deduplicated
 * overlay set for the LIVE case.
 *
 * Matrix:
 *   A.  live OPEN               B.  live UPDATE           C.  live CLOSE
 *   D.  duplicate OPEN          E.  duplicate UPDATE      F.  duplicate CLOSE
 *   G.  OPEN→UPDATE→CLOSE       H.  close immediately after open
 *   I.  missing-ticket key      J.  XAUUSD→GOLD
 *   K.  "GOLD" stock excluded   L.  unresolved DAX (DE40)
 *   M.  summer timestamp        N.  winter timestamp
 *   O.  SL update               P.  TP update
 *   Q.  reconnect/resync        R.  account isolation
 *   S.  historical + live       T.  P3-B rendering intact
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileTradeOverlays,
  buildTradeOverlays,
  normalizeMt5Symbol,
} from "../src/services/tradeOverlay.ts";
import { mt5ServerWallToBucketMs } from "../src/services/mt5Time.ts";

// ── helpers ───────────────────────────────────────────────────────────────────
const EPIC = "GOLD";
function makeOverlay(opts: Partial<TradeOverlay>): TradeOverlay {
  return {
    key: "t:111",
    mt5Symbol: "XAUUSD",
    epic: EPIC,
    resolved: true,
    direction: "Buy",
    entryBucketMs: Date.UTC(2026, 6, 31, 16, 42, 0),
    exitBucketMs: null,
    // Exact execution instants — defaults mirror a :21s entry, no exit yet.
    entryExactMs: Date.UTC(2026, 6, 31, 16, 42, 21),
    exitExactMs: null,
    entryPrice: 2400.0,
    exitPrice: null,
    sl: null,
    tp: null,
    lots: 0.1,
    pnl: null,
    rrr: "3.0",
    status: "open",
    ...opts,
  };
}
function row(overrides: Partial<TradeRecord>): TradeRecord {
  return {
    account_id: "11111111-1111-4111-8111-111111111111",
    ticket: 111,
    instrument: "XAUUSD",
    buy_sell: "Buy",
    lots: "0.10",
    price_open: "2400.00",
    price_close: null,
    sl: null,
    tp: null,
    risk_per_trade: null,
    rrr: "3.0",
    mfe: null,
    mae: null,
    time_open: "2026-07-31 19:42:21",
        time_close: null,
    pnl: null,
    ...overrides,
  };
}

// A. live OPEN — a new open trade appears after refetch, reconciled onto empty
test("A: live OPEN appears after refetch via reconcileTradeOverlays", () => {
  const existing: TradeOverlay[] = [];
  const next = [makeOverlay({ key: "t:111", status: "open", exitBucketMs: null })];
  const result = reconcileTradeOverlays(existing, next);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.status, "open");
  assert.equal(result[0]!.key, "t:111");
});

// B. live UPDATE — open trade gets a new SL; refetch produces same key, updated SL
test("B: live UPDATE merges by key (same overlay, updated SL)", () => {
  const existing = [makeOverlay({ key: "t:111", sl: null, status: "open" })];
  const next = [makeOverlay({ key: "t:111", sl: 2390.0, status: "open" })];
  const result = reconcileTradeOverlays(existing, next);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.sl, 2390.0);
  assert.equal(result[0]!.status, "open");
});

// C. live CLOSE — open trade becomes closed; refetch produces same key, with exit
test("C: live CLOSE sets exit geometry, status becomes closed", () => {
  const exitMs = Date.UTC(2026, 6, 31, 17, 10, 0);
  const existing = [makeOverlay({ key: "t:111", status: "open", exitBucketMs: null })];
  const next = [
    makeOverlay({ key: "t:111", status: "closed", exitBucketMs: exitMs, exitPrice: 2410.0, pnl: 100.0 }),
  ];
  const result = reconcileTradeOverlays(existing, next);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.status, "closed");
  assert.equal(result[0]!.exitBucketMs, exitMs);
  assert.equal(result[0]!.pnl, 100.0);
});

// D. duplicate OPEN — same key delivered twice collapses to one overlay
test("D: duplicate OPEN collapses to a single overlay", () => {
  const existing: TradeOverlay[] = [];
  const dup = makeOverlay({ key: "t:222" });
  const next = [dup, { ...dup }, { ...dup }];
  const result = reconcileTradeOverlays(existing, next);
  assert.equal(result.length, 1);
});

// E. duplicate UPDATE — repeated same-key updates stay single
test("E: duplicate UPDATE stays single (idempotent)", () => {
  const existing = [makeOverlay({ key: "t:333", sl: 2380 })];
  const upd = makeOverlay({ key: "t:333", sl: 2370 });
  const next = [upd, upd, upd];
  const result = reconcileTradeOverlays(existing, next);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.sl, 2370);
});

// F. duplicate CLOSE — repeated close events do not resurrect
test("F: duplicate CLOSE does not create extra overlays", () => {
  const existing = [
    makeOverlay({ key: "t:444", status: "closed", exitBucketMs: Date.UTC(2026, 6, 31, 17, 0, 0) }),
  ];
  const next = [makeOverlay({ key: "t:444", status: "closed" })];
  const result = reconcileTradeOverlays(existing, next);
  assert.equal(result.length, 1);
});


// G. OPEN -> UPDATE -> CLOSE lifecycle through successive reconciles
test("G: OPEN->UPDATE->CLOSE lifecycle through successive reconcileTradeOverlays", () => {
  let existing: TradeOverlay[] = [];
  existing = reconcileTradeOverlays(existing, [makeOverlay({ key: "t:555", status: "open" })]);
  assert.equal(existing.length, 1);
  assert.equal(existing[0].status, "open");
  existing = reconcileTradeOverlays(existing, [makeOverlay({ key: "t:555", status: "open", sl: 2390 })]);
  assert.equal(existing.length, 1);
  assert.equal(existing[0].sl, 2390);
  const exitMs = Date.UTC(2026, 6, 31, 17, 10, 0);
  existing = reconcileTradeOverlays(existing, [makeOverlay({ key: "t:555", status: "closed", exitBucketMs: exitMs, exitPrice: 2405, pnl: 45 })]);
  assert.equal(existing.length, 1);
  assert.equal(existing[0].status, "closed");
  assert.equal(existing[0].pnl, 45);
});

// H. close arrives immediately after open
test("H: close immediately after open resolves in one refetch", () => {
  const records = [row({ ticket: 999, status: "closed", time_open: "2026-07-31 19:42:21", time_close: "2026-07-31 19:42:45", price_open: "2400.00", price_close: "2401.00", pnl: "10.00" })];
  const next = buildTradeOverlays(records, 60);
  assert.equal(next.length, 1);
  assert.equal(next[0].status, "closed");
  assert.equal(next[0].entryBucketMs, Date.UTC(2026, 6, 31, 16, 42, 0));
  assert.equal(next[0].exitBucketMs, Date.UTC(2026, 6, 31, 16, 42, 0));
  assert.equal(next[0].exitPrice, 2401.0);
});

// I. missing ticket - composite key
test("I: missing-ticket rows use composite key", () => {
  const records = [row({ ticket: null })];
  const overlays = buildTradeOverlays(records, 60);
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].key, "t:2026-07-31 19:42:21|XAUUSD|2400.00|Buy");
  const reconciled = reconcileTradeOverlays(overlays, overlays);
  assert.equal(reconciled.length, 1);
});


// J. XAUUSD -> GOLD
test("J: XAUUSD maps exactly to AURA GOLD", () => {
  assert.deepEqual(normalizeMt5Symbol("XAUUSD"), { mt5Symbol: "XAUUSD", epic: "GOLD", resolved: true });
});

// K. GOLD stock excluded
test("K: MT5 GOLD (Barrick) NOT mapped", () => {
  assert.equal(normalizeMt5Symbol("GOLD").resolved, false);
});

// L. unresolved DAX
test("L: DE40 remains unresolved", () => {
  const n = normalizeMt5Symbol("DE40");
  assert.equal(n.resolved, false);
  assert.equal(n.epic, "DE40");
});

// M. summer
test("M: Europe/Helsinki summer (EEST UTC+3) bucket mapping", () => {
  assert.equal(mt5ServerWallToBucketMs("2026-07-31 19:42:21", 60), Date.UTC(2026, 6, 31, 16, 42, 0));
});

// N. winter
test("N: Europe/Helsinki winter (EET UTC+2) bucket mapping", () => {
  assert.equal(mt5ServerWallToBucketMs("2026-01-15 19:42:21", 60), Date.UTC(2026, 0, 15, 17, 42, 0));
});


// O. SL update
test("O: live SL update via refetch + reconcile", () => {
  const existing = [makeOverlay({ key: "t:777", sl: null })];
  const records = [row({ ticket: 777, sl: "2385.00", price_open: "2400.00", time_open: "2026-07-31 19:42:21" })];
  const next = buildTradeOverlays(records, 60);
  const result = reconcileTradeOverlays(existing, next);
  assert.equal(result.length, 1);
  assert.equal(result[0].sl, 2385);
});

// P. TP update
test("P: live TP update via refetch + reconcile", () => {
  const existing = [makeOverlay({ key: "t:888", tp: null })];
  const records = [row({ ticket: 888, tp: "2450.00", price_open: "2400.00", time_open: "2026-07-31 19:42:21" })];
  const next = buildTradeOverlays(records, 60);
  const result = reconcileTradeOverlays(existing, next);
  assert.equal(result.length, 1);
  assert.equal(result[0].tp, 2450);
});

// Q. reconnect/resync
test("Q: reconnect/resync restores full overlay set", () => {
  const before = [
    makeOverlay({ key: "t:1", entryBucketMs: Date.UTC(2026, 6, 31, 16, 0, 0) }),
    makeOverlay({ key: "t:2", entryBucketMs: Date.UTC(2026, 6, 31, 16, 1, 0) }),
  ];
  const after = [
    makeOverlay({ key: "t:1", status: "closed", exitBucketMs: Date.UTC(2026, 6, 31, 17, 0, 0), exitPrice: 2410, pnl: 90 }),
    makeOverlay({ key: "t:2", status: "open" }),
  ];
  const result = reconcileTradeOverlays(before, after);
  assert.equal(result.length, 2);
  assert(result.find((o) => o.key === "t:1"), "trade #1 survives");
  assert(result.find((o) => o.key === "t:2"), "trade #2 survives");
});

// R. account isolation
test("R: account isolation - different accounts produce separate overlays", () => {
  const records = [
    { ...row({ ticket: 100 }) },
    { ...row({ ticket: 200, account_id: "22222222-2222-4222-9222-222222222222" }) },
  ];
  const overlays = buildTradeOverlays(records, 60);
  assert.equal(overlays.length, 2);
  assert.notEqual(overlays[0].key, overlays[1].key);
});

// S. historical + live coexistence
test("S: historical closed trades coexist with live open trade", () => {
  const records = [
    { ...row({ ticket: 1 }), time_open: "2026-07-31 18:00:00", time_close: "2026-07-31 18:30:00", buy_sell: "Sell", price_open: "2410.00", price_close: "2405.00", pnl: "-50.00" },
    { ...row({ ticket: 2 }), time_open: "2026-07-31 19:42:21", time_close: null },
  ];
  const overlays = buildTradeOverlays(records, 60);
  assert.equal(overlays.length, 2);
  const closed = overlays.find((o) => o.key === "t:1");
  const openTrade = overlays.find((o) => o.key === "t:2");
  assert(closed && openTrade, "both overlays present");
  assert.equal(closed.status, "closed");
  assert.equal(closed.exitBucketMs, Date.UTC(2026, 6, 31, 15, 30, 0));
  assert.equal(openTrade.status, "open");
  assert.equal(openTrade.exitBucketMs, null);
});

// T. P3-B contract intact
test("T: P3-B overlay contract intact", () => {
  const records = [row({ ticket: 424242, instrument: "XAUUSD", buy_sell: "Buy", lots: "0.10", price_open: "2400.00", price_close: "2410.00", sl: "2390.00", tp: "2430.00", risk_per_trade: "10.00", rrr: "2.0", mfe: "15.00", mae: "-5.00", time_open: "2026-07-31 19:42:21", time_close: "2026-07-31 20:10:00", pnl: "100.00" })];
  const [o] = buildTradeOverlays(records, 60);
  assert(o);
  assert.equal(o.key, "t:424242");
  assert.equal(o.epic, "GOLD");
  assert.equal(o.resolved, true);
  assert.equal(o.direction, "Buy");
  assert.equal(o.status, "closed");
  assert.equal(o.pnl, 100);
});
