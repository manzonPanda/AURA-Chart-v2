/**
 * Frontend timeframe registry — the MINUTE_5 guard.
 *
 * WHY THIS FILE EXISTS: the timeframe→bucket map used to be duplicated in
 * TWO places (config/chart.ts's TIMEFRAMES[] and a hand-written
 * RESOLUTION_BUCKET_SEC in services/realtime.ts) with a `?? 180` fallback.
 * A new backend timeframe added to only one copy failed SILENTLY: the chart
 * drew the new timeframe's candles while every bucketSec consumer — gap
 * bands, whitespace rows, Pine warmup, trade-overlay geometry, the candle
 * countdown — silently computed on the 3m grid.
 *
 * These tests pin the single-source contract so that cannot come back:
 *   1. MINUTE_5 exists at 300 s and is reachable from the selector table.
 *   2. resolutionToBucketSec() resolves every supported timeframe from that
 *      SAME table — no second hand-maintained map.
 *   3. An UNKNOWN timeframe must NOT silently fall back to a real bucket
 *      width (the old `?? 180` behaviour). It falls back to the documented
 *      default ONLY, and callers can detect the unknown key.
 *   4. The 1m/3m mappings are byte-for-byte unchanged (regression guard).
 *
 * Run: npm --prefix frontend run test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { TIMEFRAMES, DEFAULT_TIME_FRAME } from "../src/config/chart.ts";
import { resolutionToBucketSec, isSupportedTimeFrame, DEFAULT_BUCKET_SEC, alignToBucketStart } from "../src/services/realtimeCore.ts";

// ── 1. Registry ───────────────────────────────────────────────────────────────

test("registry: MINUTE_5 is offered by the selector at 300 seconds", () => {
  const five = TIMEFRAMES.find((tf) => tf.key === "MINUTE_5");
  assert.ok(five, "the selector table exposes MINUTE_5");
  assert.equal(five.bucketSec, 300);
  assert.equal(five.label, "5m");
});

test("registry: 1m and 3m are unchanged and the default is still 3m", () => {
  assert.equal(TIMEFRAMES[0].key, "MINUTE_1");
  assert.equal(TIMEFRAMES[0].bucketSec, 60);
  assert.equal(TIMEFRAMES[0].label, "1m");
  assert.equal(TIMEFRAMES[1].key, "MINUTE_3");
  assert.equal(TIMEFRAMES[1].bucketSec, 180);
  assert.equal(TIMEFRAMES[1].label, "3m");
  // The historic 3m-first experience must not change.
  assert.equal(DEFAULT_TIME_FRAME, "MINUTE_3");
});

test("registry: the selector offers exactly 1m, 3m and 5m, in order", () => {
  assert.deepEqual(TIMEFRAMES.map((tf) => tf.key), ["MINUTE_1", "MINUTE_3", "MINUTE_5"]);
});

// ── 2. Single source of truth ─────────────────────────────────────────────────

test("resolution: every supported timeframe resolves to its table bucketSec", () => {
  for (const tf of TIMEFRAMES) {
    assert.equal(resolutionToBucketSec(tf.key), tf.bucketSec, `${tf.key} → ${tf.bucketSec}s`);
  }
});

test("resolution: MINUTE_5 resolves to 300 and can never be read as 180", () => {
  assert.equal(resolutionToBucketSec("MINUTE_5"), 300);
  // The exact silent-failure mode this change had to prevent.
  assert.notEqual(resolutionToBucketSec("MINUTE_5"), 180);
});

test("resolution: MINUTE_1 and MINUTE_3 keep their historical values (regression)", () => {
  assert.equal(resolutionToBucketSec("MINUTE_1"), 60);
  assert.equal(resolutionToBucketSec("MINUTE_3"), 180);
});

// ── 3. No silent fallback to a real timeframe ─────────────────────────────────

test("resolution: an unknown timeframe is detectable, not silently treated as 3m", () => {
  // The old implementation returned 180 for ANY unknown key, which meant a
  // misspelled or not-yet-migrated timeframe drew 3m geometry. Callers that
  // care must be able to tell "unknown" from "3m".
  assert.equal(isSupportedTimeFrame("MINUTE_5"), true);
  assert.equal(isSupportedTimeFrame("MINUTE_3"), true);
  assert.equal(isSupportedTimeFrame("MINUTE_15"), false);
  assert.equal(isSupportedTimeFrame("nonsense"), false);
  assert.equal(isSupportedTimeFrame(""), false);
});

test("resolution: an unknown key still yields a usable bucket width (no crash)", () => {
  // Behaviour preserved for existing callers: a numeric fallback keeps charts
  // rendering. It is now the ONE documented default, and isSupportedTimeFrame()
  // lets a caller detect the situation instead of guessing.
  assert.equal(typeof resolutionToBucketSec("MINUTE_15"), "number");
  assert.equal(resolutionToBucketSec("MINUTE_15"), DEFAULT_BUCKET_SEC);
  assert.equal(resolutionToBucketSec("nonsense"), DEFAULT_BUCKET_SEC);
});

test("resolution: the documented default equals the historic 3m width (behaviour preserved)", () => {
  // Whatever we chose, it must be the value the old `?? 180` produced, so no
  // existing rendering path changes behaviour.
  assert.equal(DEFAULT_BUCKET_SEC, 180);
});

// ── 4. The key type widens from the table ─────────────────────────────────────

test("types: TimeFrameKey derives from the table so MINUTE_5 is assignable", () => {
  // The compile-time half of this assertion lives in src: `TimeFrameKey` is
  // derived from the TIMEFRAMES tuple, so adding a row widens it automatically
  // and a re-hardcoded union would fail `npm run typecheck` at the App.tsx
  // call sites. Here we only pin the runtime half.
  const keys = ["MINUTE_1", "MINUTE_3", "MINUTE_5"];
  assert.deepEqual(keys, TIMEFRAMES.map((tf) => tf.key));
});

// ── 5. Bucket-grid helpers work at 300 s ──────────────────────────────────────

test("grid: alignToBucketStart floors a 5m instant to its 5-minute bucket", () => {
  const sec = (h, m) => Math.floor(Date.UTC(2024, 0, 8, h, m) / 1000) * 1000;
  assert.equal(alignToBucketStart(sec(10, 0), 300), sec(10, 0));
  assert.equal(alignToBucketStart(sec(10, 4), 300), sec(10, 0));
  assert.equal(alignToBucketStart(sec(10, 5), 300), sec(10, 5));
  assert.equal(alignToBucketStart(sec(10, 9), 300), sec(10, 5));
  assert.equal(alignToBucketStart(sec(10, 10), 300), sec(10, 10));
  // 1m/3m grids unaffected.
  assert.equal(alignToBucketStart(sec(10, 4), 180), sec(10, 3));
  assert.equal(alignToBucketStart(sec(10, 4), 60), sec(10, 4));
});
