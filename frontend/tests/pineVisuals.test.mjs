/**
 * Pine visuals test suite — the normalized PineVisual pipeline (phase 2).
 *
 * PineTS 0.9.33 exposes lines, styled plots (stepline/histogram/columns/area),
 * hlines, plotshape/plotchar markers, display.none flags and internal drawing
 * collectors in `ctx.plots`. This suite pins down AURA's extraction contract:
 * every supported construct becomes exactly one `PineVisual`; everything else
 * is REPORTED (diagnostics.unsupported) rather than faked or silently dropped.
 * A valid script with renderable output must never produce "Nothing to render".
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PineIndicatorEngine, extractVisuals } from "../src/services/pineEngine.ts";
import {
  compileImportedPine,
  loadImportedPineIndicators,
  saveImportedPineIndicators,
  PINE_STORAGE_KEY,
  staticScanCounts,
} from "../src/services/pineImport.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

function rng(seed = 1) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 100 - 50;
  };
}

function make1m(n, startTs = 1_704_153_600_000, seed = 7) {
  const r = rng(seed);
  let prevClose = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = prevClose + r();
    out.push({
      ts: startTs + i * 60_000,
      open: prevClose,
      high: Math.max(prevClose, c) + 1,
      low: Math.min(prevClose, c) - 1,
      close: c,
      volume: 1000 + i,
    });
    prevClose = c;
  }
  return out;
}

function make3m(n, startTs = 1_704_153_600_000, seed = 11) {
  const r = rng(seed);
  let prevClose = 50;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = prevClose + r();
    const c = o + r();
    out.push({
      ts: startTs + i * 180_000,
      open: o,
      high: Math.max(o, c) + 5,
      low: Math.min(o, c) - 5,
      close: c,
      volume: 800 + i,
    });
    prevClose = c;
  }
  return out;
}

/** Run a script through the visuals path and return { visuals, diagnostics }. */
async function runVisuals(script, bars, live = null, bucketSec = 60, params = {}) {
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, live, bucketSec);
  const run = await eng.computeScriptVisuals({ id: "test", source: script, bindings: [] }, params);
  eng.dispose();
  if (run === null) throw new Error("computeScriptVisuals returned null (no data / run failure)");
  return run;
}

/** Run a script and return only the visuals. */
async function runForVisuals(script, bars, live = null, bucketSec = 60, params = {}) {
  return (await runVisuals(script, bars, live, bucketSec, params)).visuals;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

// ── Basic line extraction ───────────────────────────────────────────────────

test("visuals: simple plot() yields one line visual with the plot title", async () => {
  const bars = make1m(80);
  const visuals = await runForVisuals(`//@version=6
indicator("one", overlay=true)
plot(ta.ema(close, 9), "EMA 9")`, bars);
  assert.equal(visuals.length, 1);
  assert.equal(visuals[0].type, "line");
  assert.equal(visuals[0].title, "EMA 9");
  assert.equal(visuals[0].key, "EMA 9");
  assert.equal(visuals[0].stepLine, false);
  assert.ok(visuals[0].data.length > 0);
  assert.equal(visuals[0].data[visuals[0].data.length - 1].ts, bars[bars.length - 1].ts);
});

test("visuals: plot(title=…) named-arg form is honored", async () => {
  const bars = make1m(80);
  const visuals = await runForVisuals(`//@version=6
indicator("named", overlay=true)
ema = ta.ema(close, 9)
plot(ema, title="EMA 9", linewidth=2)`, bars);
  const line = visuals.find((v) => v.type === "line");
  assert.ok(line, "expected a line visual");
  assert.equal(line.title, "EMA 9");
  assert.equal(line.lineWidth, 2);
});

test("visuals: multiple plots each become a visual", async () => {
  const bars = make1m(80);
  const visuals = await runForVisuals(`//@version=6
indicator("multi", overlay=true)
plot(ta.ema(close, 9), "EMA 9")
plot(ta.ema(close, 20), "EMA 20")
plot(ta.sma(close, 10), "SMA 10")`, bars);
  assert.deepEqual(visuals.map((v) => v.title), ["EMA 9", "EMA 20", "SMA 10"]);
  assert.ok(visuals.every((v) => v.type === "line"));
});

test("visuals: explicit plot.style_line IS a plain line (old filter regression)", async () => {
  const bars = make1m(80);
  const visuals = await runForVisuals(`//@version=6
indicator("explicit", overlay=true)
plot(ta.ema(close, 9), "e", style=plot.style_line, linewidth=2)`, bars);
  assert.equal(visuals.length, 1, JSON.stringify(visuals));
  assert.equal(visuals[0].type, "line");
  assert.equal(visuals[0].stepLine, false);
  assert.equal(visuals[0].lineWidth, 2);
});

test("visuals: uniform script color collapses; linewidth clamps to 1–4", async () => {
  const bars = make1m(80);
  const visuals = await runForVisuals(`//@version=6
indicator("styled", overlay=true)
plot(ta.ema(close, 9), "e", color=color.orange, linewidth=7)`, bars);
  assert.equal(visuals[0].color, "#FF9800");
  assert.equal(visuals[0].lineWidth, 4);
});

// ── Style mapping ───────────────────────────────────────────────────────────

test("visuals: stepline/histogram/area/columns map to typed visuals", async () => {
  const bars = make1m(120);
  const visuals = await runForVisuals(`//@version=6
indicator("styles", overlay=true)
plot(close, "steppy", style=plot.style_stepline)
hist = close > open ? 1 : -1
plot(hist, "hist", style=plot.style_histogram, color=hist >= 0 ? color.teal : color.maroon)
plot(ta.rsi(close, 14), "rsi", style=plot.style_area)
plot(volume, "vol", style=plot.style_columns)`, bars);
  const byKey = Object.fromEntries(visuals.map((v) => [v.title, v]));
  assert.equal(byKey.steppy.type, "line");
  assert.equal(byKey.steppy.stepLine, true, "stepline must render with steps");
  assert.equal(byKey.hist.type, "histogram");
  assert.equal(byKey.rsi.type, "area");
  assert.equal(byKey.vol.type, "histogram", "columns share the histogram representation");
});

test("visuals: dynamic per-bar colors survive on lines and histograms", async () => {
  const bars = make1m(120);
  const visuals = await runForVisuals(`//@version=6
indicator("dyn", overlay=true)
hist = close > open ? 1 : -1
plot(hist, "hist", style=plot.style_histogram, color=hist >= 0 ? color.teal : color.maroon)
plot(ta.ema(close, 9), "e", color=close > open ? color.red : color.blue)`, bars);
  const hist = visuals.find((v) => v.title === "hist");
  const line = visuals.find((v) => v.title === "e");
  assert.ok(hist.data.length > 10);
  const histColors = new Set(hist.data.map((p) => p.color));
  assert.ok(histColors.size >= 2, "histogram alternates colors per bar");
  assert.equal(hist.color, undefined, "dynamic colors must NOT collapse into a uniform color");
  const lineColors = new Set(line.data.map((p) => p.color));
  assert.ok(lineColors.size >= 2, "line alternates colors per bar");
  assert.equal(line.color, undefined);
});

// ── hline / markers ─────────────────────────────────────────────────────────

test("visuals: hline() becomes a horizontal visual with price/color/linestyle", async () => {
  const bars = make1m(80);
  const visuals = await runForVisuals(`//@version=6
indicator("mid", overlay=true)
plot(ta.ema(close, 9), "e")
hline(50, "Mid", color=color.gray, linestyle=hline.style_dotted, linewidth=2)`, bars);
  const h = visuals.find((v) => v.type === "horizontal");
  assert.ok(h, `expected a horizontal visual, got ${JSON.stringify(visuals.map((v) => v.type))}`);
  assert.equal(h.price, 50);
  assert.equal(h.title, "Mid");
  assert.equal(h.lineStyle, "dotted");
  assert.equal(h.lineWidth, 2);
  assert.ok(h.color, "hline color preserved");
  assert.equal(visuals.find((v) => v.title === "e").type, "line", "line sibling still rendered");
});

test("visuals: plotshape bool → markers only on true bars, with shape/position/text", async () => {
  const bars = make1m(120);
  const { visuals, diagnostics } = await runVisuals(`//@version=6
indicator("signals", overlay=true)
plotshape(close > open, "Buy", style=shape.triangleup, location=location.belowbar, color=color.green, text="B", size=size.small)`, bars);
  const m = visuals.find((v) => v.type === "marker");
  assert.ok(m, "expected a marker visual");
  assert.equal(m.title, "Buy");
  assert.ok(m.data.length > 0, "at least one true bar");
  assert.ok(m.data.length < bars.length, "false bars produce no markers");
  for (const p of m.data) {
    assert.equal(p.position, "belowBar");
    assert.equal(p.shape, "arrowUp", "triangleup maps to arrowUp");
    assert.equal(p.text, "B");
    assert.ok(p.color, "marker color preserved");
  }
  const bar = bars[m.data.length - 1].ts;
  assert.ok(m.data.every((p) => bars.some((b) => b.ts === p.ts)), "markers align to candle timestamps");
  assert.ok(diagnostics.rendered.some((r) => r.type === "marker"));
});

test("visuals: plotshape numeric (cond ? 1 : na) → markers only for truthy bars", async () => {
  const bars = make1m(120);
  const visuals = await runForVisuals(`//@version=6
indicator("signum", overlay=true)
plotshape(close > open ? 1 : na, "S", style=shape.arrowup, location=location.abovebar, color=color.red)`, bars);
  const m = visuals.find((v) => v.type === "marker");
  assert.ok(m, "expected a marker visual");
  assert.equal(m.data.length, bars.filter((b) => b.close > b.open).length);
  assert.ok(m.data.every((p) => p.position === "aboveBar" && p.shape === "arrowUp"));
});

test("visuals: plotchar → circle marker carrying the char as text", async () => {
  const bars = make1m(120);
  const visuals = await runForVisuals(`//@version=6
indicator("chars", overlay=true)
plotchar(close > open, "up", char="^", location=location.abovebar, color=color.lime)`, bars);
  const m = visuals.find((v) => v.type === "marker");
  assert.ok(m, "expected a marker visual");
  assert.ok(m.data.length > 0);
  assert.ok(m.data.every((p) => p.shape === "circle" && p.text === "^"));
});

// ── hidden + unsupported ────────────────────────────────────────────────────

test("visuals: display=display.none plots are hidden, never rendered", async () => {
  const bars = make1m(80);
  const { visuals, diagnostics } = await runVisuals(`//@version=6
indicator("disp", overlay=true)
plot(ta.ema(close, 9), "shown")
plot(ta.ema(close, 20), "gone", display=display.none)`, bars);
  assert.deepEqual(visuals.map((v) => v.title), ["shown"]);
  assert.equal(diagnostics.hidden, 1);
});

test("visuals: unsupported styles (circles/cross) are reported, never faked", async () => {
  const bars = make1m(80);
  const { visuals, diagnostics } = await runVisuals(`//@version=6
indicator("circ", overlay=true)
plot(close * 1.01, "circ", style=plot.style_circles)
plot(close * 1.02, "cross", style=plot.style_cross)`, bars);
  assert.equal(visuals.length, 0, "no line faking");
  const kinds = diagnostics.unsupported.map((u) => u.kind).join(",");
  assert.match(kinds, /circles/);
  assert.match(kinds, /cross/);
});

test("visuals: label.new + fill() drawings are reported unsupported, lines still render", async () => {
  const bars = make1m(80);
  const { visuals, diagnostics } = await runVisuals(`//@version=6
indicator("draw", overlay=true)
p1 = plot(ta.ema(close, 9), "e1")
p2 = plot(ta.ema(close, 20), "e2")
fill(p1, p2, color=color.new(color.blue, 90))
if barstate.islast
    label.new(bar_index, high, "LAST", style=label.style_label_down, color=color.orange, textcolor=color.white)`, bars);
  assert.equal(visuals.length, 2, "the two lines still render");
  const kinds = diagnostics.unsupported.map((u) => u.kind).join(",");
  assert.match(kinds, /label\.new/);
  // VERIFIED PineTS 0.9.33: fill() is emitted as a plot with style "fill"
  // (which LWC cannot represent faithfully) — reported, never faked.
  assert.match(kinds, /style "fill"/);
});

test("visuals: warmup-only output yields no visual and no crash", async () => {
  const bars = make1m(20);
  const { visuals } = await runVisuals(`//@version=6
indicator("warm", overlay=true)
plot(ta.rsi(close, 50), "rsi50")`, bars);
  assert.equal(visuals.length, 0, "no finite values yet → no visual");
});

// ── Diagnostics + import pipeline ───────────────────────────────────────────

test("diagnostics: staticScanCounts counts constructs, ignoring comments/strings", () => {
  const counts = staticScanCounts(`//@version=6
indicator("x", overlay=true)
// plot("not counted")
ema = ta.ema(close, 9)
plot(ema, "plot title with plot() text")
plotshape(close > open, style=shape.triangleup)
hline(50)
bgcolor(close > open)
fill(1, 2)`);
  assert.equal(counts["plot()"], 1);
  assert.equal(counts["plotshape()"], 1);
  assert.equal(counts["hline()"], 1);
  assert.equal(counts["bgcolor()"], 1);
  assert.equal(counts["fill()"], 1);
  assert.deepEqual(staticScanCounts(""), {});
});

test("diagnostics: rendered list mirrors the runtime visuals", async () => {
  const bars = make1m(80);
  const { visuals, diagnostics } = await runVisuals(`//@version=6
indicator("mir", overlay=true)
plot(ta.ema(close, 9), "e")
hline(50, "Mid")`, bars);
  assert.deepEqual(diagnostics.rendered, visuals.map((v) => ({ key: v.key, title: v.title, type: v.type })));
});

test("import: mixed script compiles with full diagnostics and imports cleanly", async () => {
  const bars = make1m(120);
  const outcome = await compileImportedPine({
    name: "Mixed",
    source: `//@version=6
indicator("Mixed", overlay=true)
plot(ta.ema(close, 9), "EMA 9")
plotshape(close > open, "Buy", style=shape.triangleup, color=color.green, text="B")
hline(100, "Level", color=color.gray)
plot(close * 1.01, "circ", style=plot.style_circles)`,
    bars,
    liveCandle: null,
    bucketSec: 60,
  });
  assert.equal(outcome.ok, true, outcome.issue?.message);
  const ind = outcome.indicator;
  const types = ind.plotMeta.map((p) => p.type).sort();
  assert.deepEqual(types, ["horizontal", "line", "marker"]);
  assert.ok(ind.diagnostics, "diagnostics persisted");
  assert.equal(ind.diagnostics.staticCounts["plot()"], 2, "static scan sees the raw source");
  assert.equal(ind.diagnostics.staticCounts["plotshape()"], 1);
  assert.equal(ind.diagnostics.staticCounts["hline()"], 1);
  assert.ok(ind.diagnostics.unsupported.some((u) => u.kind.includes("circles")));
  assert.equal(ind.diagnostics.rendered.length, ind.plotMeta.length);
});

test("import: zero-renderable script STILL imports with warning + diagnostics", async () => {
  const bars = make1m(80);
  const outcome = await compileImportedPine({
    name: "Circles only",
    source: `//@version=6
indicator("circles only")
plot(close, "c", style=plot.style_circles)`,
    bars,
    liveCandle: null,
    bucketSec: 60,
  });
  assert.equal(outcome.ok, true, "compiles + imports; never a bare 'Nothing to render' failure");
  assert.match(outcome.warning, /could not render any supported visual outputs/);
  assert.equal(outcome.indicator.plotMeta.length, 0);
  assert.ok(outcome.indicator.diagnostics.unsupported.some((u) => u.kind.includes("circles")));
});

// ── Timeframes: 1m / 3m / switching ─────────────────────────────────────────

test("timeframes: visuals recompute against the selected timeframe's candles", async () => {
  const m1 = make1m(80);
  const m3 = make3m(80);
  const script = `//@version=6
indicator("tf", overlay=true)
plot(ta.ema(close, 9), "e")`;
  const v1 = await runForVisuals(script, m1, null, 60);
  const v3 = await runForVisuals(script, m3, null, 180);
  assert.equal(v1[0].data[v1[0].data.length - 1].ts, m1[m1.length - 1].ts, "1m: last point on last 1m candle");
  assert.equal(v3[0].data[v3[0].data.length - 1].ts, m3[m3.length - 1].ts, "3m: last point on last 3m candle");
  assert.ok(Math.abs(v1[0].data[0].value - v3[0].data[0].value) > 1e-9, "values differ across timeframes");
});

test("timeframes: switching 1m↔3m in ONE engine recomputes (no 1m→3m bleed)", async () => {
  const eng = new PineIndicatorEngine();
  const script = `//@version=6
indicator("tf", overlay=true)
plot(ta.ema(close, 9), "e")`;
  const m1 = make1m(80);
  const m3 = make3m(80);
  eng.setCandles(m1, null, 60);
  const a = await eng.computeScriptVisuals({ id: "t", source: script, bindings: [] }, {});
  eng.setCandles(m3, null, 180);
  const b = await eng.computeScriptVisuals({ id: "t", source: script, bindings: [] }, {});
  eng.setCandles(m1, null, 60);
  const c = await eng.computeScriptVisuals({ id: "t", source: script, bindings: [] }, {});
  assert.notEqual(a.visuals[0].data[a.visuals[0].data.length - 1].value, b.visuals[0].data[b.visuals[0].data.length - 1].value);
  assert.equal(
    b.visuals[0].data[b.visuals[0].data.length - 1].ts,
    m3[m3.length - 1].ts,
    "3m recalculation consumed 3m candles",
  );
  assert.equal(c.visuals[0].data.length, a.visuals[0].data.length, "back to 1m → identical shape");
  eng.dispose();
});

// ── Live: forming candle / stale frame ──────────────────────────────────────

test("live: forming candle updates the last visual point via authoritative close", async () => {
  const bars = make1m(80);
  const bucket = 60;
  const liveTs = Math.floor((bars[bars.length - 1].ts + 60_000) / 1000);
  const script = `//@version=6
indicator("live", overlay=true)
plot(ta.ema(close, 9), "e")`;
  const withoutLive = await runForVisuals(script, bars, null, bucket);
  const withLive = await runForVisuals(
    script,
    bars,
    { time: liveTs, open: 101, high: 102, low: 100, close: 140, volume: 5 },
    bucket,
  );
  const lastW = withLive[0].data[withLive[0].data.length - 1];
  assert.equal(lastW.ts, liveTs * 1000, "forming bucket appended");
  assert.ok(lastW.value > withoutLive[0].data[withoutLive[0].data.length - 1].value, "authoritative live close pulls the EMA up");
});

test("live: stale frame (identical authoritative closes) hits the visuals cache", async () => {
  const eng = new PineIndicatorEngine();
  const bars = make1m(80);
  const spec = { id: "cache", source: `//@version=6
indicator("c", overlay=true)
plot(ta.ema(close, 9), "e")`, bindings: [] };
  eng.setCandles(bars, null, 60);
  const first = await eng.computeScriptVisuals(spec, {});
  // Identical series again (e.g. a rAF frame that changed nothing).
  eng.setCandles(bars, null, 60);
  const second = await eng.computeScriptVisuals(spec, {});
  assert.equal(second, first, "memoized result object is reused");
  eng.dispose();
});

// ── Inputs: recalculation through the visuals path ──────────────────────────

test("inputs: changing an input re-runs the visuals calculation", async () => {
  const bars = make1m(120);
  const script = `//@version=6
indicator("inp", overlay=true)
len = input.int(9, "EMA Length", minval=1, maxval=200)
plot(ta.ema(close, len), "out")`;
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const spec = { id: "inp", source: script, bindings: [{ title: "EMA Length", paramKey: "len" }] };
  const short = await eng.computeScriptVisuals(spec, { len: 9 });
  const long = await eng.computeScriptVisuals(spec, { len: 34 });
  assert.notDeepEqual(
    short.visuals[0].data.map((p) => p.value),
    long.visuals[0].data.map((p) => p.value),
  );
  eng.dispose();
});

// ── Persistence: v1 migration + round-trip ──────────────────────────────────

test("storage: v1 envelopes migrate — plotMeta types default to line", () => {
  const storage = memoryStorage();
  storage.setItem(PINE_STORAGE_KEY, JSON.stringify({
    version: 1,
    indicators: [{
      id: "pine-v1",
      name: "Old EMA",
      source: `//@version=6\nindicator("Old")\nplot(ta.ema(close, 9), "EMA 9")`,
      enabled: true,
      overlay: true,
      inputs: {},
      inputMeta: [],
      plotMeta: [{ key: "EMA 9", title: "EMA 9", color: "#2962ff" }],
      createdAt: 1_700_000_000_000,
    }],
  }));
  const loaded = loadImportedPineIndicators(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].plotMeta[0].type, "line");
});

test("storage: v2 round-trip preserves typed plotMeta + diagnostics", () => {
  const storage = memoryStorage();
  const list = [{
    id: "pine-v2",
    name: "Mixed",
    source: `//@version=6\nindicator("Mixed")\nplot(ta.ema(close, 9), "e")\nhline(50)`,
    enabled: true,
    overlay: true,
    inputs: {},
    inputMeta: [],
    plotMeta: [
      { key: "e", title: "e", type: "line", color: "#ff0000", linewidth: 2 },
      { key: "Mid", title: "Mid", type: "horizontal" },
    ],
    diagnostics: {
      staticCounts: { "plot()": 1, "hline()": 1 },
      rendered: [{ key: "e", title: "e", type: "line" }],
      unsupported: [],
      hidden: 0,
    },
    createdAt: 1_700_000_000_000,
  }];
  saveImportedPineIndicators(list, storage);
  const loaded = loadImportedPineIndicators(storage);
  assert.equal(loaded[0].plotMeta[0].type, "line");
  assert.equal(loaded[0].plotMeta[1].type, "horizontal");
  assert.deepEqual(loaded[0].diagnostics.staticCounts, { "plot()": 1, "hline()": 1 });
  // Re-saving must keep the envelope at the CURRENT version.
  const envelope = JSON.parse(storage._map.get(PINE_STORAGE_KEY));
  assert.equal(envelope.version, 2);
});

test("compat: computeScript line path still works alongside the visuals path", async () => {
  const bars = make1m(80);
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const spec = { id: "dual", source: `//@version=6
indicator("dual", overlay=true)
plot(ta.ema(close, 9), "EMA 9")
plot(ta.ema(close, 20), "EMA 20")`, bindings: [] };
  const map = await eng.computeScript(spec, {});
  const run = await eng.computeScriptVisuals(spec, {});
  assert.equal(map.size, 2);
  assert.equal(run.visuals.length, 2);
  assert.deepEqual(map.get("EMA 9").points, run.visuals[0].data, "both paths extract identical points");
  eng.dispose();
});

// ── extractVisuals unit sanity (defensive shapes) ───────────────────────────

test("extractVisuals: null/undefined context and empty plots are safe", () => {
  const empty = extractVisuals(undefined, 8);
  assert.deepEqual(empty.visuals, []);
  assert.deepEqual(empty.diagnostics.unsupported, []);
  assert.equal(empty.diagnostics.hidden, 0);
  const bare = extractVisuals({ plots: {} }, 8);
  assert.equal(bare.visuals.length, 0);
});