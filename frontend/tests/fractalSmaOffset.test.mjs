/**
 * Williams Fractals (`fractal_SMA.pine`) — plot-registration regression.
 *
 * ROOT CAUSE (documented in pinePinerCore.ts / pineImport.ts): the merged
 * `fractal_SMA.pine` script declares 24 fractal line-br plots (Up/Down level
 * 1..12) PLUS the SMA/Bollinger plots. Two separate caps truncated that list:
 *   - `PINER_MAX_VISUALS` (engine extraction) was 8, and
 *   - `MAX_PLOT_SERIES_PER_INDICATOR` (import boundary) was 8,
 * so only the first 8 plots survived — the Down levels and the SMA series were
 * silently dropped, which is why the fractals stopped rendering. A third bug,
 * `if (valued === 0) continue` in the plot loop, skipped every all-na
 * `style_linebr` plot (fractals are na until a pivot confirms), destroying the
 * line-break rows that keep the levels from joining into a diagonal.
 *
 * These tests prove the END-TO-END contract with ONLY Pine features Piner
 * 0.13.0 actually implements (`ta.sma`, `plot`, `style_linebr`, `offset`, `na`).
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import { PINER_MAX_VISUALS } from "../src/services/pinePinerCore.ts";

/** Read a project source file relative to frontend/. */
const readSrc = (rel) => fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8");

// ── fixtures ─────────────────────────────────────────────────────────────────

function rng(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 100 - 50;
  };
}

/** Deterministic 1m candles (epoch-ms ts, AURA `PineBar` shape). */
function makeBars(n, tick = 0.01, startTs = 1_704_153_600_000, seed = 7) {
  const r = rng(seed);
  let prevClose = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = prevClose + Math.round(r() / tick) * tick;
    out.push({
      ts: startTs + i * 60_000,
      open: prevClose,
      high: Math.max(prevClose, c) + tick,
      low: Math.min(prevClose, c) - tick,
      close: c,
      volume: 1000 + i,
    });
    prevClose = c;
  }
  return out;
}

const IND = (body, name = "fractal-sma") => `//@version=6\nindicator("${name}", overlay=true)\n${body}`;
const SPEC = (source, id = "fractal-sma") => ({ id, source, bindings: [] });

async function runScript(src, bars) {
  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, 60, null);
  try {
    return await eng.computeScriptVisuals(SPEC(src));
  } finally {
    eng.dispose();
  }
}

const lineOf = (run, key) => run?.visuals.find((v) => v.type === "line" && v.key === key) ?? null;
const linebrOf = (run, key) =>
  run?.visuals.find((v) => v.type === "line" && v.key === key && v.breakOnNa) ?? null;

/** Split a LINE visual's rows into contiguous runs of valued rows. */
const segments = (data) => {
  const segs = [];
  let cur = [];
  for (const p of data) {
    if (typeof p.value === "number") cur.push(p);
    else if (cur.length > 0) {
      segs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) segs.push(cur);
  return segs;
};

// ── 1. Many plots (>8) survive the engine budget; none silently dropped ──────

test("fractal sma: a script with more than 8 plots renders them all", async () => {
  const bars = makeBars(120);
  // 12 SMA plots — above the old cap of 8, under the new PINER_MAX_VISUALS.
  const body = Array.from(
    { length: 12 },
    (_, i) => `plot(ta.sma(close, ${10 + i}), "MA${i + 1}", color=color.rgb(0, 200, 100))`,
  ).join("\n");
  const run = await runScript(IND(body), bars);
  assert.ok(run, "script must run");
  const lines = (run.visuals ?? []).filter((v) => v.type === "line");
  assert.equal(lines.length, 12, `all 12 plots must render (cap=${PINER_MAX_VISUALS}), got ${lines.length}`);
  for (const v of lines) {
    assert.ok(v.data.length > 0, `plot ${v.key} lost all data`);
  }
  assert.deepEqual(run.diagnostics.unsupported, [], "no unsupported style entries");
});

// ── 2. Negative plot offsets map each value to its historical bar ────────────

test("fractal sma: negative offset drops off-edge values, never duplicates timestamps", async () => {
  // Identifiable series: high[i] = 100 + i, so every value maps to a known bar.
  const bars = Array.from({ length: 10 }, (_, i) => ({
    ts: 1_704_153_600_000 + i * 60_000,
    open: 100 + i,
    high: 100 + i,
    low: 100 + i,
    close: 100 + i,
    volume: 1,
  }));
  // offset=-2: the value COMPUTED at bar i is DRAWN at bar i-2. So display bar d
  // shows high[d+2]; bars 8,9 have no source (off the right edge) and are dropped.
  const run = await runScript(IND('plot(high, "H", color=color.rgb(0, 200, 100), offset=-2)'), bars);
  assert.ok(run, "script must run");
  const line = lineOf(run, "H");
  assert.ok(line, "offset plot must render");

  // ROOT-CAUSE GUARD: LWC rejects a series with duplicate / non-ascending
  // timestamps, so an offset plot MUST never collide two source bars onto one
  // timestamp (the previous clamp-based mapping piled 3 values onto bar 0 and
  // the whole fractal series silently failed to render).
  const tsList = line.data.map((p) => p.ts);
  assert.equal(new Set(tsList).size, tsList.length, "no duplicate timestamps");
  for (let i = 1; i < tsList.length; i++) {
    assert.ok(tsList[i] > tsList[i - 1], "timestamps strictly ascending");
  }

  // Correct Pine mapping: display bar d carries the value computed at bar d+2.
  // First visible row is bar 0 showing high[2] = 102; the last is bar 7 = 109.
  assert.equal(line.data[0].ts, bars[0].ts, "first row at bar 0");
  assert.equal(line.data[0].value, 102, "bar 0 shows high computed at bar 2");
  assert.equal(line.data.at(-1).ts, bars[7].ts, "last row at bar 7 (bars 8,9 dropped)");
  assert.equal(line.data.at(-1).value, 109, "bar 7 shows high computed at bar 9");
  assert.equal(line.data.length, 8, "10 source bars, first 2 shifted off the left edge");
});

test("fractal sma: a positive offset shifts the series right and drops the tail", async () => {
  const bars = Array.from({ length: 6 }, (_, i) => ({
    ts: 1_704_153_600_000 + i * 60_000,
    open: 100 + i,
    high: 100 + i,
    low: 100 + i,
    close: 100 + i,
    volume: 1,
  }));
  // offset=+2: value computed at bar i is drawn at bar i+2; the last 2 source
  // bars fall off the right edge and are dropped, the first 2 display bars empty.
  const run = await runScript(IND('plot(high, "H", color=color.rgb(0, 200, 100), offset=2)'), bars);
  assert.ok(run, "script must run");
  const line = lineOf(run, "H");
  const tsList = line.data.map((p) => p.ts);
  assert.equal(new Set(tsList).size, tsList.length, "no duplicate timestamps");
  for (let i = 1; i < tsList.length; i++) assert.ok(tsList[i] > tsList[i - 1], "ascending");
  assert.equal(line.data[0].ts, bars[2].ts, "first value drawn at bar 2");
  assert.equal(line.data[0].value, 100, "bar 2 shows high computed at bar 0");
  assert.equal(line.data.length, 4, "6 source bars, last 2 shifted off the right edge");
});

// ── 3. style_linebr keeps na rows so the line breaks (never bridges) ─────────

test("fractal sma: style_linebr preserves na gaps as whitespace rows", async () => {
  const bars = makeBars(60);
  const run = await runScript(
    IND('plot(bar_index % 5 == 0 ? close : na, "BRK", style=plot.style_linebr, color=color.rgb(0, 200, 100))'),
    bars,
  );
  assert.ok(run, "script must run");
  const line = linebrOf(run, "BRK");
  assert.ok(line, "style_linebr plot must render as a breakOnNa line");
  assert.equal(line.breakOnNa, true, "linebr carries the break flag");
  assert.deepEqual(run.diagnostics.unsupported, [], "linebr must NOT be reported unsupported");
  // na bars survive as value-less whitespace rows -> multiple segments, never one
  // continuous line.
  const segs = segments(line.data);
  assert.ok(segs.length >= 2, `linebr must break into segments, got ${segs.length}`);
});

// ── 4. An all-na linebr plot draws nothing (matches Pine: na everywhere → no line)

test("fractal sma: an all-na linebr plot draws nothing and is never unsupported", async () => {
  const bars = makeBars(40);
  const run = await runScript(IND('plot(na, "EMPTY", style=plot.style_linebr, color=color.rgb(0, 200, 100))'), bars);
  assert.ok(run, "script must run");
  assert.deepEqual(run.diagnostics.unsupported, [], "all-na linebr must never be 'unsupported'");
  // A linebr plot with no finite value draws nothing (same as the pineLineBreak
  // "Case F" contract) — it must not throw and must not be reported unsupported.
  const line = lineOf(run, "EMPTY");
  assert.equal(line, null, "an all-na plot draws nothing");
});

// ── 5. A plain style_line still collapses the gap (unchanged behaviour) ──────

test("fractal sma: style_line still collapses the na gap (unchanged)", async () => {
  const bars = makeBars(40);
  const run = await runScript(IND('plot(bar_index % 5 == 0 ? close : na, "PLAIN", color=color.rgb(0, 200, 100))'), bars);
  assert.ok(run, "script must run");
  const line = lineOf(run, "PLAIN");
  assert.ok(line, "plain line plot must render");
  assert.ok(!line.breakOnNa, "style_line is NOT a breakOnNa line");
  assert.ok(line.data.every((p) => typeof p.value === "number"), "style_line drops na rows");
});

// ── 6. Every style coexists with linebr in one script (no cross-contamination) ─

test("fractal sma: linebr coexists with other styles in one script", async () => {
  const bars = makeBars(80);
  const body = [
    'plot(ta.sma(close, 10), "PLAIN", color=color.rgb(0, 200, 100))',
    'plot(bar_index % 5 == 0 ? close : na, "BRK", style=plot.style_linebr, color=color.rgb(255, 80, 80))',
    'plot(ta.sma(close, 20), "STEP", color=color.rgb(80, 80, 255), style=plot.style_stepline)',
  ].join("\n");
  const run = await runScript(IND(body), bars);
  assert.ok(run, "script must run");
  assert.ok(lineOf(run, "PLAIN"), "plain line renders");
  assert.ok(linebrOf(run, "BRK"), "linebr renders");
  const step = run.visuals.find((v) => v.type === "line" && v.key === "STEP");
  assert.ok(step, "stepline renders");
  assert.equal(step.stepLine, true, "stepline keeps its step flag");
  assert.ok(!step.breakOnNa, "stepline is not breakOnNa");
  assert.deepEqual(run.diagnostics.unsupported, [], "no unsupported styles");
});

// ── 7. Live recalculation keeps every plot key stable (fractals never vanish) ─

test("fractal sma: recalculating after a new bar keeps every plot key", async () => {
  const bars0 = makeBars(120);
  const body = Array.from(
    { length: 10 },
    (_, i) => `plot(ta.sma(close, ${10 + i}), "MA${i + 1}", color=color.rgb(0, 200, 100))`,
  ).join("\n");
  const eng = new PinerPineEngine();
  eng.setCandles(bars0, null, 60, null);
  const run1 = await eng.computeScriptVisuals(SPEC(IND(body)));
  const keys1 = (run1?.visuals ?? []).map((v) => v.key);
  eng.setCandles([...bars0, makeBars(1, 0.01, bars0[bars0.length - 1].ts + 60_000, 99)], null, 60, null);
  const run2 = await eng.computeScriptVisuals(SPEC(IND(body)));
  const keys2 = (run2?.visuals ?? []).map((v) => v.key);
  eng.dispose();
  assert.deepEqual(keys1, keys2, "plot keys stay stable across a live recalculation");
  assert.equal(keys1.length, 10, "all 10 plots present before and after");
});

// ── 8. END-TO-END: the real fractal_SMA.pine renders upper AND lower fractals
//    as finite values on unique, ascending timestamps aligned to pivot candles.
//    This is the regression the user reported: no fractals visible on the chart.

test("fractal sma (real script): upper & lower fractals render finite values on unique candles", async () => {
  const bars = makeBars(200);
  const run = await runScript(readSrc("src/components/Indicators/fractal_SMA.pine"), bars);
  assert.ok(run, "the merged fractal+SMA script must run");

  const up = run.visuals.find((v) => v.key === "Up level 1");
  const dn = run.visuals.find((v) => v.key === "Down level 1");
  assert.ok(up, "Up level 1 must be present (upper fractal)");
  assert.ok(dn, "Down level 1 must be present (lower fractal)");

  for (const [label, v, field] of [["Up level 1", up, "high"], ["Down level 1", dn, "low"]]) {
    const finite = v.data.filter((p) => typeof p.value === "number");
    // Finite values must exist — a plot object with zero finite rows draws nothing.
    assert.ok(finite.length > 0, `${label} must carry finite fractal values`);
    // Unique, strictly-ascending timestamps — LWC refuses the series otherwise,
    // which is exactly why an offset plot that collides timestamps goes invisible.
    const ts = v.data.map((p) => p.ts);
    assert.equal(new Set(ts).size, ts.length, `${label} has duplicate timestamps`);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1], `${label} timestamps ascending`);
    // At least one finite value must land exactly on a candle's high (Up fractal)
    // / low (Down fractal) — proving the offset placed the level on its pivot.
    const pivots = finite.filter((p) => {
      const bi = bars.findIndex((b) => b.ts === p.ts);
      return bi >= 0 && Math.abs(bars[bi][field] - p.value) < 1e-6;
    });
    assert.ok(pivots.length > 0, `${label} values must align to pivot candles (${field})`);
  }

  // The SMA / Bollinger lines keep working alongside the fractals.
  assert.ok(run.visuals.find((v) => v.key === "MA"), "MA line still renders");
});


