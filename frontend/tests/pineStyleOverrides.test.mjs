/**
 * Comprehensive Pine STYLE OVERRIDE tests — plot(), hline() and fill().
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * These tests exercise the PRODUCTION code paths end to end:
 *   • the real Piner engine (PinerPineEngine) extracts plot / hline / fill
 *     visuals from realistic Pine fixtures (services/pinePinerCore.ts);
 *   • `sanitizeStyleOverrides` validates the persisted override records
 *     (services/pineStyle.ts) — the single override/persistence system;
 *   • the PineBridge renderer wiring is asserted at source level (same style
 *     as pineSettings.test.mjs) because PineBridge drives Lightweight Charts
 *     (no DOM in Node);
 *   • the fill primitive's geometry contract is pinned against the pure
 *     pineDrawings helpers.
 *
 * The fractal plot.style_linebr regression (independent horizontal segments,
 * no diagonal connectors) is re-asserted here under COLOR OVERRIDES so a
 * style change can never reconnect separate levels.
 *
 * Override identity model: overrides are keyed by the visual's STABLE key
 * (plot title / `hline:<id>` / `fill:<id>`), persisted per indicator instance,
 * and applied only at render time — the Pine source is never modified.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Run: npm --prefix frontend run test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isDefaultPlotStyle,
  sanitizeStyleOverrides,
} from "../src/services/pineStyle.ts";
import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import { sanitizeImportedIndicator } from "../src/services/pineImport.ts";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ── fixtures ────────────────────────────────────────────────────────────────

const T0 = 1_704_153_600_000;
const MIN = 60_000;

/** Deterministic 1m candles (AURA `PineBar` shape). */
function makeBars(n, startTs = T0, seed = 7) {
  // tiny LCG so the tape is reproducible without Math.random.
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 0xffffffff);
  let prev = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = prev + (rnd() - 0.5) * 2;
    out.push({
      ts: startTs + i * MIN,
      open: prev,
      high: Math.max(prev, c) + 0.5,
      low: Math.min(prev, c) - 0.5,
      close: c,
      volume: 1000 + i,
    });
    prev = c;
  }
  return out;
}

const SPEC = (source, id = "s") => ({ id, source, bindings: [] });

async function runVisuals(src, bars) {
  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, 60, null);
  try {
    return await eng.computeScriptVisuals(SPEC(src));
  } finally {
    eng.dispose();
  }
}

const visOfType = (run, type) => (run?.visuals ?? []).filter((v) => v.type === type);
const findVis = (run, type, key) => (run?.visuals ?? []).find((v) => v.type === type && v.key === key) ?? null;

// ── realistic Pine fixtures ───────────────────────────────────────────────────

/** Two plots, static per-plot colors — the base plot() override scenario. */
const TWO_PLOT_SRC = `//@version=6
indicator("TwoPlots", overlay=true)
plot(ta.sma(close, 5), "Fast", color=color.new(color.blue, 0))
plot(ta.sma(close, 15), "Slow", color=color.new(color.red, 0))
`;

/** A plot whose color changes per bar (close>open ? up : down). */
const DYNAMIC_COLOR_SRC = `//@version=6
indicator("Dynamic", overlay=true)
plot(ta.sma(close, 5), "Dyn", color = close > open ? color.new(color.green, 0) : color.new(color.maroon, 0))
`;

/** Two independent hlines. */
const HLINE_SRC = `//@version=6
indicator("Hlines", overlay=true)
hline(101.0, "Lower", color=color.gray)
hline(105.0, "Upper", color=color.gray)
plot(close, "Price", color=color.new(color.blue, 0))
`;

/** Fills: a band between two plots + a fill to a constant. */
const FILL_SRC = `//@version=6
indicator("Fills", overlay=true)
up = ta.sma(close, 4)
dn = ta.sma(close, 10)
p1 = plot(up, "Up", color=color.new(color.blue, 0))
p2 = plot(dn, "Dn", color=color.new(color.red, 0))
fill(p1, p2, color=color.new(color.green, 80), title="Band")
fill(p1, 105.0, color=color.new(color.orange, 50), title="ToConstant")
`;

/** Fractal-style linebr plot (independent horizontal segments). */
const LINEBR_SRC = `//@version=6
indicator("Levels", overlay=true)
level = close > open ? high : low
plot(level, "Level", style=plot.style_linebr, color=color.new(color.purple, 0))
`;

// ═══════════════════════════════════════════════════════════════════════════
// A. Engine extraction: the visuals the overrides target are produced correctly
// ═══════════════════════════════════════════════════════════════════════════

test("engine: two plots extract with distinct stable keys + uniform script colors", async () => {
  const run = await runVisuals(TWO_PLOT_SRC, makeBars(40));
  const fast = findVis(run, "line", "Fast");
  const slow = findVis(run, "line", "Slow");
  assert.ok(fast, "Fast plot extracted");
  assert.ok(slow, "Slow plot extracted");
  assert.notEqual(fast.key, slow.key, "distinct stable keys (identity across refreshes)");
  assert.ok(fast.color && slow.color, "both carry a uniform script color");
});

test("engine: a dynamically-colored plot carries per-bar colors (uniform color is absent)", async () => {
  const run = await runVisuals(DYNAMIC_COLOR_SRC, makeBars(40));
  const dyn = findVis(run, "line", "Dyn");
  assert.ok(dyn, "dynamic plot extracted");
  assert.equal(dyn.color, undefined, "no uniform color — the script varies per bar");
  const perBar = new Set(dyn.data.map((p) => p.color).filter(Boolean));
  assert.ok(perBar.size >= 2, `per-bar colors present (${perBar.size} distinct) so overrides can replace them`);
});

test("engine: two hlines extract as independent horizontal visuals with distinct keys", async () => {
  const run = await runVisuals(HLINE_SRC, makeBars(40));
  const h = visOfType(run, "horizontal");
  assert.equal(h.length, 2, "two hline() outputs");
  const keys = h.map((x) => x.key);
  assert.equal(new Set(keys).size, 2, "distinct hline keys (independent styling)");
  const prices = h.map((x) => x.price).sort((a, b) => a - b);
  assert.deepEqual(prices, [101, 105], "original prices preserved");
  // An hline must NEVER be mistaken for a time-series plot.
  assert.ok(!visOfType(run, "line").some((v) => v.key.startsWith("hline:")), "hline is not a line visual");
});

test("engine: fills extract as fill visuals (not plots) with resolved boundaries + per-bar colors", async () => {
  const run = await runVisuals(FILL_SRC, makeBars(40));
  const fills = visOfType(run, "fill");
  assert.equal(fills.length, 2, "two fill() outputs");
  const band = findVis(run, "fill", "fill:2");
  const toConst = findVis(run, "fill", "fill:3");
  assert.ok(band && toConst, "both fills keyed independently");
  assert.equal(band.color.toLowerCase(), "#4caf5033", "band static color (hex, case-insensitive)");
  const valued = band.data.filter((p) => typeof p.top === "number" && typeof p.bottom === "number");
  const gaps = band.data.filter((p) => p.top === undefined || p.bottom === undefined);
  assert.ok(valued.length > 0, "some bars have both boundaries");
  assert.ok(gaps.length > 0, "warmup bars are gaps (fill must break there)");
  const constValued = toConst.data.filter((p) => typeof p.bottom === "number");
  assert.ok(constValued.length > 0 && constValued.every((p) => p.bottom === 105), "constant boundary resolves to 105 on every valued bar");
  // A fill override must NOT recolor its boundary plots.
  const upPlot = findVis(run, "line", "Up");
  assert.equal(upPlot.color.toLowerCase(), "#2962ffff", "boundary plot keeps its own color");
});

// ═══════════════════════════════════════════════════════════════════════════
// B. plot() override semantics (scenarios 1–6)
// ═══════════════════════════════════════════════════════════════════════════

test("1. ordinary plot() color override: sanitize keeps it; absent override = script color", async () => {
  const clean = sanitizeStyleOverrides({ Fast: { color: "#123456" } });
  assert.deepEqual(clean, { Fast: { color: "#123456" } });
  assert.equal(clean.Slow, undefined, "no override for Slow ⇒ the script's own color applies");
  const run = await runVisuals(TWO_PLOT_SRC, makeBars(40));
  const slow = findVis(run, "line", "Slow");
  assert.ok(slow.color, "Slow retains its script color when not overridden");
});

test("2. dynamically-colored plot: an explicit override replaces the per-bar colors", async () => {
  const run = await runVisuals(DYNAMIC_COLOR_SRC, makeBars(40));
  const dyn = findVis(run, "line", "Dyn");
  const override = sanitizeStyleOverrides({ Dyn: { color: "#abcdef" } }).Dyn;
  assert.ok(override, "override present");
  assert.equal(typeof override.color, "string");
  const perBar = dyn.data.map((p) => p.color).filter(Boolean);
  assert.ok(perBar.length > 0, "script has per-bar colors to replace");
  const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
  assert.ok(code.includes("stripColor"), "uniform override strips per-bar script colors at render");
});

test("3. color-only override preserves script-defined width + style", () => {
  const o = sanitizeStyleOverrides({ Fast: { color: "#00ff00" } }).Fast;
  assert.deepEqual(o, { color: "#00ff00" }, "only color is set — width/lineStyle stay script-defined");
  const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
  assert.ok(/resolveStyle[\s\S]*?lineWidth[\s\S]*?scriptWidth/.test(code), "width falls back to script when not overridden");
});

test("4. removing an override restores the original script colors", async () => {
  assert.deepEqual(sanitizeStyleOverrides({ Fast: { visible: true } }), {}, "clearing a visible-only override drops it");
  const run = await runVisuals(TWO_PLOT_SRC, makeBars(40));
  const fast = findVis(run, "line", "Fast");
  assert.ok(fast.color, "with no override the script's original color is intact");
});

test("5. two plots in one indicator are styled independently", () => {
  const style = sanitizeStyleOverrides({
    Fast: { color: "#111111", lineWidth: 1 },
    Slow: { color: "#222222", lineStyle: "dashed" },
  });
  assert.deepEqual(style.Fast, { color: "#111111", lineWidth: 1 });
  assert.deepEqual(style.Slow, { color: "#222222", lineStyle: "dashed" });
  assert.notEqual(style.Fast.color, style.Slow.color, "one plot's override never changes the other");
});

test("6. multiple indicators have independent overrides (per-instance isolation)", () => {
  const indA = sanitizeImportedIndicator({
    id: "a", name: "A", source: TWO_PLOT_SRC, enabled: true, overlay: true,
    inputs: {}, inputMeta: [], plotMeta: [{ key: "Fast", title: "Fast", type: "line" }],
    style: { Fast: { color: "#aaaaaa" } }, createdAt: 1,
  });
  const indB = sanitizeImportedIndicator({
    id: "b", name: "B", source: TWO_PLOT_SRC, enabled: true, overlay: true,
    inputs: {}, inputMeta: [], plotMeta: [{ key: "Fast", title: "Fast", type: "line" }],
    style: { Fast: { color: "#bbbbbb" } }, createdAt: 2,
  });
  assert.equal(indA.style.Fast.color, "#aaaaaa");
  assert.equal(indB.style.Fast.color, "#bbbbbb");
  assert.notEqual(indA.style.Fast.color, indB.style.Fast.color, "isolated by indicator instance");
});

// ═══════════════════════════════════════════════════════════════════════════
// C. hline() overrides (scenarios 7–8)
// ═══════════════════════════════════════════════════════════════════════════

test("7. hline() color, width, style and visibility overrides are supported", () => {
  const clean = sanitizeStyleOverrides({
    "hline:0": { color: "#ff0000", lineWidth: 3, lineStyle: "dashed" },
    "hline:1": { visible: false },
  });
  assert.deepEqual(clean["hline:0"], { color: "#ff0000", lineWidth: 3, lineStyle: "dashed" });
  assert.deepEqual(clean["hline:1"], { visible: false });
  // PineBridge applies hline overrides at price-line creation.
  const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
  assert.ok(code.includes("style[h.key]"), "bridge reads the hline override by its stable key");
  assert.ok(code.includes("o?.visible === false"), "a hidden hline override removes the price line");
  assert.ok(code.includes("o?.lineStyle ?? h.lineStyle"), "hline lineStyle override falls back to the script style");
});

test("8. multiple hline() outputs are independently configurable", async () => {
  const run = await runVisuals(HLINE_SRC, makeBars(40));
  const h = visOfType(run, "horizontal");
  const [k0, k1] = [h[0].key, h[1].key];
  const style = sanitizeStyleOverrides({
    [k0]: { color: "#00ff00" },
    [k1]: { color: "#0000ff", lineWidth: 2 },
  });
  assert.notEqual(style[k0].color, style[k1].color, "each hline keeps its own override");
  assert.equal(style[k1].lineWidth, 2);
  assert.equal(style[k0].lineWidth, undefined, "hline 0's width stays script-defined");
  // The hlineSig folds the override in so a style change re-creates the lines.
  const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
  assert.ok(/hlineViews[\s\S]*?hlineSig/.test(code), "hline overrides participate in the price-line signature");
});

// ═══════════════════════════════════════════════════════════════════════════
// D. fill() overrides (scenarios 9–12)
// ═══════════════════════════════════════════════════════════════════════════

test("9. fill() color and opacity overrides are supported + persist", () => {
  const clean = sanitizeStyleOverrides({
    "fill:2": { color: "#123456", opacity: 0.5 },
  });
  assert.deepEqual(clean["fill:2"], { color: "#123456", opacity: 0.5 });
  // PineBridge resolves fill color/opacity and never touches the boundaries.
  const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
  assert.ok(code.includes("resolveFill("), "bridge resolves fill overrides via resolveFill");
  assert.ok(code.includes("stripPerBar"), "a uniform fill override strips per-bar script fill colors");
});

test("10. multiple fills in one indicator are independently configurable", async () => {
  const run = await runVisuals(FILL_SRC, makeBars(40));
  const fills = visOfType(run, "fill");
  assert.equal(fills.length, 2);
  const style = sanitizeStyleOverrides({
    "fill:2": { color: "#aaaaaa" },
    "fill:3": { color: "#bbbbbb", opacity: 0.8 },
  });
  assert.notEqual(style["fill:2"].color, style["fill:3"].color, "each fill keeps its own override");
  assert.equal(style["fill:2"].opacity, undefined, "fill 2's opacity stays script-defined");
});

test("11. a fill override does not recolor its boundary plots", () => {
  const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
  // The fill branch resolves ONLY the fill region and pushes it to paneFills;
  // it never touches the boundary plot entries (they resolve through their own
  // style[ident] in the line/histogram/area branch above).
  assert.ok(code.includes("const region = resolveFill(style, v.key, v.color ?? null, v.data);"), "fill resolves its own region only");
  assert.ok(/else if \(v\.type === "fill"\)[\s\S]*?paneFills\.push\(region\);/.test(code), "the fill branch only pushes its own region");
  // The boundary plots are resolved via resolveStyle with their OWN key, so a
  // fill override (keyed fill:N) can never match a plot's key (its title).
  assert.ok(/else if \(v\.type === "boxes"\)[\s\S]*?else if \(v\.type === "fill"\)[\s\S]*?paneFills\.push\(region\);[\s\S]*?\n    \}/.test(code), "fill handling is isolated in its own branch");
});

test("12. fill geometry, boundaries and gaps remain correct", async () => {
  const run = await runVisuals(FILL_SRC, makeBars(40));
  const band = findVis(run, "fill", "fill:2");
  // Every valued bar has two finite boundaries; every gap bar has none.
  for (const p of band.data) {
    const valued = typeof p.top === "number" && typeof p.bottom === "number";
    const gap = p.top === undefined && p.bottom === undefined;
    assert.ok(valued || gap, "a bar is either fully valued or a gap (never half)");
  }
  // The fill primitive breaks across gaps: any missing boundary edge (a gap
  // bar) skips its trapezoid, so nothing is ever painted across a gap.
  const prim = stripComments(readSrc("src/components/TradingChart/pineFillPrimitive.ts"));
  assert.ok(/if \(x1 === null \|\| x2 === null[\s\S]*?continue;/.test(prim), "a missing x edge (gap) skips the trapezoid");
  assert.ok(/if \(x1 === null[\s\S]*?b2 === null\) continue;/.test(prim), "a missing top/bottom boundary edge skips the trapezoid");
  // A bar with no boundaries resolves its y to null (the guard above breaks it).
  assert.ok(/typeof p\.top === "number" \? series\.priceToCoordinate[\s\S]*?: null/.test(prim), "an absent top boundary yields a null coordinate (gap)");
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Persistence + lifecycle (scenarios 13–14)
// ═══════════════════════════════════════════════════════════════════════════

test("13. settings persist across a reload and restore the correct visual targets", () => {
  // Round-trip a record through the persisted-record sanitizer (the same code
  // localStorage load runs) — visibility, color, width, style and fill survive.
  const stored = {
    id: "x", name: "X", source: FILL_SRC, enabled: true, overlay: true,
    inputs: {}, inputMeta: [],
    plotMeta: [
      { key: "Up", title: "Up", type: "line" },
      { key: "hline:0", title: "hline 0", type: "horizontal" },
      { key: "fill:2", title: "Band", type: "fill" },
    ],
    style: {
      Up: { color: "#0a0b0c", lineWidth: 2, lineStyle: "dotted" },
      "hline:0": { color: "#111213", visible: false },
      "fill:2": { color: "#141516", opacity: 0.4 },
    },
    createdAt: 1,
  };
  const loaded = sanitizeImportedIndicator(stored);
  assert.deepEqual(loaded.style.Up, { color: "#0a0b0c", lineWidth: 2, lineStyle: "dotted" });
  assert.deepEqual(loaded.style["hline:0"], { color: "#111213", visible: false });
  assert.deepEqual(loaded.style["fill:2"], { color: "#141516", opacity: 0.4 });
  assert.ok(loaded.plotMeta.some((p) => p.key === "fill:2" && p.type === "fill"), "fill target present");
  assert.ok(loaded.plotMeta.some((p) => p.key === "hline:0" && p.type === "horizontal"), "hline target present");
});

test("14. removed/recalculated visuals do not inherit unrelated stale overrides", () => {
  // An override keyed to a visual that no longer exists is inert: it never
  // matches another visual's key, so a re-import that drops the old plot
  // leaves a stale key that simply styles nothing.
  const stale = sanitizeStyleOverrides({
    "RemovedPlot": { color: "#ff0000" },
    Fast: { color: "#00ff00" },
  });
  assert.equal(stale["RemovedPlot"].color, "#ff0000", "the stale key is preserved but harmless");
  return runVisuals(TWO_PLOT_SRC, makeBars(40)).then((run) => {
    const keys = new Set(run.visuals.map((v) => v.key));
    assert.ok(!keys.has("RemovedPlot"), "no current visual carries the stale key");
    assert.ok(keys.has("Fast"), "the live plot keeps its own key");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Fractal / linebr / continuous / line.new() compatibility (scenarios 15–18)
// ═══════════════════════════════════════════════════════════════════════════

test("15. fractal plot.style_linebr keeps horizontal segments + gaps under a color override", async () => {
  const run = await runVisuals(LINEBR_SRC, makeBars(60, T0, 3));
  const lvl = findVis(run, "line", "Level");
  assert.ok(lvl && lvl.breakOnNa, "linebr plot extracted with breakOnNa");
  const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
  assert.ok(code.includes('v.type === "line" && v.breakOnNa'), "linebr routed to the segment adapter");
  assert.ok(code.includes("linebrSegmentsToDrawings("), "segments built by the production adapter");
  assert.ok(/segColor[\s\S]*?linebrSegmentsToDrawings/.test(code), "color override feeds every segment");
  // The adapter guarantees horizontal geometry (price1 === price2 per segment).
  const adapter = stripComments(readSrc("src/services/pineDrawings.ts"));
  assert.ok(/price1: first\.value[\s\S]*?price2: last\.value/.test(adapter), "segment endpoints keep the run's price (horizontal)");
});

test("16. continuous SMA/EMA plots remain continuous (not linebr)", async () => {
  const src = `//@version=6
indicator("Cont", overlay=true)
plot(ta.sma(close, 5), "SMA")
plot(ta.ema(close, 10), "EMA")
`;
  const run = await runVisuals(src, makeBars(40));
  for (const v of visOfType(run, "line")) {
    assert.ok(!v.breakOnNa, `${v.key} is a continuous line (no breakOnNa)`);
  }
  const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
  assert.ok(/if \(v\.type === "line" && v\.breakOnNa\)[\s\S]*?continue;/.test(code), "only breakOnNa lines take the segment path; continuous lines keep LineSeries");
});

test("17. generic line.new() rendering remains unchanged (never treated as fill/hline)", () => {
  const src = `//@version=6
indicator("Draw", overlay=true)
if barstate.islast
    line.new(bar_index, low, bar_index, high, color=color.yellow)
`;
  return runVisuals(src, makeBars(40)).then((run) => {
    assert.equal(visOfType(run, "fill").length, 0, "line.new() is never treated as a fill");
    assert.equal(visOfType(run, "horizontal").length, 0, "line.new() is never treated as an hline");
    const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
    assert.ok(code.includes('v.type === "lines"'), "line.new() keeps its existing lines primitive path");
  });
});

test("18. unsupported visual types (gradient fill) fail gracefully, never approximated", async () => {
  const src = `//@version=6
indicator("Grad", overlay=true)
up = ta.sma(close, 4)
dn = ta.sma(close, 8)
p1 = plot(up, "Up")
p2 = plot(dn, "Dn")
fill(p1, p2, top_value=up, bottom_value=dn, top_color=color.green, bottom_color=color.red, title="grad")
`;
  const run = await runVisuals(src, makeBars(40));
  assert.equal(visOfType(run, "fill").length, 0, "no phantom fill from an unsupported gradient");
  const unsupported = (run.diagnostics.unsupported ?? []).map((u) => u.kind);
  assert.ok(unsupported.some((k) => k.includes("gradient")), `gradient reported unsupported (${unsupported.join(", ")})`);
  assert.ok(run.visuals.length >= 2, "the supported plots still render alongside the unsupported fill");
});




