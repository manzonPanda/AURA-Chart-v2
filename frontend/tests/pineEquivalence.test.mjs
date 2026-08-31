/**
 * PineTS <-> ema.ts equivalence regression tests.
 *
 * Proves the PineTS `ta.ema()` path produces the same values as AURA's pure
 * reference oracle (`services/ema.ts`) for: EMA 9 / EMA 20, 1m / 3m,
 * insufficient history, forming candle, rollover, timeframe switching,
 * period switching and stale (background-tab) reconciliation.
 *
 * `ema.ts` is the permanent reference oracle and is intentionally never
 * replaced here — its own `tests/ema.test.mjs` still covers the math; this file
 * only proves the PineTS engine matches it.
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { calculateEMA, effectiveCloseSeries } from "../src/services/ema.ts";
import {
  PineIndicatorEngine,
  PINE_EQUIVALENCE_TOL,
} from "../src/services/pineEngine.ts";

/** Pseudo-random close generator; deterministic so runs are reproducible. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 100 - 50;
  };
}

/** Build `n` 1m candles at `startTs` (epoch ms), seeded with deterministic noise. */
function make1m(n, startTs = 1_704_153_600_000, seed = 7) {
  const r = rng(seed);
  let acc = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = acc + r();
    acc = c;
    out.push({
      ts: startTs + i * 60_000,
      open: acc,
      high: Math.max(acc, acc + 1),
      low: Math.min(acc, acc - 1),
      close: c,
      volume: 1000 + i,
    });
  }
  return out;
}

/** Build `n` 3m candles (bucket = 180s). */
function make3m(n, startTs = 1_704_153_600_000, seed = 11) {
  const r = rng(seed);
  let acc = 50;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = acc + r();
    acc = o;
    const c = acc + r();
    out.push({
      ts: startTs + i * 180_000,
      open: o,
      high: Math.max(o, c) + 5,
      low: Math.min(o, c) - 5,
      close: c,
      volume: 1000 + i,
    });
  }
  return out;
}

/** Feed bars+live to a fresh engine and return the ema points for `period`. */
async function pineEma(bars, live, bucketSec, period) {
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, live, bucketSec);
  const pts = await eng.compute("ema", { period });
  eng.dispose();
  return pts;
}

/** Assert PineTS ema points == ema.ts oracle points (within tolerance). */
function assertEquivalent(ref, pine, label) {
  assert.ok(Array.isArray(pine), `${label}: engine returned ${pine}`);
  assert.equal(pine.length, ref.length, `${label}: count ${pine.length} vs ${ref.length}`);
  if (ref.length === 0) return;
  let maxDelta = 0;
  for (let i = 0; i < ref.length; i++) {
    assert.equal(pine[i].ts, ref[i].ts, `${label}: ts misalignment at ${i}`);
    maxDelta = Math.max(maxDelta, Math.abs(pine[i].value - ref[i].value));
  }
  assert.ok(
    maxDelta < PINE_EQUIVALENCE_TOL,
    `${label}: maxDelta ${maxDelta.toExponential(3)} >= tol ${PINE_EQUIVALENCE_TOL}`,
  );
}

// ── 1m history, EMA 9 / EMA 20 ─────────────────────────────────────────────

test("1m: PineTS ta.ema == ema.ts for EMA 9 (320 bars)", async () => {
  const bars = make1m(320);
  const ref = calculateEMA(effectiveCloseSeries(bars, null, 60), 9);
  const pine = (await pineEma(bars, null, 60, 9)) ?? [];
  assertEquivalent(ref, pine, "1m EMA9 hist");
});

test("1m: PineTS ta.ema == ema.ts for EMA 20 (320 bars)", async () => {
  const bars = make1m(320);
  const ref = calculateEMA(effectiveCloseSeries(bars, null, 60), 20);
  const pine = (await pineEma(bars, null, 60, 20)) ?? [];
  assertEquivalent(ref, pine, "1m EMA20 hist");
});

// ── 3m: computed from 3m candles, never from the 1m EMA ────────────────────

test("3m: PineTS ta.ema == ema.ts for EMA 9 (107 3m bars)", async () => {
  const bars = make3m(107);
  const ref = calculateEMA(effectiveCloseSeries(bars, null, 180), 9);
  const pine = (await pineEma(bars, null, 180, 9)) ?? [];
  assertEquivalent(ref, pine, "3m EMA9 hist");
});

test("3m: PineTS ta.ema == ema.ts for EMA 20 (107 3m bars)", async () => {
  const bars = make3m(107);
  const ref = calculateEMA(effectiveCloseSeries(bars, null, 180), 20);
  const pine = (await pineEma(bars, null, 180, 20)) ?? [];
  assertEquivalent(ref, pine, "3m EMA20 hist");
});

test("3m EMA is calculated from 3m closes, not 1m closes", async () => {
  const bars3m = make3m(30);
  const pine = (await pineEma(bars3m, null, 180, 9)) ?? [];
  // 30 bars, period 9 → 30 - 9 + 1 = 22 seeded points
  assert.equal(pine.length, 22, `expected 22 3m points, got ${pine.length}`);
  assert.equal(pine[pine.length - 1].ts, bars3m[bars3m.length - 1].ts, "last point must align to the last 3m candle");
  // Cross-check: feeding the same closes directly to ema.ts yields the same values.
  const ref = calculateEMA(effectiveCloseSeries(bars3m, null, 180), 9);
  assertEquivalent(ref, pine, "3m-from-3m closes");
});

// ── Insufficient history ────────────────────────────────────────────────────

test("insufficient history: 14 bars / EMA 20 yields nothing (== ema.ts)", async () => {
  const bars = make1m(14);
  const ref = calculateEMA(effectiveCloseSeries(bars, null, 60), 20);
  assert.equal(ref.length, 0, "oracle must return 0 points for 14 bars / EMA 20");
  const pine = (await pineEma(bars, null, 60, 20)) ?? [];
  assert.equal(pine.length, 0, "PineTS engine must also yield 0 points");
});

test("insufficient history: engine returns null before any candle is set", async () => {
  const eng = new PineIndicatorEngine();
  const pts = await eng.compute("ema", { period: 9 });
  assert.equal(pts, null, "no data set → null (EmaBridge falls back to the oracle)");
  eng.dispose();
});


// ── Forming candle (same bucket as the last history bar) ──────────────────

test("forming candle (same bucket): PineTS == ema.ts EMA 9", async () => {
  const bars = make1m(300);
  const last = bars[bars.length - 1];
  const live = { time: Math.floor(last.ts / 1000), open: last.open, high: last.high, low: last.low, close: last.close + 7, volume: 2000, timeframe: "1m" };
  const ref = calculateEMA(effectiveCloseSeries(bars, { time: live.time, close: live.close }, 60), 9);
  const pine = (await pineEma(bars, live, 60, 9)) ?? [];
  assertEquivalent(ref, pine, "forming same-bucket EMA9");
});

// ── Bucket rollover (closed candle + new forming candle) ──────────────────

test("rollover: new closed candle + forming next-bucket candle, EMA 9", async () => {
  const bars = make1m(300);
  const last = bars[bars.length - 1];
  const newClosed = { ts: last.ts + 60_000, open: 100, high: 130, low: 90, close: 125, volume: 500 };
  const histRoll = [...bars.slice(0, -1), newClosed];
  const live = { time: Math.floor(newClosed.ts / 1000) + 30, open: 125, high: 135, low: 120, close: 131, volume: 1500, timeframe: "1m" };
  const ref = calculateEMA(effectiveCloseSeries(histRoll, { time: live.time, close: live.close }, 60), 9);
  const pine = (await pineEma(histRoll, live, 60, 9)) ?? [];
  assertEquivalent(ref, pine, "rollover EMA9");
});

// ── Timeframe switching on ONE engine instance ────────────────────────────

test("timeframe switching 1m -> 3m -> 1m stays equivalent to the oracle", async () => {
  const bars1m = make1m(200);
  const bars3m = make3m(80);
  const eng = new PineIndicatorEngine();

  eng.setCandles(bars1m, null, 60);
  const p1 = (await eng.compute("ema", { period: 9 })) ?? [];
  assertEquivalent(calculateEMA(effectiveCloseSeries(bars1m, null, 60), 9), p1, "tf-switch 1m#1");

  eng.setCandles(bars3m, null, 180);
  const p3 = (await eng.compute("ema", { period: 9 })) ?? [];
  assertEquivalent(calculateEMA(effectiveCloseSeries(bars3m, null, 180), 9), p3, "tf-switch 3m");
  assert.equal(p3[p3.length - 1].ts, bars3m[bars3m.length - 1].ts, "3m points must align to 3m candles after switching");

  eng.setCandles(bars1m, null, 60);
  const p1b = (await eng.compute("ema", { period: 9 })) ?? [];
  assertEquivalent(calculateEMA(effectiveCloseSeries(bars1m, null, 60), 9), p1b, "tf-switch 1m#2");

  eng.dispose();
});

// ── Background-tab reconciliation (stale snapshot → server truth) ─────────

test("background-tab: stale live snapshot is re-anchored by the fresh server candle", async () => {
  const bars = make1m(300);
  const last = bars[bars.length - 1];
  // Tab was throttled: the WS snapshot on screen is minutes old...
  const stale = { time: Math.floor(last.ts / 1000), open: last.open, high: last.high, low: last.low, close: last.close, volume: 10, timeframe: "1m" };
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, stale, 60);
  const stalePts = (await eng.compute("ema", { period: 9 })) ?? [];

  // ...on return, the backend pushes the full authoritative server snapshot.
  const fresh = { ...stale, close: last.close + 42, high: last.high + 42 };
  eng.setCandles(bars, fresh, 60);
  const freshPts = (await eng.compute("ema", { period: 9 })) ?? [];

  const refFresh = calculateEMA(effectiveCloseSeries(bars, { time: fresh.time, close: fresh.close }, 60), 9);
  assertEquivalent(refFresh, freshPts, "background-tab fresh re-anchor EMA9");
  // The stale and fresh snapshots genuinely differ...
  assert.notEqual(stalePts[stalePts.length - 1].value, freshPts[freshPts.length - 1].value, "fresh server truth must move the EMA");
  eng.dispose();
});

test("background-tab: unchanged authoritative close stream never recomputes", async () => {
  const bars = make1m(300);
  const last = bars[bars.length - 1];
  // Two WS frames whose *close* is identical (only OHLC cosmetics differ):
  // the engine's data-signature must treat them as the same series.
  const a = { time: Math.floor(last.ts / 1000), open: last.open, high: last.high, low: last.low, close: last.close, volume: 10, timeframe: "1m" };
  const b = { ...a, open: last.open + 0.01, high: last.high + 0.5, low: last.low - 0.5, volume: 999 };
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, a, 60);
  const pts1 = await eng.compute("ema", { period: 9 });
  eng.setCandles(bars, b, 60); // no signature change expected
  const pts2 = await eng.compute("ema", { period: 9 });
  assert.equal(pts1, pts2, "identical close stream must return the memoized result (same array identity)");
  eng.dispose();
});

// ── Period switching on a compiled indicator (no re-transpile) ────────────

test("period switch 9 -> 20 reuses the compiled indicator and matches ema.ts", async () => {
  const bars = make1m(50);
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const p9 = (await eng.compute("ema", { period: 9 })) ?? [];
  const p20 = (await eng.compute("ema", { period: 20 })) ?? [];
  const ref9 = calculateEMA(effectiveCloseSeries(bars, null, 60), 9);
  const ref20 = calculateEMA(effectiveCloseSeries(bars, null, 60), 20);
  assertEquivalent(ref9, p9, "period-switch EMA9");
  assertEquivalent(ref20, p20, "period-switch EMA20");
  assert.equal(p9.length, 42, "EMA9 over 50 bars → 42 points");
  assert.equal(p20.length, 31, "EMA20 over 50 bars → 31 points");
  // Switching back to 9 must return the cached compiled instance's result —
  // still equivalent to the oracle (and identical to the first EMA9 run).
  const p9b = (await eng.compute("ema", { period: 9 })) ?? [];
  assert.equal(p9b, p9, "cached EMA9 result must be reused (same array identity)");
  assertEquivalent(ref9, p9b, "period-switch back to EMA9");
  eng.dispose();
});

