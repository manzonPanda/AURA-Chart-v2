/**
 * Pine Script import test suite — AURA's "Import Pine Script" feature.
 *
 * Covers: valid imports + plot extraction, invalid syntax / unknown functions /
 * strategy rejection, input bindings (int/float/bool/color + recalculation),
 * timeframe behavior (1m / 3m / switching), live-candle behavior (forming,
 * rollover, stale frame, background tab), localStorage persistence (round-trip,
 * corruption fallback) and safety limits (oversized scripts, runtime-error
 * isolation, multiple indicators through one engine).
 *
 * The import feature shares the SAME PineIndicatorEngine as EMA 9/20 —
 * engine-level guarantees (authoritative closes, caching) are additionally
 * proven in pineEquivalence.test.mjs.
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { calculateEMA, effectiveCloseSeries } from "../src/services/ema.ts";
import { PineIndicatorEngine } from "../src/services/pineEngine.ts";
import {
  compileImportedPine,
  friendlyPineError,
  loadImportedPineIndicators,
  MAX_IMPORTED_INDICATORS,
  MAX_PINE_SOURCE_LENGTH,
  MAX_PLOT_SERIES_PER_INDICATOR,
  PINE_STORAGE_KEY,
  PINE_STORAGE_VERSION,
  sanitizeImportedList,
  sanitizeInputValue,
  saveImportedPineIndicators,
  staticValidateSource,
} from "../src/services/pineImport.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

/** Deterministic pseudo-random closes (same style as pineEquivalence.test.mjs). */
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

const EMA_SCRIPT = `//@version=6
indicator("My EMA", overlay=true)

emaFast = ta.ema(close, 9)
emaSlow = ta.ema(close, 20)

plot(emaFast, "EMA 9")
plot(emaSlow, "EMA 20")`;

const INPUT_SCRIPT = `//@version=6
indicator("Inputs demo", overlay=true)
len = input.int(9, "EMA Length", minval=1, maxval=200)
f = input.float(1.0, "Factor", step=0.1)
useSlow = input.bool(false, "Use slow")
col = input.color(color.yellow, "Line Color")
plotLen = useSlow ? 30 : len
plot(ta.ema(close, plotLen) * f, "out", color=col)`;

async function compile(script, { bars = make1m(120), live = null, bucketSec = 60, name = "" } = {}) {
  return compileImportedPine({ name, source: script, bars, liveCandle: live, bucketSec });
}

/** Run a script body through the generic engine path and return the series map. */
async function runScript(script, bars, live = null, bucketSec = 60, params = {}) {
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, live, bucketSec);
  const map = await eng.computeScript({ id: "test", source: script, bindings: [] }, params);
  eng.dispose();
  return map;
}

function assertFiniteAligned(points, bars, label) {
  assert.ok(points.length > 0, `${label}: expected points`);
  const lastBar = bars[bars.length - 1];
  assert.equal(points[points.length - 1].ts, lastBar.ts, `${label}: last point aligns to last candle`);
  for (const p of points) {
    assert.equal(typeof p.value, "number", `${label}: numeric value`);
    assert.ok(Number.isFinite(p.value), `${label}: finite value`);
  }
}

// ── Basic: import / compile / extract ───────────────────────────────────────

test("basic: imports the canonical EMA example and extracts both plots", async () => {
  const bars = make1m(120);
  const outcome = await compile(EMA_SCRIPT, { bars, name: "My EMA" });
  assert.equal(outcome.ok, true, `compile failed: ${outcome.issue?.message}`);
  const ind = outcome.indicator;
  assert.ok(ind);
  assert.equal(ind.name, "My EMA");
  assert.equal(ind.overlay, true);
  assert.equal(ind.inputMeta.length, 0);
  assert.deepEqual(ind.plotMeta.map((p) => p.key), ["EMA 9", "EMA 20"]);

  const map = await runScript(EMA_SCRIPT, bars);
  assert.equal(map.size, 2, "both plots extracted");
  const ema9 = map.get("EMA 9");
  const ema20 = map.get("EMA 20");
  assertFiniteAligned(ema9.points, bars, "EMA 9");
  assertFiniteAligned(ema20.points, bars, "EMA 20");

  // Values match the pure-TS oracle for the same periods.
  const closes = effectiveCloseSeries(bars, null, 60);
  for (const [plot, period] of [["EMA 9", 9], ["EMA 20", 20]]) {
    const ref = calculateEMA(closes, period);
    const got = map.get(plot).points;
    assert.equal(got.length, ref.length, `${plot}: point count`);
    const maxDelta = Math.max(...got.map((p, i) => Math.abs(p.value - ref[i].value)));
    assert.ok(maxDelta < 5e-9, `${plot}: maxDelta ${maxDelta}`);
  }
});

test("basic: single-plot script yields exactly one series", async () => {
  const bars = make1m(80);
  const map = await runScript(`//@version=6
indicator("one", overlay=true)
plot(ta.sma(close, 10), "sma10")`, bars);
  assert.equal(map.size, 1);
  assert.ok(map.has("sma10"));
  assertFiniteAligned(map.get("sma10").points, bars, "sma10");
});

test("basic: untitled plots get deterministic #N keys", async () => {
  const bars = make1m(80);
  const map = await runScript(`//@version=6
indicator("untitled", overlay=true)
plot(ta.ema(close, 9))
plot(ta.ema(close, 20))`, bars);
  assert.deepEqual([...map.keys()], ["#0", "#1"]);
});

test("basic: script color/linewidth surface on the extracted series", async () => {
  const bars = make1m(80);
  const map = await runScript(`//@version=6
indicator("styled", overlay=true)
plot(ta.ema(close, 9), "EMA 9", color=color.orange, linewidth=3)`, bars);
  const s = map.get("EMA 9");
  assert.equal(s.linewidth, 3);
  assert.equal(s.color, "#FF9800", "Pine color.orange maps to hex");
});

test("basic: dynamic per-bar colors are exposed per point", async () => {
  const bars = make1m(80);
  // bar_index parity guarantees the color truly alternates (synthetic closes
  // all sit on one side of any price threshold).
  const map = await runScript(`//@version=6
indicator("dyn", overlay=true)
c = bar_index % 2 == 0 ? color.green : color.red
plot(ta.ema(close, 9), "dyn", color=c)`, bars);
  const s = map.get("dyn");
  const withColor = s.points.filter((p) => typeof p.color === "string" && p.color.length > 0);
  assert.ok(withColor.length > 0, "per-point colors present");
  const unique = new Set(withColor.map((p) => p.color));
  assert.equal(unique.size, 2, "colors genuinely alternate (green/red pair)");
});

test("basic: invalid syntax reports a friendly message, not a stack", async () => {
  const outcome = await compile(`//@version=6
indicator("bad"
plot(close "x")`);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.issue.kind, "syntax");
  assert.match(outcome.issue.message, /Pine syntax error/);
  assert.doesNotMatch(outcome.issue.message, /pinets/);
  assert.doesNotMatch(outcome.issue.message, /\n {4}at /);
});

test("basic: unknown ta function maps to 'Unknown function: …'", async () => {
  const outcome = await compile(`//@version=6
indicator("bad")
plot(ta.someFunction(close), "x")`);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.issue.kind, "run");
  assert.equal(outcome.issue.message, "Unknown function: ta.someFunction — it is not available in PineTS.");
});

test("basic: strategy() scripts are rejected as a future phase", async () => {
  const outcome = await compile(`//@version=6
strategy("my strat")
plot(close, "c")`);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.issue.kind, "strategy");
  assert.match(outcome.issue.message, /indicators only/);
});

test("basic: strategy.* member calls inside indicator scripts are rejected", async () => {
  const issue = staticValidateSource(`//@version=6
indicator("mixed")
if (ta.crossover(close, open))
    strategy.entry("long")
plot(ta.ema(close, 9), "e")`);
  assert.equal(issue.kind, "unsupported");
  assert.match(issue.message, /Strategy execution is not supported/i);
});

test("basic: v4 (study) scripts are rejected with a version message", async () => {
  const outcome = await compile(`//@version=4
study("old", overlay=true)
plot(ta.ema(close, 9), title="EMA9")`);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.issue.kind, "version");
  assert.match(outcome.issue.message, /v5\/v6/);
});

test("basic: scripts without indicator()/study() declaration are rejected", async () => {
  const issue = staticValidateSource(`//@version=6
a = ta.ema(close, 9)`);
  assert.equal(issue.kind, "declaration");
});

test("basic: request.* scripts are rejected as unsupported", async () => {
  const issue = staticValidateSource(`//@version=6
indicator("req")
plot(request.security(syminfo.tickerid, "D", close), "d")`);
  assert.equal(issue.kind, "unsupported");
});

test("basic: plotshape-only scripts import as markers (never 'nothing to render')", async () => {
  const outcome = await compile(`//@version=6
indicator("shapes")
plotshape(close > open, "sig", style=shape.triangleup, color=color.lime)`);
  assert.equal(outcome.ok, true, outcome.issue?.message);
  assert.equal(outcome.indicator.plotMeta.length, 1);
  assert.equal(outcome.indicator.plotMeta[0].type, "marker");
  assert.equal(outcome.indicator.plotMeta[0].key, "sig");
});

test("basic: styled non-line plots are filtered, line plots survive (computeScript compat path)", async () => {
  const bars = make1m(80);
  const map = await runScript(`//@version=6
indicator("mixed", overlay=true)
plot(ta.ema(close, 9), "line")
plotshape(close > open, style=shape.triangleup)
hline(100)`, bars);
  assert.deepEqual([...map.keys()], ["line"]);
});

// ── Inputs: bindings + recalculation ────────────────────────────────────────

test("inputs: compile detects input metadata with types and ranges", async () => {
  const outcome = await compile(INPUT_SCRIPT);
  assert.equal(outcome.ok, true, outcome.issue?.message);
  const byVar = Object.fromEntries(outcome.indicator.inputMeta.map((m) => [m.varId, m]));
  assert.equal(byVar.len.type, "int");
  assert.equal(byVar.len.defval, 9);
  assert.equal(byVar.len.minval, 1);
  assert.equal(byVar.len.maxval, 200);
  assert.equal(byVar.f.type, "float");
  assert.equal(byVar.f.step, 0.1);
  assert.equal(byVar.useSlow.type, "bool");
  assert.equal(byVar.col.type, "color");
  // Defaults are seeded into the record's inputs map.
  assert.equal(outcome.indicator.inputs.len, 9);
  assert.equal(outcome.indicator.inputs.useSlow, false);
});

test("inputs: changing input.int recalculates against the oracle", async () => {
  const bars = make1m(150);
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const spec = {
    id: "inputs",
    source: INPUT_SCRIPT,
    bindings: [
      { title: "EMA Length", paramKey: "len" },
      { title: "Factor", paramKey: "f" },
      { title: "Use slow", paramKey: "useSlow" },
      { title: "Line Color", paramKey: "col" },
    ],
  };
  const dflt = await eng.computeScript(spec, { len: 9, f: 1, useSlow: false, col: "#fdd835" });
  const longer = await eng.computeScript(spec, { len: 34, f: 1, useSlow: false, col: "#fdd835" });
  assert.notEqual(
    dflt.get("out").points[dflt.get("out").points.length - 1].value,
    longer.get("out").points[longer.get("out").points.length - 1].value,
    "different period → different value",
  );
  const closes = effectiveCloseSeries(bars, null, 60);
  const ref = calculateEMA(closes, 34);
  const got = longer.get("out").points;
  assert.equal(got.length, ref.length);
  const maxDelta = Math.max(...got.map((p, i) => Math.abs(p.value - ref[i].value)));
  assert.ok(maxDelta < 5e-9, `len=34 matches oracle (maxDelta ${maxDelta})`);
  eng.dispose();
});

test("inputs: input.float and input.bool change the output", async () => {
  const bars = make1m(150);
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const spec = {
    id: "inputs2",
    source: INPUT_SCRIPT,
    bindings: [
      { title: "EMA Length", paramKey: "len" },
      { title: "Factor", paramKey: "f" },
      { title: "Use slow", paramKey: "useSlow" },
      { title: "Line Color", paramKey: "col" },
    ],
  };
  const base = await eng.computeScript(spec, { len: 9, f: 1, useSlow: false, col: "#fdd835" });
  const factored = await eng.computeScript(spec, { len: 9, f: 2, useSlow: false, col: "#fdd835" });
  const slow = await eng.computeScript(spec, { len: 9, f: 1, useSlow: true, col: "#fdd835" });
  const lastOf = (m) => m.get("out").points[m.get("out").points.length - 1].value;
  const lastBase = lastOf(base);
  assert.equal(lastOf(factored), lastBase * 2, "float factor scales the plot");
  assert.notEqual(lastOf(slow), lastBase, "bool branch switches the period");
  eng.dispose();
});

test("inputs: input.color override flows into the series color", async () => {
  const bars = make1m(80);
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const spec = {
    id: "inputs3",
    source: INPUT_SCRIPT,
    bindings: [{ title: "Line Color", paramKey: "col" }],
  };
  const res = await eng.computeScript(spec, { len: 9, f: 1, useSlow: false, col: "#123456" });
  assert.equal(res.get("out").color, "#123456");
  eng.dispose();
});

test("inputs: sanitizeInputValue clamps and falls back per type", () => {
  const intMeta = { varId: "len", title: "Len", type: "int", defval: 9, minval: 1, maxval: 100 };
  assert.equal(sanitizeInputValue(intMeta, 50), 50);
  assert.equal(sanitizeInputValue(intMeta, -5), 1, "below minval clamps up");
  assert.equal(sanitizeInputValue(intMeta, 500), 100, "above maxval clamps down");
  assert.equal(sanitizeInputValue(intMeta, 1.5), 9, "float for int → defval");
  assert.equal(sanitizeInputValue(intMeta, "9"), 9, "string → defval");

  const floatMeta = { varId: "f", title: "F", type: "float", defval: 0.5 };
  assert.equal(sanitizeInputValue(floatMeta, 1.25), 1.25);
  assert.equal(sanitizeInputValue(floatMeta, NaN), 0.5);

  const boolMeta = { varId: "b", title: "B", type: "bool", defval: true };
  assert.equal(sanitizeInputValue(boolMeta, false), false);
  assert.equal(sanitizeInputValue(boolMeta, "true"), true);

  const strMeta = { varId: "s", title: "S", type: "string", defval: "A", options: ["A", "B"] };
  assert.equal(sanitizeInputValue(strMeta, "B"), "B");
  assert.equal(sanitizeInputValue(strMeta, "Z"), "A", "not in options → defval");

  const colorMeta = { varId: "c", title: "C", type: "color", defval: "#fdd835ff" };
  assert.equal(sanitizeInputValue(colorMeta, "#ABCDEF"), "#abcdef", "color normalized to lowercase hex");
  assert.equal(sanitizeInputValue(colorMeta, "yellow"), "#fdd835ff");
});

// ── Timeframes ──────────────────────────────────────────────────────────────

test("timeframes: 1m candles produce 1m-aligned points", async () => {
  const bars = make1m(100);
  const map = await runScript(EMA_SCRIPT, bars, null, 60);
  assertFiniteAligned(map.get("EMA 9").points, bars, "1m");
});

test("timeframes: 3m candles produce 3m-aligned points (never 1m math)", async () => {
  const bars3m = make3m(80);
  const map = await runScript(EMA_SCRIPT, bars3m, null, 180);
  const pts = map.get("EMA 9").points;
  assertFiniteAligned(pts, bars3m, "3m");
  for (const p of pts) {
    assert.equal(p.ts % 180_000, bars3m[0].ts % 180_000, "aligned to the 3m grid");
  }
  // And the values match an EMA computed from the 3m closes.
  const closes = effectiveCloseSeries(bars3m, null, 180);
  const ref = calculateEMA(closes, 9);
  const maxDelta = Math.max(...pts.map((p, i) => Math.abs(p.value - ref[i].value)));
  assert.ok(maxDelta < 5e-9, `3m EMA9 == oracle (maxDelta ${maxDelta})`);
});

test("timeframes: engine switching 1m → 3m → 1m recalculates on each series", async () => {
  const bars1m = make1m(200);
  const bars3m = make3m(80);
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars1m, null, 60);
  const p1 = (await eng.computeScript({ id: "t", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  assert.equal(p1[p1.length - 1].ts, bars1m[bars1m.length - 1].ts, "1m ts");

  eng.setCandles(bars3m, null, 180);
  const p3 = (await eng.computeScript({ id: "t", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  assert.equal(p3[p3.length - 1].ts, bars3m[bars3m.length - 1].ts, "3m ts after switch");
  assert.notEqual(p3[p3.length - 1].value, p1[p1.length - 1].value, "recomputed, not cached 1m output");

  eng.setCandles(bars1m, null, 60);
  const p1b = (await eng.computeScript({ id: "t", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  assert.equal(p1b[p1b.length - 1].ts, bars1m[bars1m.length - 1].ts, "back to 1m ts");
  assert.equal(p1b[p1b.length - 1].value, p1[p1.length - 1].value, "same data → same value");
  eng.dispose();
});

// ── Live: forming candle / rollover / stale / background tab ────────────────

test("live: forming candle (same bucket) drives the last point (server truth)", async () => {
  const bars = make1m(120);
  const last = bars[bars.length - 1];
  const live = { time: Math.floor(last.ts / 1000), open: last.open, high: last.high + 1, low: last.low - 1, close: last.close + 5, volume: 5000 };
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const without = (await eng.computeScript({ id: "l", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  eng.setCandles(bars, live, 60);
  const withLive = (await eng.computeScript({ id: "l", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  assert.equal(withLive.length, without.length, "same bucket → same point count");
  assert.notEqual(
    withLive[withLive.length - 1].value,
    without[without.length - 1].value,
    "the forming close moved the EMA's last point",
  );
  eng.dispose();
});

test("live: rollover appends the new bucket and continues the series", async () => {
  const bars = make1m(120);
  const last = bars[bars.length - 1];
  const newClosed = { ...last, ts: last.ts + 60_000 };
  const histRoll = [...bars, newClosed];
  const live = { time: Math.floor(newClosed.ts / 1000) + 30, open: newClosed.close, high: newClosed.close + 2, low: newClosed.close - 2, close: newClosed.close + 1, volume: 900 };
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const before = (await eng.computeScript({ id: "l", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  eng.setCandles(histRoll, live, 60);
  const after = (await eng.computeScript({ id: "l", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  assert.equal(after.length, before.length + 1, "one point per bucket — rolled over");
  assert.equal(after[after.length - 1].ts, Math.floor(live.time) * 1000 - (Math.floor(live.time) % 60) * 1000 + 0, "last point stamped at the new bucket start");
  eng.dispose();
});

test("live: stale (older-bucket) frame is ignored — output identical to no-live", async () => {
  const bars = make1m(120);
  const stale = { time: Math.floor(bars[bars.length - 5].ts / 1000), open: 1, high: 2, low: 0.5, close: 3, volume: 1 };
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, stale, 60);
  const withStale = (await eng.computeScript({ id: "l", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  eng.setCandles(bars, null, 60);
  const without = (await eng.computeScript({ id: "l", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  assert.deepEqual(withStale, without, "stale frame changes nothing");
  eng.dispose();
});

test("live: background tab — unchanged close stream short-circuits; fresh snapshot re-anchors", async () => {
  const bars = make1m(120);
  const last = bars[bars.length - 1];
  const staleLive = { time: Math.floor(last.ts / 1000), open: last.open, high: last.high, low: last.low, close: last.close, volume: 10 };
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, staleLive, 60);
  const stalePts = (await eng.computeScript({ id: "l", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;

  // Same authoritative stream (identical closes) → cached result, no recompute.
  eng.setCandles(bars, { ...staleLive, volume: 999 }, 60);
  const cachedPts = (await eng.computeScript({ id: "l", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  assert.equal(cachedPts, stalePts, "identical close stream → memoized result reused");

  // Tab wakes up: a fresh server snapshot with a moved close re-anchors.
  const freshLive = { ...staleLive, close: last.close + 3 };
  eng.setCandles(bars, freshLive, 60);
  const freshPts = (await eng.computeScript({ id: "l", source: EMA_SCRIPT, bindings: [] }, {})).get("EMA 9").points;
  assert.notEqual(freshPts[freshPts.length - 1].value, stalePts[stalePts.length - 1].value, "re-anchored by fresh truth");
  const ref = calculateEMA(effectiveCloseSeries(bars, { time: freshLive.time, close: freshLive.close }, 60), 9);
  const maxDelta = Math.max(...freshPts.map((p, i) => Math.abs(p.value - ref[i].value)));
  assert.ok(maxDelta < 5e-9, "fresh points match the oracle");
  eng.dispose();
});

// ── Persistence: versioned localStorage with sanitization ───────────────────

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

function sampleIndicator(overrides = {}) {
  return {
    id: "pine-test-1",
    name: "My EMA",
    source: EMA_SCRIPT,
    enabled: true,
    overlay: true,
    inputs: {},
    inputMeta: [],
    plotMeta: [{ key: "EMA 9", title: "EMA 9", linewidth: 2, color: "#2962ff" }],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("persistence: save → load round-trip preserves imported indicators", () => {
  const storage = memoryStorage();
  const lenMeta = { varId: "len", title: "EMA Length", type: "int", defval: 9, minval: 1, maxval: 200 };
  const list = [
    sampleIndicator(),
    sampleIndicator({
      id: "pine-test-2",
      name: "Inputs demo",
      source: INPUT_SCRIPT,
      overlay: false,
      inputMeta: [lenMeta],
      inputs: { len: 21 },
    }),
  ];
  saveImportedPineIndicators(list, storage);
  const loaded = loadImportedPineIndicators(storage);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].id, "pine-test-1");
  assert.equal(loaded[0].source, EMA_SCRIPT);
  assert.equal(loaded[1].overlay, false, "overlay=false survives (separate pane)");
  assert.equal(loaded[1].inputs.len, 21, "user input values survive");
  // Envelope is versioned for future migrations.
  const envelope = JSON.parse(storage._map.get(PINE_STORAGE_KEY));
  assert.equal(envelope.version, PINE_STORAGE_VERSION);
});

test("persistence: corrupted JSON falls back to an empty list", () => {
  const storage = memoryStorage();
  storage.setItem(PINE_STORAGE_KEY, "{not json!!!");
  assert.deepEqual(loadImportedPineIndicators(storage), []);
});

test("persistence: wrong/missing envelope version → fresh start", () => {
  const storage = memoryStorage();
  storage.setItem(PINE_STORAGE_KEY, JSON.stringify({ version: 99, indicators: [sampleIndicator()] }));
  assert.deepEqual(loadImportedPineIndicators(storage), []);
  storage.setItem(PINE_STORAGE_KEY, JSON.stringify({ indicators: [sampleIndicator()] }));
  assert.deepEqual(loadImportedPineIndicators(storage), []);
});

test("persistence: corrupt records are dropped, bad fields sanitized, good ones kept", () => {
  const storage = memoryStorage();
  storage.setItem(
    PINE_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      indicators: [
        null,
        42,
        { source: "" }, // no source → dropped
        sampleIndicator({ id: "pine-big", source: "x".repeat(MAX_PINE_SOURCE_LENGTH + 1) }), // oversized → dropped
        sampleIndicator({ id: "pine-bad-fields", enabled: "yes", createdAt: "whenever" }), // bad fields → sanitized
        sampleIndicator({ id: "pine-ok" }),
      ],
    }),
  );
  const loaded = loadImportedPineIndicators(storage);
  assert.equal(loaded.length, 2, "the two salvageable records survive");
  assert.deepEqual(loaded.map((r) => r.id), ["pine-bad-fields", "pine-ok"]);
  assert.equal(loaded[0].enabled, true, "invalid boolean → default true");
  assert.equal(typeof loaded[0].createdAt, "number", "invalid createdAt → refreshed");
});

test("persistence: imported-indicator count is capped", () => {
  const list = Array.from({ length: MAX_IMPORTED_INDICATORS + 5 }, (_, i) => sampleIndicator({ id: `pine-${i}` }));
  const sanitized = sanitizeImportedList(list);
  assert.equal(sanitized.length, MAX_IMPORTED_INDICATORS);
});

// ── Safety ──────────────────────────────────────────────────────────────────

test("safety: oversized scripts are rejected before any transpile", async () => {
  const big = `//@version=6\nindicator("big", overlay=true)\n// ${"x".repeat(MAX_PINE_SOURCE_LENGTH)}`;
  const outcome = await compile(big);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.issue.kind, "too-large");
  assert.match(outcome.issue.message, /limit/);
});

test("safety: empty script is rejected with a helpful message", async () => {
  const outcome = await compile("   \n  ");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.issue.kind, "syntax");
});

test("safety: a runtime-erroring script returns null + friendly message (never throws)", async () => {
  const bars = make1m(60);
  let raw = null;
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const map = await eng.computeScript(
    { id: "boom", source: `//@version=6\nindicator("err")\na = array.new_float(1, 0.0)\nplot(array.get(a, 5), "x")`, bindings: [] },
    {},
    (m) => {
      raw = m;
    },
  );
  eng.dispose();
  assert.equal(map, null);
  assert.ok(raw && raw.length > 0, "raw error passed to onError for the console/UI mapping");
  const friendly = friendlyPineError(raw);
  assert.doesNotMatch(friendly, /\n {4}at /, "no stack frames in the UI message");
  assert.ok(friendly.length < 400, "message is bounded");
});

test("safety: one engine serves multiple imported indicators independently", async () => {
  const bars = make1m(150);
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const a = await eng.computeScript(
    { id: "a", source: EMA_SCRIPT, bindings: [] },
    {},
  );
  const b = await eng.computeScript(
    {
      id: "b",
      source: INPUT_SCRIPT,
      bindings: [
        { title: "EMA Length", paramKey: "len" },
        { title: "Factor", paramKey: "f" },
        { title: "Use slow", paramKey: "useSlow" },
        { title: "Line Color", paramKey: "col" },
      ],
    },
    { len: 20, f: 1, useSlow: false, col: "#ff0000" },
  );
  assert.equal(a.size, 2);
  assert.equal(b.size, 1);
  // Indicator A's EMA 9 is untouched by B's inputs.
  const closes = effectiveCloseSeries(bars, null, 60);
  const ref9 = calculateEMA(closes, 9);
  const got = a.get("EMA 9").points;
  const maxDelta = Math.max(...got.map((p, i) => Math.abs(p.value - ref9[i].value)));
  assert.ok(maxDelta < 5e-9, "indicator A unaffected by indicator B");
  // B's plot honors its own input.
  assert.equal(b.get("out").color, "#ff0000");
  const ref20 = calculateEMA(closes, 20);
  const gotB = b.get("out").points;
  const maxDeltaB = Math.max(...gotB.map((p, i) => Math.abs(p.value - ref20[i].value)));
  assert.ok(maxDeltaB < 5e-9, "indicator B uses its own len=20 input");
  eng.dispose();
});

test("safety: a failing indicator does not break its siblings on the same engine", async () => {
  const bars = make1m(100);
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const bad = await eng.computeScript(
    { id: "bad", source: `//@version=6\nindicator("bad")\nplot(ta.doesNotExist(close), "x")`, bindings: [] },
    {},
    () => {},
  );
  const good = await eng.computeScript({ id: "good", source: EMA_SCRIPT, bindings: [] }, {});
  assert.equal(bad, null, "bad indicator → null");
  assert.equal(good.size, 2, "sibling still computes fine");
  eng.dispose();
});

test("safety: plot extraction is capped at the per-indicator series limit", async () => {
  const bars = make1m(80);
  const plots = Array.from(
    { length: MAX_PLOT_SERIES_PER_INDICATOR + 4 },
    (_, i) => `plot(ta.ema(close, ${i + 2}), "p${i}")`,
  ).join("\n");
  const map = await runScript(`//@version=6\nindicator("many", overlay=true)\n${plots}`, bars);
  assert.equal(map.size, MAX_PLOT_SERIES_PER_INDICATOR, "excess plots ignored");
});
