/**
 * Pine `input.source()` rendering — the SMA "Source" selector regression.
 *
 * ROOT CAUSE: `fractal_SMA.pine` declares `src = input(close, title="Source")`
 * — the GENERIC `input()` overload. Piner (0.13.0, probed) classifies that as
 * `kind:"float"` (not `"source"`) and code-generates it to `$.input.auto(...)`
 * → `pickInput`, which returns a host override RAW. So (1) AURA mapped `float`
 * → a NUMERIC field (a number box, not a dropdown), and (2) even a `"high"`
 * string was never resolved to a series (only `input.source(...)` →
 * `resolveSourceInput` → `sourceByName` does that), so `ta.sma("high", n)`=na.
 *
 * FIX: `normalizeSourceInputs` rewrites `input(<ohlc-series>)` →
 * `input.source(<ohlc-series>)` at the single compile chokepoint, applied by
 * BOTH `pinerCompile` (runtime) and `compileImportedPine` (metadata). A guarded
 * `healSourceInputMeta` upgrades an already-imported indicator's stale `float`
 * Source metadata WITHOUT a re-import. The dropdown control already exists in
 * the modal (`case "source"`), so no UI code changes.
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import { compileImportedPine, sanitizeImportedIndicator } from "../src/services/pineImport.ts";
import { normalizeSourceInputs } from "../src/services/pineSourceInputs.ts";
import { PRICE_SOURCES, isPriceSource } from "../src/services/priceSource.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => fs.readFileSync(path.resolve(HERE, "..", rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const FRACTAL_SMA = readSrc("src/components/Indicators/fractal_SMA.pine");

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Deterministic 1m candles with DISTINCT o/h/l/c so a source switch changes math. */
function makeBars(n, startTs = 1_704_153_600_000) {
  const out = [];
  let prev = 100;
  for (let i = 0; i < n; i++) {
    const open = prev;
    const close = prev + ((i % 7) - 3);
    const high = Math.max(open, close) + 2;
    const low = Math.min(open, close) - 2;
    out.push({ ts: startTs + i * 60_000, open, high, low, close, volume: 1000 + i });
    prev = close;
  }
  return out;
}

const BARS = makeBars(60);
const BINDINGS = [
  { title: "Source", paramKey: "Source" },
  { title: "Length", paramKey: "Length" },
];

/** Run the engine directly and return the "MA" line's last value. */
async function lastMA(inputs) {
  const eng = new PinerPineEngine();
  eng.setCandles(BARS, null, 60, null);
  try {
    const run = await eng.computeScriptVisuals(
      { id: "fsma", source: FRACTAL_SMA, bindings: BINDINGS },
      inputs,
    );
    assert.ok(run, "script must run");
    const ma = run.visuals.find((v) => v.key === "MA" || v.title === "MA");
    assert.ok(ma && ma.data.length > 0, "MA line must render");
    return ma.data[ma.data.length - 1].value;
  } finally {
    eng.dispose();
  }
}

async function importIndicator() {
  const outcome = await compileImportedPine({ source: FRACTAL_SMA, bars: BARS, bucketSec: 60, name: "Fractals + SMA" });
  assert.equal(outcome.ok, true, `import failed: ${outcome.issue?.message}`);
  return outcome.indicator;
}

// ── normalizeSourceInputs: the shared-pipeline transform ─────────────────────

test("normalizeSourceInputs: generic input(<ohlc>) → input.source(<ohlc>)", () => {
  assert.equal(
    normalizeSourceInputs('src = input(close, title="Source")\nplot(src)'),
    'src = input.source(close, title="Source")\nplot(src)',
  );
  assert.equal(normalizeSourceInputs('s = input(open, "S")\nplot(s)'), 's = input.source(open, "S")\nplot(s)');
  assert.equal(normalizeSourceInputs('s = input(hlc3, "S")\nplot(s)'), 's = input.source(hlc3, "S")\nplot(s)');
  assert.equal(normalizeSourceInputs('s = input(ohlc4, "S")\nplot(s)'), 's = input.source(ohlc4, "S")\nplot(s)');
});

test("normalizeSourceInputs: every other input kind is left untouched (idempotent)", () => {
  const alreadySrc = 'src = input.source(close, title="Source")\nplot(src)';
  assert.equal(normalizeSourceInputs(alreadySrc), alreadySrc);
  assert.equal(normalizeSourceInputs('n = input.int(20, "L")\nplot(n)'), 'n = input.int(20, "L")\nplot(n)');
  assert.equal(normalizeSourceInputs('f = input(1.5, "M")\nplot(f)'), 'f = input(1.5, "M")\nplot(f)');
  assert.equal(normalizeSourceInputs('f = input.float(2.0, "M")\nplot(f)'), 'f = input.float(2.0, "M")\nplot(f)');
  assert.equal(normalizeSourceInputs('b = input(true, "B")\nplot(b)'), 'b = input(true, "B")\nplot(b)');
  assert.equal(normalizeSourceInputs('c = input.color(color.red, "C")\nplot(1)'), 'c = input.color(color.red, "C")\nplot(1)');
  assert.equal(normalizeSourceInputs('m = input.string("A", "M", options=["A","B"])\nplot(1)'), 'm = input.string("A", "M", options=["A","B"])\nplot(1)');
  const once = normalizeSourceInputs('src = input(close, title="Source")\nplot(src)');
  assert.equal(normalizeSourceInputs(once), once);
});

test("normalizeSourceInputs: never edits a title/comment that merely mentions input(<leaf>)", () => {
  assert.equal(
    normalizeSourceInputs('plot(1, title="use input(close) here")'),
    'plot(1, title="use input(close) here")',
  );
  assert.equal(
    normalizeSourceInputs('// src = input(close, "S")\nplot(1)'),
    '// src = input(close, "S")\nplot(1)',
  );
  assert.equal(normalizeSourceInputs("foo.input(close, 1)\nplot(1)"), "foo.input(close, 1)\nplot(1)");
  assert.equal(normalizeSourceInputs("closeInput(1)\nplot(1)"), "closeInput(1)\nplot(1)");
});


// ── requirement 1 + 2: Source renders as a selector; all options available ────

test("import: fractal_SMA Source is a source input (dropdown), not a numeric field", async () => {
  const ind = await importIndicator();
  const src = ind.inputMeta.find((m) => m.title === "Source");
  assert.ok(src, "Source input must exist in metadata");
  assert.equal(src.type, "source", "Source must be classified as a source (drives the dropdown)");
  const len = ind.inputMeta.find((m) => m.title === "Length");
  assert.equal(len?.type, "int", "Length must remain a numeric int");
});

test("modal: source inputs render a price-source dropdown with all PRICE_SOURCES + Default (script)", () => {
  const code = stripComments(readSrc("src/components/Indicators/IndicatorSettingsModal.tsx"));
  assert.ok(code.includes('case "source":'), "source input gets its own dropdown control");
  assert.ok(code.includes("Default (script)"), "the script's own default is a first-class option");
  assert.ok(code.includes("PRICE_SOURCES.map"), "the dropdown is driven by AURA's verified PRICE_SOURCES");
  assert.ok(code.includes("PRICE_SOURCE_LABEL[s]"), "readable labels, not numeric values");
  assert.deepEqual([...PRICE_SOURCES], ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"]);
  for (const s of PRICE_SOURCES) assert.equal(isPriceSource(s), true, `${s} is a supported source`);
});

// ── requirement 3: changing the selection updates the SMA calculation ────────

test("runtime: each supported source changes the SMA (high vs low diverge)", async () => {
  const def = await lastMA({});
  const high = await lastMA({ Source: "high" });
  const low = await lastMA({ Source: "low" });
  const close = await lastMA({ Source: "close" });
  assert.ok(high > close, `high-source SMA (${high}) must exceed close-source SMA (${close})`);
  assert.ok(close > low, `close-source SMA (${close}) must exceed low-source SMA (${low})`);
  assert.equal(def, close, "no override must fall back to the script's declared default series");
  for (const leaf of ["open", "hl2", "hlc3", "ohlc4"]) {
    const v = await lastMA({ Source: leaf });
    assert.ok(Number.isFinite(v), `${leaf} source must produce a finite SMA`);
  }
  const ohlc4 = await lastMA({ Source: "ohlc4" });
  assert.notEqual(ohlc4, high, "ohlc4 (average) must differ from the high source");
});

// ── requirement 4 + 7: persistence round-trips; stale configs stay compatible ─

test("persistence: a selected source survives the sanitize round-trip", async () => {
  const ind = await importIndicator();
  const saved = { ...ind, inputs: { ...ind.inputs, Source: "high" } };
  const reloaded = sanitizeImportedIndicator(JSON.parse(JSON.stringify(saved)));
  assert.ok(reloaded, "record must survive sanitization");
  assert.equal(reloaded.inputs.Source, "high", "the selected source persists across reload");
  const src = reloaded.inputMeta.find((m) => m.title === "Source");
  assert.equal(src?.type, "source", "Source stays a source after reload");
});

test("backward-compat: a pre-fix record with Source type:float is healed to source (no re-import)", () => {
  const stale = {
    id: "pine-legacy",
    name: "Fractals + SMA",
    source: FRACTAL_SMA,
    enabled: true,
    overlay: true,
    inputs: {},
    inputMeta: [
      { varId: "Source", title: "Source", type: "float", defval: null },
      { varId: "Length", title: "Length", type: "int", defval: 20 },
    ],
    plotMeta: [],
    createdAt: 1,
  };
  const healed = sanitizeImportedIndicator(stale);
  assert.ok(healed, "legacy record must still import");
  assert.equal(healed.inputMeta.find((m) => m.title === "Source")?.type, "source", "stale float Source → source");
  assert.equal(healed.inputMeta.find((m) => m.title === "Length")?.type, "int", "a real int is never touched");
});

test("backward-compat: a genuine input.float is NEVER reclassified to source", () => {
  const src = `//@version=6
indicator("genuine float", overlay = true)
mult = input.float(2.0, "Mult")
src  = input(close, title="Source")
plot(ta.sma(src, 5) * mult)`;
  const stale = {
    id: "pine-float", name: "genuine float", source: src, enabled: true, overlay: true,
    inputs: {}, inputMeta: [
      { varId: "Mult", title: "Mult", type: "float", defval: 2 },
      { varId: "Source", title: "Source", type: "float", defval: null },
    ], plotMeta: [], createdAt: 1,
  };
  const healed = sanitizeImportedIndicator(stale);
  assert.equal(healed.inputMeta.find((m) => m.title === "Mult")?.type, "float", "a real float stays float");
  assert.equal(healed.inputMeta.find((m) => m.title === "Source")?.type, "source", "the source is still healed");
});

// ── requirement 6: fractal levels + line-break rendering remain unchanged ─────

test("regression: fractal_SMA still declares its 24 linebr fractal levels + the MA", async () => {
  const ind = await importIndicator();
  const keys = ind.plotMeta.map((m) => m.key);
  const up = keys.filter((k) => /Up level/.test(k)).length;
  const dn = keys.filter((k) => /Down level/.test(k)).length;
  assert.equal(up, 12, "all 12 Up fractal levels present");
  assert.equal(dn, 12, "all 12 Down fractal levels present");
  assert.ok(keys.includes("MA"), "the SMA MA output is present");
  const eng = new PinerPineEngine();
  eng.setCandles(BARS, null, 60, null);
  try {
    const run = await eng.computeScriptVisuals({ id: "fsma", source: FRACTAL_SMA, bindings: [] });
    assert.ok(run, "fractal_SMA runs");
    // The fractal Up/Down levels still render as line-family visuals (the
    // engine surfaces linebr series as `line` visuals; the offset/linebr
    // segment adapter in pineDrawings owns the horizontal-segment contract,
    // covered by tests/fractal*.test.mjs). Source normalization must not
    // perturb them.
    const fractalLines = run.visuals.filter((v) => v.type === "line" && /(Up|Down) level/.test(v.key));
    assert.ok(fractalLines.length > 0, "fractal levels still render as line visuals");
    assert.ok(run.visuals.some((v) => v.key === "MA" && v.type === "line"), "the SMA MA line still renders");
  } finally {
    eng.dispose();
  }
});

