/**
 * Text annotations + contextual drawing toolbar — focused regression suite.
 *   npm --prefix frontend run test
 *
 * Covers the 12 mandated scenarios through the REAL code paths:
 *   - drawingAnnotations.ts (pure): tool gating, clamps, colour/alpha math,
 *     style normalization (legacy-safe), sanitize patch, label placement;
 *   - DrawingAnnotationPrimitive (real renderer, fake canvas): text follows the
 *     drawing through the LIVE scales, empty text draws nothing, non-annotatable
 *     tools are ignored, off-screen shapes are skipped;
 *   - drawingToolbarGeometry.ts (pure): the toolbar anchor + desired position;
 *   - source-contract wiring: the contextual toolbar + primitive are mounted,
 *     go through the SAME engine, reuse clampMenuPosition, isolate pointer
 *     events, and never add a second drawing system or persistence path;
 *   - existing drawing behaviour (selection / delete / lock / persistence /
 *     measurement) is asserted INTACT by the sibling suites — this file only
 *     ADDS coverage and never weakens them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANNOTATABLE_TOOLS,
  clampColor,
  clampFontSize,
  clampOpacity,
  defaultPlacement,
  isAnnotatableTool,
  labelAnchorForTool,
  normalizeTextStyle,
  rectLabelAnchor,
  sanitizeTextPatch,
  splitColorAlpha,
  trendLineLabelAnchor,
  withAlpha,
  MAX_TEXT_LENGTH,
} from "../src/services/drawingAnnotations.ts";
import { DrawingAnnotationPrimitive } from "../src/components/TradingChart/DrawingAnnotationPrimitive.ts";
import {
  desiredToolbarPosition,
  toolbarAnchorPoint,
  TOOLBAR_OFFSET,
} from "../src/components/TradingChart/drawingToolbarGeometry.ts";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");

// ── Tool gating ──────────────────────────────────────────────────────────────

test("gating: only TrendLine and Rectangle are annotatable", () => {
  assert.deepEqual([...ANNOTATABLE_TOOLS], ["TrendLine", "Rectangle"]);
  assert.equal(isAnnotatableTool("TrendLine"), true);
  assert.equal(isAnnotatableTool("Rectangle"), true);
  assert.equal(isAnnotatableTool("DateRange"), false);
  assert.equal(isAnnotatableTool("FibRetracement"), false);
  assert.equal(isAnnotatableTool(undefined), false);
});

// ── Clamps + colour/alpha math ───────────────────────────────────────────────

test("clamps: font size, opacity and colour are bounded to safe values", () => {
  assert.equal(clampFontSize(4), 8);
  assert.equal(clampFontSize(999), 48);
  assert.equal(clampFontSize(14), 14);
  assert.equal(clampFontSize("nope"), 12); // non-finite ⇒ default
  assert.equal(clampOpacity(-1), 0);
  assert.equal(clampOpacity(5), 1);
  assert.equal(clampOpacity(0.3), 0.3);
  assert.equal(clampColor("#abc", "#000"), "#abc");
  assert.equal(clampColor("url(x)", "#000"), "#000"); // unsafe ⇒ fallback
  assert.equal(clampColor("rgba(1,2,3,0.5)", "#000"), "rgba(1,2,3,0.5)");
});

test("colour: splitColorAlpha reads hex + rgba, withAlpha bakes alpha into the fill", () => {
  assert.deepEqual(splitColorAlpha("#26a69a"), { color: "#26a69a", alpha: 1 });
  assert.deepEqual(splitColorAlpha("#26a69a80"), { color: "#26a69a", alpha: 128 / 255 });
  assert.deepEqual(splitColorAlpha("rgba(38, 166, 154, 0.5)"), { color: "#26a69a", alpha: 0.5 });
  // Opaque stays hex; translucent becomes rgba() — both valid canvas fillStyle.
  assert.equal(withAlpha("#26a69a", 1), "#26a69a");
  assert.equal(withAlpha("#26a69a", 0.3), "rgba(38, 166, 154, 0.3)");
});

// ── Normalization (legacy-safe) + sanitize ───────────────────────────────────

test("normalize: a LEGACY style yields safe defaults (no crash, no text)", () => {
  const legacy = normalizeTextStyle({ color: "#4f8cff", width: 2, dashed: false, fill: null });
  assert.equal(legacy.text, "");
  assert.equal(legacy.textSize, 12);
  assert.equal(legacy.textColor, "#e6edf3");
  assert.equal(legacy.fillOpacity, 1); // legacy fill is opaque
  assert.equal(normalizeTextStyle(undefined).text, ""); // missing style object
});

test("normalize: text is truncated to MAX_TEXT_LENGTH", () => {
  const long = normalizeTextStyle({ text: "x".repeat(MAX_TEXT_LENGTH + 50) });
  assert.equal(long.text.length, MAX_TEXT_LENGTH);
});

test("sanitize: an empty text REMOVES the annotation without deleting the drawing", () => {
  const patch = sanitizeTextPatch({ text: "" }, "TrendLine");
  assert.equal(patch.text, "");
  // The drawing itself is never touched — only its style patch is produced.
  assert.ok(!("tool" in patch) && !("points" in patch));
});

test("sanitize: values are clamped and placement validated per tool", () => {
  const patch = sanitizeTextPatch(
    { text: "  hi  ", textSize: 999, textColor: "javascript:x", textPlacement: "nowhere" },
    "Rectangle",
  );
  assert.equal(patch.text, "  hi  ");
  assert.equal(patch.textSize, 48);
  assert.equal(patch.textColor, "#e6edf3");
  assert.equal(patch.textPlacement, "center"); // Rectangle default
  assert.equal(sanitizeTextPatch({ textPlacement: "bad" }, "TrendLine").textPlacement, "above");
});

// ── Label placement math ─────────────────────────────────────────────────────

test("placement: default placement is above for lines, inside for rectangles", () => {
  assert.equal(defaultPlacement("TrendLine"), "above");
  assert.equal(defaultPlacement("Rectangle"), "center");
});

test("placement: a horizontal trend-line label sits ABOVE (smaller screen y) by default", () => {
  const a = trendLineLabelAnchor(100, 200, 300, 200, "above", 12);
  assert.equal(a.x, 200); // midpoint
  assert.ok(a.y < 200, "above ⇒ above the line");
  const below = trendLineLabelAnchor(100, 200, 300, 200, "below", 12);
  assert.ok(below.y > 200, "below ⇒ below the line");
  const center = trendLineLabelAnchor(100, 200, 300, 200, "center", 12);
  assert.equal(center.y, 200);
});

test("placement: a steeper line still offsets perpendicular, never onto the stroke", () => {
  const a = trendLineLabelAnchor(100, 100, 100, 300, "above", 12); // vertical line
  assert.notEqual(a.x, 100, "the label moves off a vertical line");
});

test("placement: rectangle label centers inside by default; above/below sit outside", () => {
  const inside = rectLabelAnchor(100, 100, 300, 300, "center", 12);
  assert.equal(inside.x, 200);
  assert.equal(inside.y, 200);
  assert.ok(rectLabelAnchor(100, 100, 300, 300, "above", 12).y < 100);
  assert.ok(rectLabelAnchor(100, 100, 300, 300, "below", 12).y > 300);
});

test("placement: labelAnchorForTool returns null for a non-annotatable tool", () => {
  assert.equal(labelAnchorForTool("DateRange", [{ x: 0, y: 0 }], "above", 12), null);
  assert.ok(labelAnchorForTool("TrendLine", [{ x: 0, y: 0 }, { x: 10, y: 10 }], "above", 12));
});

// ── Toolbar geometry (pure) ──────────────────────────────────────────────────

test("toolbar geometry: anchor is the drawing's LAST projected point", () => {
  assert.deepEqual(toolbarAnchorPoint([{ x: 1, y: 2 }, { x: 30, y: 40 }]), { x: 30, y: 40 });
  assert.deepEqual(toolbarAnchorPoint([{ x: 5, y: 6 }]), { x: 5, y: 6 });
  assert.equal(toolbarAnchorPoint([]), null);
});

test("toolbar geometry: desired position sits just off the anchor", () => {
  assert.deepEqual(desiredToolbarPosition({ x: 100, y: 200 }), { x: 100 + TOOLBAR_OFFSET, y: 200 + TOOLBAR_OFFSET });
});


// ── Annotation primitive (REAL renderer, fake canvas) ────────────────────────

/** A fake engine that exposes getDrawings + a manual onChange trigger. */
function makeEngine(drawings) {
  const listeners = new Set();
  return {
    getDrawings: () => drawings,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit() {
      for (const cb of listeners) cb();
    },
  };
}

/** Linear time/price projection (deterministic, like tradeOverlayVisual's fakes). */
function makeScale(firstSec = 0, gridSec = 60, barSpacingPx = 10, originPx = 50) {
  return {
    timeToCoordinate(time) {
      if (!Number.isFinite(time)) return null;
      const idx = (time - firstSec) / gridSec;
      return originPx + idx * barSpacingPx;
    },
  };
}
function makeSeries(pxPerPrice = 2, baseY = 300) {
  return { priceToCoordinate(price) { return Number.isFinite(price) ? baseY - price * pxPerPrice : null; } };
}

/** A recording canvas (same contract as tradeOverlayLiveRisk.test.mjs). */
function makeCtx() {
  const ctx = {
    texts: [],
    fills: [],
    font: "",
    fillStyle: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    _pts: [],
    save() {},
    restore() {},
    beginPath() { ctx._pts = []; },
    rect(x, y, w, h) { ctx._pts.push({ x, y, w, h }); },
    fill() { ctx.fills.push({ color: ctx.fillStyle, rect: ctx._pts.slice(-1)[0] }); },
    fillText(t, x, y) { ctx.texts.push({ text: t, x, y, font: ctx.font, fillStyle: ctx.fillStyle, align: ctx.textAlign, baseline: ctx.textBaseline }); },
    measureText(t) { return { width: t.length * 7 }; },
  };
  return ctx;
}

/** Render the primitive through a real draw() and return the recorded canvas. */
function renderPrimitive(engine) {
  const prim = new DrawingAnnotationPrimitive();
  prim.setEngine(engine);
  prim.attached({
    chart: { timeScale: () => makeScale() },
    series: makeSeries(),
    requestUpdate: () => {},
  });
  prim.updateAllViews();
  const ctx = makeCtx();
  prim.renderer.draw({
    useBitmapCoordinateSpace: (cb) =>
      cb({
        context: ctx,
        mediaSize: { width: 2000, height: 1200 },
        bitmapSize: { width: 2000, height: 1200 },
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      }),
  });
  return { ctx, prim };
}

const TL = (id, style) => ({
  id,
  tool: "TrendLine",
  points: [
    { time: 0, price: 100 },
    { time: 600, price: 110 },
  ],
  style: { color: "#4f8cff", width: 2, dashed: false, fill: null, ...style },
});

test("renderer: a labelled trend line paints its text at the projected anchor", () => {
  const { ctx } = renderPrimitive(makeEngine([TL("t1", { text: "Support", textPlacement: "above" })]));
  assert.equal(ctx.texts.length, 1);
  assert.equal(ctx.texts[0].text, "Support");
  assert.ok(Number.isFinite(ctx.texts[0].x) && Number.isFinite(ctx.texts[0].y));
});

test("renderer: a drawing with EMPTY text paints nothing (annotation removed, shape kept)", () => {
  const { ctx } = renderPrimitive(makeEngine([TL("t1", { text: "" })]));
  assert.equal(ctx.texts.length, 0);
});

test("renderer: a NON-annotatable tool is ignored (DateRange never gets a label)", () => {
  const engine = makeEngine([
    { id: "d1", tool: "DateRange", points: [{ time: 0, price: 100 }, { time: 600, price: 110 }], style: { text: "nope" } },
  ]);
  const { ctx } = renderPrimitive(engine);
  assert.equal(ctx.texts.length, 0);
});

test("renderer: the label FOLLOWS the drawing through the live scales (pan/zoom/move)", () => {
  const engine = makeEngine([TL("t1", { text: "SR", textPlacement: "above" })]);
  const { prim } = renderPrimitive(engine);
  // Re-project with a SHIFTED origin (as a pan/zoom would) — the same engine
  // data must now paint at a different screen x.
  prim.attached({
    chart: { timeScale: () => makeScale(0, 60, 10, 400) },
    series: makeSeries(),
    requestUpdate: () => {},
  });
  prim.updateAllViews();
  const ctx = makeCtx();
  prim.renderer.draw({
    useBitmapCoordinateSpace: (cb) =>
      cb({ context: ctx, mediaSize: { width: 2000, height: 1200 }, bitmapSize: { width: 2000, height: 1200 }, horizontalPixelRatio: 1, verticalPixelRatio: 1 }),
  });
  assert.equal(ctx.texts.length, 1);
  assert.ok(ctx.texts[0].x > 400, "the label moved with the shifted scale");
});

test("renderer: an off-screen drawing (null projection) is skipped, never crashes", () => {
  const prim = new DrawingAnnotationPrimitive();
  prim.setEngine(makeEngine([TL("t1", { text: "SR" })]));
  // priceToCoordinate returns null → the whole shape is skipped for the frame.
  prim.attached({
    chart: { timeScale: () => makeScale() },
    series: { priceToCoordinate: () => null },
    requestUpdate: () => {},
  });
  prim.updateAllViews();
  const ctx = makeCtx();
  assert.doesNotThrow(() =>
    prim.renderer.draw({
      useBitmapCoordinateSpace: (cb) =>
        cb({ context: ctx, mediaSize: { width: 2000, height: 1200 }, bitmapSize: { width: 2000, height: 1200 }, horizontalPixelRatio: 1, verticalPixelRatio: 1 }),
    }),
  );
  assert.equal(ctx.texts.length, 0);
});

test("renderer: a legacy drawing (no text key) renders no annotation and no error", () => {
  const { ctx } = renderPrimitive(makeEngine([TL("legacy")]));
  assert.equal(ctx.texts.length, 0);
});


// ── Wiring contracts (source-level, same style as the sibling suites) ─────────

test("wiring: the contextual toolbar reuses the SAME engine (no second drawing system)", () => {
  const bar = stripComments(readSrc("src/components/TradingChart/DrawingContextToolbar.tsx"));
  assert.match(bar, /engine\.getSelectedId\(\)/, "reads selection from the engine");
  assert.match(bar, /engine\.getById\(/, "reads the selected drawing from the engine");
  assert.match(bar, /engine\.setStyle\(/, "edits through the engine — never a parallel store");
  assert.match(bar, /engine\.removeSelected\(\)/, "deletes through the engine");
  // It must NEVER create, import, or persist drawings itself.
  for (const forbidden of ["engine.commit(", "engine.import(", "engine.export(", "startTool(", "/api/drawings", "localStorage"]) {
    assert.ok(!bar.includes(forbidden), `contextual toolbar must not ${forbidden}`);
  }
});

test("wiring: the toolbar shows only for TrendLine/Rectangle and hides on deselect/delete", () => {
  const bar = stripComments(readSrc("src/components/TradingChart/DrawingContextToolbar.tsx"));
  assert.match(bar, /isAnnotatableTool\(/, "gated to annotatable tools");
  assert.match(bar, /if \(!visible \|\| !selected \|\| !tool\) return null;/, "renders nothing without a supported selection");
  // Selection is a pure reflection of the engine — deselect/delete hides it.
  assert.match(bar, /engine\.onChange\(\(\) => setSelectedId\(engine\.getSelectedId\(\)\)\)/, "selection tracks the engine");
});

test("wiring: the toolbar clamps into the chart and isolates its pointer events", () => {
  const bar = stripComments(readSrc("src/components/TradingChart/DrawingContextToolbar.tsx"));
  assert.match(bar, /clampMenuPosition\(/, "reuses the shared clamp so it stays inside the chart");
  assert.match(bar, /subscribeVisibleTimeRangeChange\(/, "repositions on pan/zoom");
  assert.match(bar, /ResizeObserver/, "repositions on resize");
  // A toolbar click must never start a pan / drag a drawing / arm a tool.
  assert.match(bar, /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/, "pointer events isolated");
  assert.match(bar, /onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}/, "mouse events isolated");
});

test("wiring: the text editor applies via setStyle and empty text removes the label", () => {
  const bar = stripComments(readSrc("src/components/TradingChart/DrawingContextToolbar.tsx"));
  assert.match(bar, /sanitizeTextPatch\(/, "input is sanitized before it reaches the engine");
  // Text is a controlled input + canvas fillText — never HTML.
  assert.ok(!bar.includes("dangerouslySetInnerHTML"), "no HTML injection surface");
  assert.ok(!bar.includes("innerHTML"), "no innerHTML writes");
  // Apply + Cancel actions exist.
  assert.match(bar, /Cancel/, "cancel action present");
  assert.match(bar, /Apply/, "apply action present");
});

test("wiring: the annotation primitive is a read-only renderer over the same engine", () => {
  const prim = stripComments(readSrc("src/components/TradingChart/DrawingAnnotationPrimitive.ts"));
  assert.match(prim, /fillText\(/, "paints text with the canvas");
  assert.match(prim, /timeToCoordinate\(/, "projects X through the live time scale");
  assert.match(prim, /priceToCoordinate\(/, "projects Y through the live price scale");
  // It must never mutate or persist a drawing.
  for (const forbidden of ["setStyle", "setPoints", "removeSelected", "engine.commit", "/api/drawings", "localStorage"]) {
    assert.ok(!prim.includes(forbidden), `annotation primitive must not ${forbidden}`);
  }
  assert.ok(!prim.includes("dangerouslySetInnerHTML"), "no HTML injection surface");
});

test("wiring: DrawingLayer attaches the annotation primitive to the same series", () => {
  const layer = stripComments(readSrc("src/components/TradingChart/DrawingLayer.tsx"));
  assert.match(layer, /new DrawingAnnotationPrimitive\(\)/, "the annotation primitive is created");
  assert.match(layer, /prim\.setEngine\(/, "and bound to the per-scope engine");
  assert.match(layer, /attachPrimitive\(/, "attached to the chart series");
});

test("wiring: TradingChart mounts the contextual toolbar as a chart overlay", () => {
  const chart = stripComments(readSrc("src/components/TradingChart/TradingChart.tsx"));
  assert.match(chart, /<DrawingContextToolbar/, "contextual toolbar is mounted");
  assert.match(chart, /engine=\{drawingController\.engine\}/, "fed the per-scope engine");
  assert.match(chart, /containerRef=\{chartWrapRef\}/, "positions inside the chart container");
  // Hidden during replay (Replay owns the chart).
  assert.match(chart, /\{drawingController && !session && \(/, "hidden while a replay session owns the chart");
});

test("wiring: styles theme the contextual toolbar + its popovers", () => {
  const css = readSrc("src/styles.css");
  assert.match(css, /\.drawing-context-bar \{/, "toolbar skin exists");
  assert.match(css, /\.drawing-ctx-panel \{/, "popover skin exists");
  assert.match(css, /\.drawing-context-bar \{[^}]*position: absolute/, "positions with the chart");
});

test("compat: existing drawing persistence/selection behaviour is unchanged", () => {
  // The existing suites own these contracts; this asserts the annotation feature
  // did NOT weaken them (no clear-all, no removeAll, engine-only mutations).
  const layer = stripComments(readSrc("src/components/TradingChart/DrawingLayer.tsx"));
  assert.match(layer, /engine\.import\(/, "restore still goes through the official import API");
  assert.match(layer, /notifyChange\(engine\.getDrawings\(\)\)/, "engine changes still drive persistence");
  assert.ok(!/removeAll\s*\(/.test(layer), "no destructive clear-all added");
  // Annotations ride the EXISTING persistence path — no new DB / API.
  assert.ok(!/chart_drawings_annotation|annotation_table|new Pool/.test(layer), "no second persistence path");
});

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
