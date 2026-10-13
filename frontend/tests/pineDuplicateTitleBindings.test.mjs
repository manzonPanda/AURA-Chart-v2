/**
 * Pine DUPLICATE-TITLE input bindings regression — fractal_SMA.pine's dead
 * SMA-length control.
 *
 * ROOT CAUSE: `fractal_SMA.pine` declares TWO inputs titled "Length" (the SMA
 * `len` and the smoothing `maLengthInput`). Piner dedupes runtime input keys
 * (`compile().metadata.inputs[].key` -> "Length" / "Length (2)") and resolves
 * `inputs` overrides by that DEDUPED key — never the raw title.
 * AURA persisted params by `varId` (= that same
 * deduped key) but keyed the ENGINE side of the binding by the raw `title`,
 * so the second "Length" binding OVERWROTE the first inside the engine's
 * `inputsFor`: the SMA length control went dead and the smoothing value
 * drove the SMA instead — silently (no error, wrong math).
 *
 * FIX: `pineInputBindings` (services/pineImport.ts) is the SINGLE
 * construction point, shared by PineBridge (live chart) and the import
 * preview, and keys BOTH sides by `varId` (= Piner's deduped key).
 * Registry specs are unaffected (unique titles => key == title).
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileImportedPine,
  pineInputBindings,
} from "../src/services/pineImport.ts";
import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => fs.readFileSync(path.resolve(HERE, "..", rel), "utf8");
const FRACTAL_SMA = readSrc("src/components/Indicators/fractal_SMA.pine");

/** Deterministic 1m candles with DISTINCT o/h/l/c so input changes move math. */
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

const BARS = makeBars(120);

/** Import through the REAL pipeline; return the persisted indicator record. */
async function importIndicator() {
  const outcome = await compileImportedPine({ source: FRACTAL_SMA, bars: BARS, bucketSec: 60, name: "Fractals + SMA" });
  assert.equal(outcome.ok, true, `import failed: ${outcome.issue?.message}`);
  return outcome.indicator;
}

/** Last value of the `key` line for `params` through the REAL engine. */
async function lastOf(key, ind, params) {
  const eng = new PinerPineEngine();
  eng.setCandles(BARS, null, 60, null);
  try {
    const run = await eng.computeScriptVisuals(
      { id: "dup-title", source: ind.source, bindings: pineInputBindings(ind.inputMeta) },
      params,
    );
    assert.ok(run, "script must run");
    const v = run.visuals.find((x) => x.key === key || x.title === key);
    assert.ok(v && v.data.length > 0, `${key} line must render`);
    return v.data[v.data.length - 1].value;
  } finally {
    eng.dispose();
  }
}

// ── binding construction ────────────────────────────────────────────────────

test("pineInputBindings: engine side is keyed by varId (Piner's deduped key), never the raw title", async () => {
  const ind = await importIndicator();
  const lengths = ind.inputMeta.filter((m) => m.title === "Length");
  assert.equal(lengths.length, 2, "fractal_SMA declares two inputs titled Length");
  assert.deepEqual(
    lengths.map((m) => m.varId).sort(),
    ["Length", "Length (2)"].sort(),
    "Piner dedupes the second Length key",
  );
  const bindings = pineInputBindings(ind.inputMeta);
  const byParam = new Map(bindings.map((b) => [b.paramKey, b.title]));
  assert.equal(byParam.get("Length"), "Length", "SMA len binds Length -> Length");
  assert.equal(byParam.get("Length (2)"), "Length (2)", "smoothing length binds Length (2) -> Length (2)");
  assert.equal(
    new Set(bindings.map((b) => b.title)).size,
    bindings.length,
    "no two engine-side keys collide (the overwrite that killed the SMA control)",
  );
});

// ── runtime independence: each Length drives ONLY its own MA ────────────────

test("duplicate Length titles drive independent lines (SMA len -> MA, smoothing len -> SMA-based MA)", async () => {
  const ind = await importIndicator();
  const base = { ...ind.inputs };
  // SMA length is the FIRST Length (varId "Length", defval 20): shortening it
  // to 5 must move the MA line, while the smoothing line is untouched by it.
  const maBase = await lastOf("MA", ind, base);
  const maShort = await lastOf("MA", ind, { ...base, Length: 5 });
  assert.notEqual(maShort, maBase, "SMA Length override must move the MA line");
  // Smoothing length is the SECOND Length (varId "Length (2)", defval 6): it
  // feeds the SMA-based smoothing MA, NOT the MA line.
  const smBase = await lastOf("SMA-based MA", ind, base);
  const smLong = await lastOf("SMA-based MA", ind, { ...base, "Length (2)": 30 });
  assert.notEqual(smLong, smBase, "smoothing Length (2) override must move the SMA-based MA line");
  // Cross-check: each knob leaves the OTHER line alone (no aliasing — the
  // bug made the smoothing value drive the SMA).
  const maUnderSmooth = await lastOf("MA", ind, { ...base, "Length (2)": 30 });
  assert.equal(maUnderSmooth, maBase, "smoothing Length (2) must NOT move the MA line");
  const smUnderSma = await lastOf("SMA-based MA", ind, { ...base, Length: 5 });
  assert.notEqual(smUnderSma, smBase, "SMA Length moves the smoothing input, so the smoothing line follows");
});

test("PineBridge + import preview share the single pineInputBindings construction point", () => {
  const src = readSrc("src/components/TradingChart/PineBridge.tsx");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(stripped.includes("pineInputBindings("), "live chart builds bindings via pineInputBindings");
  assert.ok(!/bindings:\s*inputs\.map/.test(stripped), "no ad-hoc title-keyed binding construction remains");
  const importer = readSrc("src/services/pineImport.ts");
  const strippedImporter = importer.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(strippedImporter.includes("bindings: pineInputBindings(inputs)"), "import preview uses the same helper");
});
