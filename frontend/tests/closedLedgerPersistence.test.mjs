/**
 * Regression tests for the 2026-09 live-chart fixes:
 *
 *   FIX 1B — 3M same-bucket close regression guard (mergeSameBucket): a
 *   lagging `forming-ohlc` snapshot must never snap the forming close
 *   backwards over a newer `forming-quote` close in the same bucket.
 *
 *   FIX 2  — closed-live-ledger persistence across history reloads
 *   (pruneClosedLiveBars): a history reload must PRUNE the ledger (persisted
 *   truth wins) but never WIPE it — live-closed buckets the backend has not
 *   persisted yet must survive.
 *
 *   FIX 2B — gap suppression for ledger-covered buckets (resolveGapBands
 *   Rule E): a gap interval whose bucket the authoritative bar set carries is
 *   not rendered.
 *
 * Pure modules only — no chart/DOM imports.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { mergeSameBucket, pruneClosedLiveBars } from "../src/services/liveCandle.ts";
import { resolveGapBands } from "../src/services/gapRegions.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 15, 10, 0); // 10:00 UTC

// ── FIX 1B: 3M same-bucket regression guard ──────────────────────────────────

test("FIX 1B: lagging forming-ohlc close does NOT regress a newer forming-quote close", () => {
  // Quote stream already carried 102.30; the OHLC aggregation snapshot (older
  // cycle) arrives later with 101.80 — the forming close must stay 102.30.
  const truth = {
    ts: T0,
    open: 101.5,
    high: 102.4,
    low: 101.2,
    close: 102.3,
    closeAuth: "forming-quote",
  };
  const laggingOhlc = {
    ts: T0,
    open: 101.5,
    high: 102.1,
    low: 101.2,
    close: 101.8,
    closeAuth: "forming-ohlc",
  };
  const merged = mergeSameBucket(truth, laggingOhlc);
  assert.equal(merged.close, 102.3, "quote close held against lagging ohlc");
  assert.equal(merged.closeAuth, "forming-quote");
  // OHLC envelope still widens (high/low are never regressed by the guard).
  assert.equal(merged.high, 102.4);
  assert.equal(merged.low, 101.2);
});

test("FIX 1B: forming-ohlc close MOVING UP is adopted (confirmation, not regression)", () => {
  const truth = {
    ts: T0,
    open: 101.5,
    high: 101.9,
    low: 101.2,
    close: 101.9,
    closeAuth: "forming-quote",
  };
  const newerOhlc = {
    ts: T0,
    open: 101.5,
    high: 102.2,
    low: 101.2,
    close: 102.1,
    closeAuth: "forming-ohlc",
  };
  const merged = mergeSameBucket(truth, newerOhlc);
  assert.equal(merged.close, 102.1, "upward higher-authority close adopted");
  assert.equal(merged.closeAuth, "forming-ohlc");
});

test("FIX 1B: same/lower rank frames stay last-write-wins (quote may extend in either direction)", () => {
  const truth = {
    ts: T0,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    closeAuth: "forming-ohlc",
  };
  const downTick = { ts: T0, open: 100, high: 101, low: 99, close: 100.1, closeAuth: "forming-quote" };
  const merged = mergeSameBucket(truth, downTick);
  assert.equal(merged.close, 100.1, "quote extends a forming-ohlc close downward — display continuity");
});

test("FIX 1B: closed-ohlc always supersedes and stays closed across chained merges", () => {
  const forming = {
    ts: T0,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    closeAuth: "forming-quote",
  };
  const closed = {
    ts: T0,
    open: 100,
    high: 101.2,
    low: 99,
    close: 100.8,
    closed: true,
    closeAuth: "closed-ohlc",
  };
  const merged = mergeSameBucket(forming, closed);
  assert.equal(merged.close, 100.8);
  assert.equal(merged.closed, true, "closed flag survives the merge");
  // A later quote frame can never re-open the closed bucket.
  const laterQuote = { ts: T0, open: 100, high: 101, low: 99, close: 999, closeAuth: "forming-quote" };
  const after = mergeSameBucket(merged, laterQuote);
  assert.equal(after, merged, "immutable: later quote returns the closed bar untouched");
});

// ── FIX 2: closed-live ledger persists across history reloads ────────────────

const bar = (ts, close = 100) => ({ ts, open: close - 1, high: close + 1, low: close - 2, close });

test("FIX 2: pruneClosedLiveBars keeps live buckets the reloaded history lacks", () => {
  const ledger = [bar(T0 + 2 * MIN, 100), bar(T0 + 3 * MIN, 101), bar(T0 + 4 * MIN, 102)];
  // Reloaded history ends BEFORE the live-closed buckets (persistence lag).
  const history = [{ ts: T0 - MIN }, { ts: T0 }, { ts: T0 + MIN }];
  const pruned = pruneClosedLiveBars(ledger, history, 60);
  assert.deepEqual(pruned, ledger, "nothing dropped — history hasn't caught up yet");
});

test("FIX 2: pruneClosedLiveBars drops buckets the reloaded history now carries", () => {
  const ledger = [bar(T0 + 2 * MIN, 100), bar(T0 + 3 * MIN, 101)];
  const history = [{ ts: T0 }, { ts: T0 + MIN }, { ts: T0 + 2 * MIN }]; // persistence caught up on T0+2m
  const pruned = pruneClosedLiveBars(ledger, history, 60);
  assert.deepEqual(pruned, [ledger[1]], "persisted bucket dropped, still-unpersisted bucket kept");
});

test("FIX 2: pruneClosedLiveBars returns the SAME reference when nothing changes", () => {
  const ledger = [bar(T0, 100)];
  const history = [{ ts: T0 - 5 * MIN }];
  assert.equal(pruneClosedLiveBars(ledger, history, 60), ledger, "identity stable — caller can bail out");
  assert.deepEqual(pruneClosedLiveBars([], history, 60), [], "empty ledger → early-out");
  assert.deepEqual(pruneClosedLiveBars(ledger, [], 60), ledger, "empty history → ledger untouched");
});

test("FIX 2: prune honours the bucket width (3m buckets align by floor)", () => {
  const ledger = [bar(T0 + 3 * MIN)]; // 10:03 — a 3m bucket start
  const history = [{ ts: T0 + 4 * MIN }]; // inside the 10:03 bucket
  const pruned = pruneClosedLiveBars(ledger, history, 180);
  assert.deepEqual(pruned, [], "ledger bucket pruned: history carries the 10:03 bucket");
});

// ── FIX 2B: gap suppressed when the authoritative bar set covers the bucket ──

test("FIX 2B: resolveGapBands suppresses a gap whose bucket the bar set carries (Rule E)", () => {
  // Missing 10:05 bucket (interval 10:05→10:06, one bucket wide); the history
  // reload still lacks 10:05 BUT the live ledger carries that bar. With
  // candles = history + ledger, no band renders.
  const gaps = [{ startTime: T0 + 5 * MIN, endTime: T0 + 6 * MIN }];
  const withLedgerBar = [
    { ts: T0 + 4 * MIN },
    { ts: T0 + 5 * MIN }, // ledger-covered bucket inside the outage
    { ts: T0 + 8 * MIN },
  ];
  assert.deepEqual(resolveGapBands(withLedgerBar, gaps, 60), [], "ledger-covered bucket erases the gap band");
  // Without the ledger bar the outage still renders (baseline behavior).
  const withoutLedgerBar = [{ ts: T0 + 4 * MIN }, { ts: T0 + 8 * MIN }];
  const bands = resolveGapBands(withoutLedgerBar, gaps, 60);
  assert.equal(bands.length, 1, "band still renders when the bucket is genuinely missing");
  assert.equal(bands[0]?.startMs, T0 + 5 * MIN);
});