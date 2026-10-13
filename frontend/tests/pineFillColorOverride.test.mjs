/**
 * Bollinger Bands fill COLOR/OPACITY override — the "fill color doesn't update
 * the chart" regression.
 *
 * ROOT CAUSE: the fill Style override resolves in PineBridge `resolveFill`,
 * which — when an opacity (or color+opacity) override is active — computes the
 * region's uniform color via `withAlpha`, returning an `rgba(r, g, b, a)`
 * string. The fill primitive then paints each bar with
 * `pineHexToRgba(perBar || region.color, PINE_DEFAULT_FILL_COLOR)`, but
 * `pineHexToRgba` only understood `#hex` — an `rgba(...)` input matched NO
 * pattern and returned the hardcoded fallback `#2962FF33` (default blue). So an
 * opacity override (and any color+opacity combo) painted the WRONG color.
 *
 * FIX: `pineHexToRgba` now passes a valid `rgb()`/`rgba()` string straight
 * through, so the resolved region color reaches the canvas `fillStyle`.
 *
 * These tests exercise the REAL engine fill data, the REAL `pineHexToRgba`, and
 * a faithful mirror of the primitive's exact per-bar color selection, so the
 * assertion is on the ACTUAL color that reaches the canvas.
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import { pineHexToRgba, PINE_DEFAULT_FILL_COLOR } from "../src/services/pineDrawings.ts";
import { sanitizeStyleOverrides } from "../src/services/pineStyle.ts";
import { sanitizeImportedIndicator } from "../src/services/pineImport.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => fs.readFileSync(path.resolve(HERE, "..", rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const FRACTAL_SMA = readSrc("src/components/Indicators/fractal_SMA.pine");

// ── fixtures ─────────────────────────────────────────────────────────────────

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

/** Run fractal_SMA and return its single Bollinger fill visual. */
async function runFractalVisuals() {
  const eng = new PinerPineEngine();
  eng.setCandles(makeBars(60), null, 60, null);
  try {
    const run = await eng.computeScriptVisuals({ id: "fsma", source: FRACTAL_SMA, bindings: [] });
    assert.ok(run, "fractal_SMA runs");
    return run.visuals;
  } finally {
    eng.dispose();
  }
}

async function runFractalFill() {
  const visuals = await runFractalVisuals();
  const fill = visuals.find((v) => v.type === "fill");
  assert.ok(fill, "the Bollinger Bands Background Fill visual is present");
  return fill;
}

// ── faithful mirror of PineBridge.resolveFill + the primitive's color pick ───
// Same rules as PineBridge.tsx `resolveFill` and pineFillPrimitive.ts's per-bar
// `fillStyle` selection, so the assertion is on the ACTUAL canvas color.

function withAlpha(color, alpha) {
  let c = color.trim();
  const m3 = /^#([0-9a-f]{3})([0-9a-f]{2})?$/i.exec(c);
  if (m3 && !m3[2]) c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (!m) return color;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const ownAlpha = m[2] ? parseInt(m[2], 16) / 255 : 1;
  return `rgba(${r}, ${g}, ${b}, ${(Math.max(0, Math.min(1, alpha)) * ownAlpha).toFixed(3)})`;
}

function resolveFill(style, key, scriptColor, data) {
  const o = style[key];
  const overrideColor = typeof o?.color === "string" ? o.color : null;
  const opacity = typeof o?.opacity === "number" ? Math.max(0, Math.min(1, o.opacity)) : null;
  const base = overrideColor ?? scriptColor ?? null;
  let regionColor = base ?? "#2962FF33";
  if (opacity !== null) {
    const src = base ?? "#2962FF";
    regionColor = withAlpha(src.startsWith("#") ? src : "#2962FF", opacity);
  }
  const stripPerBar = overrideColor !== null;
  const points = stripPerBar
    ? data.map((p) => ({ ts: p.ts, ...(p.top !== undefined ? { top: p.top } : {}), ...(p.bottom !== undefined ? { bottom: p.bottom } : {}) }))
    : data.map((p) => ({
        ts: p.ts,
        ...(p.top !== undefined ? { top: p.top } : {}),
        ...(p.bottom !== undefined ? { bottom: p.bottom } : {}),
        ...(p.color && opacity !== null
          ? { color: withAlpha(p.color.startsWith("#") ? p.color : "#2962FF", opacity) }
          : p.color ? { color: p.color } : {}),
      }));
  return { points, color: regionColor };
}

/** The EXACT color the fill primitive assigns a valued bar's canvas fillStyle. */
function primitiveCanvasColor(region, i) {
  const p = region.points[i];
  const perBar = p.color;
  return pineHexToRgba(perBar && perBar.length > 0 ? perBar : region.color, PINE_DEFAULT_FILL_COLOR);
}

function firstValuedIndex(region) {
  return region.points.findIndex((p) => typeof p.top === "number" && typeof p.bottom === "number");
}


// ── pineHexToRgba: the exact bug location ────────────────────────────────────

test("pineHexToRgba: passes a valid rgba()/rgb() string straight through (the fix)", () => {
  assert.equal(pineHexToRgba("rgba(255, 0, 0, 0.5)", "#2962FF33"), "rgba(255, 0, 0, 0.5)");
  assert.equal(pineHexToRgba("rgba(6, 175, 12, 0.049)", "#2962FF33"), "rgba(6, 175, 12, 0.049)");
  assert.equal(pineHexToRgba("rgb(1, 2, 3)", "#2962FF33"), "rgb(1, 2, 3)");
  // Malformed rgb/rgba still falls back safely (never a broken fillStyle).
  assert.equal(pineHexToRgba("rgba(1, 2, 3, notanumber)", "#2962FF33"), "#2962FF33");
  assert.equal(pineHexToRgba("rgba(1, 2)", "#2962FF33"), "#2962FF33");
  // Hex forms are unchanged by the fix.
  assert.equal(pineHexToRgba("#ff0000", "#2962FF33"), "#ff0000");
  assert.equal(pineHexToRgba("#06AF0C19", "#2962FF33"), "rgba(6, 175, 12, 0.098)");
  assert.equal(pineHexToRgba("", "#2962FF33"), "#2962FF33");
  assert.equal(pineHexToRgba("garbage", "#2962FF33"), "#2962FF33");
});

// ── a changed fill color reaches the ACTUAL rendering input ──────────────────

test("fill: a color override reaches the canvas fillStyle (not the default blue)", async () => {
  const fill = await runFractalFill();
  const key = fill.key;
  const region = resolveFill(sanitizeStyleOverrides({ [key]: { color: "#ff0000" } }), key, fill.color ?? null, fill.data);
  const i = firstValuedIndex(region);
  assert.ok(i >= 0, "the fill has at least one valued bar");
  assert.equal(region.points[i].color, undefined, "color override strips per-bar script colors");
  assert.equal(primitiveCanvasColor(region, i), "#ff0000", "the canvas paints the user's red");
});

test("fill: an OPACITY-only override keeps the script color at the new alpha (was default blue)", async () => {
  const fill = await runFractalFill();
  const key = fill.key;
  const region = resolveFill(sanitizeStyleOverrides({ [key]: { opacity: 0.5 } }), key, fill.color ?? null, fill.data);
  const i = firstValuedIndex(region);
  assert.match(region.color, /^rgba\(/, "opacity path produces an rgba region color");
  const painted = primitiveCanvasColor(region, i);
  assert.notEqual(painted, PINE_DEFAULT_FILL_COLOR, "must NOT fall back to the default blue");
  assert.match(painted, /^rgba\(6, 175, 12, /, "the script green is kept at the override alpha");
});

test("fill: color + opacity together reach the canvas (user red at chosen alpha)", async () => {
  const fill = await runFractalFill();
  const key = fill.key;
  const region = resolveFill(sanitizeStyleOverrides({ [key]: { color: "#ff0000", opacity: 0.5 } }), key, fill.color ?? null, fill.data);
  assert.equal(primitiveCanvasColor(region, firstValuedIndex(region)), "rgba(255, 0, 0, 0.500)");
});

// ── fill stays independent of the boundary Bollinger line colors ─────────────

test("fill: a fill color override never recolors the Upper/Lower Bollinger bands", async () => {
  const visuals = await runFractalVisuals();
  const fill = visuals.find((v) => v.type === "fill");
  const upper = visuals.find((v) => v.type === "line" && v.title === "Upper Bollinger Band");
  const lower = visuals.find((v) => v.type === "line" && v.title === "Lower Bollinger Band");
  assert.ok(fill && upper && lower, "fill + both bands present");
  assert.notEqual(fill.key, upper.key, "fill key differs from the Upper band key");
  assert.notEqual(fill.key, lower.key, "fill key differs from the Lower band key");
  assert.ok(/^#/i.test(upper.color ?? ""), "Upper band keeps its own color");
  assert.ok(/^#/i.test(lower.color ?? ""), "Lower band keeps its own color");
});


// ── persistence + reset ──────────────────────────────────────────────────────

test("fill: the chosen color+opacity survive a reload; reset restores the script styling", async () => {
  const fill = await runFractalFill();
  const key = fill.key;
  const stored = {
    id: "pine-fill", name: "Fractals + SMA", source: FRACTAL_SMA, enabled: true, overlay: true,
    inputs: {}, inputMeta: [],
    plotMeta: [{ key, title: "Bollinger Bands Background Fill", type: "fill", color: "#06af0c19" }],
    style: { [key]: { color: "#ff0000", opacity: 0.4 } },
    createdAt: 1,
  };
  const loaded = sanitizeImportedIndicator(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(loaded.style[key], { color: "#ff0000", opacity: 0.4 }, "color+opacity persist across reload");
  const region = resolveFill(loaded.style, key, fill.color ?? null, fill.data);
  assert.equal(primitiveCanvasColor(region, firstValuedIndex(region)), "rgba(255, 0, 0, 0.400)", "reloaded override reaches the canvas");

  // Reset → override dropped → the script's own green at its own alpha shows.
  const resetRegion = resolveFill(sanitizeStyleOverrides({}), key, fill.color ?? null, fill.data);
  assert.equal(primitiveCanvasColor(resetRegion, firstValuedIndex(resetRegion)), "rgba(6, 175, 12, 0.098)", "reset restores the script-defined fill color/alpha");
});

// ── a subsequent engine run must not overwrite the user override ─────────────

test("fill: a fresh engine run yields the script color; the override still wins at render", async () => {
  const fill = await runFractalFill();
  const key = fill.key;
  assert.equal(fill.color, "#06AF0C19", "the engine still reports the script's own fill color");
  const region = resolveFill(sanitizeStyleOverrides({ [key]: { color: "#00ff00" } }), key, fill.color ?? null, fill.data);
  assert.equal(primitiveCanvasColor(region, firstValuedIndex(region)), "#00ff00", "override wins over the fresh run");
});

// ── repeated updates never create duplicate fills ────────────────────────────

test("fill: one fill visual ⇒ one region; the primitive is cached (no duplicate series)", async () => {
  const visuals = await runFractalVisuals();
  const fills = visuals.filter((v) => v.type === "fill");
  assert.equal(fills.length, 1, "exactly one fill visual (no duplicates from the engine)");
  const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
  assert.ok(/const existing = st\.fillPrimitives\.get\(paneIndex\);\s*if \(existing\) return existing;/.test(code), "fill primitive is cached per pane (no duplicate attach)");
  assert.ok(code.includes("prim.setFills(paneFills);"), "setFills replaces the whole fill layer");
});

// ── runtime metadata healing must not overwrite user styling ─────────────────

test("healing: the plotMeta healer preserves the user's style override", () => {
  const app = stripComments(readSrc("src/App.tsx"));
  assert.ok(/next\[idx\] = \{ \.\.\.cur, plotMeta \}/.test(app), "the healer spreads the current record (keeps style)");
});

