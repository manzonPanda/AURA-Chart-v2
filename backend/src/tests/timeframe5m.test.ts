/**
 * MINUTE_5 (5m) timeframe — registry, aggregation and live-rollover tests.
 *
 * The 5m timeframe is NOT a separate pipeline: it is one row in the shared
 * registry, and every downstream stage (live aggregator set, WS fan-out,
 * history derivation, gap detection, alert engine) is already generic over
 * `bucketSec` / `minutes`. These tests pin that contract so a future refactor
 * cannot quietly break 5m while 1m/3m keep passing.
 *
 * What is covered:
 *   1. Registry      — MINUTE_5 → 300 s → 5 minutes; the round-trip helpers.
 *   2. Aggregation   — 5 × 1m → 1 × 5m with correct OHLC + volume.
 *   3. Boundaries    — the pure epoch grid at 10:00/10:04/10:05/10:09/10:10.
 *   4. Completeness  — a bucket with only 4 of its 5 constituents is NOT emitted.
 *   5. Live rollover — a 5m candle forms, merges and rolls over exactly once at
 *                      the next 5-minute boundary, and is NEVER persisted.
 *
 * Deliberately framework-free (no Hono, no DB, no WS): the same constraint
 * documented in streaming/instrumentPipeline.ts, so `tsx --test` loads it fast.
 *
 * Run: npm --prefix backend run test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_TIMEFRAME,
  STREAM_TIME_FRAMES,
  TIMEFRAME_BUCKET_SEC,
  aggregateCompleteToMinutes,
  bucketOf,
  isPersistedTimeframe,
  minutesFor,
  timeframeForMinutes,
  timeframeLabel,
} from "../streaming/timeframes.js";
import { aggregateToMinutes } from "../streaming/aggregation.js";
import { CandleAggregator } from "../streaming/aggregator.js";
import { createInstrumentUnit, persistenceInstrumentFor } from "../streaming/instrumentPipeline.js";
import { EMA_ALERT_TIMEFRAMES, sanitizeEmaAlertSettings } from "../emaAlert/emaAlertConfig.js";
import type { Candle } from "../types/candle.js";
import type { IngTick } from "../streaming/types.js";

/** 2024-01-08 is a Monday. `sec` = epoch SECONDS of January `d`, `h:m` UTC. */
const sec = (d: number, h: number, m: number): number => Math.floor(Date.UTC(2024, 0, d, h, m) / 1000);

/** A 1m candle at `h:m` with a predictable OHLC. */
const one = (h: number, m: number, o: number, hi: number, lo: number, c: number, v = 10): Candle => ({
  ts: sec(8, h, m) * 1000,
  open: o,
  high: hi,
  low: lo,
  close: c,
  volume: v,
});

/** A tick for CandleAggregator — price only; volume is optional. */
const tick = (h: number, m: number, price: number): IngTick =>
  ({ tsMs: sec(8, h, m) * 1000, price, volume: 0, priceRaw: price }) as unknown as IngTick;

// ── 1. Registry ───────────────────────────────────────────────────────────────

test("registry: MINUTE_5 is a known timeframe at 300 seconds", () => {
  assert.equal(TIMEFRAME_BUCKET_SEC.MINUTE_5, 300);
  assert.ok(STREAM_TIME_FRAMES.includes("MINUTE_5"));
});

test("registry: MINUTE_5 is 5 whole minutes and round-trips through timeframeForMinutes", () => {
  assert.equal(minutesFor("MINUTE_5"), 5);
  assert.equal(timeframeForMinutes(5), "MINUTE_5");
  assert.equal(timeframeLabel("MINUTE_5"), "5m");
});

test("registry: 1m and 3m are unchanged and 1m remains the only persisted frame", () => {
  assert.equal(TIMEFRAME_BUCKET_SEC.MINUTE_1, 60);
  assert.equal(TIMEFRAME_BUCKET_SEC.MINUTE_3, 180);
  assert.equal(CANONICAL_TIMEFRAME, "MINUTE_1");
  assert.equal(isPersistedTimeframe("MINUTE_1"), true);
  // A derived timeframe must NEVER be written to ohlc_candles.
  assert.equal(isPersistedTimeframe("MINUTE_3"), false);
  assert.equal(isPersistedTimeframe("MINUTE_5"), false);
});

test("registry: a closed 5m candle is never assigned a persistence identity", () => {
  const unit = createInstrumentUnit("GOLD", "Gold", 2);
  assert.equal(persistenceInstrumentFor("MINUTE_1", unit), "GOLD");
  assert.equal(persistenceInstrumentFor("MINUTE_3", unit), null);
  assert.equal(persistenceInstrumentFor("MINUTE_5", unit), null);
});

// ── 2. Aggregation — 5 × 1m → 1 × 5m ─────────────────────────────────────────

test("aggregation: 5 consecutive 1m candles merge into one 5m candle", () => {
  const out = aggregateToMinutes(
    [
      one(10, 0, 100, 105, 99, 104), // open of the bucket
      one(10, 1, 104, 110, 103, 108),
      one(10, 2, 108, 109, 100, 101), // lowest low of the bucket
      one(10, 3, 101, 115, 100, 114), // highest high of the bucket
      one(10, 4, 114, 116, 112, 113), // close of the bucket
    ],
    5,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    ts: sec(8, 10, 0) * 1000, // bucket START
    open: 100, // FIRST underlying open
    high: 116, // max high (5th candle reaches 116)
    low: 99, // min low
    close: 113, // LAST underlying close
    volume: 50, // sum
  });
});

test("aggregation: 15 × 1m candles produce 3 × 5m candles on the hour grid", () => {
  const rows: Candle[] = [];
  for (let i = 0; i < 15; i++) rows.push(one(10, i, 100 + i, 101 + i, 99 + i, 100.5 + i, 2));
  const out = aggregateToMinutes(rows, 5);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((c) => c.ts),
    [sec(8, 10, 0) * 1000, sec(8, 10, 5) * 1000, sec(8, 10, 10) * 1000],
  );
  assert.deepEqual(
    out.map((c) => c.volume),
    [10, 10, 10],
  );
  // close of each macro candle is the close of its LAST constituent
  assert.equal(out[0].close, 104.5);
  assert.equal(out[2].close, 114.5);
});

test("aggregation: 5m and 3m buckets do not nest (each request derives independently)", () => {
  // 10:00–10:09 is three 3m buckets but only two complete 5m buckets; a 5m
  // bucket is never a union of 3m buckets and vice versa.
  const rows: Candle[] = [];
  for (let i = 0; i < 10; i++) rows.push(one(10, i, 100 + i, 100 + i, 100 + i, 100 + i));
  const five = aggregateToMinutes(rows, 5);
  const three = aggregateToMinutes(rows, 3);
  assert.deepEqual(five.map((c) => c.ts), [sec(8, 10, 0) * 1000, sec(8, 10, 5) * 1000]);
  // 10:00, 10:03, 10:06, 10:09 → the trailing 10:09 bucket holds a single row
  // (aggregateToMinutes keeps it; aggregateCompleteToMinutes is what drops it).
  assert.deepEqual(
    three.map((c) => c.ts),
    [sec(8, 10, 0) * 1000, sec(8, 10, 3) * 1000, sec(8, 10, 6) * 1000, sec(8, 10, 9) * 1000],
  );
});

// ── 3. Bucket boundaries — the pure epoch grid ───────────────────────────────

test("boundaries: a 5m instant floors to its 5-minute bucket start", () => {
  const at = (m: number) => bucketOf(sec(8, 10, m) * 1000, 300);
  assert.equal(at(0), sec(8, 10, 0), "10:00 → 10:00 (bucket start)");
  assert.equal(at(4), sec(8, 10, 0), "10:04 → 10:00");
  assert.equal(at(5), sec(8, 10, 5), "10:05 → 10:05 (next bucket)");
  assert.equal(at(9), sec(8, 10, 5), "10:09 → 10:05");
  assert.equal(at(10), sec(8, 10, 10), "10:10 → 10:10");
  // Sub-minute precision floors into the containing bucket.
  assert.equal(bucketOf(sec(8, 10, 4) * 1000 + 59_999, 300), sec(8, 10, 0));
  // 1m/3m grids are untouched by the 5m row.
  assert.equal(bucketOf(sec(8, 10, 4) * 1000, 180), sec(8, 10, 3));
  assert.equal(bucketOf(sec(8, 10, 4) * 1000, 60), sec(8, 10, 4));
});

// ── 4. Complete-bucket requirement ────────────────────────────────────────────

test("completeness: a 5m bucket with only 4 of 5 constituents is NOT emitted", () => {
  const complete = aggregateCompleteToMinutes(
    [one(10, 0, 1, 1, 1, 1), one(10, 1, 1, 1, 1, 1), one(10, 2, 1, 1, 1, 1), one(10, 3, 1, 1, 1, 1), one(10, 4, 1, 1, 1, 1)],
    5,
  );
  assert.equal(complete.length, 1, "all five 1m rows ⇒ one 5m candle");

  const short = aggregateCompleteToMinutes(
    [one(10, 5, 1, 1, 1, 1), one(10, 6, 1, 1, 1, 1), one(10, 7, 1, 1, 1, 1), one(10, 8, 1, 1, 1, 1)],
    5,
  );
  assert.deepEqual(short, [], "four of five rows ⇒ omitted, never a short 'complete' candle");
});

test("completeness: a trailing forming 5m bucket stays out of history", () => {
  // 12:03–12:05 plus a forming 12:05 → the 12:00 bucket is complete, 12:05 is not.
  const rows = [one(12, 0, 1, 1, 1, 1), one(12, 1, 1, 1, 1, 1), one(12, 2, 1, 1, 1, 1), one(12, 3, 1, 1, 1, 1), one(12, 4, 1, 1, 1, 1), one(12, 5, 1, 1, 1, 1), one(12, 6, 1, 1, 1, 1)];
  const out = aggregateCompleteToMinutes(rows, 5);
  assert.deepEqual(out.map((c) => c.ts), [sec(8, 12, 0) * 1000]);
});

test("completeness: the same rule already holds for 1m and 3m (no regression)", () => {
  const rows = [one(9, 0, 1, 1, 1, 1), one(9, 1, 1, 1, 1, 1), one(9, 2, 1, 1, 1, 1), one(9, 3, 1, 1, 1, 1)];
  assert.equal(aggregateCompleteToMinutes(rows, 3).length, 1);
  assert.equal(aggregateCompleteToMinutes(rows, 1).length, 4);
});

// ── 5. Live aggregation + rollover ───────────────────────────────────────────

test("live: a 5m candle forms from ticks and merges OHLC correctly", () => {
  const agg = new CandleAggregator(300, "MINUTE_5");
  agg.onTick(tick(10, 0, 100));
  agg.onTick(tick(10, 1, 105));
  agg.onTick(tick(10, 2, 95));
  agg.onTick(tick(10, 3, 110));
  const c = agg.getCandle();
  assert.ok(c);
  assert.equal(c.time, sec(8, 10, 0), "frame time is the bucket START in epoch seconds");
  assert.equal(c.open, 100, "open is the first tick");
  assert.equal(c.high, 110, "high is max");
  assert.equal(c.low, 95, "low is min");
  assert.equal(c.close, 110, "close is the latest tick");
  assert.equal(agg.getClosedCandle(), undefined, "nothing has closed yet");
});

test("live: a 5m candle rolls over exactly once, at the next 5-minute boundary", () => {
  const agg = new CandleAggregator(300, "MINUTE_5");
  agg.onTick(tick(10, 0, 100));
  agg.onTick(tick(10, 4, 120)); // still the 10:00 bucket
  assert.equal(agg.getCandle()?.time, sec(8, 10, 0));
  assert.equal(agg.getClosedCandle(), undefined, "10:04 does NOT close the bucket");

  agg.onTick(tick(10, 5, 121)); // crosses the boundary
  const forming = agg.getCandle();
  assert.equal(forming?.time, sec(8, 10, 5), "a new 5m candle opened at 10:05");

  const closed = agg.getClosedCandle();
  assert.ok(closed, "the 10:00 bucket closed exactly once");
  assert.equal(closed.time, sec(8, 10, 0));
  assert.equal(closed.open, 100);
  assert.equal(closed.high, 120);
  assert.equal(closed.close, 120);

  // Further ticks in the new bucket must not re-close the old one.
  agg.onTick(tick(10, 6, 130));
  assert.equal(agg.getClosedCandle()?.time, sec(8, 10, 0));
  assert.equal(agg.getCandle()?.time, sec(8, 10, 5));
});

test("live: the aggregator set builds a 5m aggregator from the registry alone", () => {
  // No 5m-specific wiring: the set is constructed by mapping over the registry.
  const unit = createInstrumentUnit("GOLD", "Gold", 2);
  unit.aggregators.onTick(tick(10, 2, 100));
  const five = unit.aggregators.getCandleFor(300);
  const one_ = unit.aggregators.getCandleFor(60);
  const three = unit.aggregators.getCandleFor(180);
  assert.ok(five, "a 5m forming candle exists");
  assert.equal(five.time, sec(8, 10, 0));
  assert.equal(one_?.time, sec(8, 10, 2), "the 1m candle sits on its own grid");
  assert.equal(three?.time, sec(8, 10, 0), "3m and 5m share the 10:00 bucket start");
});

// ── 6. EMA alert configuration ───────────────────────────────────────────────

test("alerts: MINUTE_5 is a valid alert timeframe and 1m/3m are unchanged", () => {
  assert.deepEqual([...EMA_ALERT_TIMEFRAMES], ["MINUTE_1", "MINUTE_3", "MINUTE_5"]);
});

test("alerts: the sanitizer accepts 5m and keeps it in an explicit selection", () => {
  const s = sanitizeEmaAlertSettings({ enabled: true, alertTimeframes: ["MINUTE_5"] });
  assert.deepEqual(s.alertTimeframes, ["MINUTE_5"]);
  assert.equal(s.enabled, true);
});

test("alerts: 5m can be enabled alongside 1m and 3m, order-preserved and deduped", () => {
  const s = sanitizeEmaAlertSettings({ alertTimeframes: ["MINUTE_5", "MINUTE_1", "MINUTE_5", "MINUTE_3"] });
  assert.deepEqual(s.alertTimeframes, ["MINUTE_5", "MINUTE_1", "MINUTE_3"]);
});

test("alerts: an unknown timeframe is still rejected, and an empty list stays valid", () => {
  assert.deepEqual(sanitizeEmaAlertSettings({ alertTimeframes: ["MINUTE_15", "MINUTE_5"] }).alertTimeframes, ["MINUTE_5"]);
  assert.deepEqual(sanitizeEmaAlertSettings({ alertTimeframes: [] }).alertTimeframes, []);
  // A missing value falls back to ALL detectors, now including 5m.
  assert.deepEqual(sanitizeEmaAlertSettings({}).alertTimeframes, ["MINUTE_1", "MINUTE_3", "MINUTE_5"]);
});
