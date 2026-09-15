/**
 * DATA GAP REVALIDATION — unit tests for forensic fix #8 (gap state must track
 * the AUTHORITATIVE dataset, not stale frontend state). Runs with Node's type
 * stripping:   npm --prefix frontend run test
 *
 * Rules under test:
 *   A. a bucket that has an authoritative candle is NEVER a DATA GAP;
 *   B. a gap is only historical/real when OLDER than the newest authoritative
 *      closed bucket (the forming bucket and unsettled frontier are excluded);
 *   C. a reconciliation/backfill that inserts a previously-missing candle makes
 *      its gap disappear on the next data/gap update;
 *   D. temporary quote/live state never GENERATES a gap (revalidateGaps only
 *      filters — it cannot fabricate intervals);
 *   E. resolveGapBands suppresses a gap whose bucket is present in the candles.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { mergeGapLists, revalidateGaps, resolveGapBands } from "../src/services/gapRegions.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 4, 10, 0); // bucket grid, epoch ms

const gap = (bucketMs, buckets = 1) => ({
  instrument: "GOLD",
  timeframe: "MINUTE_1",
  startTime: bucketMs,
  endTime: bucketMs + buckets * MIN,
});
const candle = (bucketMs, c = 4300) => ({ ts: bucketMs, open: c, high: c, low: c, close: c });

test("Rule A/C: a gap whose bucket now has an authoritative candle disappears", () => {
  const stale = [gap(T0), gap(T0 + MIN), gap(T0 + 2 * MIN)];
  // Backfill/reconciliation inserted the middle candle.
  const candles = [candle(T0), candle(T0 + MIN), candle(T0 + 2 * MIN)];
  assert.deepEqual(revalidateGaps(stale, candles, 60), [], "repaired buckets are no longer gaps");
});

test("Rule B: gaps at/after the newest authoritative closed bucket are suppressed", () => {
  const gaps = [gap(T0), gap(T0 + 3 * MIN)];
  // Newest authoritative closed bucket = 10:03 → the 10:03 gap is frontier noise
  // (its bucket carries a candle; the 10:00 gap is genuinely missing and OLDER).
  const candles = [candle(T0 + 3 * MIN)];
  const kept = revalidateGaps(gaps, candles, 60);
  assert.deepEqual(
    kept.map((g) => g.startTime),
    [T0],
    "only the strictly-older historical gap survives",
  );
});

test("real historical gaps are KEPT (no over-suppression)", () => {
  const gaps = [gap(T0 + MIN)];
  const candles = [candle(T0), candle(T0 + 2 * MIN)]; // 10:01 missing for real
  const kept = revalidateGaps(gaps, candles, 60);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].startTime, T0 + MIN);
});

test("Rule D: no temporary/live state can FABRICATE a gap", () => {
  // revalidateGaps only ever filters its input: live-only overlay state cannot
  // invent shading.
  assert.deepEqual(revalidateGaps([], [candle(T0)], 60), []);
  assert.deepEqual(revalidateGaps([], [], 60), []);
  // Invalid / inverted intervals are dropped, never repaired into bands.
  const bad = [{ instrument: "GOLD", timeframe: "MINUTE_1", startTime: T0 + MIN, endTime: T0 }];
  assert.deepEqual(revalidateGaps(bad, [candle(T0), candle(T0 + 2 * MIN)], 60), []);
});

test("mergeGapLists still dedupes across pages (load-more accumulation intact)", () => {
  const a = [gap(T0)];
  const b = [gap(T0), gap(T0 + 5 * MIN)];
  const merged = mergeGapLists(a, b);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((g) => g.startTime), [T0, T0 + 5 * MIN]);
});

test("Rule E: resolveGapBands suppresses a band when the bucket is present", () => {
  // Even if a stale gap list survives, a candle at 10:01 means NO band.
  const gaps = [gap(T0 + MIN)];
  const candles = [candle(T0), candle(T0 + MIN), candle(T0 + 2 * MIN)];
  assert.deepEqual(resolveGapBands(candles, gaps, 60), [], "present bucket → no band");

  // The real missing bucket still produces exactly one band.
  const real = [gap(T0 + MIN)];
  const withHole = [candle(T0), candle(T0 + 2 * MIN)];
  const bands = resolveGapBands(withHole, real, 60);
  assert.equal(bands.length, 1);
  assert.equal(bands[0].spanIndices, 1);
});
