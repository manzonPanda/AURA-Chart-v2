import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const layer = () => readSrc("../src/components/TradingChart/DrawingLayer.tsx");
const chart = () => readSrc("../src/components/TradingChart/TradingChart.tsx");

/** The only drawing tools AURA is allowed to expose. */
const ALLOWED_TOOLS = ["TrendLine", "Rectangle", "DateRange"];

/** CandleKit's remaining tools — none of these may reach the toolbar. */
const FORBIDDEN_TOOLS = [
  "Ray",
  "ExtendedLine",
  "HorizontalLine",
  "HorizontalRay",
  "VerticalLine",
  "CrossLine",
  "Arrow",
  "Circle",
  "Triangle",
  "ParallelChannel",
  "PriceRange",
  "FibRetracement",
  "FibExtension",
];

/** Slice just the toolbar component out of DrawingLayer. */
function toolbarBody() {
  const src = layer();
  const from = src.indexOf("function DrawingToolsBar");
  const to = src.indexOf("function SyncStatusChip");
  assert.ok(from > 0 && to > from, "DrawingToolsBar is present");
  return src.slice(from, to);
}

/** Tool ids actually declared in the exported DRAWING_TOOLS array. */
function declaredTools() {
  const m = /export const DRAWING_TOOLS[^=]*=\s*\[([\s\S]*?)\];/.exec(layer());
  assert.ok(m, "DRAWING_TOOLS is exported");
  return [...m[1].matchAll(/id:\s*"([^"]+)"/g)].map((x) => x[1]);
}

test("toolbar: exactly three drawing tools are declared", () => {
  assert.deepEqual(declaredTools(), ALLOWED_TOOLS);
});

test("toolbar: no other CandleKit tool id is exposed anywhere in the strip", () => {
  const body = toolbarBody();
  for (const id of FORBIDDEN_TOOLS) {
    assert.ok(!body.includes(`id: "${id}"`), `${id} must not be offered`);
  }
});

test("toolbar: renders exactly seven controls at runtime", () => {
  const body = toolbarBody();
  const literal = body.match(/<button\b/g) ?? [];
  // Five literal <button> tags: the mapped tool button (inside DRAWING_TOOLS.map,
  // rendered once per tool) plus Cursor/Select, Delete, Lock and Measurement.
  assert.equal(literal.length, 5, "mapped tool + 4 action buttons, no strays");
  const tools = declaredTools().length;
  assert.equal(tools, 3, "the map renders three drawing tools");
  // Runtime controls = (5 literals − 1 mapped) + 3 mapped = 7.
  assert.equal(literal.length - 1 + tools, 7, "seven controls total");
  for (const label of [
    "Cursor / Select",
    "Delete Selected",
    "Lock Drawings",
    "Unlock Drawings",
    "Measurement Ruler",
  ]) {
    assert.ok(body.includes(label), `control present: ${label}`);
  }
});

test("toolbar: no destructive clear-all and no bulk delete path", () => {
  const body = toolbarBody();
  assert.ok(!body.includes("Clear all"), "clear-all is never offered");
  assert.ok(!/removeAll\s*\(/.test(body), "engine.removeAll() is unreachable");
  assert.match(body, /engine\.removeSelected\(/, "delete is per-selection only");
});

test("toolbar: lock reuses the engine's own lock state (no second lock system)", () => {
  const body = toolbarBody();
  assert.match(body, /engine\.setLocked\(/, "locks through DrawingEngine");
  assert.match(body, /engine\.isLocked\(\)/, "reads DrawingEngine state");
  assert.ok(!/localStorage|useState<.*locked/i.test(body), "no parallel lock store");
});

test("toolbar: deleting respects lock + selection, and never fires on tool change", () => {
  const body = toolbarBody();
  assert.match(body, /if \(locked \|\| !hasSelection\) return;/, "guarded no-op");
  assert.match(body, /disabled=\{!hasSelection \|\| locked\}/, "button disabled when unsafe");
  // Picking a tool must only ever change the tool — no deletion side effect.
  const pickTool = /const pickTool[\s\S]*?\n  };/.exec(body);
  assert.ok(pickTool, "pickTool handler present");
  assert.ok(!/remove|delete/i.test(pickTool[0]), "changing tools never deletes a drawing");
});

test("measurement: ChartView arms the NATIVE controller with a stable prop", () => {
  const src = chart();
  assert.match(src, /measurement=\{true\}/, "measurement enabled on ChartView");
  assert.match(src, /<MeasurementOverlay\s*\/>/, "library readout is mounted");
  assert.match(
    src,
    /MeasurementOverlay,\s*\n\s*ReplayControls/,
    "MeasurementOverlay comes from @getcandlekit/charts/react",
  );
  // The prop must be a literal so its identity never changes: ChartView's plugin
  // effect cleanup also removes the DRAWING controller.
  assert.ok(
    !/measurement=\{measure|measurement=\{\[/.test(src),
    "measurement prop must stay referentially stable",
  );
});

test("measurement: ruler is NOT persisted as a drawing", () => {
  const persistenceLayers = [
    "../src/services/drawingPersistence.ts",
    "../../backend/src/db/chartDrawingStore.ts",
    "../../backend/src/routes/chartDrawings.ts",
    "../../backend/supabase/migrations/0004_chart_drawings.sql",
  ];
  for (const rel of persistenceLayers) {
    const src = readSrc(rel);
    assert.ok(
      !/measurement|ruler/i.test(src),
      `${rel} must not gain a measurement drawing type`,
    );
  }
});

test("measurement: AURA owns no ruler math — the library computes every value", () => {
  const files = [
    "../src/components/TradingChart/DrawingLayer.tsx",
    "../src/components/TradingChart/TradingChart.tsx",
  ];
  for (const rel of files) {
    // Strip comments first: documenting the native call is fine, computing is not.
    const code = readSrc(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const token of ["pricePct", "priceDiff", "barCount", "timeDiffSeconds", "computeMeasurement"]) {
      assert.ok(!code.includes(token), `${rel} must not compute ${token}`);
    }
  }
});
