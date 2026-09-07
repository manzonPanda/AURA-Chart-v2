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
  mergeGapIntervals,
  mergeGapLists,
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