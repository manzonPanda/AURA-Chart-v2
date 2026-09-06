/**
 * Pine syminfo test suite — symbol metadata (syminfo.mintick et al.).
 *
 * Root cause this pins down: PineTS 0.9.33 only populates the script-visible
 * `syminfo` namespace when the data source implements the optional
 * `getSymbolInfo(tickerId)` provider contract. A plain-array source (the old
 * engine wiring) leaves `pine.syminfo` undefined, so ANY `syminfo.mintick`
 * read in a user script threw
 * "Cannot read properties of undefined (reading 'mintick')".
 *
 * The engine now always wraps its candles in a provider duck-type whose
 * `getSymbolInfo` returns registry-derived metadata (mintick from the active
 * instrument's quoting decimals; data-estimate fallback; documented floor).
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PineIndicatorEngine,
  buildPineSymbolInfo,
  estimateMintickFromCandles,
  mintickFromDecimals,
} from "../src/services/pineEngine.ts";
import { compileImportedPine } from "../src/services/pineImport.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

function rng(seed = 1) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 100 - 50;
  };
}

/** Candles whose price deltas all land on a known tick grid. */
function makeBars(n, tick, startTs = 1_704_153_600_000, seed = 7) {
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

/** Run a script and return the first line visual's numeric values. */
async function runLineValues(script, bars, symbol) {
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60, symbol ?? null);
  const run = await eng.computeScriptVisuals({ id: "test", source: script, bindings: [] }, {});
  eng.dispose();
  if (run === null) throw new Error("computeScriptVisuals returned null (no data / run failure)");
  const line = run.visuals.find((v) => v.type === "line");
  return line ? line.data.map((p) => p.value) : [];
}

// ── Unit: mintick derivation ────────────────────────────────────────────────

test("mintickFromDecimals: registry decimals → tick grid (DAX 1 → 0.1, Gold 2 → 0.01)", () => {
  assert.equal(mintickFromDecimals(0), 1);
  assert.equal(mintickFromDecimals(1), 0.1);
  assert.equal(mintickFromDecimals(2), 0.01);
  assert.equal(mintickFromDecimals(4), 0.0001);
});

test("mintickFromDecimals: invalid decimals clamp to the safe 0-decimal floor", () => {
  assert.equal(mintickFromDecimals(-3), 1); // < 0 → 0 decimals
  assert.equal(mintickFromDecimals(2.5), 1); // non-integer → 0 decimals
  assert.equal(mintickFromDecimals(99), 1); // > 8 → 0 decimals (garbage registry input)
  assert.equal(mintickFromDecimals(Number.NaN), 1);
});

test("estimateMintickFromCandles: smallest delta snapped DOWN onto the {1,2,2.5,5}×10^n grid", () => {
  const bars = [
    { open: 100, high: 100.5, low: 100, close: 100.25 },
    { open: 100.25, high: 100.75, low: 100.25, close: 100.5 },
    { open: 100.5, high: 101, low: 100.5, close: 100.75 },
  ];
  assert.equal(estimateMintickFromCandles(bars), 0.25);
});

test("estimateMintickFromCandles: degenerate flat data → null (caller owns the floor)", () => {
  const flat = [
    { open: 50, high: 50, low: 50, close: 50 },
    { open: 50, high: 50, low: 50, close: 50 },
  ];
  assert.equal(estimateMintickFromCandles(flat), null);
  assert.equal(estimateMintickFromCandles([]), null);
});
test("buildPineSymbolInfo: instrument decimals WIN over the candle-data estimate", () => {
  const klines = [
    { open: 100, high: 100.5, low: 100, close: 100.25 },
    { open: 100.25, high: 100.75, low: 100.25, close: 100.5 },
  ];
  const info = buildPineSymbolInfo({ tickerid: "CS.D.GOLDCGD.TODAY.IP", decimals: 2 }, klines);
  assert.equal(info.mintick, 0.01);
  assert.equal(info.pricescale, 100); // TradingView: pricescale = 1/mintick
  assert.equal(info.minmove, 1);
  assert.equal(info.tickerid, "CS.D.GOLDCGD.TODAY.IP");
});

test("buildPineSymbolInfo: no registry meta → data-derived mintick; flat data → documented floor", () => {
  const grid = [
    { open: 100, high: 100.5, low: 100, close: 100.25 },
    { open: 100.25, high: 100.75, low: 100.25, close: 100.5 },
  ];
  assert.equal(buildPineSymbolInfo(null, grid).mintick, 0.25);
  const flat = [
    { open: 50, high: 50, low: 50, close: 50 },
    { open: 50, high: 50, low: 50, close: 50 },
  ];
  assert.equal(buildPineSymbolInfo(null, flat).mintick, 0.0001);
});

// ── End-to-end: the engine serves syminfo.* to user scripts ─────────────────

test("engine: script reading syminfo.mintick renders the instrument tick (decimals=2 → 0.01)", async () => {
  const bars = makeBars(60, 0.01);
  const values = await runLineValues(
    `//@version=6
indicator("mintick probe", overlay=true)
plot(syminfo.mintick)`,
    bars,
    { tickerid: "CS.D.GOLDCGD.TODAY.IP", decimals: 2 },
  );
  assert.ok(values.length > 0, "expected a rendered line");
  for (const v of values) assert.equal(v, 0.01);
});

test("engine: symbol metadata propagates — syminfo.tickerid + timezone are visible to scripts", async () => {
  const bars = makeBars(60, 0.1);
  const values = await runLineValues(
    `//@version=6
indicator("syminfo id probe", overlay=true)
plot(syminfo.tickerid == "TEST.EPIC.IP" ? 1 : 0)`,
    bars,
    { tickerid: "TEST.EPIC.IP", decimals: 1, timezone: "Europe/London" },
  );
  assert.ok(values.length > 0);
  for (const v of values) assert.equal(v, 1);
});

test("engine: symbol=null still yields syminfo (data-derived mintick) — no undefined crash", async () => {
  const bars = makeBars(60, 0.1);
  const values = await runLineValues(
    `//@version=6
indicator("fallback probe", overlay=true)
plot(syminfo.mintick)`,
    bars,
    null,
  );
  assert.ok(values.length > 0);
  // Contract: with no registry metadata the mintick is DERIVED FROM THE DATA
  // (the estimator's exact output for these candles) — never a crash, never a
  // hardcoded 0.01.
  const expected = estimateMintickFromCandles(bars);
  assert.ok(expected !== null && expected > 0, "fixture must carry usable deltas");
  for (const v of values) assert.equal(v, expected);
});

// ── Regression: the provider-source runtime did not break existing paths ────

test("regression: plain plot/EMA scripts still run through the engine", async () => {
  const bars = makeBars(80, 0.01);
  const values = await runLineValues(
    `//@version=6
indicator("ema probe", overlay=true)
plot(ta.ema(close, 9))`,
    bars,
    { tickerid: "TEST.EPIC.IP", decimals: 2 },
  );
  assert.ok(values.length > 0, "EMA line vanished under the provider source");
  for (const v of values) assert.ok(Number.isFinite(v));
});
// ── Import path: the modal preview gets the same syminfo ────────────────────

test("import: a syminfo.mintick script compiles + previews cleanly when the symbol is provided", async () => {
  const bars = makeBars(120, 0.01);
  const outcome = await compileImportedPine({
    name: "Mintick import",
    source: `//@version=6
indicator("mintick import", overlay=true)
plot(syminfo.mintick)`,
    bars,
    bucketSec: 60,
    symbol: { tickerid: "CS.D.GOLDCGD.TODAY.IP", decimals: 2 },
  });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.issue?.message);
  const line = outcome.indicator?.plotMeta.find((m) => m.type === "line");
  assert.ok(line, "expected a line in the import plot metadata");
});

// ── The real-world scale: an ~83k padded script still compiles WITH syminfo ──

test("import: an ~83k script using syminfo.mintick is accepted end-to-end", { timeout: 20_000 }, async () => {
  const bars = makeBars(120, 0.01);
  // Comments pad the source to the same size class as the user's real script
  // without changing its semantics.
  const filler = "// AURA compatibility padding for realistic script sizes.\n".repeat(1_515);
  const source = `//@version=6
indicator("big mintick script", overlay=true)
${filler}plot(syminfo.mintick)`;
  assert.ok(source.length > 80_000 && source.length < 100_000, `fixture size ${source.length}`);
  const outcome = await compileImportedPine({
    name: "Big mintick import",
    source,
    bars,
    bucketSec: 60,
    symbol: { tickerid: "CS.D.GOLDCGD.TODAY.IP", decimals: 2 },
  });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.issue?.message);
  assert.ok(
    outcome.indicator?.plotMeta.some((m) => m.type === "line"),
    "the 83k script must still produce its line output",
  );
});
