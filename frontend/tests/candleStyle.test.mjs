/**
 * Candlestick Symbol-section derivation tests (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * The Settings modal's Candles block (body/borders/wick toggles + up/down
 * colors) is reduced to PURE functions in candleColors.ts that emit the exact
 * Lightweight Charts candlestick-series options CandleStyleBridge pushes via
 * `series.applyOptions(...)`. No chart/React runtime needed here: the contract
 * is "these options are what changes what the user sees".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  TRANSPARENT_CANDLE_COLOR,
  candleElementOptions,
  effectiveCandleColors,
} from "../src/components/TradingChart/candleColors.ts";
import { defaultCandleSettings } from "../src/config/chartSettings.ts";

/** A fresh default candle config. */
const def = () => ({ ...defaultCandleSettings(), upColor: "#26a69a", downColor: "#ef5350" });

// ── body toggle: hides the BODY via transparent colors, NOT via a flag ─────────

test("body OFF → up/down colors are transparent (LWC paints no body, borders+wicks remain)", () => {
  const palette = effectiveCandleColors("#26a69a", "#ef5350", false);
  const opts = candleElementOptions(palette, { body: false, borders: true, wick: true });
  assert.equal(opts.upColor, TRANSPARENT_CANDLE_COLOR, "transparent up body");
  assert.equal(opts.downColor, TRANSPARENT_CANDLE_COLOR, "transparent down body");
  assert.equal(opts.borderVisible, true, "borders still visible (decoupled)");
  assert.equal(opts.wickVisible, true, "wicks still visible (decoupled)");
});

test("body ON restores the palette EXACTLY (stateless, no color accumulation)", () => {
  const palette = effectiveCandleColors("#26a69a", "#ef5350", false);
  const off = candleElementOptions(palette, { body: false, borders: true, wick: true });
  const on = candleElementOptions(palette, { body: true, borders: true, wick: true });
  assert.equal(on.upColor, "#26a69a");
  assert.equal(on.downColor, "#ef5350");
  assert.notEqual(on.upColor, off.upColor, "toggle is reversible");
});

// ── borders / wick toggles: native LWC visibility flags ───────────────────────

test("borders toggle maps to native borderVisible", () => {
  const palette = effectiveCandleColors("#26a69a", "#ef5350", false);
  assert.equal(candleElementOptions(palette, { body: true, borders: false, wick: true }).borderVisible, false);
  assert.equal(candleElementOptions(palette, { body: true, borders: true, wick: true }).borderVisible, true);
});

test("wick toggle maps to native wickVisible", () => {
  const palette = effectiveCandleColors("#26a69a", "#ef5350", false);
  assert.equal(candleElementOptions(palette, { body: true, borders: true, wick: false }).wickVisible, false);
  assert.equal(candleElementOptions(palette, { body: true, borders: true, wick: true }).wickVisible, true);
});

// ── colors flow through to all six series color options ───────────────────────

test("picked up/down colors populate every color slot of the palette", () => {
  const palette = effectiveCandleColors("#111111", "#222222", false);
  assert.deepEqual(palette, {
    upColor: "#111111",
    downColor: "#222222",
    borderUpColor: "#111111",
    borderDownColor: "#222222",
    wickUpColor: "#111111",
    wickDownColor: "#222222",
  });
});

// ── candleStyleOptions: the bridge's PURE derivation (settings + invert → opts) ─

test("candleStyleOptions composition: settings + invert → the exact options applyOptions pushes", () => {
  // Mirrors CandleStyleBridge's PURE derivation (candles + invertScale →
  // CandleElementOptions). The bridge pushes THIS object into series.applyOptions,
  // so the option shape here IS what changes what the user views:
    const candles = { ...def(), upColor: "#ff0000", downColor: "#00ff00", body: true, borders: false, wick: true };

  // inverted → up/down swap (close>open renders the bearish color):
  const invertedPalette = effectiveCandleColors(candles.upColor, candles.downColor, true);
  const inverted = candleElementOptions(invertedPalette, candles);
  assert.equal(inverted.upColor, "#00ff00", "inverted up = user down color");
  assert.equal(inverted.downColor, "#ff0000", "inverted down = user up color");
  assert.equal(inverted.borderVisible, false, "borders toggle honored while inverted");
  assert.equal(inverted.wickVisible, true, "wick toggle honored while inverted");

  // non-inverted → palette matches the user's pick exactly:
  const normal = candleElementOptions(effectiveCandleColors(candles.upColor, candles.downColor, false), candles);
  assert.equal(normal.upColor, "#ff0000");
  assert.equal(normal.downColor, "#00ff00");

  // every emitted option is a string LWC's candlestick accepts (no canvas hacks):
  assert.equal(typeof inverted.upColor, "string");
  assert.equal(typeof inverted.wickUpColor, "string");
  assert.equal(typeof inverted.borderDownColor, "string");
});
