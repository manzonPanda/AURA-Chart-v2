/**
 * Market-data gap geometry tests — services/gapRegions.ts.
 *
 * Covers the pure layer between the backend's derived CandleGap intervals and
 * the chart's DATA GAP primitive:
 *   - mergeGapIntervals: adjacent/overlapping buckets collapse into maximal
 *     spans (a 9-minute outage must render as ONE band, not nine);
 *   - resolveGapBands: anchor/width geometry on LWC's compacted axis, edge
 *     skipping, degenerate inputs;
 *   - mergeGapLists: load-more accumulation without duplicates.
 *
 * Run: npm --prefix frontend run test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  GAP_SETTLE_GRACE_FALLBACK_MS,
  mergeGapIntervals,
  mergeGapLists,
  revalidateGaps,
  resolveGapBands,
} from "../src/services/gapRegions.ts";

const T0 = Date.UTC(2024, 0, 8, 9, 0); // Mon 09:00 UTC
const MIN = 60_000;
const gap = (startMs, endMs) => ({ instrument: "TEST", timeframe: "MINUTE_1", startTime: startMs, endTime: endMs, reason: "broker_gap" });
const candleAt = (t) => ({ ts: t });

// ── mergeGapIntervals ────────────────────────────────────────────────────────

test("mergeGapIntervals: consecutive missing buckets collapse into one span", () => {
  // The backend reports one interval per missing bucket (09:30–09:38 outage).
  const nine = [];
  for (let i = 0; i < 9; i++) nine.push(gap(T0 + (30 + i) * MIN, T0 + (31 + i) * MIN));
  const merged = mergeGapIntervals(nine);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].startTime, T0 + 30 * MIN);
  assert.equal(merged[0].endTime, T0 + 39 * MIN);
});

test("mergeGapIntervals: overlapping and unordered input merge; invalid dropped", () => {
  const merged = mergeGapIntervals([
    gap(T0 + 10 * MIN, T0 + 14 * MIN),
    gap(T0, T0 + 2 * MIN),
    gap(T0 + 12 * MIN, T0 + 16 * MIN), // overlaps the first
    gap(Number.NaN, T0),
    gap(T0 + 5 * MIN, T0 + 5 * MIN), // empty
  ]);
  assert.deepEqual(merged, [
    { startTime: T0, endTime: T0 + 2 * MIN },
    { startTime: T0 + 10 * MIN, endTime: T0 + 16 * MIN },
  ]);
});

test("mergeGapIntervals: separated outages stay separate", () => {
  const merged = mergeGapIntervals([gap(T0, T0 + MIN), gap(T0 + 5 * MIN, T0 + 6 * MIN)]);
  assert.equal(merged.length, 2);
});

// ── resolveGapBands ──────────────────────────────────────────────────────────

test("resolveGapBands: no gaps → no bands", () => {
  const candles = [0, 1, 2].map((i) => candleAt(T0 + i * MIN));
  assert.deepEqual(resolveGapBands(candles, [], 60), []);
  assert.deepEqual(resolveGapBands([], [gap(T0, T0 + MIN)], 60), []);
});

test("resolveGapBands: single missing minute anchors between its neighbors", () => {
  // Candles 09:29 and 09:39 adjacent (compacted); outage 09:30–09:39.
  const candles = [candleAt(T0 + 29 * MIN), candleAt(T0 + 39 * MIN)];
  const bands = resolveGapBands(candles, [gap(T0 + 30 * MIN, T0 + 39 * MIN)], 60);
  assert.equal(bands.length, 1);
  assert.equal(bands[0].anchorIndex, 0.5); // boundary between index 0 and 1
  assert.equal(bands[0].spanIndices, 9); // nine missing minutes
  assert.equal(bands[0].startMs, T0 + 30 * MIN);
  assert.equal(bands[0].endMs, T0 + 39 * MIN);
});

test("resolveGapBands: a gap abutting a calendar-closed stretch anchors on the first real candle after the outage", () => {
  // Real Sep-7 shape (Spot Gold): outage 02:30–05:00 PH, then the calendar's
  // daily break (05:00–06:00 PH — never a candle, never a whitespace slot),
  // first real candle 06:01 PH. The merged interval ends where the CLOSED
  // stretch begins, so `endTime` itself is NOT registered on the chart's time
  // scale — the band's right anchor must snap to the first real candle, or
  // the primitive's timestamp-first geometry bails to the compaction fallback
  // and the band lands half the outage LEFT of its true position.
  const candles = [candleAt(T0 + 29 * MIN), candleAt(T0 + 61 * MIN)]; // 09:29, 10:01
  // Merged outage [09:30, 10:00) — 30 expected-missing buckets; 10:00 starts
  // the calendar-closed stretch (no gap interval, no candle, no slot).
  const bands = resolveGapBands(candles, [gap(T0 + 30 * MIN, T0 + 60 * MIN)], 60);
  assert.equal(bands.length, 1);
  assert.equal(bands[0].startMs, T0 + 30 * MIN);
  assert.equal(bands[0].endMs, T0 + 61 * MIN); // snapped to the 10:01 candle — registered
  assert.equal(bands[0].anchorIndex, 0.5); // boundary between 09:29 (idx 0) and 10:01 (idx 1)
  // Width keeps the missing-bucket count: on the whitespace axis the step
  // count from the first slot (09:30) to the 10:01 candle is ALSO 30 (the
  // closed stretch compacts into the one step 09:59|10:01), so the primitive
  // derives barW = 1 bar exactly and both boundary candles stay outside.
  assert.equal(bands[0].spanIndices, 30);
});

test("resolveGapBands: a multi-minute outage renders as ONE wide band", () => {
  const candles = [0, 29, 39, 40].map((i) => candleAt(T0 + i * MIN));
  const bands = resolveGapBands(
    candles,
    Array.from({ length: 9 }, (_, i) => gap(T0 + (30 + i) * MIN, T0 + (31 + i) * MIN)),
    60,
  );
  assert.equal(bands.length, 1);
  assert.equal(bands[0].anchorIndex, 1.5); // between 09:29 (idx 1) and 09:39 (idx 2)
  assert.equal(bands[0].spanIndices, 9);
});

test("resolveGapBands: edge gaps (no candle on one side) are never shaded", () => {
  const candles = [candleAt(T0 + 5 * MIN), candleAt(T0 + 6 * MIN)];
  // Before the oldest candle and after the newest — pagination/future space.
  const bands = resolveGapBands(
    candles,
    [gap(T0, T0 + 3 * MIN), gap(T0 + 10 * MIN, T0 + 12 * MIN)],
    60,
  );
  assert.deepEqual(bands, []);
});

test("resolveGapBands: 3m bucket width scales the span", () => {
  const candles = [candleAt(T0), candleAt(T0 + 3 * MIN * 2)]; // 09:00, 09:06
  const bands = resolveGapBands(candles, [gap(T0 + 3 * MIN, T0 + 6 * MIN)], 180);
  assert.equal(bands.length, 1);
  assert.equal(bands[0].anchorIndex, 0.5);
  assert.equal(bands[0].spanIndices, 1);
});

test("resolveGapBands: invalid bucket width or malformed gaps are safe", () => {
  const candles = [candleAt(T0), candleAt(T0 + MIN)];
  assert.deepEqual(resolveGapBands(candles, [gap(T0 + MIN, T0 + 2 * MIN)], 0), []);
  assert.deepEqual(resolveGapBands(candles, [gap(Number.NaN, T0 + 2 * MIN)], 60), []);
  assert.deepEqual(resolveGapBands(candles, [gap(T0 + 2 * MIN, T0 + MIN)], 60), []); // inverted
});

// ── mergeGapLists (load-more accumulation) ──────────────────────────────────

test("mergeGapLists: dedupes exact intervals and sorts ascending", () => {
  const a = [gap(T0 + 10 * MIN, T0 + 11 * MIN)];
  const b = [gap(T0, T0 + MIN), gap(T0 + 10 * MIN, T0 + 11 * MIN)];
  const merged = mergeGapLists(a, b);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].startTime, T0);
  assert.equal(merged[1].startTime, T0 + 10 * MIN);
});

// ── revalidateGaps — settled reconciliation boundary (Rule B′) ───────────────
//
// Production evidence (2026-09-16 forensic): Capital DISTINCT OHLC delivery
// can leave a bucket absent from PostgreSQL for up to ~18m while the
// quote-driven live display already showed the candle. The reconciler's
// settled scan boundary separates PENDING (never shaded) from CONFIRMED
// (genuinely missing → DATA GAP).

test("revalidateGaps: a newly missing bucket inside the reconciliation window is PENDING, never a DATA GAP", () => {
  // 02:38-style hole: history …02:37, 02:39…; the newest successful run ended
  // its scan at 02:35 (forming 02:38 − 3m lag) — the hole is at/after the
  // boundary ⇒ PENDING ⇒ never shaded, even though the backend still lists it.
  const bucket = T0 + 38 * MIN;
  const candles = [candleAt(T0 + 37 * MIN), candleAt(T0 + 39 * MIN), candleAt(T0 + 40 * MIN)];
  const kept = revalidateGaps([gap(bucket, bucket + MIN)], candles, 60, {
    settledToSecMs: T0 + 35 * MIN,
    nowMs: T0 + 41 * MIN,
  });
  assert.deepEqual(kept, []);
});

test("revalidateGaps: after the settled boundary passes a still-missing bucket it becomes a genuine DATA GAP", () => {
  // 20:59-style permanent hole: the reconciler scanned past it (boundary
  // 21:05) and Capital had no candle → eligible.
  const bucket = T0 + 59 * MIN;
  const candles = [candleAt(T0 + 58 * MIN), candleAt(T0 + 62 * MIN)];
  const kept = revalidateGaps([gap(bucket, bucket + MIN)], candles, 60, {
    settledToSecMs: T0 + 65 * MIN,
    nowMs: T0 + 66 * MIN,
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].startTime, bucket);
});

test("revalidateGaps: a bucket repaired before the boundary is erased (Rule A)", () => {
  // 22:06-style worst case: repaired (inserted) by the same run whose scan end
  // first passed it — the reloaded history now carries the candle, so the gap
  // disappears even though the boundary is newer than the bucket.
  const bucket = T0 + 6 * MIN;
  const candles = [candleAt(T0 + 5 * MIN), candleAt(bucket), candleAt(T0 + 7 * MIN)];
  const kept = revalidateGaps([gap(bucket, bucket + MIN)], candles, 60, {
    settledToSecMs: T0 + 20 * MIN,
    nowMs: T0 + 21 * MIN,
  });
  assert.deepEqual(kept, []);
});

// ── Rule B′ time-based fallback (no authoritative boundary available) ────────

test("revalidateGaps: with no settled boundary a young bucket is suppressed by the 20-minute grace", () => {
  // 02:38-style hole, 3 minutes old. The backend supplied no boundary (older
  // build / reconciler unavailable) ⇒ the documented 20-minute grace applies:
  // the bucket is still inside the normal reconciliation opportunity window.
  const bucket = T0 + 38 * MIN;
  const candles = [candleAt(T0 + 37 * MIN), candleAt(T0 + 39 * MIN)];
  // The documented fallback = safetyLag 3m + interval 15m + 2m slack.
  assert.equal(GAP_SETTLE_GRACE_FALLBACK_MS, 20 * MIN);
  const kept = revalidateGaps([gap(bucket, bucket + MIN)], candles, 60, {
    nowMs: T0 + 41 * MIN,
  });
  assert.deepEqual(kept, []);
});

test("revalidateGaps: with no settled boundary a bucket older than the grace is still a real DATA GAP", () => {
  // Same shape, 40 minutes old ⇒ outside every possible reconciliation
  // opportunity ⇒ genuinely missing ⇒ shaded.
  const bucket = T0 + 38 * MIN;
  const candles = [candleAt(T0 + 37 * MIN), candleAt(T0 + 39 * MIN)];
  const kept = revalidateGaps([gap(bucket, bucket + MIN)], candles, 60, {
    nowMs: T0 + 78 * MIN,
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].startTime, bucket);
});

test("revalidateGaps: the fallback grace counts against the SERVER-calibrated clock, not the local one", () => {
  // A skewed client clock must not flip the pending classification. The bucket
  // is 5 minutes behind the LOCAL clock, but the server-calibrated clock is 100
  // minutes ahead (clockOffsetMs = +100m): real age ~105m ⇒ a genuine DATA GAP.
  const bucket = Date.now() - 5 * MIN;
  const candles = [candleAt(bucket - MIN), candleAt(bucket + 10 * MIN)];
  const gaps = [gap(bucket, bucket + MIN)];

  // Local clock only: 5 minutes old ⇒ pending ⇒ suppressed.
  assert.deepEqual(revalidateGaps(gaps, candles, 60, {}), []);

  // Server-calibrated clock (offset applied because `nowMs` is omitted).
  const kept = revalidateGaps(gaps, candles, 60, { clockOffsetMs: 100 * MIN });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].startTime, bucket);
});

test("revalidateGaps: an explicit settled boundary takes precedence over the fallback grace", () => {
  // 30 minutes old (outside the 20m fallback grace) but the newest successful
  // reconciler run still has not scanned it ⇒ PENDING ⇒ suppressed.
  const bucket = T0 + 38 * MIN;
  const candles = [candleAt(T0 + 37 * MIN), candleAt(T0 + 39 * MIN)];
  const kept = revalidateGaps([gap(bucket, bucket + MIN)], candles, 60, {
    settledToSecMs: T0 + 20 * MIN,
    nowMs: T0 + 68 * MIN,
  });
  assert.deepEqual(kept, []);
});

// ─ 3M: one pending 1M constituent omits the whole derived bucket ────────────
//
// MINUTE_3 is derived-on-read from MINUTE_1 and requires all three
// constituents (aggregateCompleteToMinutes). One 1M row pending reconciliation
// therefore removes the whole 3M candle even though the live 3M candle closed
// and 2/3 constituents persisted. Production example: 1M 02:38 pending ⇒ 3M
// macro bucket 02:36 omitted, reported as a 3-bar DATA GAP.

test("revalidateGaps (3M): a bucket omitted because one 1M constituent is pending is never a DATA GAP", () => {
  const macro = T0 + 36 * MIN; // 3M bucket 09:36–09:39 (1M 09:38 is the pending one)
  const candles = [candleAt(T0 + 33 * MIN), candleAt(T0 + 39 * MIN)]; // 09:33, 09:39
  const kept = revalidateGaps([gap(macro, macro + 3 * MIN)], candles, 180, {
    // The newest successful run scanned to 09:35 — before the macro bucket.
    settledToSecMs: T0 + 35 * MIN,
    nowMs: T0 + 40 * MIN,
  });
  assert.deepEqual(kept, []);
});

test("revalidateGaps (3M): the same bucket becomes a real DATA GAP once its 1M constituent is genuinely missing", () => {
  const macro = T0 + 36 * MIN;
  const candles = [candleAt(T0 + 33 * MIN), candleAt(T0 + 39 * MIN)];
  const kept = revalidateGaps([gap(macro, macro + 3 * MIN)], candles, 180, {
    // The reconciler scanned past 09:36 (to 09:45) and Capital had no 09:38 ⇒
    // the constituent is genuinely missing ⇒ the derived bucket stays absent.
    settledToSecMs: T0 + 45 * MIN,
    nowMs: T0 + 46 * MIN,
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].startTime, macro);
});

test("revalidateGaps (3M): a repaired 1M constituent restores the derived bucket and erases its gap (Rule A)", () => {
  const macro = T0 + 36 * MIN;
  // History now carries the 09:36 3M candle because all three 1M rows were
  // reconciled — the merged `data` set contains the bucket.
  const candles = [candleAt(T0 + 33 * MIN), candleAt(macro), candleAt(T0 + 39 * MIN)];
  const kept = revalidateGaps([gap(macro, macro + 3 * MIN)], candles, 180, {
    settledToSecMs: T0 + 45 * MIN,
  });
  assert.deepEqual(kept, []);
});

// ── History reloads must never repaint young pending gaps ────────────────────

test("revalidateGaps: repeated history loads / load-more merges never repaint a pending bucket", () => {
  // Refresh, tab resync, timeframe change and Load More all funnel through the
  // same call. With a boundary that has not yet passed the bucket, every pass
  // must yield the same empty result — no oscillation with request ordering.
  const bucket = T0 + 38 * MIN;
  const candles = [candleAt(T0 + 37 * MIN), candleAt(T0 + 39 * MIN), candleAt(T0 + 40 * MIN)];
  const opts = { settledToSecMs: T0 + 35 * MIN, nowMs: T0 + 41 * MIN };

  const firstLoad = revalidateGaps([gap(bucket, bucket + MIN)], candles, 60, opts);
  assert.deepEqual(firstLoad, []);

  // Load More: previous gap state merged with an older page's gaps, then
  // revalidated against the freshly merged dataset. The OLD eligible gap
  // survives (real gap detection intact); the pending bucket never returns.
  const merged = mergeGapLists(firstLoad, [gap(bucket, bucket + MIN), gap(T0 + 10 * MIN, T0 + 11 * MIN)]);
  const afterLoadMore = revalidateGaps(merged, candles, 60, opts);
  assert.deepEqual(afterLoadMore.map((g) => g.startTime), [T0 + 10 * MIN]);

  // A later reload with the same boundary is still empty (the boundary only
  // advances, so a pending bucket cannot become eligible by reloading).
  assert.deepEqual(revalidateGaps([gap(bucket, bucket + MIN)], candles, 60, opts), []);
});

test("revalidateGaps: a repaired bucket stays repaired across a reload (Rule C)", () => {
  // The reconciler filled 09:38; the next history load carries the candle, so
  // the stale gap interval from the previous page must not survive the merge.
  const bucket = T0 + 38 * MIN;
  const stale = [gap(bucket, bucket + MIN)];
  const repaired = [candleAt(T0 + 37 * MIN), candleAt(bucket), candleAt(T0 + 39 * MIN)];
  const kept = revalidateGaps(stale, repaired, 60, { settledToSecMs: T0 + 45 * MIN });
  assert.deepEqual(kept, []);
});

// ── Existing behaviour preserved: real gaps, ledger Rule E, geometry ────────

test("revalidateGaps: a genuine multi-bucket historical outage is still detected (no regression)", () => {
  // 9-minute outage 09:30–09:39, well past every reconciliation opportunity.
  const gaps = [];
  for (let i = 0; i < 9; i++) gaps.push(gap(T0 + (30 + i) * MIN, T0 + (31 + i) * MIN));
  const candles = [candleAt(T0 + 29 * MIN), candleAt(T0 + 39 * MIN)];
  const kept = revalidateGaps(gaps, candles, 60, { settledToSecMs: T0 + 60 * MIN, nowMs: T0 + 61 * MIN });
  assert.equal(kept.length, 9);
  assert.equal(kept[0].startTime, T0 + 30 * MIN);
  // …and still renders as ONE band of the correct extent.
  const bands = resolveGapBands(candles, mergeGapIntervals(kept), 60);
  assert.equal(bands.length, 1);
  assert.equal(bands[0].spanIndices, 9);
});

test("revalidateGaps: a candle in the merged set (closed-live ledger) suppresses its gap — Rule E", () => {
  // Rule E input is the SAME merged `data` set (PostgreSQL history + closed-live
  // ledger). A bucket carried only by the ledger must erase the gap even when
  // the settled boundary has already passed it.
  const bucket = T0 + 38 * MIN;
  const ledgerMerged = [candleAt(T0 + 37 * MIN), candleAt(bucket), candleAt(T0 + 39 * MIN)];
  const kept = revalidateGaps([gap(bucket, bucket + MIN)], ledgerMerged, 60, {
    settledToSecMs: T0 + 45 * MIN,
  });
  assert.deepEqual(kept, []);

  // Without that ledger candle the same bucket is a confirmed DATA GAP.
  const historyOnly = [candleAt(T0 + 37 * MIN), candleAt(T0 + 39 * MIN)];
  const confirmed = revalidateGaps([gap(bucket, bucket + MIN)], historyOnly, 60, {
    settledToSecMs: T0 + 45 * MIN,
  });
  assert.equal(confirmed.length, 1);
});

test("gap geometry is unchanged by the settled-boundary rule (Rule B′ affects classification only)", () => {
  // Same confirmed interval either way: the band anchor/width must be
  // identical. GapRegionsPrimitive.ts is untouched by this fix.
  const candles = [candleAt(T0 + 29 * MIN), candleAt(T0 + 39 * MIN)];
  const interval = [gap(T0 + 30 * MIN, T0 + 39 * MIN)];
  const kept = revalidateGaps(interval, candles, 60, { settledToSecMs: T0 + 60 * MIN });
  const bands = resolveGapBands(candles, kept, 60);
  assert.equal(bands.length, 1);
  assert.equal(bands[0].anchorIndex, 0.5);
  assert.equal(bands[0].spanIndices, 9);
  assert.equal(bands[0].startMs, T0 + 30 * MIN);
  assert.equal(bands[0].endMs, T0 + 39 * MIN);
});