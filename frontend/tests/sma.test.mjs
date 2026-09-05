/**
 * Unit tests for the pure SMA core (services/sma.ts).
 *
 * Runs with Node's type stripping:
 *   npm --prefix frontend run test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateSMA,
  isValidSmaPeriod,
  MIN_SMA_PERIOD,
  MAX_SMA_PERIOD,
} from "../src/services/sma.ts";
import {
  SMA_PERIODS,
  DEFAULT_SMA_SETTINGS,
  defaultSmaSettings,
  sanitizeSmaSettings,
  hexToRrggbbSma,
} from "../src/config/smaSettings.ts";

function makeBars(closes) {
  return closes.map((c, i) => ({ ts: i * 1000, close: c }));
}

test("SMA 3 over closes [2,4,6,8,10]: first SMA = mean(2,4,6) = 4", () => {
  const pts = calculateSMA(makeBars([2, 4, 6, 8, 10]), 3);
  assert.equal(pts.length, 3);
  assert.equal(pts[0].value, 4);
  assert.equal(pts[1].value, 6);
  assert.equal(pts[2].value, 8);
  assert.equal(pts[0].ts, 2000);
});

test("SMA 9 matches known hand-computed value", () => {
  const closes = [100, 102, 99, 104, 98, 105, 101, 103, 100, 106, 104];
  const pts = calculateSMA(makeBars(closes), 9);
  assert.equal(pts.length, 3);
  const firstSma = closes.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  assert.ok(Math.abs(pts[0].value - firstSma) < 1e-12);
});

test("SMA 20 produces correct count", () => {
  const pts = calculateSMA(makeBars(Array.from({ length: 30 }, () => 50)), 20);
  assert.equal(pts.length, 11);
});

test("SMA over constant closes = the constant", () => {
  const pts = calculateSMA(makeBars(Array.from({ length: 50 }, () => 100)), 20);
  for (const p of pts) assert.equal(p.value, 100);
});

test("insufficient candles: 14 bars / SMA 20 yields nothing", () => {
  assert.equal(calculateSMA(makeBars(Array.from({ length: 14 }, () => 50)), 20).length, 0);
});

test("exactly period candles yields exactly 1 SMA point", () => {
  const pts = calculateSMA(makeBars([1, 2, 3, 4, 5]), 5);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].value, 3);
});

test("period 1 degenerates to the close series", () => {
  const pts = calculateSMA(makeBars([10, 20, 30]), 1);
  assert.equal(pts.length, 3);
  assert.deepEqual(pts.map((p) => p.value), [10, 20, 30]);
});

test("invalid periods return []", () => {
  const bars = makeBars([1, 2, 3, 4, 5]);
  assert.equal(calculateSMA(bars, 0).length, 0);
  assert.equal(calculateSMA(bars, -1).length, 0);
  assert.equal(calculateSMA(bars, 1.5).length, 0);
  assert.equal(calculateSMA(bars, NaN).length, 0);
  assert.equal(calculateSMA(bars, Infinity).length, 0);
  assert.equal(calculateSMA(bars, 99999).length, 0);
});

test("non-array input returns []", () => {
  assert.equal(calculateSMA(null, 10).length, 0);
  assert.equal(calculateSMA(undefined, 10).length, 0);
  assert.equal(calculateSMA("x", 10).length, 0);
});

test("bars with non-finite ts/close are skipped", () => {
  const bars = [
    { ts: 0, close: 10 },
    { ts: 1000, close: NaN },
    { ts: 2000, close: 20 },
    { ts: 3000, close: 30 },
  ];
  const pts = calculateSMA(bars, 2);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].value, 15);
  assert.equal(pts[1].value, 25);
});

test("window slides: adding a candle adds exactly one new point", () => {
  const a = calculateSMA(makeBars([1, 2, 3, 4, 5, 6, 7, 8, 9]), 9);
  const b = calculateSMA(makeBars([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
  assert.equal(b[0].value, a[0].value);
  assert.equal(b[1].value, (2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10) / 9);
});

test("changing period changes point count", () => {
  const bars = makeBars(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(calculateSMA(bars, 9).length, 92);
  assert.equal(calculateSMA(bars, 20).length, 81);
  assert.equal(calculateSMA(bars, 200).length, 0);
});

test("all SMA_PERIODS are valid and match expected set", () => {
  for (const p of SMA_PERIODS) assert.ok(isValidSmaPeriod(p));
  assert.deepEqual(SMA_PERIODS, [9, 20, 50, 100, 200]);
});

test("MIN/MAX bounds", () => {
  assert.equal(MIN_SMA_PERIOD, 1);
  assert.equal(MAX_SMA_PERIOD, 1000);
});

// ── Settings persistence ───────────────────────────────────────────────────────

test("defaultSmaSettings returns a fresh object each call", () => {
  const a = defaultSmaSettings();
  const b = defaultSmaSettings();
  assert.notEqual(a, b);
  assert.deepEqual(a, DEFAULT_SMA_SETTINGS);
});

test("sanitizeSmaSettings fills defaults for corrupted input", () => {
  const bad = { enabled: "yes", period: -5, color: "nope", width: "thick" };
  assert.deepEqual(sanitizeSmaSettings(bad), defaultSmaSettings());
});

test("sanitizeSmaSettings preserves valid fields", () => {
  const clean = sanitizeSmaSettings({ enabled: false, period: 50, color: "#ff0000", width: 3 });
  assert.equal(clean.enabled, false);
  assert.equal(clean.period, 50);
  assert.equal(clean.color, "#ff0000");
  assert.equal(clean.width, 3);
});

test("hexToRrggbbSma expands 3-digit hex", () => {
  assert.equal(hexToRrggbbSma("#abc"), "#aabbcc");
  assert.equal(hexToRrggbbSma("#a78bfa"), "#a78bfa");
  assert.equal(hexToRrggbbSma("#a78bfa00"), "#a78bfa");
  assert.equal(hexToRrggbbSma("#ABC"), "#aabbcc");
  assert.equal(hexToRrggbbSma("nope"), "#000000");
});

