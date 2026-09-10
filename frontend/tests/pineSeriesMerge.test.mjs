/**
 * Regression tests for `mergeBridgeBars` (services/pineSeries.ts) — the
 * closed-live-bucket ledger merge that keeps EMA/SMA/Pine synchronized with
 * TradingView's ever-growing candle series.
 *
 * BUG BEING LOCKED IN: App's `candles` history is frozen at load — live
 * bucket rollovers are painted ONLY into the CandleKit controller and never flow
 * back into React state. Prior to the ledger, the indicator bridges received
 *     [historical bars] + [single forming candle]
 * so every live bucket that closed after the last history load silently vanished
 * from the Pine/EMA input — EMA diverged from TradingView and looked stale until
 * a manual browser refresh reloaded history.
 *
 * `mergeBridgeBars(historical, closedLive, forming, bucketSec)` reconstructs
 * the complete authoritative series: history + closed-live ledger + forming.
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { mergeBridgeBars } from "../src/services/pineSeries.ts";

/** 1m bucket starts (epoch ms). */
const T0 = 1_704_153_600_000;
const T1 = T0 + 60_000;
const T2 = T0 + 120_000;
const T3 = T0 + 180_000;
const T4 = T0 + 240_000;

const histBar = (ts, close) => ({
  ts,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  volume: 100,
});

/** Forming WS candle — `time` is bucket start in epoch SECONDS (AURA realtime shape). */
const liveBar = (timeMs, close) => ({
  time: timeMs / 1000,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  volume: 50,
});

test("merge: ledger buckets are inserted between history and forming", () => {
  const historical = [histBar(T0, 100), histBar(T1, 101), histBar(T2, 102)];
  const ledger = [histBar(T3, 103)];
  const forming = liveBar(T4, 104);

  const merged = mergeBridgeBars(historical, ledger, forming, 60);
  assert.deepEqual(
    merged.map((b) => b.ts),
    [T0, T1, T2, T3, T4],
    "history + ledger + forming must form ONE strictly-ordered series",
  );
  assert.equal(merged[3].close, 103, "ledger's closed bucket keeps its close");
  assert.equal(merged[4].close, 104, "forming candle is last");
  assert.equal(merged[4].volume, 50, "forming candle keeps WS volume");
});

test("merge: same bucket ts (history tail vs forming) replaces in place — no duplicate", () => {
  const historical = [histBar(T0, 100), histBar(T1, 101)];
  // Forming candle's bucket equals the LAST historical bar (e.g. history already
  // contains the current bucket; the WS forming candle is its live update).
  const merged = mergeBridgeBars(historical, [], liveBar(T1, 109), 60);
  assert.deepEqual(
    merged.map((b) => b.ts),
    [T0, T1],
    "same bucket must NOT produce a duplicate timestamp",
  );
  assert.equal(merged.length, 2, "series length unchanged on same-bucket replace");
  assert.equal(merged[1].close, 109, "server truth replaces the historical close");
  assert.equal(merged[1].high, 110, "server truth replaces the historical high as well");
});

test("merge: ledger dedups against history (no repeated closed bucket)", () => {
  // The ledger can carry a bucket that history already closed (history refreshed
  // while candles.length > 0). History wins; the ledger must not duplicate it.
  const historical = [histBar(T0, 100), histBar(T1, 101)];
  const ledger = [histBar(T1, 101), histBar(T2, 104)];
  const merged = mergeBridgeBars(historical, ledger, null, 60);

  assert.deepEqual(
    merged.map((b) => b.ts),
    [T0, T1, T2],
    "overlapping ledger bucket must collapse onto the historical bucket",
  );
  assert.equal(merged.length, 3, "no duplicate timestamps");
});

test("merge: live-only (empty history) accumulates ledger + forming", () => {
  const ledger = [histBar(T0, 100), histBar(T1, 101)];
  const merged = mergeBridgeBars([], ledger, liveBar(T2, 102.5), 60);

  assert.deepEqual(
    merged.map((b) => b.ts),
    [T0, T1, T2],
    "live-only mode must still produce the full series",
  );
  assert.equal(merged[2].close, 102.5);
});

test("merge: forming uses bucket grid floor (epoch s -> ms) + null/empty safety", () => {
  // Forming time not exactly on the grid must floor to the bucket start.
  const merged = mergeBridgeBars([], [], liveBar(T1 + 30_000, 99), 60);
  assert.deepEqual(merged.map((b) => b.ts), [T1], "bucket start floors the forming time");
  assert.equal(merged[0].close, 99);

  // Null forming and empty ledger: identity on history.
  const identity = mergeBridgeBars([histBar(T0, 5), histBar(T1, 6)], [], null, 60);
  assert.deepEqual(identity.map((b) => b.ts), [T0, T1]);
  assert.deepEqual(identity.map((b) => b.close), [5, 6]);

  // Degenerate bucketSec must not crash / produce NaNs.
  const safe = mergeBridgeBars([histBar(T0, 5)], [], liveBar(T1, 7), 0);
  assert.equal(safe.length, 2);
  assert.ok(safe.every((b) => Number.isFinite(b.ts)));
});
