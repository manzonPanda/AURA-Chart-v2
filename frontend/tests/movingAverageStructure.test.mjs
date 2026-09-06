/**
 * Moving Average Structure engine tests (node:test — same runner as ema.test.mjs).
 * The engine is framework-free, so tests import the .ts source directly via the
 * existing strip-types loader (see package.json: "test").
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyStructure,
  structureOrderLabel,
  pairwiseGap,
  pairDirection,
  relationshipStatus,
  gapTrend,
  calculateSlope,
  gapConvergence,
  seedGapHistory,
  updateGapSamples,
  emptyGapSamples,
  emptyGapHistory,
  evaluateMaStructure,
  structureCycleDistance,
  STRUCTURE_CYCLE,
  GAP_TREND_WINDOW,
  MA_PAIR_KEYS,
  MA_STRUCTURE_EMA_FAST,
  MA_STRUCTURE_EMA_SLOW,
  MA_STRUCTURE_SMA_PERIOD,
} from "../src/services/movingAverageStructure.ts";
import { calculateEMA, effectiveCloseSeries } from "../src/services/ema.ts";
import { calculateSMA } from "../src/services/sma.ts";

// ── 1. The six structural states ─────────────────────────────────────────────

test("EMA9 > EMA20 > SMA20 classifies as BULLISH (confirmed)", () => {
  assert.equal(classifyStructure(101, 100, 99), "BULLISH");
  assert.equal(structureOrderLabel(101, 100, 99), "EMA9 > EMA20 > SMA20");
});

test("EMA9 > SMA20 > EMA20 classifies as BULLISH_WEAKENING", () => {
  assert.equal(classifyStructure(101, 99, 100), "BULLISH_WEAKENING");
  assert.equal(structureOrderLabel(101, 99, 100), "EMA9 > SMA20 > EMA20");
});

test("SMA20 > EMA9 > EMA20 classifies as BEARISH_HOLDING — NOT a generic bullish transition", () => {
  // The critical semantic case: EMA9 above EMA20 but BOTH still below SMA20.
  assert.equal(classifyStructure(101, 100, 102), "BEARISH_HOLDING");
  assert.equal(structureOrderLabel(101, 100, 102), "SMA20 > EMA9 > EMA20");
});

test("SMA20 > EMA20 > EMA9 classifies as BEARISH (confirmed)", () => {
  assert.equal(classifyStructure(99, 100, 101), "BEARISH");
  assert.equal(structureOrderLabel(99, 100, 101), "SMA20 > EMA20 > EMA9");
});

test("EMA20 > SMA20 > EMA9 classifies as BEARISH_WEAKENING", () => {
  assert.equal(classifyStructure(99, 101, 100), "BEARISH_WEAKENING");
  assert.equal(structureOrderLabel(99, 101, 100), "EMA20 > SMA20 > EMA9");
});

test("EMA20 > EMA9 > SMA20 classifies as BULLISH_HOLDING — NOT a generic bearish transition", () => {
  // The mirror semantic case: EMA9 has lost EMA20 but BOTH still above SMA20.
  assert.equal(classifyStructure(101, 102, 100), "BULLISH_HOLDING");
  assert.equal(structureOrderLabel(101, 102, 100), "EMA20 > EMA9 > SMA20");
});

test("all six strict orderings are exhaustive and map 1:1 to the six states", () => {
  const [E9, E20, S] = [1, 2, 3]; // identity ranks
  const orderings = [
    [[E9, E20, S], "BULLISH"],
    [[E9, S, E20], "BULLISH_WEAKENING"],
    [[S, E9, E20], "BEARISH_HOLDING"],
    [[S, E20, E9], "BEARISH"],
    [[E20, S, E9], "BEARISH_WEAKENING"],
    [[E20, E9, S], "BULLISH_HOLDING"],
  ];
  const seen = new Set();
  for (const [[a, b, c], expected] of orderings) {
    // Each ordering gets its OWN descending price assignment (a > b > c) —
    // a single fixed value dict can only ever express one strict ordering.
    const values = {};
    values[a] = 102;
    values[b] = 100;
    values[c] = 98;
    const got = classifyStructure(values[E9], values[E20], values[S]);
    assert.equal(got, expected);
    seen.add(got);
  }
  assert.equal(seen.size, 6);
  assert.equal(STRUCTURE_CYCLE.length, 6);
  // Cycle must contain exactly the six states, no extras.
  for (const s of seen) assert.ok(STRUCTURE_CYCLE.includes(s));
});

test("classification is scale-invariant (price level independent)", () => {
  const scale = (k) => [k * 101, k * 100, k * 99];
  for (const k of [0.5, 1, 26.5, 2646.14]) {
    const [a, b, c] = scale(k);
    assert.equal(classifyStructure(a, b, c), "BULLISH");
  }
});

test("cycle distance: neighbors are adjacent, confirmed states are 3 apart", () => {
  assert.equal(structureCycleDistance("BULLISH", "BULLISH_WEAKENING"), 1);
  assert.equal(structureCycleDistance("BULLISH", "BEARISH"), 3);
  assert.equal(structureCycleDistance("BEARISH", "BEARISH_WEAKENING"), 1);
});

test("structural periods are the design's EMA9/EMA20/SMA20", () => {
  assert.equal(MA_STRUCTURE_EMA_FAST, 9);
  assert.equal(MA_STRUCTURE_EMA_SLOW, 20);
  assert.equal(MA_STRUCTURE_SMA_PERIOD, 20);
});


// ── 2. Pairwise gaps ─────────────────────────────────────────────────────────

test("pairwiseGap: signed gap is first − second, distance is |gap|", () => {
  // Float-safe: 2650.5 − 2648.32 is 2.1799…9 in IEEE754, so compare with a
  // 1e-9 tolerance instead of strict equality (the spec's own example).
  const { signedGap, distance } = pairwiseGap(2650.5, 2648.32);
  assert.ok(Math.abs(signedGap - 2.18) < 1e-9);
  assert.ok(Math.abs(distance - 2.18) < 1e-9);
  const mirrored = pairwiseGap(2648.32, 2650.5);
  assert.ok(Math.abs(mirrored.signedGap + 2.18) < 1e-9);
  assert.ok(Math.abs(mirrored.distance - 2.18) < 1e-9);
  // Exact in binary — the sign and symmetry hold to the bit.
  assert.deepEqual(pairwiseGap(2650.5, 2648.5), { signedGap: 2, distance: 2 });
  assert.deepEqual(pairwiseGap(2648.5, 2650.5), { signedGap: -2, distance: 2 });
});

test("pairwiseGap: positive and negative relationships stay exact", () => {
  assert.equal(pairwiseGap(100.25, 100.1).signedGap > 0, true);
  assert.equal(pairwiseGap(100.1, 100.25).signedGap < 0, true);
  assert.equal(pairwiseGap(2650.5, 2650.5).distance, 0);
});

test("pairDirection: above → BULLISH, below → BEARISH (directional vocabulary)", () => {
  assert.equal(pairDirection(2.18), "BULLISH");
  assert.equal(pairDirection(-1.42), "BEARISH");
  assert.equal(pairDirection(0), null);
});

test("relationshipStatus exposes ONLY the four trader-facing labels", () => {
  assert.equal(relationshipStatus("BULLISH", "WIDENING"), "BULLISH");
  assert.equal(relationshipStatus("BULLISH", "NARROWING"), "BULLISH_NEARING");
  assert.equal(relationshipStatus("BEARISH", "WIDENING"), "BEARISH");
  assert.equal(relationshipStatus("BEARISH", "NARROWING"), "BEARISH_NEARING");
  assert.equal(relationshipStatus("BEARISH", "FLAT"), "BEARISH");
  assert.equal(relationshipStatus(null, "NARROWING"), null);
  const allowed = new Set(["BULLISH", "BULLISH_NEARING", "BEARISH", "BEARISH_NEARING"]);
  for (const d of ["BULLISH", "BEARISH"]) {
    for (const t of ["NARROWING", "WIDENING", "FLAT"]) {
      assert.ok(allowed.has(relationshipStatus(d, t)));
    }
  }
});

// ── 3. Gap trend — NEARING requires a genuinely narrowing gap ────────────────

test("gapTrend: distance decreasing → NARROWING", () => {
  assert.equal(gapTrend([5, 4, 3, 2, 1]).trend, "NARROWING");
  assert.ok(gapTrend([5, 4, 3, 2, 1]).slope < 0);
});

test("gapTrend: distance increasing → WIDENING", () => {
  assert.equal(gapTrend([1, 2, 3, 4, 5]).trend, "WIDENING");
  assert.ok(gapTrend([1, 2, 3, 4, 5]).slope > 0);
});

test("gapTrend: flat window stays FLAT", () => {
  assert.equal(gapTrend([2, 2, 2, 2]).trend, "FLAT");
});

test("a small but WIDENING gap is NOT reported as nearing", () => {
  // Gap is numerically small (0.05 → 0.20) but growing — no crossover is near.
  const { trend } = gapTrend([0.05, 0.08, 0.11, 0.14, 0.2]);
  assert.equal(trend, "WIDENING");
  assert.equal(relationshipStatus("BULLISH", trend), "BULLISH");
});

test("a large but NARROWING gap IS nearing — trend, not size, decides", () => {
  // 12 pts and falling: crossing is being approached even though the gap is big.
  const { trend } = gapTrend([12, 10, 8, 6, 4]);
  assert.equal(trend, "NARROWING");
  assert.equal(relationshipStatus("BEARISH", trend), "BEARISH_NEARING");
});

test("gapTrend: noisy-but-flat window does not flip the trend", () => {
  const { trend } = gapTrend([2, 2.01, 1.99, 2.01, 1.99, 2.0]);
  assert.equal(trend, "FLAT");
});

test("gapTrend: fewer than two samples is FLAT by definition", () => {
  assert.equal(gapTrend([]).trend, "FLAT");
  assert.equal(gapTrend([3.3]).trend, "FLAT");
  assert.equal(gapTrend([]).slope, 0);
});

test("gapTrend handles a single-sample step without a threshold artifact", () => {
  assert.equal(gapTrend([0.42, 0.4]).trend, "NARROWING");
  assert.equal(gapTrend([0.4, 0.42]).trend, "WIDENING");
});

// ── 4. Sample fold: one committed sample per CLOSED candle ──────────────────

test("updateGapSamples: per-tick same-bucket updates replace — never multiply samples", () => {
  let s = emptyGapSamples();
  // 40 ticks inside one forming bucket → still exactly one forming sample.
  for (let i = 0; i < 40; i++) {
    s = updateGapSamples(s, 1000, 2.18 - i * 0.001);
  }
  assert.equal(s.samples.length, 0);
  assert.equal(s.ts, 1000);
  // Bucket rollover commits the FINAL (closed) forming distance once.
  s = updateGapSamples(s, 1060, 1.9);
  assert.equal(s.samples.length, 1);
  assert.ok(Math.abs(s.samples[0] - (2.18 - 39 * 0.001)) < 1e-12);
});

test("updateGapSamples: samples cap at the trend window", () => {
  let s = emptyGapSamples();
  for (let i = 0; i < GAP_TREND_WINDOW + 6; i++) {
    s = updateGapSamples(s, 1000 + i * 60, i);
  }
  assert.equal(s.samples.length, GAP_TREND_WINDOW);
  // Oldest samples are evicted, newest retained, in ascending order.
  assert.equal(s.samples[s.samples.length - 1], GAP_TREND_WINDOW + 4);
});

test("updateGapSamples: backward ts RESETS the window (history/replay-seek safety)", () => {
  let s = updateGapSamples(emptyGapSamples(), 1000, 5);
  s = updateGapSamples(s, 1060, 4);
  s = updateGapSamples(s, 1120, 3);
  assert.equal(s.samples.length, 2);
  // Time goes backwards → fresh window; the stale future can never persist.
  s = updateGapSamples(s, 900, 9);
  assert.equal(s.samples.length, 0);
  assert.equal(s.ts, 900);
});

test("updateGapSamples: non-finite input is ignored", () => {
  const s = updateGapSamples(emptyGapSamples(), 1000, 5);
  assert.equal(updateGapSamples(s, 1060, Number.NaN), s);
  assert.equal(updateGapSamples(s, Number.NaN, 5), s);
});

// ── 5. Boundary / equality cases — deterministic, no extra states ────────────

test("exact three-way equality yields one of the six states — deterministically", () => {
  const got = classifyStructure(2650.5, 2650.5, 2650.5);
  assert.ok(STRUCTURE_CYCLE.includes(got));
  // Fixed tie-break (EMA9 > EMA20 > SMA20 priority) → always the same state.
  assert.equal(classifyStructure(2650.5, 2650.5, 2650.5), got);
  assert.equal(classifyStructure(0, 0, 0), classifyStructure(2650.5, 2650.5, 2650.5));
});

test("exact pairwise equality resolves via the fixed tie-break, stably", () => {
  // EMA9 == EMA20, both above SMA20 → BULLISH vs BULLISH_HOLDING are cycle
  // neighbors; the tie-break must pick one and stick to it.
  const a = classifyStructure(2650.5, 2650.5, 2640);
  assert.ok(a === "BULLISH" || a === "BULLISH_HOLDING");
  assert.equal(classifyStructure(2650.5, 2650.5, 2640), a);
  // EMA20 == SMA20 with EMA9 above → BULLISH vs BULLISH_WEAKENING neighbors.
  const b = classifyStructure(2652, 2650.5, 2650.5);
  assert.ok(b === "BULLISH" || b === "BULLISH_WEAKENING");
  assert.equal(classifyStructure(2652, 2650.5, 2650.5), b);
  // EMA9 == SMA20 with EMA20 below → the straddled strict orderings are
  // EMA9 > SMA20 > EMA20 (BULLISH_WEAKENING) and SMA20 > EMA9 > EMA20
  // (BEARISH_HOLDING) — cycle neighbors. The tie-break must pick one.
  const c = classifyStructure(2640, 2638, 2640);
  assert.ok(c === "BULLISH_WEAKENING" || c === "BEARISH_HOLDING");
  assert.equal(structureCycleDistance(
    classifyStructure(2641, 2638, 2640), // EMA9 above → BULLISH_WEAKENING
    classifyStructure(2639, 2638, 2640), // SMA20 above → BEARISH_HOLDING
  ), 1);
  assert.equal(classifyStructure(2640, 2638, 2640), c);
});

test("near-equality within epsilon collapses exactly like exact equality", () => {
  // 1e-10 apart — inside the epsilon band → same as exact equality.
  assert.equal(classifyStructure(100 + 1e-10, 100, 99), classifyStructure(100, 100, 99));
  // 1e-6 apart — outside the band, real ordering wins.
  assert.equal(classifyStructure(100 + 1e-6, 100, 99), "BULLISH");
});

test("crossing a boundary flips to the cycle-ADJACENT state only", () => {
  // BULLISH → BULLISH_WEAKENING is one EMA20/SMA20 swap; the state must move
  // one step on the cycle, never jump straight across it.
  const before = classifyStructure(101, 100, 99.999999); // EMA20 > SMA20
  const after = classifyStructure(101, 100, 100.000001); // SMA20 > EMA20
  assert.equal(before, "BULLISH");
  assert.equal(after, "BULLISH_WEAKENING");
  assert.equal(structureCycleDistance(before, after), 1);
});

// ── 6. Integration — real indicator pipeline, timeframe isolation ───────────

/** Deterministic PRNG walk (seeded — no Math.random flakiness). */
function makeCandles(n, { start = 100, drift = 0, curve = 0, seed = 12345, jitter = 0.4 } = {}) {
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const out = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = open + drift + curve * i + (rand() - 0.5) * jitter;
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    out.push({ ts: (1704067200 + i * 60) * 1000, open, high, low, close, volume: 1000 });
  }
  return out;
}

/** Aggregate 1m candles into 3m buckets (matches the app's derive-3m flow). */
function to3m(candles1m) {
  const out = [];
  for (let i = 0; i < candles1m.length; i += 3) {
    const g = candles1m.slice(i, i + 3);
    if (g.length < 3) break;
    out.push({
      ts: g[0].ts,
      open: g[0].open,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      close: g[g.length - 1].close,
      volume: g.reduce((a, c) => a + c.volume, 0),
    });
  }
  return out;
}

function lastOf(points) {
  return points.length > 0 ? points[points.length - 1].value : null;
}

function secondLastOf(points) {
  return points.length > 1 ? points[points.length - 2].value : null;
}

/** Feed real indicator series through the engine — the app's exact data flow.
 *  withSeries mirrors the panel: it hands the indicator SERIES to the engine so
 *  slopes + seeded convergence history are computed (default off keeps the
 *  original engine-only semantics for the pre-existing tests). */
function evaluateCandles(candles, history = emptyGapHistory(), liveCandle = null, withSeries = false) {
  const closes = effectiveCloseSeries(candles, liveCandle, 60);
  const ema9Series = calculateEMA(closes, 9);
  const ema20Series = calculateEMA(closes, 20);
  const sma20Series = calculateSMA(closes, 20);
  return evaluateMaStructure({
    ema9: lastOf(ema9Series),
    ema20: lastOf(ema20Series),
    sma20: lastOf(sma20Series),
    ts: closes.length > 0 ? closes[closes.length - 1].ts : null,
    history,
    ...(withSeries ? { series: { EMA9: ema9Series, EMA20: ema20Series, SMA20: sma20Series } } : {}),
  });
}

test("integration: 1m structure follows 1m candles (rally → BULLISH)", () => {
  // Accelerating rally (EMA9 pulls away hardest, SMA20 lags everything).
  const candles = makeCandles(130, { start: 100, drift: 0.05, curve: 0.005, seed: 7, jitter: 0.1 });
  const { snapshot } = evaluateCandles(candles);
  assert.equal(snapshot.structure, "BULLISH");
  assert.equal(snapshot.orderLabel, "EMA9 > EMA20 > SMA20");
});

test("integration: 1m structure follows 1m candles (selloff → BEARISH)", () => {
  // Mirror: accelerating decline keeps EMA9 lowest, SMA20 highest.
  const candles = makeCandles(130, { start: 160, drift: -0.05, curve: -0.005, seed: 11, jitter: 0.1 });
  const { snapshot } = evaluateCandles(candles);
  assert.equal(snapshot.structure, "BEARISH");
  assert.equal(snapshot.orderLabel, "SMA20 > EMA20 > EMA9");
});

test("integration: sharp drop + full recovery reads BEARISH_HOLDING (not a bullish flip)", () => {
  // Drop hard, then snap back: EMA9 reclaims EMA20 fastest while BOTH EMAs are
  // still being dragged down by the drop inside SMA20's window — the semantic
  // case the design calls out. (Shape probed against the real ema/sma services.)
  const flat = makeCandles(40, { start: 100, seed: 1, jitter: 0.1 });
  const drop = makeCandles(4, { start: 99.5, drift: -3.0, seed: 1, jitter: 0.1 });
  const recover = makeCandles(4, { start: drop[drop.length - 1].close + 3.5, drift: 3.5, seed: 2, jitter: 0.1 });
  const { snapshot } = evaluateCandles([...flat, ...drop, ...recover]);
  assert.equal(snapshot.orderLabel, "SMA20 > EMA9 > EMA20");
  assert.equal(snapshot.structure, "BEARISH_HOLDING");
});

test("integration: blow-off top + fade reads BULLISH_HOLDING (not a bearish flip)", () => {
  // Mirror shape: EMA9 loses EMA20 on the fade while BOTH stay above SMA20.
  const flat = makeCandles(40, { start: 100, seed: 5, jitter: 0.1 });
  const rise = makeCandles(5, { start: 100.5, drift: 3.0, seed: 5, jitter: 0.1 });
  const fade = makeCandles(5, { start: rise[rise.length - 1].close - 3.3, drift: -3.3, seed: 6, jitter: 0.1 });
  const { snapshot } = evaluateCandles([...flat, ...rise, ...fade]);
  assert.equal(snapshot.orderLabel, "EMA20 > EMA9 > SMA20");
  assert.equal(snapshot.structure, "BULLISH_HOLDING");
});

test("integration: 3m structure follows 3m candles — never 1m structure", () => {
  // Two DIFFERENT series: 1m engineered bullish, its 3m aggregation of a
  // decline engineered bearish. The classification must follow whichever
  // series it is fed — the chart wires one series per selected bucket.
  const flat = makeCandles(30, { start: 100, seed: 21, jitter: 0.1 });
  const rally1m = [...flat, ...makeCandles(100, { start: 115.4, drift: 0.05, curve: 0.005, seed: 21, jitter: 0.1 })];
  const decline1m = [...flat, ...makeCandles(100, { start: 114.6, drift: -0.05, curve: -0.005, seed: 22, jitter: 0.1 })];
  const bear3m = to3m(decline1m);
  const oneMinute = evaluateCandles(rally1m).snapshot;
  const threeMinute = evaluateCandles(bear3m).snapshot;
  assert.equal(oneMinute.structure, "BULLISH");
  assert.equal(threeMinute.structure, "BEARISH");
});

test("null / non-finite inputs return null (warm-up), never a fabricated state", () => {
  assert.equal(classifyStructure(null, 100, 99), null);
  assert.equal(classifyStructure(101, null, 99), null);
  assert.equal(classifyStructure(101, 100, null), null);
  assert.equal(classifyStructure(Number.NaN, 100, 99), null);
  assert.equal(classifyStructure(101, Number.POSITIVE_INFINITY, 99), null);
  assert.equal(structureOrderLabel(101, null, 99), null);
});


test("integration: history loading resolves the warm-up and updates the structure", () => {
  // 18 candles: SMA20 (and so the structure) cannot exist yet → null, no fake.
  const candles = makeCandles(18, { start: 100, drift: 0.3, seed: 9, jitter: 0.1 });
  // Before enough history: SMA20 has no values → structure null (no fake state).
  assert.equal(evaluateCandles(candles).snapshot.structure, null);
  assert.equal(evaluateCandles(candles).snapshot.orderLabel, null);
  // "Load more history" prepends older candles → the triple exists and the
  // structure is classified from the EXPANDED series.
  const history = makeCandles(20, { start: 96, drift: 0.1, seed: 9, jitter: 0.1 }).map((c, i) => ({
    ...c,
    ts: candles[0].ts - (20 - i) * 60_000,
  }));
  const expanded = [...history, ...candles];
  const after = evaluateCandles(expanded).snapshot;
  assert.notEqual(after.structure, null);
  assert.ok(STRUCTURE_CYCLE.includes(after.structure));
  const closes = effectiveCloseSeries(expanded, null, 60);
  assert.equal(
    after.orderLabel,
    structureOrderLabel(
      lastOf(calculateEMA(closes, 9)),
      lastOf(calculateEMA(closes, 20)),
      lastOf(calculateSMA(closes, 20)),
    ),
  );
});

test("integration: live forming candle updates the gap display per tick", () => {
  const candles = makeCandles(60, { start: 100, drift: 0.05, seed: 13 });
  const bucket = candles[candles.length - 1].ts + 60_000;
  const closed = evaluateCandles(candles);
  // Three ticks inside the SAME forming bucket: gap refreshes each tick…
  // (RealtimeCandleMsg.time is epoch SECONDS, exactly as the WS delivers it.)
  let last = null;
  let history = closed.history;
  for (const px of [101.0, 101.4, 101.9]) {
    const live = { time: bucket / 1000, open: 100.8, high: px + 0.2, low: 99.9, close: px };
    last = evaluateCandles(candles, history, live);
    history = last.history;
  }
  assert.notEqual(last.snapshot.relationships[0], null);
  // …but the trend window gained exactly ONE sample for the closed bucket —
  // per-tick updates never multiply samples (single-tick noise cannot trend).
  assert.equal(history.EMA9_EMA20.samples.length, 1);
  assert.equal(history.EMA9_EMA20.ts, bucket);
  // The live evaluation saw the forming close, the closed-only one did not.
  assert.notEqual(
    last.snapshot.relationships[0].signedGap,
    closed.snapshot.relationships[0].signedGap,
  );
});

test("integration: replay slice evaluates in isolation — no leak into live state", () => {
  const candles = makeCandles(80, { start: 100, drift: 0.05, seed: 17 });
  const live = evaluateCandles(candles);
  // A replay seek jumps BACK to an older bucket: the fold must RESET, so the
  // replayed past can never contaminate the live trend window.
  const closes = effectiveCloseSeries(candles, null, 60);
  const replay = evaluateMaStructure({
    ema9: lastOf(calculateEMA(closes.slice(0, 30), 9)),
    ema20: lastOf(calculateEMA(closes.slice(0, 30), 20)),
    sma20: lastOf(calculateSMA(closes.slice(0, 30), 20)),
    ts: candles[10].ts,
    history: live.history, // live history handed in — must NOT survive
  });
  assert.equal(replay.history.EMA9_EMA20.samples.length, 0);
  // And the chart withholds the live forming candle during replay:
  const future = candles[candles.length - 1].ts + 60_000;
  const withLive = evaluateCandles(candles, emptyGapHistory(), {
    time: future / 1000, open: 100, high: 130, low: 90, close: 130,
  });
  const withoutLive = evaluateCandles(candles, emptyGapHistory(), null);
  assert.notEqual(
    withLive.snapshot.relationships[0].signedGap,
    withoutLive.snapshot.relationships[0].signedGap,
  );
  assert.equal(withLive.history.EMA9_EMA20.ts, future);
});

test("integration: effectiveCloseSeries merges the live truth into its own bucket", () => {
  const candles = makeCandles(40, { start: 100, seed: 19 });
  const bucket = candles[candles.length - 1].ts + 60_000;
  const merged = effectiveCloseSeries(
    candles,
    { time: bucket / 1000, open: 100, high: 101, low: 99, close: 100.7 },
    60,
  );
  assert.equal(merged.length, candles.length + 1);
  assert.equal(merged[merged.length - 1].ts, bucket);
  // effectiveCloseSeries emits {ts, close} points — the live truth's close is
  // the point's close (EMA/SMA consume closes only).
  assert.equal(merged[merged.length - 1].close, 100.7);
  // A forming candle from an OLDER bucket is ignored (stale stream guard).
  const stale = effectiveCloseSeries(
    candles,
    { time: (candles[0].ts - 60_000) / 1000, open: 1, high: 1, low: 1, close: 1 },
    60,
  );
  assert.equal(stale.length, candles.length);
});

// ── 8. Display contract: exactly THREE relationship rows, stable identity ────

test("display contract: relationships are exactly MA_PAIR_KEYS in order (panel keys rows by this)", () => {
  // The panel keys each .ma-pair row by MA_PAIR_KEYS[i] — the fixed pair
  // identity — so a pending (null) row keeps the SAME key as the real row it
  // becomes. Regressing to a shared placeholder key ("pending" for every null)
  // made React's reconciler duplicate/orphan rows across the live→replay
  // boundary (blank "—" rows stacked above the real ones). These assertions
  // pin the contract the panel's index-keyed rendering relies on.
  assert.deepEqual(MA_PAIR_KEYS, ["EMA9_EMA20", "EMA9_SMA20", "EMA20_SMA20"]);

  const candles = makeCandles(60, { start: 100, drift: 0.05, seed: 23 });
  const full = evaluateCandles(candles);
  assert.equal(full.snapshot.relationships.length, 3, "exactly three relationship rows");
  assert.deepEqual(
    full.snapshot.relationships.map((rel) => rel?.pair ?? null),
    [...MA_PAIR_KEYS],
  );

  // Warm-up (fewer bars than any period): still exactly three entries — all
  // pending (null). The PANEL keys these by MA_PAIR_KEYS[i], so each pending
  // row keeps the identity of the real row it becomes; the engine's contract
  // is "three slots, in the fixed order".
  const warming = evaluateCandles(candles.slice(0, 5));
  assert.equal(warming.snapshot.relationships.length, 3);
  assert.deepEqual(warming.snapshot.relationships, [null, null, null]);
});

// ── 9. Slope (calculateSlope) ────────────────────────────────────────────────

test("calculateSlope: current > previous → ↗, current < previous → ↘, equal → --", () => {
  assert.equal(calculateSlope(101, 100), "↗");
  assert.equal(calculateSlope(100, 101), "↘");
  assert.equal(calculateSlope(100, 100), "--");
});

test("calculateSlope: tiny float noise inside the epsilon cannot flip the glyph", () => {
  // The engine's structure epsilon convention (1e-9): arithmetic jitter from
  // EMA recursion lands here — a clean flat must READ flat, not start flickering
  // ↗ ↘ ↗ ↘ on every recalculation.
  assert.equal(calculateSlope(100.5 + 1e-11, 100.5), "--");
  assert.equal(calculateSlope(100.5, 100.5 + 1e-11), "--");
  assert.equal(calculateSlope(100.5 - 1e-11, 100.5), "--");
  // A REAL movement just outside the tiny epsilon still classifies normally —
  // no large arbitrary threshold was introduced.
  assert.equal(calculateSlope(100.5 + 1e-6, 100.5), "↗");
  assert.equal(calculateSlope(100.5 - 1e-6, 100.5), "↘");
});

test("calculateSlope: insufficient / non-finite data reads --", () => {
  assert.equal(calculateSlope(null, 100), "--");
  assert.equal(calculateSlope(100, null), "--");
  assert.equal(calculateSlope(NaN, 100), "--");
  assert.equal(calculateSlope(100, Infinity), "--");
});

// ── 10. Convergence (gapConvergence + the fold) ──────────────────────────────

test("gapConvergence: decreasing distance → convergence rises toward the recent max", () => {
  // recent closed gaps [2.40, 1.85, 1.31, 0.72], current 0.31 → 1 − 0.31/2.40.
  const c = gapConvergence([2.4, 1.85, 1.31, 0.72], 0.31);
  assert.ok(c !== null && c > 0.8 && c < 0.9, `expected ≈0.87, got ${c}`);
});

test("gapConvergence: increasing distance → divergence (0), never a false positive", () => {
  assert.equal(gapConvergence([0.31, 0.72, 1.31], 1.85), 0);
  assert.equal(gapConvergence([0.5, 0.9, 1.4], 2.0), 0);
  // Current AT the recent max scores 0 — there is no recently-closed range the
  // pair sits closer to than its own widest observation.
  assert.equal(gapConvergence([1, 2, 3], 3), 0);
});

test("gapConvergence: a small-but-widening gap is NOT converging", () => {
  // 0.09 → 0.15 → 0.27: numerically tiny, still WIDENING. The current gap sits at
  // (or beyond) the recent max, so convergence must read 0 — never "nearing"
  // just because the numbers are small.
  let state = emptyGapSamples();
  const distances = [0.09, 0.15, 0.27];
  let last = null;
  for (let i = 0; i < distances.length; i += 1) {
    state = updateGapSamples(state, 1000 + i * 60_000, distances[i]);
    if (i > 0) {
      const c = gapConvergence(state.samples, state.forming);
      assert.equal(c, 0, `step ${i} must read 0, got ${c}`);
      last = c;
    }
  }
  assert.equal(last, 0);
});

test("gapConvergence: folding the user's example sequence is strong convergence (monotone up)", () => {
  const seq = [2.4, 1.85, 1.31, 0.72, 0.31];
  let state = emptyGapSamples();
  let prev = 0;
  let got = null;
  for (let i = 0; i < seq.length; i += 1) {
    state = updateGapSamples(state, 1000 + i * 60_000, seq[i]);
    const c = gapConvergence(state.samples, state.forming);
    if (state.samples.length > 0) {
      assert.ok(
        c !== null && c + 1e-12 >= prev,
        `convergence must rise monotonically at step ${i} (got ${c}, prev ${prev})`,
      );
      prev = c;
      got = c;
    }
  }
  assert.ok(got !== null && got > 0.8, `strong convergence expected ≈0.87, got ${got}`);
});

test("gapConvergence: divergence sequence stays at 0 throughout the fold", () => {
  const seq = [0.31, 0.72, 1.31, 1.85];
  let state = emptyGapSamples();
  const reads = [];
  for (let i = 0; i < seq.length; i += 1) {
    state = updateGapSamples(state, 1000 + i * 60_000, seq[i]);
    if (state.samples.length > 0) reads.push(gapConvergence(state.samples, state.forming));
  }
  for (const c of reads) assert.equal(c, 0, "divergence must never register convergence");
});

test("gapConvergence: no recent closed history → null (nothing to calibrate against)", () => {
  assert.equal(gapConvergence([], 1.5), null);
  assert.equal(gapConvergence([], null), null);
});

// ── 11. Series seeding (history load → ready-to-render visuals) ──────────────

test("seedGapHistory: a fresh history seeds the closed gap window from the loaded series", () => {
  const candles = makeCandles(60, { start: 100, drift: 0.05, seed: 13 });
  const once = evaluateCandles(candles, emptyGapHistory(), null, true);
  // The loaded CLOSED buckets fill the trend window immediately (not 1 sample),
  // so the convergence/trend visuals have recent history on first paint.
  assert.ok(
    once.history.EMA9_EMA20.samples.length >= 2,
    `expected seeded closed samples, got ${once.history.EMA9_EMA20.samples.length}`,
  );
  assert.equal(once.history.EMA9_EMA20.samples.length, GAP_TREND_WINDOW);
  assert.ok(
    once.snapshot.relationships[0] !== null &&
      once.snapshot.relationships[0].convergence !== null,
    "convergence must be available right after history load",
  );
});

test("seedGapHistory: re-folding the same bucket replaces in place (idempotent)", () => {
  const candles = makeCandles(60, { start: 100, drift: 0.05, seed: 13 });
  const closes = effectiveCloseSeries(candles, null, 60);
  const ema9Series = calculateEMA(closes, 9);
  const ema20Series = calculateEMA(closes, 20);
  const sma20Series = calculateSMA(closes, 20);
  const input = {
    ema9: lastOf(ema9Series),
    ema20: lastOf(ema20Series),
    sma20: lastOf(sma20Series),
    ts: closes[closes.length - 1].ts,
    history: emptyGapHistory(),
    series: { EMA9: ema9Series, EMA20: ema20Series, SMA20: sma20Series },
  };
  const first = evaluateMaStructure(input);
  const second = evaluateMaStructure({ ...input, history: first.history });
  assert.equal(second.history.EMA9_EMA20.samples.length, first.history.EMA9_EMA20.samples.length);
  assert.equal(second.history.EMA9_EMA20.forming, first.history.EMA9_EMA20.forming);
  assert.equal(second.history.EMA9_EMA20.ts, first.history.EMA9_EMA20.ts);
});

test("seedGapHistory: already-folded or live histories are never re-seeded", () => {
  const candles = makeCandles(60, { start: 100, drift: 0.05, seed: 13 });
  const closes = effectiveCloseSeries(candles, null, 60);
  const ema9Series = calculateEMA(closes, 9);
  const ema20Series = calculateEMA(closes, 20);
  const sma20Series = calculateSMA(closes, 20);
  // A history that already carries one folded forming sample must never be
  // back-seeded from the series — the sample clock stays exactly where the
  // live fold left it (only the same-bucket forming value is refreshed).
  const folded = updateGapSamples(emptyGapSamples(), closes[closes.length - 1].ts, 1.23);
  const evaled = evaluateMaStructure({
    ema9: lastOf(ema9Series),
    ema20: lastOf(ema20Series),
    sma20: lastOf(sma20Series),
    ts: closes[closes.length - 1].ts,
    history: { ...emptyGapHistory(), EMA9_EMA20: folded },
    series: { EMA9: ema9Series, EMA20: ema20Series, SMA20: sma20Series },
  });
  assert.equal(
    evaled.history.EMA9_EMA20.samples.length,
    0,
    "non-pristine history must not gain a seeded closed window",
  );
  // The fold DOES refresh the same-bucket forming value (measured from the
  // series) — the normal live contract, not a re-seed.
  assert.equal(
    evaled.history.EMA9_EMA20.forming,
    Math.abs(lastOf(ema9Series) - lastOf(ema20Series)),
  );
});

// ── 12. Slopes + convergence through the engine (real indicator series) ──────

test("slopes follow the selected-timeframe indicator series (indicator movement, not candle wording)", () => {
  // Accelerating rally → EMA9 genuinely rising (↗); accelerating selloff → falling (↘).
  const rally = makeCandles(130, { start: 100, drift: 0.05, curve: 0.005, seed: 7, jitter: 0.1 });
  const selloff = makeCandles(130, { start: 160, drift: -0.045, curve: -0.005, seed: 11, jitter: 0.1 });
  const bull = evaluateCandles(rally, emptyGapHistory(), null, true).snapshot;
  const bear = evaluateCandles(selloff, emptyGapHistory(), null, true).snapshot;

  assert.equal(bull.structure, "BULLISH");
  assert.equal(bear.structure, "BEARISH");
  assert.equal(bull.relationships[0].firstSlope, "↗");
  assert.equal(bear.relationships[0].firstSlope, "↘");
  // All three relationships carry the new fields.
  for (const rel of bull.relationships) {
    assert.ok(rel !== null);
    assert.ok(["↗", "↘", "--"].includes(rel.firstSlope), rel.firstSlope);
    assert.ok(["↗", "↘", "--"].includes(rel.secondSlope), rel.secondSlope);
    assert.equal(typeof rel.convergence, "number");
  }
});

test("timeframe: 1m rally and 3m selloff use their own selected-timeframe series", () => {
  const flat = makeCandles(30, { start: 100, seed: 21, jitter: 0.1 });
  const rally1m = [...flat, ...makeCandles(100, { start: 115.4, drift: 0.05, curve: 0.005, seed: 21, jitter: 0.1 })];
  const decline1m = [...flat, ...makeCandles(100, { start: 114.6, drift: -0.05, curve: -0.005, seed: 22, jitter: 0.1 })];
  const bear3m = to3m(decline1m);

  const oneMinute = evaluateCandles(rally1m, emptyGapHistory(), null, true).snapshot;
  const threeMinute = evaluateCandles(bear3m, emptyGapHistory(), null, true).snapshot;

  assert.equal(oneMinute.structure, "BULLISH");
  assert.equal(threeMinute.structure, "BEARISH");
  assert.equal(oneMinute.relationships[0].firstSlope, "↗");
  assert.equal(threeMinute.relationships[0].firstSlope, "↘");
});

test("pair independence: EMA9/EMA20 convergence never affects EMA20/SMA20", () => {
  // Deterministic synthetic series bundle — pair0 converges, pair2 diverges,
  // sharing identical buckets. Each pair must normalize ONLY against its own
  // recent gap history.
  const mk = (vals, start = 1000) => vals.map((v, i) => ({ ts: start + i * 60_000, value: v }));
  const ema9Series = mk([106.5, 106.0, 105.4, 105.0]); // falls toward pinned EMA20
  const ema20Series = mk([105.0, 105.0, 105.0, 105.0]);
  const sma20Series = mk([106.0, 106.4, 106.9, 107.5]); // runs away (widening)

  const evaled = evaluateMaStructure({
    ema9: 105.0,
    ema20: 105.0,
    sma20: 107.5,
    ts: 1000 + 3 * 60_000,
    history: emptyGapHistory(),
    series: { EMA9: ema9Series, EMA20: ema20Series, SMA20: sma20Series },
  });
  const [pair0, , pair2] = evaled.snapshot.relationships;

  // pair0 (EMA9/EMA20): 1.5 → 1.0 → 0.4 → 0.0 — strong convergence.
  assert.ok(pair0.convergence !== null && pair0.convergence >= 0.99, `got ${pair0.convergence}`);
  // pair2 (EMA20/SMA20): 1.0 → 1.4 → 1.9 → 2.5 — pure divergence.
  assert.equal(pair2.convergence, 0);
  // Slopes from indicator movement: EMA9 falling ↘, EMA20 flat --, SMA20 rising ↗.
  assert.equal(pair0.firstSlope, "↘");
  assert.equal(pair0.secondSlope, "--");
  assert.equal(pair2.secondSlope, "↗");
  // Their histories are independent — the converging window never leaks into
  // the diverging pair's samples.
  assert.equal(evaled.history.EMA9_EMA20.samples.length, 3);
  assert.equal(evaled.history.EMA20_SMA20.samples.length, 3);
  assert.notEqual(
    evaled.history.EMA9_EMA20.samples[0],
    evaled.history.EMA20_SMA20.samples[0],
  );
});

test("replay: slopes + convergence derive from the replay slice — nothing leaks from live", () => {
  const candles = makeCandles(90, { start: 100, drift: 0.05, seed: 17 });
  // LIVE side: full data with series → seeded live history + live slopes.
  const live = evaluateCandles(candles, emptyGapHistory(), null, true);
  assert.ok(live.history.EMA9_EMA20.samples.length >= 2, "live history populated");

  // Replay enters on a backward cursor slice (the app resets historyRef, so the
  // engine sees a PRISTINE history + the slice's series).
  const slice = candles.slice(15, 55);
  const closes = effectiveCloseSeries(slice, null, 60);
  const ema9Series = calculateEMA(closes, 9);
  const ema20Series = calculateEMA(closes, 20);
  const sma20Series = calculateSMA(closes, 20);
  const replay = evaluateMaStructure({
    ema9: lastOf(ema9Series),
    ema20: lastOf(ema20Series),
    sma20: lastOf(sma20Series),
    ts: closes[closes.length - 1].ts,
    history: emptyGapHistory(),
    series: { EMA9: ema9Series, EMA20: ema20Series, SMA20: sma20Series },
  });
  // Convergence + samples come from the REPLAY slice, forward-folded from a
  // fresh history — none of the live window survives.
  assert.equal(replay.history.EMA9_EMA20.samples.length, GAP_TREND_WINDOW);
  assert.ok(
    replay.snapshot.relationships[0].convergence !== null,
    "replay convergence derived from replay gap history",
  );
  assert.equal(
    replay.snapshot.relationships[0].firstSlope,
    calculateSlope(lastOf(ema9Series), secondLastOf(ema9Series)),
  );
  // Replay EXIT: a fresh evaluation against the full LIVE series re-seeds from
  // live data — slopes/conv reflect live again, never a replay residue.
  const liveAgain = evaluateCandles(candles, emptyGapHistory(), null, true);
  assert.equal(liveAgain.snapshot.relationships[0].firstSlope, live.snapshot.relationships[0].firstSlope);
  assert.equal(liveAgain.snapshot.relationships[0].signedGap, live.snapshot.relationships[0].signedGap);
});

