/**
 * Piner engine tests — Piner is the sole Pine engine (worker-hosted).
 * (docs/pine-migration.md §Testing requirements).
 *
 * The suite exercises the AURA-owned engine boundary, NOT @heyphat/piner
 * internals directly: `PinerPineEngine` (in-thread, the worker/fallback core)
 * and `PinerWorkerEngine` (worker-transported, transparent in-thread fallback
 * under Node where no DOM Worker exists — the designed test path).
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import { PinerWorkerEngine } from "../src/services/pineWorkerClient.ts";
import { mintickFromDecimals } from "../src/services/pineMintick.ts";
import { pineTimeframeStr } from "../src/services/pinePinerCore.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

function rng(seed = 1) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 100 - 50;
  };
}

/** Deterministic tick-grid candles (epoch-ms ts, AURA `PineBar` shape). */
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

const SPEC = (source, id = "piner-test") => ({ id, source, bindings: [] });

/** Fresh engine over `bars`; returns the engine (caller disposes). */
function engineOver(bars, symbol = null, bucketSec = 60) {
  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, bucketSec, symbol);
  return eng;
}

const lineOf = (run) => run?.visuals.find((v) => v.type === "line") ?? null;

// ── Unit: pure core helpers ─────────────────────────────────────────────────

test("pineTimeframeStr: bucket seconds → Pine timeframe strings", () => {
  assert.equal(pineTimeframeStr(60), "1");
  assert.equal(pineTimeframeStr(180), "3");
  assert.equal(pineTimeframeStr(3600), "60");
  assert.equal(pineTimeframeStr(45), "45S");
  assert.equal(pineTimeframeStr(0), "1"); // degenerate → safe default
  assert.equal(pineTimeframeStr(Number.NaN), "1");
});

test("mintickFromDecimals: registry decimals → tick grid", () => {
  assert.equal(mintickFromDecimals(2), 0.01);
  assert.equal(mintickFromDecimals(1), 0.1);
  assert.equal(mintickFromDecimals(0), 1);
});


// ── Init / execute / candle input ───────────────────────────────────────────

test("piner engine: executes a plain SMA plot over the authoritative candle slice", async () => {
  const bars = makeBars(40);
  const eng = engineOver(bars);
  const run = await eng.computeScriptVisuals(
    SPEC(`//@version=6\nindicator("sma", overlay=true)\nplot(ta.sma(close, 5), "sma5")`),
  );
  assert.ok(run, "run must succeed");
  const line = lineOf(run);
  assert.ok(line, "expected a line visual");
  // Warmup rows (first 4 bars) are stripped; points align to candle openTime.
  assert.equal(line.data.length, 40 - 4);
  assert.equal(line.data[0].ts, bars[4].ts);
  const sma5 = (bars.slice(0, 5).reduce((a, b) => a + b.close, 0) / 5).toFixed(2);
  assert.equal(line.data[0].value.toFixed(2), sma5);
  eng.dispose();
});

test("piner engine: the forming live candle feeds the run (close plot ends at live close)", async () => {
  const bars = makeBars(30);
  // PineLiveCandle.time is epoch SECONDS (mirrors the WS realtime payload).
  const live = { time: (bars[29].ts + 60_000) / 1000, open: bars[29].close, high: 112, low: 108, close: 111, volume: 5 };
  const eng = new PinerPineEngine();
  eng.setCandles(bars, live, 60, null);
  const run = await eng.computeScriptVisuals(SPEC(`//@version=6\nindicator("c", overlay=true)\nplot(close)`));
  const line = lineOf(run);
  assert.ok(line && line.data.length > 0);
  const last = line.data[line.data.length - 1];
  assert.equal(last.ts, 1_704_153_600_000 + 30 * 60_000, "live bucket openTime");
  assert.equal(last.value, 111); // the live close, not the last closed bar
  eng.dispose();
});

test("piner engine: compile failure surfaces through onError without throwing", async () => {
  const eng = engineOver(makeBars(20));
  let err = "";
  const run = await eng.computeScriptVisuals(SPEC("this is not pine"), {}, (m) => (err = m));
  assert.equal(run, null);
  assert.ok(err.length > 0, "the raw compiler error must reach the caller");
  eng.dispose();
});

test("piner engine: no candles → null (insufficient data, not an error)", async () => {
  const eng = new PinerPineEngine();
  const run = await eng.computeScriptVisuals(SPEC(`//@version=6\nindicator("x")\nplot(close)`));
  assert.equal(run, null);
  eng.dispose();
});

// ── syminfo / instrument isolation ──────────────────────────────────────────

test("syminfo.mintick: registry decimals drive the value; symbol change invalidates the cache", async () => {
  const bars = makeBars(25);
  const src = `//@version=6\nindicator("mintick", overlay=true)\nplot(syminfo.mintick * 1000)`;
  const eng = new PinerPineEngine();

  eng.setCandles(bars, null, 60, { tickerid: "CS.D.GOLDCGD.TODAY.IP", decimals: 2 });
  const gold = lineOf(await eng.computeScriptVisuals(SPEC(src)));
  assert.ok(gold && gold.data.length > 0);
  assert.equal(gold.data[0].value.toFixed(6), (0.01 * 1000).toFixed(6));

  // SAME candles, DIFFERENT instrument (3-decimal) — symSig change must
  // invalidate the visuals cache and re-run with the new mintick.
  eng.setCandles(bars, null, 60, { tickerid: "TEST.EURUSD.IP", decimals: 3 });
  const fx = lineOf(await eng.computeScriptVisuals(SPEC(src)));
  assert.ok(fx && fx.data.length > 0);
  assert.equal(fx.data[0].value.toFixed(6), (0.001 * 1000).toFixed(6));
  eng.dispose();
});


// ── plots: styles ───────────────────────────────────────────────────────────

test("plot styles: stepline/histogram/area map to their AURA visual kinds", async () => {
  const bars = makeBars(30);
  const eng = engineOver(bars);
  const run = await eng.computeScriptVisuals(
    SPEC(`//@version=6
indicator("styles", overlay=true)
plot(ta.sma(close, 5), "step", style=plot.style_stepline)
plot(ta.sma(close, 6), "hist", style=plot.style_histogram)
plot(ta.sma(close, 7), "area", style=plot.style_area)`),
  );
  assert.ok(run);
  assert.ok(run.visuals.some((v) => v.type === "line" && v.stepLine), "stepline");
  assert.ok(run.visuals.some((v) => v.type === "histogram"), "histogram");
  assert.ok(run.visuals.some((v) => v.type === "area"), "area");
  eng.dispose();
});

// ── markers ─────────────────────────────────────────────────────────────────

test("plotshape/plotchar: crossover markers map to the LWC marker domain", async () => {
  // Oscillating closes guarantee both a crossover AND a crossunder of
  // sma(3)/sma(8) within the window (a random walk may never cross).
  const bars = [];
  let prev = 100;
  for (let i = 0; i < 40; i++) {
    const c = prev + Math.sin(i / 3) * 2 + (i % 4 === 0 ? 2 : -1);
    bars.push({ ts: 1_704_153_600_000 + i * 60_000, open: prev, high: Math.max(prev, c) + 1, low: Math.min(prev, c) - 1, close: c, volume: 1000 + i });
    prev = c;
  }
  const eng = engineOver(bars);
  const run = await eng.computeScriptVisuals(
    SPEC(`//@version=6
indicator("marks", overlay=true)
fast = ta.sma(close, 3)
slow = ta.sma(close, 8)
plotshape(ta.crossover(fast, slow), title="up", style=shape.triangleup, location=location.belowbar, color=color.green)
plotchar(ta.crossunder(fast, slow), title="dn", char="v", location=location.abovebar, color=color.red)`),
  );
  assert.ok(run);
  const markers = run.visuals.filter((v) => v.type === "marker");
  assert.ok(markers.length >= 1, "at least the plotshape must surface");
  for (const m of markers) {
    for (const p of m.data) {
      assert.ok(p.ts > 0 && Number.isFinite(p.ts));
      assert.ok(["aboveBar", "belowBar", "inBar"].includes(p.position));
      assert.ok(["arrowUp", "arrowDown", "circle", "square"].includes(p.shape));

// ── drawings: labels / lines / boxes + lifecycle + force_overlay ───────────

test("drawings: label/line/box extract through the shared normalizers with force_overlay routing", async () => {
  const bars = makeBars(25);
  const eng = engineOver(bars);
  const run = await eng.computeScriptVisuals(
    SPEC(`//@version=6
indicator("draw", overlay=true, max_labels_count=500, max_lines_count=500, max_boxes_count=500)
if barstate.islast
    label.new(bar_index, high, "PANEL", color=color.orange, textcolor=color.white, style=label.style_label_down)
    label.new(bar_index, high, "OVERLAY", color=color.green, textcolor=color.white, force_overlay=true)
    line.new(bar_index - 5, low, bar_index, high, color=color.red, width=2)
    box.new(bar_index - 8, high, bar_index, low, border_color=color.blue, bgcolor=color.new(color.blue, 80))`),
  );
  assert.ok(run);
  const labels = run.visuals.find((v) => v.type === "labels");
  const lines = run.visuals.find((v) => v.type === "lines");
  const boxes = run.visuals.find((v) => v.type === "boxes");
  assert.ok(labels, "labels visual present");
  assert.equal(labels.labels.length, 1, "pane label");
  assert.equal(labels.overlayLabels.length, 1, "force_overlay label routed to the overlay bucket");
  assert.equal(labels.overlayLabels[0].text, "OVERLAY");
  assert.ok(lines && lines.lines.length === 1, "line drawing present");
  assert.ok(boxes && boxes.boxes.length === 1, "box drawing present");
  eng.dispose();
});

test("drawing lifecycle: set_text/set_color mutate in place and delete removes the object", async () => {
  const bars = makeBars(20);
  const eng = engineOver(bars);
  const run = await eng.computeScriptVisuals(
    SPEC(`//@version=6
indicator("lifecycle", overlay=true, max_labels_count=500)
var label l = na
if bar_index == 5
    l := label.new(bar_index, high, "FIRST")
if bar_index == 9
    label.set_text(l, "UPDATED")
    label.set_color(l, color.red)
if bar_index == 12
    label.delete(l)`),
  );
  assert.ok(run);
  const labels = run.visuals.find((v) => v.type === "labels");
  assert.ok(!labels || (labels.labels.length === 0 && labels.overlayLabels.length === 0),
    "the deleted label must be gone from the final registry snapshot");
  eng.dispose();
});

// ── replay determinism (no future-bar leakage) ──────────────────────────────

test("replay: a slice re-run matches the full run truncated — no future leakage", async () => {
  const bars = makeBars(40);
  const src = `//@version=6
indicator("replay", overlay=true, max_labels_count=500)
plot(ta.sma(close, 5), "sma")
plot(ta.ema(close, 8), "ema")
if barstate.islast
    label.new(bar_index, high, "LAST")`;
  const full = engineOver(bars);
  const fullRun = await full.computeScriptVisuals(SPEC(src));

  // Replay cursor at bar 25: only the first 25 bars exist.
  const sliced = engineOver(bars.slice(0, 25));
  const sliceRun = await sliced.computeScriptVisuals(SPEC(src, "piner-test-2"));

  for (const key of ["sma", "ema"]) {
    const a = fullRun.visuals.find((v) => v.type === "line" && v.title === key);
    const b = sliceRun.visuals.find((v) => v.type === "line" && v.title === key);
    assert.ok(a && b, `${key} present in both runs`);
    const aPrefix = a.data.filter((p) => p.ts < bars[25].ts);
    assert.deepEqual(
      b.data.map((p) => [p.ts, p.value]),
      aPrefix.map((p) => [p.ts, p.value]),
      `${key} values inside the slice must be identical (deterministic, replay-safe)`,
    );
  }
  // The barstate.islast label anchors INSIDE the slice — a replay run never
  // draws at a bar that has not "happened" yet.
  const sliceLabels = sliceRun.visuals.find((v) => v.type === "labels");
  if (sliceLabels) {
    for (const l of [...sliceLabels.labels, ...sliceLabels.overlayLabels]) {
      assert.ok(l.logical <= 24, "no label anchored beyond the replay cursor");
    }
  }
  full.dispose();
  sliced.dispose();
});

    }
  }
  eng.dispose();
});

// ── stale-run protection (per-script serialization) ─────────────────────────

test("concurrent runs: interleaved requests never cross-contaminate results", async () => {
  const bars = makeBars(30);
  const eng = engineOver(bars);
  const spec = SPEC(`//@version=6
indicator("params", overlay=true)
len = input.int(5, "Length")
plot(ta.sma(close, len), "out")`);

  const specBound = { ...spec, bindings: [{ title: "Length", paramKey: "len" }] };
  const base5 = lineOf(await eng.computeScriptVisuals(specBound, { len: 5 }));
  const base10 = lineOf(await eng.computeScriptVisuals(specBound, { len: 10 }));
  assert.ok(base5 && base10, "both baselines produced");
  assert.notEqual(base5.data[10].value, base10.data[10].value, "the two parameter sets genuinely differ");

  const [r5, r10] = await Promise.all([
    eng.computeScriptVisuals(specBound, { len: 5 }),
    eng.computeScriptVisuals(specBound, { len: 10 }),
  ]);
  assert.deepEqual(lineOf(r5).data, base5.data, "run A keeps its own result");
  assert.deepEqual(lineOf(r10).data, base10.data, "run B keeps its own result");
  eng.dispose();
});

// ── timeframe isolation ─────────────────────────────────────────────────────

test("timeframe isolation: a new candle slice invalidates the previous run's cache", async () => {
  const bars1m = makeBars(30);
  const eng = new PinerPineEngine();
  eng.setCandles(bars1m, null, 60, null);
  const run1m = lineOf(await eng.computeScriptVisuals(SPEC(`//@version=6\nindicator("t", overlay=true)\nplot(close)`)));
  assert.equal(run1m.data.length, 30);

  const bars3m = bars1m.map((b, i) => ({ ...b, ts: b.ts + (i % 2) * 180_000 }));
  eng.setCandles(bars3m, null, 180, null);
  const run3m = lineOf(await eng.computeScriptVisuals(SPEC(`//@version=6\nindicator("t", overlay=true)\nplot(close)`)));
  assert.deepEqual(
    run3m.data.map((p) => p.ts),
    bars3m.map((b) => b.ts),
    "points re-anchor to the new slice's timestamps",
  );
  eng.dispose();
});

// ── worker transport (fallback = designed Node path) ────────────────────────

test("worker engine: Node (no DOM Worker) transparently falls back in-thread with stage events", async () => {
  const eng = new PinerWorkerEngine();
  const bars = makeBars(25);
  eng.setCandles(bars, null, 60, { tickerid: "TEST.IP", decimals: 2 });
  const stages = [];
  const run = await eng.computeScriptVisuals(
    SPEC(`//@version=6\nindicator("w", overlay=true)\nplot(syminfo.mintick * 1000)`),
    {},
    undefined,
    undefined,
    (s) => stages.push(s),
  );
  assert.ok(run, "fallback run succeeds");
  assert.equal(lineOf(run).data[0].value.toFixed(6), "10.000000");
  assert.deepEqual(
    stages.filter((s, i, arr) => s !== arr[i - 1]),
    ["compiling", "executing", "extracting"],
    "real stage boundaries surface through the transport",
  );
  eng.dispose();
});

// ── the migration gate: real-world ~83k script through Piner ────────────────

test("MIGRATION GATE: an ~83k script compiles + executes through Piner with syminfo", { timeout: 60_000 }, async () => {
  const bars = makeBars(300, 0.01);
  const filler = "// AURA compatibility padding for realistic script sizes.\n".repeat(1_515);
  const source = `//@version=6
indicator("big script", overlay=true)
${filler}fast = ta.ema(close, 9)
plot(fast, "EMA")
plot(ta.sma(close, 20), "SMA")
plotshape(ta.crossover(fast, close), title="sig", style=shape.triangleup, location=location.belowbar)
plot(syminfo.mintick * 1000, "tickx1000")`;
  assert.ok(source.length > 80_000 && source.length < 100_000, `fixture size ${source.length}`);

  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, 60, { tickerid: "CS.D.GOLDCGD.TODAY.IP", decimals: 2 });
  const t0 = performance.now();
  const run = await eng.computeScriptVisuals(SPEC(source));
  const elapsed = performance.now() - t0;
  assert.ok(run, "83k script must compile+run through the Piner adapter");
  const tick = run.visuals.find((v) => v.type === "line" && v.title === "tickx1000");
  assert.ok(tick && tick.data.length > 0 && tick.data[0].value.toFixed(4) === "10.0000",
    "syminfo.mintick still resolves inside the large script");
  assert.ok(run.visuals.some((v) => v.type === "line" && v.title === "EMA"));
  assert.ok(run.visuals.some((v) => v.type === "marker"));
  assert.equal(run.diagnostics.unsupported.length, 0, "nothing silently unsupported");
  console.log(`[pinePiner] 83k compile+execute: ${elapsed.toFixed(0)}ms`);
  assert.ok(elapsed < 55_000, "83k script must complete inside the gate budget");
  eng.dispose();
});
