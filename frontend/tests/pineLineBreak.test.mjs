/**
 * plot.style_linebr — Pine line-break semantics (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * REGRESSION CONTEXT: Pine compilation always worked for style_linebr; the
 * importer reported `Not rendered: plot style "linebr" × N`. Root cause found
 * by probe (tests/probe-linebr.mjs):
 *   1. Piner 0.13.0 emits `options.style === "linebr"` (unprefixed), and
 *   2. encodes Pine `na` as `NaN` in `plots[i].data[]`.
 * The mapper dropped every non-finite row (the documented warmup/sentinel
 * guard), so a gap silently CLOSED, and the style dispatch had no `linebr`
 * arm — so it was bucketed as unsupported and never rendered.
 *
 * The fix preserves each na bar as a VALUE-LESS WHITESPACE row, which is
 * Lightweight Charts' native line-break mechanism (LWC 5.2.1
 * `DataMapType.Line: LineData | WhitespaceData`). It is NOT an alias of
 * style_line: the break is the whole point.
 *
 * Matrix:
 *   A continuous → one segment          E multiple gaps → 3 segments
 *   B middle gap → break, 2 segments    F all-na → nothing, no error
 *   C gap at start → line starts at 3   G realtime append → never reconnects
 *   D gap at end → line ends at 3       + diagnostics + style regressions
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import { PINER_MAX_VISUALS } from "../src/services/pinePinerCore.ts";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read a project source file relative to frontend/. */
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");

/** Strip block + line comments so guards evaluate CODE only. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ── fixtures ─────────────────────────────────────────────────────────────────

function rng(seed = 1) {
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

const SPEC = (source, id = "linebr-test") => ({ id, source, bindings: [] });

/** Run one script over `bars` and return the engine run result. */
async function runScript(src, bars) {
  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, 60, null);
  try {
    return await eng.computeScriptVisuals(SPEC(src));
  } finally {
    eng.dispose();
  }
}

const IND = (body, name = "br") => `//@version=6\nindicator("${name}", overlay=true)\n${body}`;

/**
 * Split a LINE visual's rows into CONTIGUOUS runs of valued rows.
 * A value-less (whitespace) row terminates the current run — so the number of
 * segments is exactly the number of places LWC will break the line.
 */
const segments = (data) => {
  const segs = [];
  let cur = [];
  for (const p of data) {
    if (typeof p.value === "number") cur.push(p);
    else if (cur.length > 0) { segs.push(cur); cur = []; }
  }
  if (cur.length > 0) segs.push(cur);
  return segs;
};

const lineOf = (run, key) => run?.visuals.find((v) => v.type === "line" && v.key === key) ?? null;
const isWs = (p) => typeof p.value !== "number";
// ── 1/2/9. recognition + diagnostics ─────────────────────────────────────────

test("1/2. style_linebr is recognized and is NOT classified as unsupported", async () => {
  const bars = makeBars(20);
  const run = await runScript(IND('plot(bar_index % 5 == 0 ? close : na, "brk", style=plot.style_linebr)'), bars);
  assert.ok(run, "script must run");
  const line = lineOf(run, "brk");
  assert.ok(line, "style_linebr must produce a line visual");
  assert.equal(line.type, "line");
  assert.equal(line.stepLine, false, "linebr is a plain line, NOT a stepline");
  assert.equal(line.breakOnNa, true, "linebr carries the break flag");
  // The diagnostic must move it into RENDERED, not "Not rendered".
  assert.deepEqual(run.diagnostics.unsupported, [], "no unsupported entries");
  assert.ok(!run.diagnostics.unsupported.some((u) => u.kind.includes("linebr")));
  assert.ok(
    run.diagnostics.rendered.some((r) => r.key === "brk" && r.type === "line"),
    "linebr must appear under Rendered",
  );
});

test("9. several linebr plots in ONE script all import and render (real failure shape)", async () => {
  const bars = makeBars(20);
  // Mirrors the reported failure: many × style_linebr in a single script.
  const body = Array.from({ length: 6 }, (_, i) =>
    `plot(bar_index % ${3 + i} == 0 ? close : na, "br${i}", style=plot.style_linebr)`,
  ).join("\n") +
    '\nplot(ta.sma(close, 3), "sma")\nplot(ta.sma(close, 4), "area", style=plot.style_area)';
  const run = await runScript(IND(body, "many"), bars);
  assert.ok(run, "a script with several linebr plots must import successfully");
  const lines = run.visuals.filter((v) => v.type === "line" && v.breakOnNa);
  assert.equal(lines.length, 6, "every linebr plot renders");
  for (const l of lines) {
    assert.ok(segments(l.data).length >= 2, `${l.key} must contain at least one break`);
  }
  // NONE of them is reported as unsupported any more.
  assert.deepEqual(run.diagnostics.unsupported, []);
  assert.ok(run.visuals.some((v) => v.type === "area"), "other styles unaffected");
});

test("9b. the per-indicator series cap still applies, and never becomes 'unsupported'", async () => {
  const bars = makeBars(20);
  // 10 linebr plots — above PINER_MAX_VISUALS (8). A rendered plot legitimately
  // consumes a series slot, so only the first N render (pre-existing, documented
  // limit: "Only the first 8 outputs are rendered"). The KEY regression guard:
  // the overflow is a CAP, never a "plot style linebr" unsupported entry.
  const body = Array.from({ length: 10 }, (_, i) =>
    `plot(bar_index % ${3 + i} == 0 ? close : na, "br${i}", style=plot.style_linebr)`,
  ).join("\n");
  const run = await runScript(IND(body, "cap"), bars);
  const lines = run.visuals.filter((v) => v.type === "line" && v.breakOnNa);
  assert.equal(lines.length, PINER_MAX_VISUALS, "rendered up to the series cap");
  assert.deepEqual(run.diagnostics.unsupported, [], "the cap is NOT reported as an unsupported style");
});

// ── 3. Case A — continuous values stay connected ─────────────────────────────

test("3. Case A — continuous linebr values render ONE unbroken segment (no whitespace)", async () => {
  const bars = makeBars(15);
  const run = await runScript(IND('plot(close, "cont", style=plot.style_linebr)'), bars);
// ── 4/5. Cases B/C/D — na breaks the line, neighbours never joined ───────────

test("4/5. Case B — a middle gap becomes whitespace and is NOT bridged", async () => {
  const bars = makeBars(12);
  const run = await runScript(
    IND('cond = not (bar_index >= 3 and bar_index <= 5)\nplot(cond ? close : na, "mid", style=plot.style_linebr)'),
    bars,
  );
  const line = lineOf(run, "mid");
  assert.ok(line, "line visual present");
  const segs = segments(line.data);
  assert.equal(segs.length, 2, "exactly two segments — no line across the gap");
  assert.deepEqual(segs[0].map((p) => p.ts), [0, 1, 2].map((i) => bars[i].ts));
  assert.deepEqual(segs[1].map((p) => p.ts), [6, 7, 8, 9, 10, 11].map((i) => bars[i].ts));
  // The gap bars survive as value-less rows — that IS the break marker.
  assert.deepEqual(
    line.data.filter(isWs).map((p) => p.ts),
    [3, 4, 5].map((i) => bars[i].ts),
  );
  // Values untouched: no bar was dropped or interpolated.
  assert.equal(line.data[2].value, bars[2].close);
  assert.equal(line.data[6].value, bars[6].close);
});

test("5b. Case C — a gap at the START makes the line begin at the first value", async () => {
  const bars = makeBars(12);
  const run = await runScript(IND('plot(bar_index >= 3 ? close : na, "head", style=plot.style_linebr)'), bars);
  const segs = segments(lineOf(run, "head").data);
  assert.equal(segs.length, 1);
  assert.equal(segs[0][0].ts, bars[3].ts, "line begins at bar 3, not bar 0");
  assert.equal(segs[0].length, 9, "bars 3..11");
});

test("5c. Case D — a gap at the END makes the line stop at the last value", async () => {
  const bars = makeBars(12);
  const run = await runScript(IND('plot(bar_index <= 5 ? close : na, "tail", style=plot.style_linebr)'), bars);
  const segs = segments(lineOf(run, "tail").data);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].at(-1).ts, bars[5].ts, "line ends at bar 5");
  assert.equal(segs[0].length, 6, "bars 0..5");
});

// ── 6. Case E — multiple gaps ────────────────────────────────────────────────

test("6. Case E — multiple gaps produce multiple independent segments", async () => {
  const bars = makeBars(14);
  const run = await runScript(
    IND('gap = (bar_index >= 2 and bar_index <= 3) or (bar_index >= 7 and bar_index <= 8)\nplot(not gap ? close : na, "multi", style=plot.style_linebr)'),
    bars,
  );
  const line = lineOf(run, "multi");
  const segs = segments(line.data);
  assert.equal(segs.length, 3, "three independent line segments");
  assert.deepEqual(segs.map((s) => s.length), [2, 3, 5]);
  assert.equal(line.data.filter(isWs).length, 4, "both gaps preserved as whitespace");
});

// ── Case F — all na ──────────────────────────────────────────────────────────

test("F. Case F — an all-na linebr plot renders nothing and never throws", async () => {
  const bars = makeBars(10);
  const run = await runScript(
    IND('plot(bar_index < 0 ? close : na, "empty", style=plot.style_linebr)\nplot(close, "ok")'),
    bars,
  );
  assert.ok(run, "must not throw");
  assert.equal(lineOf(run, "empty"), null, "an all-na plot draws nothing");
  assert.ok(lineOf(run, "ok"), "the healthy plot in the same script still renders");
  assert.deepEqual(run.diagnostics.unsupported, [], "an empty linebr is not an error");
});

// ── Case G — realtime append must never reconnect segments ──────────────────

test("G. Case G — appending realtime bars never reconnects previously split segments", async () => {
  const src = IND('plot(bar_index % 4 == 0 ? close : na, "rt", style=plot.style_linebr)');
  const first = makeBars(12);
  const r1 = await runScript(src, first);
  const before = segments(lineOf(r1, "rt").data);
  assert.ok(before.length >= 3, `expected several segments, got ${before.length}`);

  // A new closed bucket arrives (realtime rollover) — the engine re-runs over
// ── 7. Existing plot styles are UNCHANGED (na handling not global) ──────────

test("7. a plain style_line with the SAME na pattern still collapses the gap (unchanged)", async () => {
  const bars = makeBars(12);
  const run = await runScript(
    IND('cond = not (bar_index >= 3 and bar_index <= 5)\nplot(cond ? close : na, "plain")'),
    bars,
  );
  const line = lineOf(run, "plain");
  assert.ok(line, "line visual present");
  assert.equal(line.breakOnNa, undefined, "plain line has no break flag");
  // Identical na condition as the linebr Case B run — but this style keeps the
  // historical "drop na" behaviour: 3 fewer rows and NO whitespace.
  assert.equal(line.data.length, 9, "na bars are still dropped for a normal line");
  assert.equal(line.data.filter(isWs).length, 0, "no whitespace rows for a normal line");
  assert.equal(segments(line.data).length, 1, "the gap still closes (unchanged legacy behaviour)");
});

test("7b. stepline / histogram / columns / area keep mapping to their visual kinds", async () => {
  const bars = makeBars(30);
  const run = await runScript(
    IND('c = not (bar_index % 7 == 0)\n'
      + 'plot(ta.sma(close, 5), "step", style=plot.style_stepline)\n'
      + 'plot(c ? ta.sma(close, 5) : na, "hist", style=plot.style_histogram)\n'
      + 'plot(c ? ta.sma(close, 6) : na, "cols", style=plot.style_columns)\n'
      + 'plot(ta.sma(close, 7), "area", style=plot.style_area)'),
    bars,
  );
  assert.ok(run);
  const step = lineOf(run, "step");
  assert.equal(step.stepLine, true);
  assert.equal(step.breakOnNa, undefined);
  assert.equal(step.data.filter(isWs).length, 0, "stepline never gains whitespace");
  for (const key of ["hist", "cols"]) {
    const h = run.visuals.find((v) => v.type === "histogram" && v.key === key);
    assert.ok(h, `${key} is a histogram`);
    assert.equal(h.data.filter(isWs).length, 0, "histogram rows always carry a value");
  }
  const area = run.visuals.find((v) => v.type === "area" && v.key === "area");
  assert.ok(area, "area visual present");
  assert.deepEqual(run.diagnostics.unsupported, []);
});

test("7c. style_linebr coexists with every other style in one script", async () => {
  const bars = makeBars(30);
  const run = await runScript(
    IND('c = bar_index % 6 != 0\n'
      + 'plot(c ? close : na, "br", style=plot.style_linebr)\n'
      + 'plot(ta.sma(close, 3), "plain")\n'
      + 'plot(ta.sma(close, 4), "step", style=plot.style_stepline)\n'
      + 'plot(ta.sma(close, 5), "hist", style=plot.style_histogram)\n'
      + 'plot(ta.sma(close, 6), "area", style=plot.style_area)'),
    bars,
  );
  assert.ok(run);
  assert.deepEqual(run.diagnostics.unsupported, [], "no style regressed");
  assert.ok(lineOf(run, "br").breakOnNa, "linebr flagged");
  assert.equal(lineOf(run, "plain").breakOnNa, undefined);
  assert.equal(lineOf(run, "step").stepLine, true);
  assert.ok(run.visuals.some((v) => v.type === "histogram"));
  assert.ok(run.visuals.some((v) => v.type === "area"));
  // The linebr plot kept its own na bars; the plain one dropped ITS na bars.
  assert.ok(lineOf(run, "br").data.length > lineOf(run, "plain").data.length);
});

// ── Renderer boundary: LWC whitespace + no style aliasing (source contracts) ─
// Node's strip-types loader cannot import a .tsx, so these assert the SAME
// wiring contracts the repo's other component suites use (chartContextMenu,
// invertScaleColors, pineSettings). The executable half of the behaviour is
// proven above; these pin that the renderer really emits whitespace.

test("renderer: toLineData emits a value-less WHITESPACE row (LWC's line break)", () => {
  const src = readSrc("src/components/TradingChart/PineBridge.tsx");
  assert.match(src, /\.\.\.\(typeof p\.value === "number" \? \{ value: p\.value \} : \{\}\)/);
  // The old unconditional `value: p.value` must be gone — it would emit
  // `value: undefined` (a real point at an undefined price) instead of whitespace.
  assert.ok(!/^\s*value: p\.value,/m.test(src), "unconditional value assignment must be removed");
  assert.match(src, /series\.setData\(v\.data\.map\(\(p\) => toLineData\(p, stripColor\)\)\)/);
});

test("renderer: the realtime update() fast path uses the same whitespace mapping", () => {
  const src = readSrc("src/components/TradingChart/PineBridge.tsx");
  // Both the setData path and the forming-tick update() path go through
  // toLineData, so an appended bar can never invent a connecting segment.
  assert.match(src, /series\.update\(toLineData\(last, stripColor\)\)/);
});

test("renderer: breakOnNa is tracked per entry so a style edit re-creates the series", () => {
  const src = readSrc("src/components/TradingChart/PineBridge.tsx");
  assert.match(src, /entry\.breakOnNa !== \(v\.breakOnNa \?\? false\)/);
  assert.match(src, /breakOnNa: v\.breakOnNa \?\? false/);
});

test("mapper: linebr is NOT aliased to style_line, and no other style gained breaks", () => {
  const src = stripComments(readSrc("src/services/pinePinerCore.ts"));
  // The break arm is its OWN dispatch branch carrying breakOnNa: true…
  assert.match(src, /else if \(breaksOnNa\) \{/);
  assert.match(src, /stepLine: false, breakOnNa: true, data: breaks/);
  // …and `breaks` (which carries the whitespace rows) is used ONLY there.
  assert.equal((src.match(/data: breaks\b/g) ?? []).length, 1, "breaks feeds exactly one style");
  // The `style === "line"` arm must still take the na-dropping `points` array.
  assert.match(src, /else if \(style === "line"\) \{\s*visuals\.push\(\{ type: "line", key, title: plotTitle,[\s\S]*?data: points \}\)/);
  // Exactly the four pre-existing PLOT arms feed `points` (stepline / histogram
  // / area / line). The 5th historical match is the plotshape marker arm,
  // unrelated to plot styles — assert the plot arms by their visual type.
  const plotArms = (src.match(/type: "(?:line|histogram|area)", key, title: plotTitle,[\s\S]*?data: points/g) ?? []).length;
  assert.equal(plotArms, 4, "stepline/histogram/area/line unchanged");
});
  // the longer slice.
  const extended = [...first, ...makeBars(3, 0.01, first.at(-1).ts + 60_000, 99)];
  const r2 = await runScript(src, extended);
  const after = segments(lineOf(r2, "rt").data);
  // Every new bar is itself na (12 % 4 === 0 ⇒ the appended run is isolated),
  // so exactly one more isolated point appears and NO earlier segment merged.
  assert.equal(after.length, before.length + 1, "no two previously separate segments were joined");
  for (const seg of before) {
    const still = after.some((s) => s[0].ts === seg[0].ts && s.at(-1).ts === seg.at(-1).ts);
    assert.ok(still, "every pre-existing segment survives unchanged");
  }
});
  const line = lineOf(run, "cont");
  assert.ok(line, "line visual present");
  assert.equal(line.data.length, 15, "every bar is kept");
  assert.equal(line.data.filter(isWs).length, 0, "no whitespace rows");
  assert.equal(segments(line.data).length, 1, "exactly one connected segment");
  // Values are the raw closes — nothing about the data was altered.
  line.data.forEach((p, i) => assert.equal(p.value, bars[i].close));
});