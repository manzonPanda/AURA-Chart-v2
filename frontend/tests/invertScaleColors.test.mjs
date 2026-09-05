/**
 * Invert Scale ↔ candle-color contract tests (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * AURA PRODUCT SEMANTICS (intentional): Invert Scale inverts the price axis
 * AND swaps the rendered bullish/bearish candle colors:
 *   invertScale=false: close>open → bullish #26a69a, close<open → bearish #ef5350
 *   invertScale=true : close>open → bearish #ef5350, close<open → bullish #26a69a
 *
 * HARD CONSTRAINTS pinned here:
 *   - OHLC data is NEVER transformed (no negation, no open/close swap, no
 *     second dataset) — the color decision is a pure comparison on values;
 *   - price geometry stays Lightweight Charts' NATIVE `invertScale`;
 *   - the color swap is applied through the SUPPORTED series-options API
 *     (no canvas hacking), by InvertScaleBridge, which re-asserts the palette
 *     whenever CandleKit restyles (bus "theme");
 *   - direction UI (countdown pill, OHLC readout, debug probe) routes through
 *     the same `effectiveBullish` helper.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  effectiveBullish,
  effectiveCandleColors,
} from "../src/components/TradingChart/candleColors.ts";
import { sanitizeChartSettings } from "../src/config/chartSettings.ts";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read a project source file relative to frontend/. */
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");

/**
 * Strip block + line comments so guards evaluate CODE only — documentation
 * that merely mentions color option names must not trip the source scans.
 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const BULL = "#26a69a";
const BEAR = "#ef5350";

// ── AURA color semantics (pure functions) ─────────────────────────────────────

test("effectiveBullish normal mode: close>open → bullish, close<open → bearish", () => {
  assert.equal(effectiveBullish(110, 100, false), true);
  assert.equal(effectiveBullish(100, 110, false), false);
  const c = effectiveCandleColors(BULL, BEAR, false);
  assert.equal(c.upColor, BULL, "normal bullish body = bullish color");
  assert.equal(c.downColor, BEAR, "normal bearish body = bearish color");
});

test("effectiveBullish inverted mode: close>open → bearish color, close<open → bullish color", () => {
  assert.equal(effectiveBullish(110, 100, true), false, "inverted bullish renders bearish");
  assert.equal(effectiveBullish(100, 110, true), true, "inverted bearish renders bullish");
  const c = effectiveCandleColors(BULL, BEAR, true);
  assert.equal(c.upColor, BEAR, "inverted bullish body = bearish color");
  assert.equal(c.downColor, BULL, "inverted bearish body = bullish color");
});

test("doji (close === open) counts bullish — and renders bearish while inverted", () => {
  assert.equal(effectiveBullish(100, 100, false), true);
  assert.equal(effectiveBullish(100, 100, true), false);
});

test("effectiveCandleColors swaps body, border AND wick together while inverted", () => {
  const off = effectiveCandleColors(BULL, BEAR, false);
  assert.deepEqual(off, {
    upColor: BULL,
    downColor: BEAR,
    borderUpColor: BULL,
    borderDownColor: BEAR,
    wickUpColor: BULL,
    wickDownColor: BEAR,
  });
  const on = effectiveCandleColors(BULL, BEAR, true);
  assert.deepEqual(on, {
    upColor: BEAR,
    downColor: BULL,
    borderUpColor: BEAR,
    borderDownColor: BULL,
    wickUpColor: BEAR,
    wickDownColor: BULL,
  });
});

test("toggle round-trip OFF→ON→OFF restores the original palette exactly", () => {
  const original = effectiveCandleColors(BULL, BEAR, false);
  const inverted = effectiveCandleColors(BULL, BEAR, true);
  assert.notDeepEqual(inverted, original);
  // The bridge ALWAYS re-derives from the theme's true bull/bear colors —
  // never from the currently-applied (possibly swapped) series options — so
  // toggling OFF restores the original palette exactly, statelessly.
  const restored = effectiveCandleColors(BULL, BEAR, false);
  assert.deepEqual(restored, original);
});

test("color semantics are comparison-only — OHLC values are never transformed", () => {
  const pairs = [
    [100, 110],
    [110, 100],
    [100, 100],
    [26039.8, 26040.8],
    [26049.7, 26044.3],
    [-5, 5],
    [0.0001, -0.0001],
  ];
  for (const [open, close] of pairs) {
    // effectiveBullish(o,c,inv) === (close>=open) XOR invert — a pure boolean
    // derivation; the VALUES themselves flow through untouched.
    assert.equal(effectiveBullish(close, open, false), close >= open);
    assert.equal(effectiveBullish(close, open, true), !(close >= open));
  }
  // The palette derivation only ever re-orders the two theme colors — no
  // value can be invented, negated or lost through it.
  const on = effectiveCandleColors(BULL, BEAR, true);
  const set = new Set(Object.values(on));
  assert.deepEqual([...set].sort(), [BEAR, BULL].sort());
});

// ── Wiring: the swap reaches the chart through supported APIs only ────────────

test("InvertScaleBridge wiring: native priceScale option + series palette swap + theme re-assert; no canvas hacks", () => {
  const code = stripComments(readSrc("src/components/TradingChart/InvertScaleBridge.tsx"));
  // Geometry stays native:
  assert.ok(
    code.includes('chart.priceScale("right").applyOptions({ invertScale })'),
    "price geometry must use LWC's native invertScale",
  );
  // Palette swap goes through the series-options API (recolors historical +
  // live candles at paint time; survives every setData/updateBar path):
  assert.ok(code.includes("effectiveCandleColors("), "colors derived via effectiveCandleColors");
  assert.ok(code.includes("series.applyOptions("), "swap applied via series.applyOptions");
  assert.ok(code.includes('bus.on("theme"'), "palette re-asserted when CandleKit restyles");
  // Guardrails: no canvas pixel hacking, no per-bar color injection:
  assert.ok(!/getImageData|getContext/.test(code), "bridge must not touch the canvas");
  assert.ok(!/color:\s/.test(code), "bridge must not inject per-bar colors into data");
  assert.ok(!/createPriceLine/.test(code), "bridge must not create price lines");
});

test("direction UI routes through effectiveBullish (countdown pill, OHLC readout, probe)", () => {
  for (const rel of [
    "src/components/TradingChart/CandleCountdown.tsx",
    "src/components/TradingChart/OHLCReadout.tsx",
    "src/components/TradingChart/invertDebug.tsx",
  ]) {
    const code = stripComments(readSrc(rel));
    assert.ok(
      code.includes("effectiveBullish("),
      `${rel} must derive rendered direction via effectiveBullish`,
    );
  }
});

test("the App toggle flips only the boolean state — never the candle data", () => {
  const app = stripComments(readSrc("src/App.tsx"));
  assert.ok(
    app.includes("setChartSettings((prev) => ({ ...prev, invertScale: !prev.invertScale }))"),
    "the toggle must mutate only the invertScale boolean",
  );
});

test("chartSettings sanitizer drops color-shaped fields — settings stay presentation-only", () => {
  assert.deepEqual(
    sanitizeChartSettings({ invertScale: true, upColor: "red", downColor: "#0f0", bearishColor: "blue" }),
    { invertScale: true },
  );
});

// ── Installed Lightweight-Charts bundle: the native colorer is OHLC-based ─────
// This documents WHY the options-level swap is the correct mechanism: LWC
// computes per-candle colors from raw OHLC at paint time and reads the series
// options we swap — so our override is complete without touching the canvas.

/** Dev (readable) bundles of the installed library, most-preferred first. */
const LWC_BUNDLE_CANDIDATES = [
  "node_modules/lightweight-charts/dist/lightweight-charts.development.mjs",
  "node_modules/lightweight-charts/dist/lightweight-charts.standalone.development.mjs",
  "node_modules/lightweight-charts/dist/lightweight-charts.standalone.development.js",
];

test("installed lightweight-charts is v5.x with native invertScale support", () => {
  const pkg = JSON.parse(readSrc("node_modules/lightweight-charts/package.json"));
  assert.match(pkg.version, /^5\./, "native price-scale invertScale requires v5");
  const typings = readSrc("node_modules/lightweight-charts/dist/typings.d.ts");
  assert.match(typings, /invertScale:\s*boolean/, "PriceScaleOptions must expose invertScale");
});

test("native Candlestick colorer reads raw open<=close + series options (so the options-level swap is complete)", () => {
  const bundleRel = LWC_BUNDLE_CANDIDATES.find((rel) => fs.existsSync(path.join(FRONTEND_ROOT, rel)));
  assert.ok(bundleRel, "a readable lightweight-charts dev bundle must exist");
  const bundle = readSrc(bundleRel);

  const start = bundle.indexOf("Candlestick: (findBar");
  assert.notEqual(start, -1, "Candlestick colorer entry point found in the bundle");
  let end = bundle.length;
  for (const next of ["Custom: (findBar", "Area: (findBar", "Baseline: (findBar", "Line: (findBar"]) {
    const idx = bundle.indexOf(next, start + 1);
    if (idx !== -1) end = Math.min(end, idx);
  }
  const block = bundle.slice(start, end);

  // Direction from RAW OHLC only (open = value[0], close = value[3]):
  assert.match(
    block,
    /isUp\s*=\s*ensure\(currentBar\.(_internal_)?value\[0[^\]]*\]\)\s*<=\s*ensure\(currentBar\.(_internal_)?value\[3/,
    "isUp must be open <= close on RAW values",
  );
  // ...combined with the SERIES OPTIONS we swap (per-bar overrides win, but
  // AURA never sets any — CandleKit maps plain OHLC everywhere):
  assert.ok(block.includes("isUp ? upColor : downColor"), "body color follows isUp via options");
  assert.ok(block.includes("isUp ? borderUpColor : borderDownColor"), "border follows options");
  assert.ok(block.includes("isUp ? wickUpColor : wickDownColor"), "wick follows options");
  assert.ok(!/invert/i.test(block), "the native colorer itself never consults invertScale");
  // Inversion is coordinate-only in the renderer (geometry, not restyle):
  assert.ok(bundle.includes("isInverted ? invCoordinate"));
});



