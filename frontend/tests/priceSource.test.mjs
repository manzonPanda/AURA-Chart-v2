/**
 * Price-source series tests — the Source input of the EMA/SMA settings modal
 * (services/priceSource.ts).
 *
 * Covers: close passthrough (must equal the historical effectiveCloseSeries
 * behavior), hl2/hlc3/ohlc4 math, live-candle merge semantics (same bucket →
 * replace, newer → append, older → ignore), invalid-source fallback, and the
 * EMA/SMA config sanitizers keeping a persisted source field.
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { calculateEMA } from "../src/services/ema.ts";
import { calculateSMA } from "../src/services/sma.ts";
import {
  effectiveSourceSeries,
  isPriceSource,
  sourceValue,
} from "../src/services/priceSource.ts";
import { sanitizeEmaSettings } from "../src/config/emaSettings.ts";
import { sanitizeSmaSettings } from "../src/config/smaSettings.ts";

/** 5 fixed candles: close 10..14, open = close-1, high = close+2, low = close-2. */
function bars() {
  return Array.from({ length: 5 }, (_, i) => ({
    ts: 1_704_153_600_000 + i * 60_000,
    open: 9 + i,
    high: 12 + i,
    low: 8 + i,
    close: 10 + i,
  }));
}

test("priceSource: sourceValue matches the OHLC-derived formulas", () => {
  const b = { ts: 0, open: 10, high: 12, low: 8, close: 11 };
  assert.equal(sourceValue(b, "open"), 10);
  assert.equal(sourceValue(b, "high"), 12);
  assert.equal(sourceValue(b, "low"), 8);
  assert.equal(sourceValue(b, "close"), 11);
  assert.equal(sourceValue(b, "hl2"), 10); // (12+8)/2
  assert.equal(sourceValue(b, "hlc3"), (12 + 8 + 11) / 3);
  assert.equal(sourceValue(b, "ohlc4"), (10 + 12 + 8 + 11) / 4);
});

test("priceSource: close passthrough equals the historical effectiveCloseSeries behavior", () => {
  const bs = bars();
  const got = effectiveSourceSeries(bs, null, 60, "close");
  assert.equal(got.length, bs.length);
  for (let i = 0; i < bs.length; i++) {
    assert.equal(got[i].ts, bs[i].ts);
    assert.equal(got[i].close, bs[i].close);
  }
});

test("priceSource: hl2/hlc3/ohlc4 feed the EMA/SMA math with derived values", () => {
  const bs = bars();
  const hl2 = effectiveSourceSeries(bs, null, 60, "hl2");
  assert.equal(hl2[0].close, (bs[0].high + bs[0].low) / 2);
  // EMA over hl2 must equal EMA computed manually over the hl2 values.
  const manual = bs.map((b) => ({ ts: b.ts, close: (b.high + b.low) / 2 }));
  const emaA = calculateEMA(hl2, 3);
  const emaB = calculateEMA(manual, 3);
  assert.deepEqual(emaA, emaB);
  const ohlc4 = effectiveSourceSeries(bs, null, 60, "ohlc4");
  const smaA = calculateSMA(ohlc4, 3);
  const smaB = calculateSMA(
    bs.map((b) => ({ ts: b.ts, close: (b.open + b.high + b.low + b.close) / 4 })),
    3,
  );
  assert.deepEqual(smaA, smaB);
});

test("priceSource: live candle merges like effectiveCloseSeries (replace/append/ignore)", () => {
  const bs = bars();
  const last = bs[bs.length - 1];
  const bucketSec = 60;
  // Same bucket → the server truth REPLACES the last value (hl2 of the frame).
  const same = effectiveSourceSeries(
    bs,
    { time: Math.floor(last.ts / 1000), open: 1, high: 30, low: 10, close: 20 },
    bucketSec,
    "hl2",
  );
  assert.equal(same.length, bs.length);
  assert.equal(same[same.length - 1].close, (30 + 10) / 2);
  // Newer bucket → appended.
  const newer = effectiveSourceSeries(
    bs,
    { time: Math.floor(last.ts / 1000) + bucketSec, open: 1, high: 30, low: 10, close: 20 },
    bucketSec,
    "hl2",
  );
  assert.equal(newer.length, bs.length + 1);
  assert.equal(newer[newer.length - 1].close, (30 + 10) / 2);
  // Older (stale) frame → ignored.
  const stale = effectiveSourceSeries(
    bs,
    { time: Math.floor(last.ts / 1000) - bucketSec, open: 1, high: 30, low: 10, close: 20 },
    bucketSec,
    "hl2",
  );
  assert.equal(stale.length, bs.length);
  assert.equal(stale[stale.length - 1].close, (last.high + last.low) / 2);
});

test("priceSource: invalid source falls back to close (corrupted storage can never break the chart)", () => {
  assert.equal(isPriceSource("median"), false);
  assert.equal(isPriceSource("close"), true);
  const bs = bars();
  const got = effectiveSourceSeries(bs, null, 60, "median");
  assert.deepEqual(got, effectiveSourceSeries(bs, null, 60, "close"));
});

test("priceSource: EMA/SMA sanitizers keep a persisted source and reject junk", () => {
  const ema = sanitizeEmaSettings({ ema9: { period: 9, source: "hlc3" }, ema20: { source: 42 } });
  assert.equal(ema.ema9.source, "hlc3");
  assert.equal(ema.ema20.source, "close"); // junk → default
  const sma = sanitizeSmaSettings({ period: 50, source: "ohlc4" });
  assert.equal(sma.source, "ohlc4");
  assert.equal(sanitizeSmaSettings({ source: "junk" }).source, "close");
});
