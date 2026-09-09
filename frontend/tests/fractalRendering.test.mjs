/**
 * Williams Fractals — Pine `line` rendering regression.
 *
 * Proves the END-TO-END coordinate contract across the rendering layer:
 *   Piner  x1=10 / x2=15  (bar_index)
 *        → normalizeLine(extractLineDrawings)
 *        → resolveAnchorX → Lightweight-Charts coordinate space
 *   renderer x1 → candle 10, x2 → candle 15   (NO clamp to currentBar)
 *
 * Two scenarios:
 *   (A) contiguous candles (no whitespace): chart span is exactly 5 candles.
 *   (B) a 2-slot whitespace gap sits between the pivot (idx 10) and the
 *       endpoint (idx 15): the line must STILL span to candle 15 (the gap is
 *       drawn as empty time, never collapsed), and x2 must NOT be clamped to
 *       the confirmation bar (currentBar=12).
 *
 * Run: npm --prefix frontend run test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { extractLineDrawings, resolveAnchorX } from "../src/services/pineDrawings.ts";
import { remapLogicalToChart } from "../src/services/whitespaceRows.ts";

/** 16 candles, engine idx 0..15. A 2-bucket gap between idx 11 (BASE+11m) and
 *  idx 12 (BASE+14m) injects 2 whitespace slots (BASE+12m, BASE+13m). */
const BASE = 1_704_153_600_000;
const MIN = 60_000;
const WSPACE_KLINES = Array.from({ length: 16 }, (_, i) => ({
  openTime: BASE + (i <= 11 ? i : i + 2) * MIN, // idx 12→+2 slots (gap), idx15→BASE+17m
  high: 1,
  low: 1,
}));
const WSPACE_SLOTS = [BASE + 12 * MIN, BASE + 13 * MIN]; // the 2 missing buckets

/** Contiguous 16 candles, no gaps. */
const CONTIG_KLINES = Array.from({ length: 16 }, (_, i) => ({
  openTime: BASE + i * MIN,
  high: 1,
  low: 1,
}));

function coord(logical) {
  return 10 * (logical + 0.5);
}
/** Fake LWC time scale: registers every real candle time (→ remapped chart logical)
 *  and every whitespace slot; logicalToCoordinate uses the remapped logical. */
function makeTimeScale(klines, slots) {
  const candleTimes = klines.map((k) => k.openTime);
  const registered = new Map();
  for (let i = 0; i < klines.length; i++) {
    registered.set(klines[i].openTime / 1000, remapLogicalToChart(i, candleTimes, slots));
  }
  for (const s of slots) registered.set(s / 1000, NaN); // slots are time-registered; resolveAnchorX uses candle logical
  return {
    timeToCoordinate(timeSec) {
      const g = registered.get(timeSec);
      return g == null || !Number.isFinite(g) ? null : coord(g);
    },
    logicalToCoordinate(logical) {
      return coord(remapLogicalToChart(logical, candleTimes, slots));
    },
  };
}

const RAW_LINE = {
  id: 1,
  x1: 10,
  y1: 110,
  x2: 15,
  y2: 110,
  xloc: "bar_index",
  extend: "none",
  color: "#009688FF",
  style: "line_style_solid",
  width: 2,
  force_overlay: false,
};

test("renderer: normalizeLine preserves Piner x1=10/x2=15 (no clamp to confirmation bar 12)", () => {
  for (const [klines, slots, label] of [
    [CONTIG_KLINES, [], "contiguous"],
    [WSPACE_KLINES, WSPACE_SLOTS, "with-whitespace-gap"],
  ]) {
    const { lines } = extractLineDrawings([{ value: [RAW_LINE] }], klines);
    const ln = lines[0];
    assert.ok(ln, `line must extract in ${label}`);
    assert.equal(ln.logical1, 10, `x1=10 in ${label}`);
    assert.equal(ln.logical2, 15, `x2=15 in ${label} — NOT clamped to currentBar(12)`);
    assert.equal(ln.price1, 110);
    assert.equal(ln.price2, 110, "y1==y2 horizontal");
    assert.equal(ln.xloc, "bar_index");
    assert.equal(ln.extend, "none");
    assert.equal(ln.time1Ms, klines[10].openTime, `time1Ms==candle10 openTime in ${label}`);
    assert.equal(ln.time2Ms, klines[15].openTime, `time2Ms==candle15 openTime in ${label}`);
  }
});

test("renderer: fractional logicals outside the loaded range resolve by the bar grid, never LWC's integer-guard 0", () => {
  // Faithful LWC TimeScale: integer logicals → linear coord; FRACTIONAL
  // logicals → 0 (Lightweight Charts' _internal_indexToCoordinate does
  // `!isInteger(index) → return 0` — the far-LEFT/history edge). This is the
  // exact condition that made an active killzone's START jump to the chart
  // history when the session start fell before the loaded candles.
  const cloud = { logicalToCoordinate: (logical) => (Number.isInteger(logical) ? 10 * (logical + 0.5) : 0) };
  // Killzone start 4.5 candles before the first loaded bar (a common live
  // state as the trailing window advances past the London open).
  const leftLogical = -4.5;
  const x = resolveAnchorX(leftLogical, null, CONTIG_KLINES, [], cloud);
  // Correct extrapolation along the bar grid: coord(-5)→-45, coord(-4)→-35,
  // so -4.5 → -40. It must NEVER be 0 (the history-edge degradation).
  assert.ok(x !== null, "fractional out-of-range logical resolves (not skipped)");
  assert.equal(x, -40, "left edge stays at its true time position (−40), NOT 0");
  // In-range fractional (an in-gap interpolation) also resolves via the grid.
  const x2 = resolveAnchorX(10.5, null, CONTIG_KLINES, [], cloud);
  // coord(10.5) = 10*(10.5+0.5) = 110 — the exact bar-grid position.
  assert.equal(x2, 110, "in-range fractional interpolates along the grid (10.5 → 110)");
  // A null logical still yields null (shape preserved).
  assert.equal(resolveAnchorX(null, null, CONTIG_KLINES, [], cloud), null);
});

test("renderer: line endpoints map to candle 10 → candle 15 across the time scale (incl. whitespace)", () => {
  // Contiguous: span is exactly 5 candles (no clamping).
  {
    const ts = makeTimeScale(CONTIG_KLINES, []);
    const x1 = resolveAnchorX(10, CONTIG_KLINES[10].openTime, CONTIG_KLINES, [], ts);
    const x2 = resolveAnchorX(15, CONTIG_KLINES[15].openTime, CONTIG_KLINES, [], ts);
    assert.equal(x1, coord(10), "contiguous x1 → candle 10");
    assert.equal(x2, coord(15), "contiguous x2 → candle 15");
    const cur = resolveAnchorX(12, CONTIG_KLINES[12].openTime, CONTIG_KLINES, [], ts);
    assert.notEqual(x2, cur, "x2 must NOT equal the confirmation bar (currentBar=12)");
    assert.ok(x2 > cur, "x2 must extend PAST the confirmation bar");
  }
  // Whitespace between pivot(10) and endpoint(15): x2 still lands on candle 15
  // (chart logical 17 = engine 15 + 2 inserted slots), never clamped to currentBar.
  {
    const ts = makeTimeScale(WSPACE_KLINES, WSPACE_SLOTS);
    const x1 = resolveAnchorX(10, WSPACE_KLINES[10].openTime, WSPACE_KLINES, WSPACE_SLOTS, ts);
    const x2 = resolveAnchorX(15, WSPACE_KLINES[15].openTime, WSPACE_KLINES, WSPACE_SLOTS, ts);
    assert.equal(x1, coord(10), "wspace x1 → candle 10 (chart logical 10)");
    assert.equal(x2, coord(17), "wspace x2 → candle 15 (chart logical 15 + 2 slots = 17), gap preserved");
    assert.equal(x2 - x1, coord(17) - coord(10), "span includes the 2 whitespace slots, not collapsed");
    const cur = resolveAnchorX(12, WSPACE_KLINES[12].openTime, WSPACE_KLINES, WSPACE_SLOTS, ts);
    assert.notEqual(x2, cur, "wspace: x2 != currentBar(12 → chart logical 14)");
    assert.ok(x2 > cur, "wspace: x2 extends past the confirmation bar");
  }
});

// ═══ Renderer-level regression: the REAL PineLineBoxPrimitive ════════════════
// Drives the actual drawing primitive (the component Lightweight Charts
// invokes) with REAL Piner engine output and a faithful LWC whitespace
// time-scale model, then inspects the canvas moveTo/lineTo coordinates —
// proving: Piner x1=10 / x2=15  →  renderer draws candle 10 → candle 15.

import { PineLineBoxPrimitive } from "../src/components/TradingChart/pineLineBoxPrimitive.ts";
import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import {
  FRACTAL_CLOSES_NOBREAK,
  FRACTAL_HIGHS,
  FRACTAL_PINE_SOURCE,
  fractalLines,
  fractalScenarioBars,
  fractalUp110,
} from "./fractalFixture.mjs";

const RENDER_SPEC = { id: "fractal-render-regression", source: FRACTAL_PINE_SOURCE, bindings: [] };

/** Fixture bars with a 2-bucket market gap after engine idx 11 (idx 12 sits at
 *  BASE+14m) — the engine sees compacted logicals, the chart inserts 2 slots. */
function gappedFractalBars(H, C) {
  return H.map((h, i) => {
    const c = C[i];
    return {
      ts: BASE + (i <= 11 ? i : i + 2) * MIN,
      open: c - 0.5,
      high: h,
      low: Math.min(c - 1, h - 2),
      close: c,
      volume: 1000,
    };
  });
}

/** LWC time-scale model: every real candle time is registered at its
 *  whitespace-remapped chart logical (whitespace slots occupy their own
 *  coordinates); logicalToCoordinate maps CHART logicals. */
function makeLwcScale(candleTimes, slots) {
  const registered = new Map();
  for (let i = 0; i < candleTimes.length; i++) {
    registered.set(candleTimes[i] / 1000, remapLogicalToChart(i, candleTimes, slots));
  }
  return {
    timeToCoordinate(timeSec) {
      const g = registered.get(timeSec);
      return g == null || !Number.isFinite(g) ? null : coord(g);
    },
    logicalToCoordinate(logical) {
      return coord(remapLogicalToChart(logical, candleTimes, slots));
    },
  };
}


/** Canvas 2D recorder: captures moveTo/lineTo segments, no-ops the rest. */
function makeCtxRecorder() {
  const segments = [];
  let current = null;
  return {
    segments,
    save() {},
    restore() {},
    scale() {},
    beginPath() {},
    setLineDash() {},
    stroke() {},
    fill() {},
    closePath() {},
    moveTo(x, y) {
      current = { x1: x, y1: y };
    },
    lineTo(x, y) {
      if (current) {
        segments.push({ x1: current.x1, y1: current.y1, x2: x, y2: y });
        current = null;
      }
    },
  };
}

const PRICE_TO_Y = (price) => 1000 - price * 8; // linear, finite for all fixture prices
const Y110 = PRICE_TO_Y(110);

/** Render the engine's line drawings through the REAL primitive; return the
 *  canvas segments (bitmap space, pixelRatio 1). */
function renderThroughPrimitive(lines, klines, slots) {
  const prim = new PineLineBoxPrimitive();
  prim.attached({
    chart: { timeScale: () => makeLwcScale(klines.map((k) => k.openTime), slots) },
    series: { priceToCoordinate: PRICE_TO_Y },
    requestUpdate: () => {},
  });
  prim.setAnchorContext(klines, slots);
  prim.setDrawings(lines, []);
  const ctx = makeCtxRecorder();
  prim.renderer.draw({
    useBitmapCoordinateSpace: (cb) =>
      cb({
        context: ctx,
        mediaSize: { width: 4000, height: 600 },
        bitmapSize: { width: 4000, height: 600 },
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      }),
  });
  return ctx.segments;
}

/** The canvas segment for the UP level (the horizontal line at price 110). */
function upSegment(segments) {
  return segments.find((s) => s.y1 === Y110 && s.y2 === Y110);
}

test("renderer primitive: Piner x1=10/x2=15 → canvas draws candle 10 → candle 15 (contiguous)", async () => {
  const bars = fractalScenarioBars(FRACTAL_HIGHS, FRACTAL_CLOSES_NOBREAK);
  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, 60, null);
  const run = await eng.computeScriptVisuals(RENDER_SPEC);
  assert.ok(run, "script must run");
  const up = fractalUp110(fractalLines(run));
  assert.ok(up, "UP level drawing must exist");
  // Piner's exact endpoint report:
  assert.deepEqual(
    { x1: up.logical1, x2: up.logical2, y1: up.price1, y2: up.price2, xloc: up.xloc },
    { x1: 10, x2: 15, y1: 110, y2: 110, xloc: "bar_index" },
  );
  eng.dispose();

  const klines = bars.map((b) => ({ openTime: b.ts, high: b.high, low: b.low }));
  const segments = renderThroughPrimitive(fractalLines(run), klines, []);
  const seg = upSegment(segments);
  assert.ok(seg, "the 110-level line must be stroked on the canvas");
  // What the renderer actually paints (canvas coordinates):
  assert.equal(seg.x1, coord(10), "renderer x1 == candle 10 coordinate");
  assert.equal(seg.x2, coord(15), "renderer x2 == candle 15 coordinate — full 5-candle span, NOT clamped");
  assert.equal(seg.y1, Y110, "renderer y1 == price 110");
  assert.equal(seg.y2, Y110, "renderer y2 == price 110 (horizontal)");
  assert.notEqual(seg.x2, coord(12), "x2 must NOT be the confirmation bar (candle 12)");
  assert.ok(seg.x2 > coord(12), "x2 extends past the confirmation bar");
});

test("renderer primitive: full span across 2 whitespace slots between the endpoints", async () => {
  const bars = gappedFractalBars(FRACTAL_HIGHS, FRACTAL_CLOSES_NOBREAK);
  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, 60, null);
  const run = await eng.computeScriptVisuals(RENDER_SPEC);
  assert.ok(run, "script must run");
  const up = fractalUp110(fractalLines(run));
  assert.ok(up, "UP level drawing must exist");
  assert.equal(up.logical1, 10, "engine logical x1 = pivot 10 (compacted engine space)");
  assert.equal(up.logical2, 15, "engine logical x2 = pivot+5 (compacted engine space)");
  assert.equal(up.time1Ms, BASE + 10 * MIN, "time1Ms = pivot candle openTime");
  assert.equal(up.time2Ms, BASE + 17 * MIN, "time2Ms = endpoint candle openTime (gap-shifted)");
  eng.dispose();

  const klines = bars.map((b) => ({ openTime: b.ts, high: b.high, low: b.low }));
  // pivot (engine 10) sits at chart logical 10; endpoint (engine 15) at chart
  // logical 17 — 2 whitespace slots inserted after chart logical 11.
  const segments = renderThroughPrimitive(fractalLines(run), klines, WSPACE_SLOTS);
  const seg = upSegment(segments);
  assert.ok(seg, "the 110-level line must be stroked on the canvas");
  assert.equal(seg.x1, coord(10), "renderer x1 == pivot candle (chart logical 10)");
  assert.equal(
    seg.x2,
    coord(17),
    "renderer x2 == endpoint candle (chart 15 + 2 slots = 17) — gap crossed, NOT collapsed",
  );
  const confirmChartLogical = remapLogicalToChart(12, klines.map((k) => k.openTime), WSPACE_SLOTS);
  assert.notEqual(seg.x2, coord(confirmChartLogical), "x2 must NOT clamp to the confirmation candle");
  assert.ok(seg.x2 > coord(confirmChartLogical), "x2 extends past the confirmation candle");
});

test("renderer primitive: close-break line visibly ends exactly at the breaking candle", async () => {
  const closes = [...FRACTAL_CLOSES_NOBREAK];
  closes[12] = 110; // first close >= level at engine idx 12
  for (const [gapped, slots, label] of [
    [false, [], "contiguous"],
    [true, WSPACE_SLOTS, "whitespace"],
  ]) {
    const bars = gapped ? gappedFractalBars(FRACTAL_HIGHS, closes) : fractalScenarioBars(FRACTAL_HIGHS, closes);
    const eng = new PinerPineEngine();
    eng.setCandles(bars, null, 60, null);
    const run = await eng.computeScriptVisuals(RENDER_SPEC);
    const up = fractalUp110(fractalLines(run));
    assert.ok(up, `UP level drawing must exist (${label})`);
    assert.equal(up.logical2, 12, `Piner x2 = breaking candle 12 (${label})`);
    eng.dispose();

    const klines = bars.map((b) => ({ openTime: b.ts, high: b.high, low: b.low }));
    const segments = renderThroughPrimitive(fractalLines(run), klines, slots);
    const seg = upSegment(segments);
    assert.ok(seg, `the 110-level line must be stroked on the canvas (${label})`);
    assert.equal(seg.x1, coord(10), `renderer x1 == candle 10 (${label})`);
    const confirmChartLogical = remapLogicalToChart(12, klines.map((k) => k.openTime), slots);
    assert.equal(
      seg.x2,
      coord(confirmChartLogical),
      `renderer x2 == breaking candle 12's exact chart slot (${label})`,
    );
  }
});
