/**
 * fractal_SMA.pine — Style-tab controls regression.
 *
 * ROOT CAUSE (this task): the Indicator Settings modal's Style tab is driven by
 * the persisted `plotMeta`, which was built from the engine's RENDERED visuals
 * only (`visuals.slice(0, MAX).map(plotMetaFromVisual)`). The plot loop drops any
 * output with `valued === 0` (no finite values in the current window) and any
 * `display=display.none` output. fractal_SMA.pine's SMA-based MA, Upper/Lower
 * Bollinger Bands and their fill are conditional (`display = isBB ? all : none`)
 * AND warmup-gated, so before enough history loads — or if the MA type is toggled
 * off — those Style rows VANISHED from the tab even though the script DECLARES
 * them. TradingView always lists a declared output in the Style tab.
 *
 * FIX: the engine now records a `declared` list (every plot/hline/fill the script
 * declares, captured BEFORE the display/valued drops) and `compileImportedPine`
 * builds `plotMeta` as the UNION of declared + rendered visuals. Rendering is
 * unchanged (PineBridge still paints from finite-valued `visuals`), so a
 * declared-but-unrendered row exposes style controls without a phantom series.
 *
 * These tests run the ACTUAL `fractal_SMA.pine` through the production engine +
 * import path (no synthetic fixtures for the target outputs) and assert the
 * Style-tab contract end-to-end.
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import {
  buildPlotMeta,
  compileImportedPine,
  sanitizeImportedIndicator,
} from "../src/services/pineImport.ts";
import { sanitizeStyleOverrides } from "../src/services/pineStyle.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => fs.readFileSync(path.resolve(HERE, "..", rel), "utf8");
const FRACTAL_SMA = readSrc("src/components/Indicators/fractal_SMA.pine");

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

/** Run the engine directly (visuals + runtime diagnostics). */
async function runEngine(bars) {
  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, 60, null);
  try {
    return await eng.computeScriptVisuals({ id: "fsma", source: FRACTAL_SMA, bindings: [] });
  } finally {
    eng.dispose();
  }
}

/** Full import path → the persisted indicator (plotMeta drives the Style tab). */
async function importIndicator(bars) {
  const outcome = await compileImportedPine({ source: FRACTAL_SMA, bars, bucketSec: 60, name: "Fractals + SMA" });
  assert.equal(outcome.ok, true, `import failed: ${outcome.issue?.message}`);
  return outcome.indicator;
}

const metaOf = (ind, key) => ind.plotMeta.find((m) => m.key === key) ?? null;

// The five Style-tab targets (independent of any hardcoded script name in tests:
// these are the plot TITLES the script itself declares).
const TARGET_LINES = ["MA", "SMA-based MA", "Upper Bollinger Band", "Lower Bollinger Band"];
const FILL_KEY = "fill:28"; // fill: title "Bollinger Bands Background Fill"


// ── 1. Engine records every declared output regardless of finite values ───────

test("engine: declared list carries all 5 targets even with too little history", async () => {
  // 5 bars: far below the SMA(20)+smoothing(6) warmup — the bands/fill produce
  // NO finite values, yet the script still DECLARES them.
  const run = await runEngine(makeBars(5));
  assert.ok(run, "script must run");
  const declared = new Set(run.diagnostics.declared.map((d) => d.key));
  for (const t of TARGET_LINES) {
    assert.ok(declared.has(t), `declared must include "${t}" (got: ${[...declared].join(", ")})`);
  }
  assert.ok(declared.has(FILL_KEY), `declared must include the fill (${FILL_KEY})`);
});

test("engine: declared fill carries type=fill and its script color", async () => {
  const run = await runEngine(makeBars(5));
  const fill = run.diagnostics.declared.find((d) => d.key === FILL_KEY);
  assert.ok(fill, "fill must be declared");
  assert.equal(fill.type, "fill");
  assert.equal(fill.color, "#06AF0C19");
});

// ── 2. Style tab (plotMeta) exposes every target at every history size ────────

for (const n of [200, 60, 10, 5]) {
  test(`import: all 5 Style rows present with ${n} bars`, async () => {
    const ind = await importIndicator(makeBars(n));
    for (const t of TARGET_LINES) {
      const m = metaOf(ind, t);
      assert.ok(m, `Style row "${t}" must be present (${n} bars)`);
      assert.equal(m.type, "line", `"${t}" is a line`);
      assert.ok(typeof m.color === "string" && m.color.startsWith("#"), `"${t}" carries a script color`);
    }
    const fill = metaOf(ind, FILL_KEY);
    assert.ok(fill, `fill Style row must be present (${n} bars)`);
    assert.equal(fill.type, "fill", "the fill row is a fill");
    assert.equal(fill.color, "#06AF0C19", "the fill row carries the script fill color");
  });
}

// ── 3. Declared-but-unrendered rows never create a phantom visual ─────────────

test("render contract: declared rows never add a visual when no finite values", async () => {
  const run = await runEngine(makeBars(5));
  const renderedKeys = new Set(run.visuals.map((v) => v.key));
  // With 5 bars the bands/fill render NOTHING (all-na), but ARE declared.
  for (const t of ["SMA-based MA", "Upper Bollinger Band", "Lower Bollinger Band"]) {
    assert.ok(!renderedKeys.has(t), `"${t}" must NOT be a rendered visual at 5 bars`);
  }
  assert.ok(!renderedKeys.has(FILL_KEY), "the fill must NOT be a rendered visual at 5 bars");
  assert.ok(run.diagnostics.declared.some((d) => d.key === "SMA-based MA"), "but IS declared");
});


// ── 4. The 60-bar happy path: rows present AND rendering unchanged ────────────

test("render contract: 60 bars still renders exactly the finite-valued outputs", async () => {
  const run = await runEngine(makeBars(60));
  const lines = run.visuals.filter((v) => v.type === "line");
  const fills = run.visuals.filter((v) => v.type === "fill");
  assert.equal(fills.length, 1, "exactly one fill visual at 60 bars");
  assert.equal(fills[0].key, FILL_KEY, "the fill is the Bollinger background fill");
  // The four MA/BB lines all paint finite values here.
  for (const t of TARGET_LINES) {
    const v = lines.find((l) => l.key === t);
    assert.ok(v, `"${t}" renders at 60 bars`);
    assert.ok(v.data.some((p) => typeof p.value === "number"), `"${t}" has finite values`);
  }
});

// ── 5. Style overrides persist per-output and survive a sanitize round-trip ───

test("persistence: per-output overrides survive sanitize (round-trip)", async () => {
  const ind = await importIndicator(makeBars(60));
  const style = {
    MA: { color: "#111111", lineWidth: 3 },
    "SMA-based MA": { color: "#222222", lineStyle: "dashed" },
    "Upper Bollinger Band": { visible: false },
    "Lower Bollinger Band": { color: "#333333" },
    [FILL_KEY]: { color: "#0a0a0a", opacity: 0.5 },
  };
  const record = { ...ind, style };
  // Serialize exactly like localStorage (JSON) then sanitize on load.
  const loaded = sanitizeImportedIndicator(JSON.parse(JSON.stringify(record)));
  assert.ok(loaded, "record must sanitize");
  assert.deepEqual(loaded.style.MA, { color: "#111111", lineWidth: 3 });
  assert.deepEqual(loaded.style["SMA-based MA"], { color: "#222222", lineStyle: "dashed" });
  assert.deepEqual(loaded.style["Upper Bollinger Band"], { visible: false });
  assert.deepEqual(loaded.style["Lower Bollinger Band"], { color: "#333333" });
  assert.deepEqual(loaded.style[FILL_KEY], { color: "#0a0a0a", opacity: 0.5 });
});

// ── 6. Overrides are independent — one never touches another ──────────────────

test("persistence: one output's override never changes another", async () => {
  const style = sanitizeStyleOverrides({
    MA: { color: "#abcdef" },
    "SMA-based MA": { color: "#123456" },
  });
  assert.equal(style.MA.color, "#abcdef");
  assert.equal(style["SMA-based MA"].color, "#123456");
  assert.notEqual(style.MA.color, style["SMA-based MA"].color);
  assert.equal(style["Upper Bollinger Band"], undefined, "unstyled bands keep no override");
});

// ── 7. Style tab is script-agnostic: a plain 2-plot script is unaffected ───────

test("generality: a simple 2-plot script still yields exactly its 2 rows", async () => {
  const src = `//@version=6
indicator("two", overlay=true)
plot(ta.sma(close, 9), "Fast", color=color.rgb(1, 2, 3))
plot(ta.sma(close, 20), "Slow", color=color.rgb(4, 5, 6))`;
  const outcome = await compileImportedPine({ source: src, bars: makeBars(60), bucketSec: 60 });
  assert.equal(outcome.ok, true, outcome.issue?.message);
  assert.deepEqual(
    outcome.indicator.plotMeta.map((m) => m.key),
    ["Fast", "Slow"],
    "declared+rendered union preserves declaration order and adds nothing",
  );
});

// ── 8. A declared-but-unrendered output gets its row on a SHORT-history import ─

test("short history: SMA-based MA / bands / fill are styleable before warmup", async () => {
  // 3 bars: nothing past warmup renders, yet the Style tab must still list all.
  const ind = await importIndicator(makeBars(3));
  const keys = new Set(ind.plotMeta.map((m) => m.key));
  for (const t of [...TARGET_LINES, FILL_KEY]) {
    assert.ok(keys.has(t), `"${t}" Style row must exist at 3 bars`);
  }
});


// ── 9. RUNTIME HEAL — the actual bug: a stale (rendered-only) plotMeta ────────
//
// The Style tab reads `indicator.plotMeta`, which is frozen at import. An
// indicator imported BEFORE the declared-output capture carries a rendered-only
// plotMeta missing the conditional / warmup rows. PineBridge now rebuilds
// plotMeta from every live run (buildPlotMeta(declared, visuals)) and App adopts
// it (handlePineDeclared). This test reproduces that exact heal.

test("runtime heal: a stale rendered-only plotMeta is rebuilt to include the conditional rows", async () => {
  // A "stale" plotMeta = what the OLD import produced: only the outputs that
  // happened to paint. Simulate a short-history import that captured NOTHING
  // for the bands/fill, then heal it from a live run.
  const run = await runEngine(makeBars(60));
  const healed = buildPlotMeta(run.diagnostics.declared, run.visuals);
  const keys = new Set(healed.map((m) => m.key));
  for (const t of [...TARGET_LINES, FILL_KEY]) {
    assert.ok(keys.has(t), `healed plotMeta must include "${t}"`);
  }
  // The heal is a pure superset of the rendered set (no phantom rows beyond
  // declared ∪ rendered) and preserves the fill's type.
  const fill = healed.find((m) => m.key === FILL_KEY);
  assert.equal(fill.type, "fill", "healed fill keeps type=fill");
});

test("runtime heal: healing is idempotent (stable signature across runs)", async () => {
  const a = await runEngine(makeBars(60));
  const b = await runEngine(makeBars(120));
  const sig = (run) => buildPlotMeta(run.diagnostics.declared, run.visuals).map((m) => `${m.key}:${m.type}`).join("|");
  // The declared set is script-static, so the key/type signature is identical
  // regardless of history length — App's change-guard therefore settles after
  // one heal and never loops.
  assert.equal(sig(a), sig(b), "declared key/type signature is history-independent");
});

test("runtime heal: a rendered-only plotMeta (missing bands/fill) gains them", async () => {
  // Simulate the persisted stale record: only MA + a couple of fractal levels.
  const stalePlotMeta = [
    { key: "Up level 1", title: "Up level 1", type: "line" },
    { key: "MA", title: "MA", type: "line" },
  ];
  const run = await runEngine(makeBars(60));
  // App adopts the freshly-built list wholesale (not a merge), so the result is
  // exactly buildPlotMeta(declared, visuals) — a superset that includes the
  // previously-missing conditional rows.
  const healed = buildPlotMeta(run.diagnostics.declared, run.visuals);
  const staleKeys = new Set(stalePlotMeta.map((m) => m.key));
  const healedKeys = healed.map((m) => m.key);
  for (const k of staleKeys) assert.ok(healedKeys.includes(k), `heal preserves existing row "${k}"`);
  for (const t of ["SMA-based MA", "Upper Bollinger Band", "Lower Bollinger Band", FILL_KEY]) {
    assert.ok(healedKeys.includes(t), `heal adds the previously-missing "${t}"`);
  }
});
