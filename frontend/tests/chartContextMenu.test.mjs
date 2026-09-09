/**
 * Chart context-menu tests (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * Covers the TradingChart right-click context menu:
 *   - GEOMETRY (pure function): clampMenuPosition keeps the ENTIRE menu inside
 *     the chart container — overflow right/bottom is repositioned, negative
 *     anchors are nudged in, tiny containers pin at the margin;
 *   - WIRING (source contracts, same style as invertScaleColors.test.mjs):
 *     the menu is a presentation-only overlay that REUSES App's existing
 *     Invert Scale / Auto state and actions (no duplicated state, no candle-
 *     data access), prevents the native browser menu, closes on outside
 *     click / Escape / scope change, and never blocks left-click chart
 *     interaction (no preventDefault/stopPropagation on the outside path).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  clampMenuPosition,
  CONTEXT_MENU_MARGIN,
} from "../src/components/TradingChart/contextMenu.ts";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read a project source file relative to frontend/. */
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");

/**
 * Strip block + line comments so guards evaluate CODE only — documentation
 * that merely mentions a forbidden token must not trip the source scans.
 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ── Geometry: the menu must stay fully inside the chart container ─────────────

const MENU = { width: 190, height: 76 }; // ~rendered menu size (min-width 190px + 2 items)
const CHART = { width: 1200, height: 640 }; // a roomy chart container

test("clampMenuPosition: anchor with room on both axes → menu opens at the cursor", () => {
  assert.deepEqual(clampMenuPosition({ x: 300, y: 200 }, MENU, CHART), { x: 300, y: 200 });
});

test("clampMenuPosition: cursor near the RIGHT edge → menu repositioned fully inside", () => {
  const p = clampMenuPosition({ x: 1150, y: 200 }, MENU, CHART);
  assert.equal(p.x + MENU.width, CHART.width - CONTEXT_MENU_MARGIN, "right edge sits inside the container");
  assert.equal(p.y, 200, "y untouched");
});

test("clampMenuPosition: cursor near the BOTTOM edge → menu repositioned fully inside", () => {
  const p = clampMenuPosition({ x: 300, y: 620 }, MENU, CHART);
  assert.equal(p.y + MENU.height, CHART.height - CONTEXT_MENU_MARGIN, "bottom edge sits inside the container");
  assert.equal(p.x, 300, "x untouched");
});

test("clampMenuPosition: bottom-right corner → both axes repositioned inside", () => {
  assert.deepEqual(clampMenuPosition({ x: 1150, y: 620 }, MENU, CHART), {
    x: CHART.width - CONTEXT_MENU_MARGIN - MENU.width,
    y: CHART.height - CONTEXT_MENU_MARGIN - MENU.height,
  });
});

test("clampMenuPosition: negative anchor (cursor at/behind the origin) → nudged to the margin", () => {
  assert.deepEqual(clampMenuPosition({ x: -20, y: -5 }, MENU, CHART), {
    x: CONTEXT_MENU_MARGIN,
    y: CONTEXT_MENU_MARGIN,
  });
});

test("clampMenuPosition: container smaller than the menu → pinned at the margin (best effort)", () => {
  assert.deepEqual(clampMenuPosition({ x: 50, y: 25 }, MENU, { width: 100, height: 50 }), {
    x: CONTEXT_MENU_MARGIN,
    y: CONTEXT_MENU_MARGIN,
  });
});

test("clampMenuPosition: custom margin is honored on both axes", () => {
  assert.deepEqual(clampMenuPosition({ x: 5, y: 5 }, { width: 40, height: 20 }, { width: 200, height: 100 }, 10), {
    x: 10,
    y: 10,
  });
});

test("CONTEXT_MENU_MARGIN is a small, non-zero gap (menus hug the cursor but never clip)", () => {
  assert.equal(CONTEXT_MENU_MARGIN, 4);
  assert.ok(CONTEXT_MENU_MARGIN > 0 && CONTEXT_MENU_MARGIN < 10);

// ── Component source contracts (same style as invertScaleColors.test.mjs) ─────

test("menu exposes BOTH existing controls with right-aligned state indicators", () => {
  const code = stripComments(readSrc("src/components/TradingChart/ChartContextMenu.tsx"));
  assert.ok(code.includes('role="menu"'), "semantic menu container");
  assert.ok(code.includes("Invert Scale"), "the existing Invert Scale control");
  assert.ok(code.includes("Auto"), "the existing Auto control");
  // Toggle state is REFLECTED via aria-checked (the ✓ indicator alignment
  // itself lives in CSS) — the component owns neither piece of state.
  assert.ok(code.includes("aria-checked={invertScale}"));
  assert.ok(code.includes("aria-checked={autoFollow}"));
  assert.ok(!code.includes("setInvertScale"), "no duplicated invert-scale state");
  assert.ok(!code.includes("setAutoFollow"), "no duplicated auto-follow state");
});

test("right-click opens the menu and PREVENTS the native browser menu", () => {
  const code = stripComments(readSrc("src/components/TradingChart/ChartContextMenu.tsx"));
  assert.ok(code.includes('addEventListener("contextmenu"'), "right-click is captured on the chart container");
  // The ONLY preventDefault in the file is the native-menu suppression.
  assert.equal((code.match(/preventDefault\(\)/g) || []).length, 1, "exactly one preventDefault");
  const openEffect = code.match(/useEffect\(\(\) => \{\s*const host = containerRef\.current;[\s\S]*?\}, \[containerRef\]\);/);
  assert.ok(openEffect, "contextmenu listener effect present");
  assert.ok(openEffect[0].includes("preventDefault()"), "native browser menu is prevented");
  assert.ok(openEffect[0].includes("clientX") && openEffect[0].includes("clientY"), "anchored at the real cursor");
  assert.ok(openEffect[0].includes("setOpen(true)"), "the custom menu opens");
});

test("menu selection invokes the EXISTING actions and then closes", () => {
  const code = stripComments(readSrc("src/components/TradingChart/ChartContextMenu.tsx"));
  const invert = code.match(/const pickInvertScale = useCallback\(\(\) => \{\s*onToggleInvertScale\?\.\(\);\s*setOpen\(false\);/);
  assert.ok(invert, "Invert Scale item calls the shared action, then closes");
  const auto = code.match(/const pickAuto = useCallback\(\(\) => \{\s*onToggleAutoFollow\?\.\(\);\s*setOpen\(false\);/);
  assert.ok(auto, "Auto item calls the shared action, then closes");
});


test("clicking outside closes the menu WITHOUT blocking chart interaction", () => {
  const code = stripComments(readSrc("src/components/TradingChart/ChartContextMenu.tsx"));
  const outside = code.match(/const onPointerDown = \(e: PointerEvent\): void => \{[\s\S]*?\n    \};/);
  assert.ok(outside, "outside-pointerdown closer present");
  assert.ok(outside[0].includes("menu.contains"), "clicks on the menu itself are ignored");
  assert.ok(!outside[0].includes("preventDefault"), "outside clicks stay native");
  assert.ok(!outside[0].includes("stopPropagation"), "outside clicks still reach the chart");
  assert.ok(outside[0].includes("setOpen(false)"), "outside click closes the menu");
});

test("Escape closes the menu", () => {
  const code = stripComments(readSrc("src/components/TradingChart/ChartContextMenu.tsx"));
  assert.ok(code.includes('e.key === "Escape"'), "Escape handler present");
  assert.ok(code.includes("window.addEventListener(\"keydown\""), "keyboard listener bound while open");
});

test("scope change (timeframe / instrument / replay) closes the menu — no stale state", () => {
  const code = stripComments(readSrc("src/components/TradingChart/ChartContextMenu.tsx"));
  assert.ok(code.includes("}, [scopeKey]);"), "scopeKey change closes the menu");
});

test("menu stays inside the chart bounds: measured size + container-aware clamp", () => {
  const code = stripComments(readSrc("src/components/TradingChart/ChartContextMenu.tsx"));
  assert.ok(code.includes("clampMenuPosition("), "uses the tested pure clamp helper");
  assert.ok(code.includes("offsetWidth") && code.includes("offsetHeight"), "measures the RENDERED menu");
  assert.ok(code.includes("clientWidth") && code.includes("clientHeight"), "measures the chart container");
});

test("presentation-only: the menu never touches candle data, Pine, whitespace or replay state", () => {
  const code = stripComments(readSrc("src/components/TradingChart/ChartContextMenu.tsx"));
  for (const forbidden of ["setData", "updateBar", "getBars", "ReplayController", "setSession", "whitespace", "priceScale"]) {
    assert.ok(!code.includes(forbidden), `context menu must not reference ${forbidden}`);
  }
});


test("TradingChart mounts the menu inside the chart container with shared state", () => {
  const code = stripComments(readSrc("src/components/TradingChart/TradingChart.tsx"));
  assert.ok(code.includes('<div className="chart-canvas-wrap" ref={chartWrapRef}>'), "overlay lives inside the chart wrap");
  assert.ok(code.includes("<ChartContextMenu"), "context menu is mounted");
  assert.ok(code.includes("invertScale={invertScale}"), "reflects the existing invertScale prop");
  assert.ok(code.includes("autoFollow={autoFollow}"), "reflects the existing autoFollow prop");
  assert.ok(code.includes("onToggleInvertScale={onToggleInvertScale}"), "reuses the shared invert action");
  assert.ok(code.includes("onToggleAutoFollow={onToggleAutoFollow}"), "reuses the shared auto action");
  // Replay-aware scope — mirrors the MaStructurePanel resetKey contract:
  assert.ok(code.includes('session ? "replay" : "live"'), "replay enter/exit closes the menu");
});

test("App keeps ONE state source: header controls removed, the context menu drives the shared actions", () => {
  const app = stripComments(readSrc("src/App.tsx"));
  assert.equal(
    (app.match(/setChartSettings\(\(prev\) => \(\{ \.\.\.prev, invertScale: !prev\.invertScale \}\)\)/g) || []).length,
    1,
    "exactly ONE invert-scale mutation — shared, never duplicated",
  );
  assert.ok(app.includes("onToggleInvertScale={toggleInvertScale}"), "context menu uses the shared action");
  assert.equal(
    (app.match(/const \[autoFollow, setAutoFollow\] = useState/g) || []).length,
    1,
    "autoFollow state is declared exactly once — the menu flips the SAME state",
  );
  assert.ok(app.includes("setAutoFollow((prev) => !prev)"), "menu toggle goes through the existing setter");
  assert.ok(app.includes("onToggleAutoFollow={toggleAutoFollow}"), "context menu uses the shared auto action");
  // The old header "Auto" checkbox and "Invert" button are GONE — the right-click
  // context menu is the single home for these toggles (no duplicated UI).
  assert.ok(!app.includes("auto-toggle"), "header Auto checkbox removed");
  assert.ok(!app.includes("invert-toggle"), "header Invert button removed");
  assert.ok(!app.includes('Invert: {chartSettings'), "header Invert ON/OFF label removed");
});

test("styles: compact chart-native menu above every chart overlay", () => {
  const css = readSrc("src/styles.css");
  const block = css.match(/\.chart-context-menu \{[^}]+\}/);
  assert.ok(block, ".chart-context-menu styles exist");
  assert.ok(block[0].includes("position: absolute"), "positioned within .chart-canvas-wrap");
  assert.ok(block[0].includes("z-index: 60"), "above chart chips (5), replay dock (30) and dropdowns (45)");
  assert.ok(block[0].includes("box-shadow"), "small shadow");
  assert.ok(/min-width:\s*190px/.test(block[0]), "compact ~190px width (180–220px band)");
  assert.ok(css.includes('.chart-context-menu-item[aria-checked="true"]'), "checkmark shows only for enabled toggles");
  // Dead styles from the removed header toggles must not linger:
  assert.ok(!css.includes(".invert-toggle"), "removed header Invert button styles cleaned up");
  assert.ok(!css.includes(".auto-toggle"), "removed header Auto checkbox styles cleaned up");
});

});
