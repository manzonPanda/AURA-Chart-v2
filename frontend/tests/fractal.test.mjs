/**
 * Williams Fractals regression — `fractal.pine` level rendering.
 *
 * RENDERING MODEL (migrated from line.new() drawings to plot.style_linebr):
 * each level is a SINGLE linebr plot series ("Up level 1" / "Down level 1").
 * With `offset = -n` the value computed on the confirmation bar b is DRAWN on
 * bar b - n = the pivot bar, so the level's FIRST finite row sits on the pivot
 * candle and equals its wick (Up → high, Down → low). na bars are emitted as
 * value-less WHITESPACE rows, so the line BREAKS between one level's lifetime
 * and the next (no diagonal joins). This replaces the old per-pivot line-object
 * model (which saturated TradingView's max_lines_count=500 on long histories).
 *
 * The confirmed UP level is at pivot 10 / price 110 (n=2, confirmation bar 12).
 * A close >= level after the pivot ends the level; a wick touch does NOT.
 * These tests assert that contract over the REAL engine output.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import {
  FRACTAL_CLOSES_NOBREAK,
  FRACTAL_HIGHS,
  FRACTAL_PINE_SOURCE,
  finiteRows,
  finiteSegments,
  fractalDnSeries,
  fractalScenarioBars,
  fractalUpSeries,
} from "./fractalFixture.mjs";

const SPEC = { id: "fractal-regression", source: FRACTAL_PINE_SOURCE, bindings: [] };

function engineOver(bars) {
  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, 60, null);
  return eng;
}

/** Run the script and return { run, up, dn } plus a dispose(). */
async function runLevels(bars) {
  const eng = engineOver(bars);
  const run = await eng.computeScriptVisuals(SPEC);
  eng.dispose();
  return { run, up: fractalUpSeries(run), dn: fractalDnSeries(run) };
}

test("fractal: unbroken UP level spans pivot(10)->pivot+5(15) on the pivot wick", async () => {
  const bars = fractalScenarioBars(FRACTAL_HIGHS, FRACTAL_CLOSES_NOBREAK);
  const { run, up } = await runLevels(bars);
  assert.ok(run, "script must run");
  assert.equal(run.diagnostics.unsupported.length, 0, "no silently unsupported line feature");
  assert.ok(up, "Up level 1 linebr series must exist");
  assert.equal(up.breakOnNa, true, "the level is a style_linebr series");

  const rows = finiteRows(up, bars);
  assert.equal(rows.length, 6, "the level lives 6 finite bars (pivot .. pivot+5)");
  // offset=-n puts the FIRST finite row exactly on the pivot candle (idx 10)…
  assert.equal(rows[0].idx, 10, "first finite row is the pivot candle");
  assert.equal(rows[0].value, 110, "level price = pivot high");
  assert.equal(bars[10].high, 110, "sanity: pivot candle high is 110");
  // …and it extends the full 5-candle lifetime to idx 15.
  assert.equal(rows[rows.length - 1].idx, 15, "last finite row is pivot+5");
  assert.ok(rows.every((r) => r.value === 110), "the level is horizontal");

  // Unique, strictly-ascending timestamps — the property LWC requires and the
  // reason an offset plot must DROP off-edge values, never clamp them.
  const ts = up.data.map((p) => p.ts);
  assert.equal(new Set(ts).size, ts.length, "no duplicate timestamps");
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1], "timestamps strictly ascending");
});

test("fractal: first close >= level ends the level WITH the breaking candle included", async () => {
  // A close that reaches the level at display bar bp truncates the level at
  // bp + n (the emission bar that draws bp), still >= the breaking candle.
  for (const [bp, expectedLast] of [
    [10, 12],
    [11, 13],
    [12, 14],
  ]) {
    const closes = [...FRACTAL_CLOSES_NOBREAK];
    closes[bp] = 110; // close >= level on display bar bp
    const bars = fractalScenarioBars(FRACTAL_HIGHS, closes);
    const { up } = await runLevels(bars);
    assert.ok(up, `Up level must exist (break@${bp})`);
    const rows = finiteRows(up, bars);
    assert.equal(rows[0].idx, 10, `break@${bp}: still starts on the pivot`);
    assert.equal(rows[rows.length - 1].idx, expectedLast, `break@${bp}: last finite row = ${expectedLast} (bp + n)`);
    assert.ok(rows.some((r) => r.idx === bp), `break@${bp}: the breaking candle is included`);
    assert.ok(rows[rows.length - 1].idx < 15, `break@${bp}: level is truncated below the full lifetime`);
  }
});

test("fractal: wick touch without a close break does NOT stop the level", async () => {
  // A bar whose HIGH pierces the level (112) but whose CLOSE stays below (104)
  // is a wick touch — it must NOT truncate the level.
  const H = [...FRACTAL_HIGHS];
  const C = [...FRACTAL_CLOSES_NOBREAK];
  H[13] = 112;
  C[13] = 104;
  const bars = fractalScenarioBars(H, C);
  const { up } = await runLevels(bars);
  assert.ok(up, "UP level must exist");
  const rows = finiteRows(up, bars);
  assert.equal(rows[0].idx, 10, "starts on the pivot");
  assert.equal(rows[rows.length - 1].idx, 15, "wick-only touch must NOT truncate — full lifetime");
  assert.equal(rows[0].value, 110, "level price unchanged by the wick touch");
});


test("fractal DOWN mirror: unbroken support spans pivot(10)->pivot+5(15); close break truncates", async () => {
  const H = [110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100, 101, 102, 103, 104, 105, 106, 107];
  const Lw = [109, 108, 107, 106, 105, 104, 103, 102, 101, 100, 90, 91, 92, 93, 94, 95, 96, 97];
  const Cn = [109.5, 108.5, 107.5, 106.5, 105.5, 104.5, 103.5, 102.5, 101.5, 100.5, 99, 96, 97, 98, 99, 100, 101, 102];
  const mk = (Cc) => H.map((h, i) => ({ ts: 1_704_153_600_000 + i * 60_000, open: Cc[i] - 0.5, high: h, low: Lw[i], close: Cc[i], volume: 1000 }));

  // Unbroken: DOWN support at the pivot low (90), full 6-bar lifetime.
  {
    const bars = mk(Cn);
    const { dn } = await runLevels(bars);
    assert.ok(dn, "DOWN level at pivot 10 / low 90 must exist");
    const rows = finiteRows(dn, bars);
    assert.equal(rows[0].idx, 10, "starts on the pivot");
    assert.equal(rows[0].value, 90, "level price = pivot low");
    assert.equal(bars[10].low, 90, "sanity: pivot candle low is 90");
    assert.equal(rows[rows.length - 1].idx, 15, "unbroken DOWN support spans the full lifetime");
  }

  // Broken: a close <= level at display bar 12 truncates at 12 + n = 14.
  {
    const Cb = [...Cn];
    Cb[12] = 90; // close <= level on display bar 12
    const bars = mk(Cb);
    const { dn } = await runLevels(bars);
    assert.ok(dn, "broken DOWN level must exist");
    const rows = finiteRows(dn, bars);
    assert.equal(rows[0].idx, 10, "starts on the pivot");
    assert.equal(rows[rows.length - 1].idx, 14, "breaking candle (12) + n = 14, truncated below 15");
    assert.ok(rows.some((r) => r.idx === 12), "the breaking candle is included");
  }
});

test("fractal: dense histories render bounded, unique, sane levels (no object-pool eviction)", async () => {
  // The line.new model saturated max_lines_count=500 and TradingView evicted the
  // OLDEST levels. Plots live outside that budget, so a 3000-bar history must
  // keep EVERY level with unique ascending timestamps and finite prices.
  const bars = [];
  let c = 100;
  for (let i = 0; i < 3000; i++) {
    const phase = i % 4;
    const h = phase === 2 ? c + 5 : c + 0.5;
    const cc = c + 0.1;
    bars.push({ ts: 1_704_153_600_000 + i * 60_000, open: c, high: h, low: c - 0.5, close: cc, volume: 1000 });
    c = cc;
  }
  const { run, up } = await runLevels(bars);
  assert.ok(run, "script must run");
  assert.ok(up, "Up level series present on dense history");

  const ts = up.data.map((p) => p.ts);
  assert.equal(new Set(ts).size, ts.length, "every timestamp unique (LWC would reject duplicates)");
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1], "timestamps strictly ascending");

  const rows = finiteRows(up, bars);
  assert.ok(rows.length > 1000, "many levels survive (no pool eviction): got " + rows.length);
  // Newest levels reach the live edge (last finite row within the final bars).
  assert.ok(rows[rows.length - 1].idx >= 2990, "newest levels reach the live edge");
  // No price-scale explosion: every finite value stays in a sane band.
  assert.ok(rows.every((r) => Number.isFinite(r.value) && Math.abs(r.value) <= 1e6), "all finite values sane");
  // Every contiguous segment is a horizontal level (offset keeps y constant).
  const segs = finiteSegments(up);
  assert.ok(segs.length > 1, "multiple independent levels");
  assert.ok(segs.every((s) => s.every((p) => p.value === s[0].value)), "every level is horizontal");
});

