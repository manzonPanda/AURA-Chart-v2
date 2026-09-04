/**
 * Market calendars — unit tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *
 * Phase 0 multi-instrument: the wall-clock conversion is now parameterized by
 * each calendar's OWN timezone (was hardcoded Europe/London), and the new
 * IG Spot Gold calendar must express the Globex-aligned gold schedule:
 * Sunday open 23:00 London, Friday close 22:00 London, daily break
 * 22:00–23:00. Deterministic UTC epochs on known dates; DST is exercised for
 * real (September = BST, December = GMT). DAX assertions double as a
 * behavior-preservation regression for the timezone refactor.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { IG_GERMANY_40, IG_SPOT_GOLD, isBucketExpected } from "../market/calendar.js";

/** Epoch seconds of a UTC wall-clock instant, aligned to the 60 s grid. */
const B = (y: number, m: number, d: number, h = 0, min = 0): number =>
  Math.floor(Date.UTC(y, m - 1, d, h, min) / 1000 / 60) * 60;

// ── Gold: BST week (September 2026; London = UTC+1) ──────────────────────────

test("gold: Sunday open 23:00 BST (22:00 UTC) — exact open bucket is expected", () => {
  assert.equal(isBucketExpected(B(2026, 9, 6, 22, 0), IG_SPOT_GOLD), true);
});

test("gold: Sunday pre-open buckets are NOT expected", () => {
  assert.equal(isBucketExpected(B(2026, 9, 6, 21, 59), IG_SPOT_GOLD), false); // 22:59 BST
  assert.equal(isBucketExpected(B(2026, 9, 6, 21, 0), IG_SPOT_GOLD), false); // 22:00 BST (break)
});

test("gold: weekday 00:00–22:00 BST window (overnight + day session)", () => {
  assert.equal(isBucketExpected(B(2026, 9, 7, 0, 0), IG_SPOT_GOLD), true); // Mon 01:00 BST
  assert.equal(isBucketExpected(B(2026, 9, 7, 20, 59), IG_SPOT_GOLD), true); // Mon 21:59 BST
});

test("gold: daily break 22:00–23:00 BST is never expected", () => {
  assert.equal(isBucketExpected(B(2026, 9, 7, 21, 0), IG_SPOT_GOLD), false); // Mon 22:00 BST
  assert.equal(isBucketExpected(B(2026, 9, 7, 21, 30), IG_SPOT_GOLD), false); // Mon 22:30 BST
});

test("gold: Friday close 22:00 BST — last session minute in, close bucket out", () => {
  assert.equal(isBucketExpected(B(2026, 9, 11, 20, 59), IG_SPOT_GOLD), true); // 21:59 BST
  assert.equal(isBucketExpected(B(2026, 9, 11, 21, 0), IG_SPOT_GOLD), false); // 22:00 BST
});

test("gold: Saturday is fully closed", () => {
  assert.equal(isBucketExpected(B(2026, 9, 12, 12, 0), IG_SPOT_GOLD), false);
});

// ── Gold: GMT week (December 2026; London = UTC+0) — DST correctness ─────────

test("gold: December Sunday open 23:00 GMT holds the same wall-clock schedule", () => {
  assert.equal(isBucketExpected(B(2026, 12, 6, 23, 0), IG_SPOT_GOLD), true);
  assert.equal(isBucketExpected(B(2026, 12, 6, 22, 0), IG_SPOT_GOLD), false);
  assert.equal(isBucketExpected(B(2026, 12, 7, 0, 0), IG_SPOT_GOLD), true); // Mon 00:00 GMT
});

// ── Gold: holiday closures (Globex precious metals) ──────────────────────────

test("gold: New Year's Day and Christmas Day are full closures", () => {
  assert.equal(isBucketExpected(B(2026, 1, 1, 12, 0), IG_SPOT_GOLD), false);
  assert.equal(isBucketExpected(B(2026, 12, 25, 12, 0), IG_SPOT_GOLD), false);
  assert.equal(isBucketExpected(B(2027, 3, 26, 12, 0), IG_SPOT_GOLD), false); // Good Friday 2027
});

// ── Instrument-aware calendars: the two markets MUST diverge ─────────────────

test("calendars diverge: German holidays close the DAX but NOT Gold", () => {
  // 2026-05-01 (Friday, Labour Day — Xetra closed) 06:30 BST = DAX daily break
  const bucket = B(2026, 5, 1, 5, 30); // 05:30 UTC = 06:30 BST
  assert.equal(isBucketExpected(bucket, IG_GERMANY_40), false, "DAX: break AND German holiday");
  assert.equal(isBucketExpected(bucket, IG_SPOT_GOLD), true, "Gold: normal Globex trading");
});

test("calendars agree where both are closed (Christmas Day)", () => {
  const bucket = B(2026, 12, 25, 12, 0);
  assert.equal(isBucketExpected(bucket, IG_GERMANY_40), false);
  assert.equal(isBucketExpected(bucket, IG_SPOT_GOLD), false);
});

// ── DAX regression: the timezone refactor must not move IG_GERMANY_40 ────────

test("DAX regression: BST summer windows unchanged (08:00 UK open)", () => {
  assert.equal(isBucketExpected(B(2025, 8, 5, 7, 0), IG_GERMANY_40), true); // 08:00 BST
  assert.equal(isBucketExpected(B(2025, 8, 5, 6, 57), IG_GERMANY_40), false); // 07:57 BST (break)
  assert.equal(isBucketExpected(B(2025, 8, 9, 7, 0), IG_GERMANY_40), false); // Saturday
});

test("DAX regression: GMT winter windows unchanged (08:00 UK = 08:00 UTC)", () => {
  assert.equal(isBucketExpected(B(2025, 12, 2, 8, 0), IG_GERMANY_40), true);
  assert.equal(isBucketExpected(B(2025, 12, 2, 7, 57), IG_GERMANY_40), false);
});

test("DAX regression: mid-grid open (01:10 UK) admits the touching bucket per grid width", () => {
  // 3m grid: the 01:09–01:12 bucket touches the 01:10 open → expected.
  assert.equal(isBucketExpected(B(2025, 8, 5, 0, 9), IG_GERMANY_40, 180), true);
  assert.equal(isBucketExpected(B(2025, 8, 5, 0, 6), IG_GERMANY_40, 180), false); // 01:06–01:09
  // 1m grid (canonical persisted frame): 01:09 does NOT touch 01:10.
  assert.equal(isBucketExpected(B(2025, 8, 5, 0, 9), IG_GERMANY_40), false);
  assert.equal(isBucketExpected(B(2025, 8, 5, 0, 10), IG_GERMANY_40), true);
});
