/**
 * Regression tests — FIX A (closed-live-ledger refresh bridge) + FIX B
 * (rollover-candidate guard), forensic report 2026-09-16 (GOLD MINUTE_3).
 *
 * A newly closed 3M candle lived ONLY in the in-memory `closedLiveBars` ledger
 * for ~60s (Capital authoritative MINUTE OHLC arrives ~60s late → the third 1M
 * constituent reaches PostgreSQL late → derived 3M history cannot contain the
 * bucket). A page refresh wiped the ledger, quote frames polluted the
 * rollover-tracking refs so the bucket was never re-captured, and the history
 * `setData` removed the candle until the authoritative frame arrived.
 *
 * The lifecycle test below reproduces the LIVE-CAPTURED production sequence
 * (read-only diagnostics, 2026-09-16):
 *
 *     08:21:00  3M bucket starts
 *     08:24:00  wall-clock close (quote stream rolls to 08:24)
 *     08:24:05  user refresh → ledger wiped → candle vanished
 *     08:25:00.236  authoritative `phase:"closed"` frame + PG persistence
 *     08:25:01  /api/candles/db first contains the 08:21 bucket
 *
 * All functions under test are the REAL production implementations —
 * closedLedgerBridge.ts, liveCandle.pruneClosedLiveBars (unmodified) and
 * pineSeries.mergeBridgeBars (unmodified). Pure modules only — no chart/DOM.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOSED_LEDGER_MAX_AGE_MS,
  bridgeClosedLiveLedger,
  closedLedgerStorageKey,
  defaultBridgeStorage,
  loadClosedLiveLedger,
  nextRolloverCandidate,
  parseClosedLiveLedger,
  saveClosedLiveLedger,
  serializeClosedLiveLedger,
} from "../src/services/closedLedgerBridge.ts";
import { pruneClosedLiveBars } from "../src/services/liveCandle.ts";
import { mergeBridgeBars } from "../src/services/pineSeries.ts";

// ── Forensic fixtures (exact values from the production capture) ─────────────
const MIN = 60_000;
const T0821 = Date.UTC(2026, 8, 16, 8, 21, 0); // bucket start (epoch ms)
const T0824 = Date.UTC(2026, 8, 16, 8, 24, 0); // wall-clock 3M close
const SEC = (iso) => Math.floor(iso / 1000);   // wire frames carry epoch SECONDS

/** The just-closed 08:21 3M candle as the capture effect recorded it at the
 *  quote rollover (from the seeded authoritative forming-ohlc snapshot). */
const PROVISIONAL_0821 = {
  ts: T0821,
  open: 4333,
  high: 4337.88,
  low: 4332.72,
  close: 4336.8,
  savedAt: T0824 + 300,
};
/** The authoritative `phase:"closed"` frame delivered at 08:25:00.236. */
const AUTH_CLOSED_0821 = {
  time: SEC(T0821),
  open: 4333,
  high: 4337.88,
  low: 4332.72,
  close: 4334.67, // ← differs from the provisional close: the truth won
};
/** WS seed replay: the aggregator's last CLOSED candle (08:18) at reconnect. */
const SEED_CLOSED_0818 = {
  time: SEC(Date.UTC(2026, 8, 16, 8, 18, 0)),
  open: 4331.82,
  high: 4335.32,
  low: 4329.89,
  close: 4332.98,
};
/** Quote stream already forming the NEXT bucket (08:24) at refresh time. */
const QUOTE_0824 = {
  time: SEC(T0824),
  open: 4334.76,
  high: 4335.73,
  low: 4334.74,
  close: 4334.85,
  source: "quote", // the backend tags quote frames explicitly
  phase: "forming",
};
/** Seed authoritative forming-ohlc frame (the 08:21 bucket, mid-delivery). */
const SEED_FORMING_0821 = {
  time: SEC(T0821),
  open: 4333,
  high: 4337.88,
  low: 4332.72,
  close: 4336.8,
  source: "ohlc",
  phase: "forming",
};
/** /api/candles/db history as captured at 08:24:05 — the 08:21 bucket ABSENT. */
const HISTORY_WITHOUT_0821 = [
  { ts: Date.UTC(2026, 8, 16, 8, 9), open: 4325.15, high: 4325.76, low: 4324.11, close: 4325.12 },
  { ts: Date.UTC(2026, 8, 16, 8, 12), open: 4325.91, high: 4326.52, low: 4324.97, close: 4325.21 },
  { ts: Date.UTC(2026, 8, 16, 8, 15), open: 4326.07, high: 4326.24, low: 4324.08, close: 4325.1 },
  { ts: Date.UTC(2026, 8, 16, 8, 18), open: 4331.82, high: 4335.32, low: 4329.89, close: 4332.98 },
];
/** /api/candles/db history as captured at 08:25:01 — 08:21 PRESENT (final). */
const HISTORY_WITH_0821 = [
  ...HISTORY_WITHOUT_0821,
  { ts: T0821, open: 4333, high: 4337.88, low: 4332.72, close: 4334.67 },
];

/** Deterministic in-memory sessionStorage double (never touches the DOM). */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    _map: map,
  };
}

const KEY = closedLedgerStorageKey("GOLD", 180);

// ── FIX A: serialization / restore / safety ──────────────────────────────────

test("FIX A 1: closed-live ledger serializes correctly (fields + savedAt preserved + empty → '')", () => {
  const now = T0824 + 5_000;
  const withoutStamp = { ts: T0821 - 3 * MIN, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7 };
  const parsed = JSON.parse(serializeClosedLiveLedger([{ ...PROVISIONAL_0821 }, withoutStamp], now));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].ts, T0821);
  assert.equal(parsed[0].open, 4333);
  assert.equal(parsed[0].high, 4337.88);
  assert.equal(parsed[0].low, 4332.72);
  assert.equal(parsed[0].close, 4336.8);
  // savedAt is stamped only when missing — the age cap survives refreshes.
  assert.equal(parsed[0].savedAt, T0824 + 300);
  assert.equal(parsed[1].savedAt, now);
  assert.equal(parsed[1].volume, 7);
  // Empty ledger serializes to "" → callers remove the storage key.
  assert.equal(serializeClosedLiveLedger([], now), "");
});

test("FIX A 2: a valid recent entry restores (round-trip through real storage)", () => {
  const store = memoryStorage();
  const now = T0824 + 6_000;
  saveClosedLiveLedger(store, KEY, [PROVISIONAL_0821], now);
  const restored = loadClosedLiveLedger(store, KEY, now);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].ts, T0821);
  assert.equal(restored[0].close, 4336.8);
  assert.equal(restored[0].savedAt, T0824 + 300);
});

test("FIX A 3: entries older than the 15-minute cap are rejected (boundary kept)", () => {
  const now = T0824 + 60_000;
  const fresh = { ts: T0821, open: 1, high: 2, low: 0.5, close: 1.5, savedAt: now - CLOSED_LEDGER_MAX_AGE_MS };
  const stale = { ts: T0821 - 3 * MIN, open: 1, high: 2, low: 0.5, close: 1.5, savedAt: now - CLOSED_LEDGER_MAX_AGE_MS - 1 };
  const kept = parseClosedLiveLedger(JSON.stringify([stale, fresh]), now);
  assert.deepEqual(kept.map((b) => b.savedAt), [fresh.savedAt]); // only the boundary entry survives
});

test("FIX A 4: malformed payloads/entries are ignored safely (valid siblings survive)", () => {
  const now = T0824;
  assert.deepEqual(parseClosedLiveLedger("not json at all", now), []);
  assert.deepEqual(parseClosedLiveLedger("{\"ts\":1}", now), []);          // not an array
  assert.deepEqual(parseClosedLiveLedger("null", now), []);
  assert.deepEqual(parseClosedLiveLedger(undefined, now), []);
  const messy = JSON.stringify([
    null,
    42,
    "candle",
    [],
    {},
    { ts: "x", open: 1, high: 2, low: 0.5, close: 1.5, savedAt: now },     // non-numeric ts
    { ts: T0821, open: NaN, high: 2, low: 0.5, close: 1.5, savedAt: now }, // NaN OHLC
    { ts: T0821, open: 1, high: 2, low: 0.5, close: 1.5, savedAt: "now" }, // invalid savedAt
    { ts: T0821, open: 1, high: 2, low: 0.5, close: 1.5, volume: "lots", savedAt: now }, // bad volume
    { ts: T0821, open: 1, high: 2, low: 0.5, close: 1.5, savedAt: now },   // ✓ valid
  ]);
  const out = parseClosedLiveLedger(messy, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].ts, T0821);
});

test("FIX A 5: storage failures are harmless (throwing storage, null storage)", () => {
  const now = T0824;
  const throwing = {
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => { throw new Error("SecurityError"); },
  };
  assert.doesNotThrow(() => saveClosedLiveLedger(throwing, KEY, [PROVISIONAL_0821], now));
  assert.deepEqual(loadClosedLiveLedger(throwing, KEY, now), []);
  // A partially-broken storage (read ok, parse garbage) yields [].
  const broken = memoryStorage({ [KEY]: "{{{" });
  assert.deepEqual(loadClosedLiveLedger(broken, KEY, now), []);
  // Missing/unavailable storage (SSR, blocked) is a no-op on both paths.
  assert.doesNotThrow(() => saveClosedLiveLedger(null, KEY, [PROVISIONAL_0821], now));
  assert.deepEqual(loadClosedLiveLedger(null, KEY, now), []);
  // defaultBridgeStorage() itself must never throw even without a DOM.
  assert.doesNotThrow(() => defaultBridgeStorage());
});

test("FIX A 6: scope isolation — instruments/timeframes never share bridge entries", () => {
  const store = memoryStorage();
  const now = T0824;
  saveClosedLiveLedger(store, closedLedgerStorageKey("GOLD", 180), [PROVISIONAL_0821], now);
  saveClosedLiveLedger(store, closedLedgerStorageKey("GOLD", 60), [{ ts: T0821, open: 9, high: 9, low: 9, close: 9, savedAt: now }], now);
  saveClosedLiveLedger(store, closedLedgerStorageKey("IX.D.DAX.IGM.IP", 180), [{ ts: T0821, open: 8, high: 8, low: 8, close: 8, savedAt: now }], now);
  const gold3m = loadClosedLiveLedger(store, closedLedgerStorageKey("GOLD", 180), now);
  assert.equal(gold3m.length, 1);
  assert.equal(gold3m[0].close, 4336.8); // the GOLD 3M entry, and only it
  assert.equal(loadClosedLiveLedger(store, closedLedgerStorageKey("GOLD", 60), now)[0].open, 9);
  assert.equal(loadClosedLiveLedger(store, closedLedgerStorageKey("IX.D.DAX.IGM.IP", 180), now)[0].open, 8);
  assert.deepEqual(loadClosedLiveLedger(store, closedLedgerStorageKey("SILVER", 180), now), []);
  assert.notEqual(closedLedgerStorageKey("GOLD", 180), closedLedgerStorageKey("GOLD", 60));
});

// ── FIX A × existing prune/merge rules (REAL liveCandle + pineSeries code) ──

test("FIX A 7: restored ledger SURVIVES a history load that does NOT contain the bucket", () => {
  const store = memoryStorage();
  const now = T0824 + 6_000; // refresh at 08:24:06
  saveClosedLiveLedger(store, KEY, [PROVISIONAL_0821], now);
  let ledger = loadClosedLiveLedger(store, KEY, now); // scope-effect restore
  assert.equal(ledger.length, 1);
  // loadHistory resolves at 08:24:05 with the captured history (08:21 ABSENT).
  ledger = pruneClosedLiveBars(ledger, HISTORY_WITHOUT_0821, 180);
  assert.equal(ledger.length, 1, "the just-closed bucket must be retained");
  assert.equal(ledger[0].ts, T0821);
  // …and the merged chart data carries it → the candle stays VISIBLE.
  const view = bridgeClosedLiveLedger([SEED_CLOSED_0818], ledger, 180);
  const data = mergeBridgeBars(HISTORY_WITHOUT_0821, view, null, 180);
  const bars0821 = data.filter((b) => b.ts === T0821);
  assert.equal(bars0821.length, 1, "exactly one 08:21 bar — no disappearance");
  assert.equal(bars0821[0].close, 4336.8);
});

test("FIX A 8: restored ledger is PRUNED once history contains the bucket (+ storage cleaned)", () => {
  const store = memoryStorage();
  const now = T0824 + 6_000;
  saveClosedLiveLedger(store, KEY, [PROVISIONAL_0821], now);
  let ledger = loadClosedLiveLedger(store, KEY, now);
  // History reload at 08:25:01 now carries 08:21 (persisted truth wins).
  ledger = pruneClosedLiveBars(ledger, HISTORY_WITH_0821, 180);
  assert.equal(ledger.filter((b) => b.ts === T0821).length, 0, "ledger copy pruned");
  // Saving the pruned (empty) ledger REMOVES the storage key — cleaned.
  saveClosedLiveLedger(store, KEY, ledger, now);
  assert.equal(store.getItem(KEY), null);
  assert.deepEqual(loadClosedLiveLedger(store, KEY, now), []);
  // The chart still shows exactly one 08:21 bar — from HISTORY now.
  const data = mergeBridgeBars(HISTORY_WITH_0821, bridgeClosedLiveLedger([], ledger, 180), null, 180);
  const bars0821 = data.filter((b) => b.ts === T0821);
  assert.equal(bars0821.length, 1);
  assert.equal(bars0821[0].close, 4334.67); // authoritative value
});

test("FIX A 9: authoritative phase:'closed' frame REPLACES the restored provisional entry", () => {
  const restored = [{ ...PROVISIONAL_0821 }];
  // In-session ledger merge: the closed-ohlc frame wins same-bucket, and the
  // provisional copy is filtered out — one entry, authoritative values.
  const view = bridgeClosedLiveLedger([SEED_CLOSED_0818, AUTH_CLOSED_0821], restored, 180);
  const at0821 = view.filter((b) => b.ts === T0821);
  assert.equal(at0821.length, 1, "no duplicate bucket after authority replaces provisional");
  assert.equal(at0821[0].close, 4334.67);
  assert.equal(at0821[0].open, 4333);
  assert.equal(at0821[0].high, 4337.88);
  assert.equal(at0821[0].low, 4332.72);
  // Provisional entries for buckets the authority has not reached stay.
  assert.ok(view.some((b) => b.ts === SEC(Date.UTC(2026, 8, 16, 8, 18, 0)) * 1000));
  // Ascending order preserved.
  for (let i = 1; i < view.length; i++) assert.ok(view[i - 1].ts < view[i].ts);
});

// ── FIX B: quote frames must not destroy the rollover candidate ──────────────

test("FIX B 10: quote frames do NOT overwrite the seeded authoritative rollover candidate", () => {
  // Seed forming-ohlc 08:21 → the candidate.
  let c = nextRolloverCandidate(null, null, SEED_FORMING_0821);
  assert.equal(c.ts, SEC(T0821));
  assert.equal(c.bar.source, "ohlc");
  // Quote storm for 08:24 — the candidate MUST survive every one of them.
  for (let i = 0; i < 50; i++) {
    c = nextRolloverCandidate(c.ts, c.bar, { ...QUOTE_0824, close: QUOTE_0824.close - i * 0.01 });
    assert.equal(c.ts, SEC(T0821), "quote frame kept its hands off the candidate");
    assert.equal(c.bar.source, "ohlc");
  }
  // History loads → capture effect sees prevTs=08:21 vs liveCandle=08:24
  // → the 08:21→08:24 rollover IS detected and 08:21 is re-capturable.
  assert.ok(QUOTE_0824.time > c.ts, "rollover detectable after the quote storm");
});

test("FIX B 10b: candidate rules — quote continuity, authoritative refresh, no rewind, reset", () => {
  // Pure-quote stream (no authoritative frame yet): continuity still works.
  let c = nextRolloverCandidate(null, null, QUOTE_0824);
  assert.equal(c.ts, SEC(T0824));
  const newerQuote = { ...QUOTE_0824, time: SEC(T0824) + 180 };
  c = nextRolloverCandidate(c.ts, c.bar, newerQuote);
  assert.equal(c.ts, SEC(T0824) + 180);
  // Authoritative frames always adopt (fresher same-bucket snapshot).
  const authSame = { ...SEED_FORMING_0821, time: SEC(T0824) + 180, close: 4337.0 }; // same bucket as candidate
  c = nextRolloverCandidate(c.ts, c.bar, authSame);
  assert.equal(c.bar.source, "ohlc");
  assert.equal(c.bar.close, 4337.0);
  // Out-of-order (backward) frames never move the candidate backward.
  const backward = { ...SEED_FORMING_0821, time: SEC(T0821) };
  c = nextRolloverCandidate(c.ts, c.bar, backward);
  assert.equal(c.ts, SEC(T0824) + 180);
  c = nextRolloverCandidate(c.ts, c.bar, { ...QUOTE_0824, time: SEC(T0821) }); // backward quote
  assert.equal(c.ts, SEC(T0824) + 180);
  // Null frame (stream reset) resets exactly as before.
  c = nextRolloverCandidate(c.ts, c.bar, null);
  assert.deepEqual(c, { ts: null, bar: null });
  // A quote frame with NO candidate still adopts (never loses quote capture).
  c = nextRolloverCandidate(null, null, QUOTE_0824);
  assert.equal(c.ts, SEC(T0824));
});

// ── THE FORENSIC LIFECYCLE: 08:21 bucket stays continuously represented ──────

test("FIX A 11+12: 08:21 3M candle remains visible across the 08:24:05 refresh until history catches up — no duplicates", () => {
  const store = memoryStorage();
  // 08:24:00.3 — quote rollover: capture effect commits the just-closed bucket
  // (the seeded authoritative partial OHLC; the FIX B guard keeps the candidate
  // alive against the quote storm, so this capture fires pre-refresh too).
  const captured = [{ ...PROVISIONAL_0821 }];
  // 08:24:05 — REFRESH. The save effect mirrors the ledger, then everything
  // in-memory resets (new session).
  saveClosedLiveLedger(store, KEY, captured, T0824 + 5_000);
  let ledger = [];
  // 08:24:06 — boot: scope adoption restores the bridge BEFORE history lands.
  ledger = loadClosedLiveLedger(store, KEY, T0824 + 6_000);
  assert.equal(ledger.filter((b) => b.ts === T0821).length, 1);
  // 08:24:07 — history resolves WITHOUT 08:21 → prune keeps it → VISIBLE.
  ledger = pruneClosedLiveBars(ledger, HISTORY_WITHOUT_0821, 180);
  let view = bridgeClosedLiveLedger([SEED_CLOSED_0818], ledger, 180);
  let data = mergeBridgeBars(HISTORY_WITHOUT_0821, view, null, 180);
  assert.equal(data.filter((b) => b.ts === T0821).length, 1, "visible at 08:24:07");
  // 08:24:30 — a second refresh mid-window: the bridge still carries the bar
  // (savedAt preserved → age cap anchored at first capture, not re-stamped).
  saveClosedLiveLedger(store, KEY, ledger, T0824 + 30_000);
  ledger = pruneClosedLiveBars(loadClosedLiveLedger(store, KEY, T0824 + 31_000), HISTORY_WITHOUT_0821, 180);
  assert.equal(ledger.filter((b) => b.ts === T0821).length, 1, "survives repeated refreshes");
  assert.equal(ledger[0].savedAt, T0824 + 300, "savedAt not re-stamped by later saves");
  // 08:25:00.236 — authoritative Capital OHLC arrives: phase:"closed" replaces
  // the provisional values through the EXISTING authority rules.
  view = bridgeClosedLiveLedger([SEED_CLOSED_0818, AUTH_CLOSED_0821], ledger, 180);
  data = mergeBridgeBars(HISTORY_WITHOUT_0821, view, null, 180);
  const authoritative = data.filter((b) => b.ts === T0821);
  assert.equal(authoritative.length, 1);
  assert.equal(authoritative[0].close, 4334.67, "the truth won — still exactly one bar");
  // 08:25:01 — /api/candles/db now contains 08:21: prune drops the ledger copy
  // and the chart shows the HISTORY bar — still exactly one, still visible.
  ledger = pruneClosedLiveBars(ledger, HISTORY_WITH_0821, 180);
  data = mergeBridgeBars(HISTORY_WITH_0821, bridgeClosedLiveLedger([AUTH_CLOSED_0821], ledger, 180), null, 180);
  const final0821 = data.filter((b) => b.ts === T0821);
  assert.equal(final0821.length, 1, "NO duplicate after history catches up");
  assert.equal(final0821[0].close, 4334.67);
  // Storage cleaned (requirement 11): the pruned ledger saves as empty → key removed.
  saveClosedLiveLedger(store, KEY, ledger, T0824 + 61_000);
  assert.equal(store.getItem(KEY), null);
  // Continuity ledger: at every observed instant the chart data contained
  // exactly one 08:21 bar — the candle never disappeared.
});
