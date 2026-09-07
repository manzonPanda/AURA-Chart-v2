/**
 * Calendar-aware gap-interval derivation tests (market-data gap rendering).
 *
 * Covers the renderable `deriveGapIntervals()` companion to `detectGaps`:
 *   1. consecutive session candles → no gaps
 *   2. a missing 1m candle mid-session → exactly one [startMs, endMs) interval
 *   3. weekend/market-closed periods → NEVER reported (calendar decides)
 *   4. multiple outages → all reported, ascending
 *   5. gaps before the oldest / after the newest loaded candle → not reported
 *   6. `toSec` clamps the scan (forming-bucket territory excluded)
 *   7. `closedDates` suppresses reporting
 *   8. degenerate inputs → []
 *
 * Run: npm --prefix backend test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deriveGapIntervals, type GapInterval } from "../market/gapDetector.js";
import type { MarketCalendar } from "../market/calendar.js";

/** 2024-01-08 is a Monday. `d` = day of January, minutes UTC. */
const sec = (d: number, h: number, m: number): number => Math.floor(Date.UTC(2024, 0, d, h, m) / 1000);

/** Mon–Fri 08:00–21:00 UTC dealing window, no holidays. */
const WEEK_WINDOWS = [{ openMin: 8 * 60, closeMin: 21 * 60 }];
const CAL: MarketCalendar = {
  id: "test-mkt",
  label: "Test market (UTC)",
  timezone: "UTC",
  windowsByWeekday: { 1: WEEK_WINDOWS, 2: WEEK_WINDOWS, 3: WEEK_WINDOWS, 4: WEEK_WINDOWS, 5: WEEK_WINDOWS, 6: [], 7: [] },
  closedDates: [],
};

const ms = (s: number): number => s * 1000;

test("gap intervals: consecutive session candles produce none", () => {
  const times: number[] = [];
  for (let i = 0; i < 10; i++) times.push(sec(8, 9, 0) + i * 60); // Mon 09:00–09:09
  assert.deepEqual(deriveGapIntervals(times, CAL, 60, { toSec: sec(8, 9, 30) }), []);
});

test("gap intervals: one missing mid-session minute → exactly one interval", () => {
  // 09:00–09:04 present, 09:05 missing, 09:06–09:09 present.
  const times = [0, 1, 2, 3, 4, 6, 7, 8, 9].map((i) => sec(8, 9, 0) + i * 60);
  const gaps: GapInterval[] = deriveGapIntervals(times, CAL, 60, { toSec: sec(8, 9, 30) });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].startMs, ms(sec(8, 9, 5)));
  assert.equal(gaps[0].endMs, ms(sec(8, 9, 6)));
});

test("gap intervals: weekend closure between Fri and Mon is never reported", () => {
  // Fri 2024-01-12 20:59 (last dealt minute) → Mon 2024-01-15 08:00 (first).
  const times = [sec(12, 20, 59), sec(15, 8, 0)];
  assert.deepEqual(deriveGapIntervals(times, CAL, 60, { toSec: sec(15, 9, 0) }), []);
});

test("gap intervals: multiple outages are all reported, ascending", () => {
  const present = new Set([0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 19, 20, 21]);
  const times: number[] = [];
  for (let i = 0; i <= 21; i++) if (present.has(i)) times.push(sec(8, 9, 0) + i * 60);
  // Missing 09:05 and 09:12–09:18 (merge is the RENDERER's job — raw buckets here).
  const gaps = deriveGapIntervals(times, CAL, 60, { toSec: sec(8, 9, 30) });
  assert.deepEqual(
    gaps.map((g) => g.startMs),
    [ms(sec(8, 9, 5)), ...[12, 13, 14, 15, 16, 17, 18].map((i) => ms(sec(8, 9, 0) + i * 60))],
  );
  for (const g of gaps) assert.equal(g.endMs - g.startMs, 60_000);
});

test("gap intervals: buckets older than the oldest loaded candle are never reported", () => {
  // 09:00 missing from the array, but the window STARTS at 09:01 — pagination
  // territory, not an outage.
  const times = [1, 2, 3].map((i) => sec(8, 9, 0) + i * 60);
  assert.deepEqual(deriveGapIntervals(times, CAL, 60, { toSec: sec(8, 9, 30) }), []);
});

test("gap intervals: buckets newer than the newest loaded candle are never reported", () => {
  // Loaded through 09:05; 09:06–09:19 are unsynced future/pagination space.
  const times = [0, 1, 2, 3, 4, 5].map((i) => sec(8, 9, 0) + i * 60);
  assert.deepEqual(deriveGapIntervals(times, CAL, 60, { toSec: sec(8, 9, 20) }), []);
});

test("gap intervals: toSec clamps the scan at the forming bucket", () => {
  // 09:00–09:04 present, 09:05–09:08 missing, forming 09:09 present in list.
  // toSec = 09:09 → scan clamps at 09:08: the forming bucket itself and
  // everything after it are excluded even when a row sneaks into the input.
  const times = [0, 1, 2, 3, 4, 9].map((i) => sec(8, 9, 0) + i * 60);
  const gaps = deriveGapIntervals(times, CAL, 60, { toSec: sec(8, 9, 9) });
  assert.deepEqual(
    gaps.map((g) => g.startMs),
    [5, 6, 7, 8].map((i) => ms(sec(8, 9, 0) + i * 60)),
  );
});

test("gap intervals: closedDates suppress reporting", () => {
  const holiday: MarketCalendar = { ...CAL, closedDates: ["2024-01-08"] };
  const times = [0, 1, 3, 4].map((i) => sec(8, 9, 0) + i * 60); // 09:02 missing
  assert.deepEqual(deriveGapIntervals(times, holiday, 60, { toSec: sec(8, 9, 30) }), []);
});

test("gap intervals: 3m grid reports whole macro buckets", () => {
  // Mon 09:00/09:03/09:12 present on the 180 s grid → 09:06 and 09:09 missing.
  const times = [sec(8, 9, 0), sec(8, 9, 3), sec(8, 9, 12)];
  const gaps = deriveGapIntervals(times, CAL, 180, { toSec: sec(8, 9, 30) });
  assert.deepEqual(
    gaps.map((g) => g.startMs),
    [ms(sec(8, 9, 6)), ms(sec(8, 9, 9))],
  );
  for (const g of gaps) assert.equal(g.endMs - g.startMs, 180_000);
});

test("gap intervals: degenerate inputs are safe", () => {
  assert.deepEqual(deriveGapIntervals([], CAL, 60), []);
  assert.deepEqual(deriveGapIntervals([sec(8, 9, 0)], CAL, 0), []);
  assert.deepEqual(deriveGapIntervals([Number.NaN, sec(8, 9, 1)], CAL, 60, { toSec: sec(8, 9, 5) }), []);
  // Non-grid timestamps floor onto their bucket: 09:00:37 → the 09:00 bucket
  // (no gap), even though the raw value is off-grid.
  const gaps = deriveGapIntervals([sec(8, 9, 0), sec(8, 9, 0) + 37], CAL, 60, { toSec: sec(8, 9, 5) });
  assert.deepEqual(gaps, []);
});