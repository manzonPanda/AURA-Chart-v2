/**
 * Unit tests for the pure EMA core (services/ema.ts) and the EMA settings
 * sanitizer (config/emaSettings.ts). Runs with Node's type stripping:
 *   npm --prefix frontend run test
 * No chart/DOM needed — both modules are framework-free by design (replay
 * engine compatibility).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateEMA,
  effectiveCloseSeries,
  isValidEmaPeriod,
} from "../src/services/ema.ts";
import {
  EMA_SLOTS,
  EMA_STORAGE_KEY,
  defaultEmaSettings,
  hexToRrggbb,
  sanitizeEmaSettings,
} from "../src/config/emaSettings.ts";

const closeTo = (a, b, eps = 1e-12) => {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);
};

// ── calculateEMA: known hand-computed vectors ────────────────────────────────

test("EMA 3 over closes 1..6: SMA seed then standard recursion", () => {
  const bars = [1, 2, 3, 4, 5, 6].map((close, i) => ({ ts: (i + 1) * 1000, close }));
  // multiplier = 2/(3+1) = 0.5; seed = SMA(1,2,3) = 2 @ bar index 2 (ts 3000)
  const pts = calculateEMA(bars, 3);
  assert.equal(pts.length, 4);
  assert.deepEqual(
    pts.map((p) => p.ts),
    [3000, 4000, 5000, 6000],
  );
  closeTo(pts[0].value, 2);
  closeTo(pts[1].value, 4 * 0.5 + 2 * 0.5); // EMA@bar3 = close4·0.5 + ema·0.5 → 3
  closeTo(pts[2].value, 5 * 0.5 + 3 * 0.5); // → 4
  closeTo(pts[3].value, 6 * 0.5 + 4 * 0.5); // → 5
});

test("EMA 9: seed = SMA of first 9 closes, multiplier = 0.2", () => {
  const bars = Array.from({ length: 10 }, (_, i) => ({ ts: (i + 1) * 1000, close: 10 + i }));
  const pts = calculateEMA(bars, 9);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].ts, 9000);
  closeTo(pts[0].value, (10 + 11 + 12 + 13 + 14 + 15 + 16 + 17 + 18) / 9); // 14
  closeTo(pts[1].value, 19 * 0.2 + 14 * 0.8); // 15
});

test("EMA 20 on a constant series is exactly constant (stability)", () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({ ts: (i + 1) * 1000, close: 100 }));
  for (const period of [9, 20]) {
    const pts = calculateEMA(bars, period);
    assert.equal(pts.length, 30 - period + 1);
    for (const p of pts) closeTo(p.value, 100);
  }
});

// ── Shape, alignment and source ─────────────────────────────────────────────

test("point count = n − period + 1; ts aligns to the seed bar and last bar", () => {
  const bars = Array.from({ length: 25 }, (_, i) => ({ ts: 60_000 * (i + 1), close: 50 + i * 0.5 }));
  const pts9 = calculateEMA(bars, 9);
  assert.equal(pts9.length, 25 - 9 + 1);
  assert.equal(pts9[0].ts, 60_000 * 9);
  assert.equal(pts9[pts9.length - 1].ts, 60_000 * 25);
  const pts20 = calculateEMA(bars, 20);
  assert.equal(pts20.length, 6);
  assert.equal(pts20[0].ts, 60_000 * 20);
});

test("uses the CLOSE as source (other OHLC fields ignored)", () => {
  const candles = Array.from({ length: 12 }, (_, i) => ({
    ts: (i + 1) * 1000,
    open: 1,
    high: 999,
    low: 0,
    close: 10 + i,
    volume: 42,
  }));
  const fromCandles = calculateEMA(candles, 9);
  const fromCloses = calculateEMA(candles.map((c) => ({ ts: c.ts, close: c.close })), 9);
  assert.deepEqual(fromCandles, fromCloses);
});

test("period 1 degenerates to the close series", () => {
  const bars = [7, 8, 9].map((close, i) => ({ ts: (i + 1) * 1000, close }));
  const pts = calculateEMA(bars, 1);
  assert.deepEqual(pts, [
    { ts: 1000, value: 7 },
    { ts: 2000, value: 8 },
    { ts: 3000, value: 9 },
  ]);
});

// ── Insufficient history & invalid periods ──────────────────────────────────

test("insufficient history: fewer than `period` candles ⇒ NO values (no misleading EMA 20)", () => {
  const bars19 = Array.from({ length: 19 }, (_, i) => ({ ts: (i + 1) * 1000, close: 100 + i }));
  assert.deepEqual(calculateEMA(bars19, 20), []);
  const bars20 = bars19.concat([{ ts: 20_000, close: 200 }]);
  const pts = calculateEMA(bars20, 20);
  assert.equal(pts.length, 1); // exactly the SMA seed
  closeTo(pts[0].value, bars20.reduce((s, b) => s + b.close, 0) / 20);
});

test("invalid periods (0, negative, float, NaN, Infinity, non-number) ⇒ []", () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({ ts: (i + 1) * 1000, close: 100 }));
  for (const period of [0, -9, 2.5, NaN, Infinity, -Infinity, "9", null, undefined]) {
    assert.deepEqual(calculateEMA(bars, period), [], `period=${String(period)}`);
    assert.equal(isValidEmaPeriod(period), false, `isValid(${String(period)})`);
  }
  assert.equal(isValidEmaPeriod(9), true);
  assert.equal(isValidEmaPeriod(500), true);
  assert.equal(isValidEmaPeriod(501), false);
});

test("non-finite closes are skipped; seed uses the first valid closes", () => {
  const bars = [
    { ts: 1000, close: 1 },
    { ts: 2000, close: NaN },
    { ts: 3000, close: 3 },
  ];
  const pts = calculateEMA(bars, 2);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].ts, 3000);
  closeTo(pts[0].value, 2);
});

// ── effectiveCloseSeries: authoritative forming-candle overlay ───────────────

const bars = (pairs) => pairs.map(([ts, close]) => ({ ts, close }));

test("no live candle ⇒ the bar list passes through (filtered to valid finite rows)", () => {
  assert.deepEqual(effectiveCloseSeries(bars([[60_000, 10], [120_000, 11]]), null, 60), [
    { ts: 60_000, close: 10 },
    { ts: 120_000, close: 11 },
  ]);
  assert.deepEqual(effectiveCloseSeries(bars([[60_000, 10], [120_000, NaN]]), null, 60), [
    { ts: 60_000, close: 10 },
  ]);
});

test("live candle on a NEW bucket ⇒ appended (rollover); the forming close drives the EMA", () => {
  const out = effectiveCloseSeries(bars([[60_000, 10], [120_000, 11]]), { time: 180, close: 11.5 }, 60);
  assert.deepEqual(out, [
    { ts: 60_000, close: 10 },
    { ts: 120_000, close: 11 },
    { ts: 180_000, close: 11.5 },
  ]);
});

test("live candle on the SAME bucket ⇒ REPLACES the last close (server truth wins)", () => {
  // IG's last historical row IS the forming bucket; every WS frame is a full
  // snapshot of it, so the authoritative close replaces the history row.
  const out = effectiveCloseSeries(bars([[60_000, 10], [120_000, 99]]), { time: 120, close: 11.7 }, 60);
  assert.deepEqual(out, [
    { ts: 60_000, close: 10 },
    { ts: 120_000, close: 11.7 },
  ]);
});

test("stale live candle (older bucket) ⇒ ignored", () => {
  const out = effectiveCloseSeries(bars([[180_000, 12]]), { time: 60, close: 9 }, 60);
  assert.deepEqual(out, [{ ts: 180_000, close: 12 }]);
});

test("empty history ⇒ live-only series on the bucket grid (1m and 3m)", () => {
  assert.deepEqual(effectiveCloseSeries([], { time: 3665, close: 20 }, 60), [{ ts: 3_660_000, close: 20 }]);
  // 3m: server time 3600 (01:00:00) → bucket start 3_600_000 ms on the 180s grid
  assert.deepEqual(effectiveCloseSeries([], { time: 3600, close: 30 }, 180), [{ ts: 3_600_000, close: 30 }]);
  assert.deepEqual(effectiveCloseSeries([], { time: 3779, close: 31 }, 180), [{ ts: 3_600_000, close: 31 }]);
});

// ── sanitizeEmaSettings: corrupted localStorage must never break the chart ──

test("defaults: two slots, both enabled, periods 9/20, storage key", () => {
  assert.equal(EMA_STORAGE_KEY, "aura.ema.settings");
  assert.deepEqual(EMA_SLOTS.map((s) => s.id), ["ema9", "ema20"]);
  const def = defaultEmaSettings();
  assert.equal(def.ema9.enabled, true);
  assert.equal(def.ema9.period, 9);
  assert.equal(def.ema20.enabled, true);
  assert.equal(def.ema20.period, 20);
  assert.equal(def.ema9.width, 2);
  assert.equal(def.ema20.width, 2);
});

test("non-object payloads (null, string, number, array) ⇒ wholesale defaults", () => {
  for (const raw of [null, undefined, "garbage", 42, [], ["ema9"]]) {
    assert.deepEqual(sanitizeEmaSettings(raw), defaultEmaSettings(), `raw=${String(raw)}`);
  }
});

test("garbage per-slot values fall back PER FIELD to that slot's defaults", () => {
  const out = sanitizeEmaSettings({
    ema9: { period: 0, color: "red", width: 99, enabled: "yes", extra: 1 },
    ema20: { period: -4, color: 12, width: NaN },
    ema99: { period: 5 },
  });
  assert.deepEqual(out, defaultEmaSettings());
});

test("valid fields are kept; invalid ones fall back individually", () => {
  const out = sanitizeEmaSettings({
    ema9: { enabled: false, period: 12, color: "#FF8800", width: 3 },
    ema20: { enabled: true, period: 20.5, color: "#38bdf8aa", width: 2 },
  });
  assert.deepEqual(out.ema9, { enabled: false, period: 12, color: "#ff8800", width: 3 });
  assert.deepEqual(out.ema20, { enabled: true, period: 20, color: "#38bdf8aa", width: 2 });
});

test("out-of-range values are rejected: period bounds, width bounds", () => {
  const out = sanitizeEmaSettings({
    ema9: { period: 501, width: 5 },
    ema20: { period: -1, width: 0 },
  });
  assert.equal(out.ema9.period, 9);
  assert.equal(out.ema9.width, 2);
  assert.equal(out.ema20.period, 20);
  assert.equal(out.ema20.width, 2);
});

test("sanitizing is idempotent (load → save → load roundtrip)", () => {
  const once = sanitizeEmaSettings({ ema9: { period: 14, color: "#ABCDEF", width: 4, enabled: false } });
  const twice = sanitizeEmaSettings(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});

test("hexToRrggbb expands short hex and strips alpha for the color picker", () => {
  assert.equal(hexToRrggbb("#abc"), "#aabbcc");
  assert.equal(hexToRrggbb("#ABCD"), "#aabbcc");
  assert.equal(hexToRrggbb("#FBBF24"), "#fbbf24");
  assert.equal(hexToRrggbb("#38bdf8"), "#38bdf8");
  assert.equal(hexToRrggbb("#38bdf880"), "#38bdf8");
  assert.equal(hexToRrggbb("nonsense"), "#000000");
});

