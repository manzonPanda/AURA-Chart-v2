/**
 * MA STRUCTURE PANEL VISIBILITY — preference + toggle wiring tests.
 * Runs with Node's type stripping:  npm --prefix frontend run test
 *
 * Two layers, matching the repo's existing test architecture:
 *
 *  1. BEHAVIOUR (pure, no DOM) — the REAL
 *     `services/maStructureVisibility.ts` helpers against an injectable
 *     storage. Node's strip-types loader cannot import a `.tsx` file
 *     (`Unknown file extension ".tsx"`), which is why every other
 *     component-level suite here (chartContextMenu, invertScaleColors,
 *     timeScaleRightSpace, pineSettings) asserts wiring via source contracts.
 *
 *  2. WIRING (source contracts) — the panel is a pure visibility switch:
 *     a native <button> hide control in the header, a compact restore control
 *     when hidden, contents UNMOUNTED (not made transparent), and no reachable
 *     path from the toggle to candles / indicators / timeframe / viewport /
 *     websocket.
 *
 * Mandated matrix:
 *   1. Default state is visible
 *   2. Stored false loads as hidden
 *   3. Stored true loads as visible
 *   4. Invalid / missing storage value falls back to visible
 *   5. Clicking the toggle changes visibility
 *   6. Clicking restore makes the panel visible again
 *   7. Toggling does not alter chart / timeframe / data state
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MA_STRUCTURE_VISIBILITY_STORAGE_KEY,
  MA_STRUCTURE_VISIBLE_BY_DEFAULT,
  sanitizeMaStructureVisible,
  loadMaStructureVisible,
  saveMaStructureVisible,
  toggleMaStructureVisible,
} from "../src/services/maStructureVisibility.ts";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read a project source file relative to frontend/. */
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");

/** Strip block + line comments so guards evaluate CODE only. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const PANEL = stripComments(readSrc("src/components/TradingChart/MaStructurePanel.tsx"));
const TRADING_CHART = stripComments(readSrc("src/components/TradingChart/TradingChart.tsx"));
const CHART_SETTINGS = stripComments(readSrc("src/config/chartSettings.ts"));
/** Stylesheet with its `/* … *\/` banners removed so a rule's captured selector
 *  text is the selector itself (not the comment that precedes it). */
const CSS = readSrc("src/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** In-memory storage, optionally throwing (private-mode simulation). */
const memStorage = (init = {}, throwOn = false) => {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    getItem: (k) => {
      if (throwOn) throw new Error("denied");
      return m.has(k) ? m.get(k) : null;
    },
    setItem: (k, v) => {
      if (throwOn) throw new Error("denied");
      m.set(k, v);
    },
  };
};

/**
 * Parse the stylesheet into `{ selector, body }` rules. `@media` preludes are
 * dropped so a media-scoped duplicate can never be mistaken for the base rule
 * (the width ladder redefines `.ma-structure` at ≤1100px).
 */
const cssRules = () =>
  [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] }))
    .filter((r) => !r.selector.startsWith("@"));

/** Declarations of the rule whose selector list matches EXACTLY `selector`. */
const cssRule = (selector) => {
  const rules = cssRules().filter((r) => r.selector === selector);
  assert.ok(rules.length > 0, `CSS rule not found: ${selector}`);
  return rules[0].body;
};

/** Every declaration in the rules whose selector list contains `selector`. */
const cssRulesFor = (selector) =>
  cssRules()
    .filter((r) => r.selector.split(",").map((s) => s.trim()).includes(selector))
    .map((r) => r.body)
    .join("\n");

// ── 1. Default state is visible ───────────────────────────────────────────────

test("1. default state is VISIBLE — nothing stored, and the default constant says so", () => {
  assert.equal(MA_STRUCTURE_VISIBLE_BY_DEFAULT, true);
  assert.equal(loadMaStructureVisible(memStorage({})), true);
  assert.equal(loadMaStructureVisible(memStorage({ [MA_STRUCTURE_VISIBILITY_STORAGE_KEY]: null })), true);
});

test("1b. the preference uses the dedicated versioned key, NOT ChartSettings", () => {
  assert.equal(MA_STRUCTURE_VISIBILITY_STORAGE_KEY, "aura.ma.structure.visibility.v1");
  // ChartSettings is TEMPLATE state (templates snapshot the whole object), so
  // the panel-visibility flag must never land there.
  assert.ok(!CHART_SETTINGS.includes(MA_STRUCTURE_VISIBILITY_STORAGE_KEY));
  assert.ok(!/maStructureVisible|maStructureVisibility/i.test(CHART_SETTINGS));
});

// ── 2 / 3. Stored false → hidden, stored true → visible ──────────────────────

test("2. stored false loads as HIDDEN", () => {
  assert.equal(loadMaStructureVisible(memStorage({ [MA_STRUCTURE_VISIBILITY_STORAGE_KEY]: "false" })), false);
});

test("3. stored true loads as VISIBLE", () => {
  assert.equal(loadMaStructureVisible(memStorage({ [MA_STRUCTURE_VISIBILITY_STORAGE_KEY]: "true" })), true);
});

test("2b/3b. the sanitizer accepts both bare and JSON boolean forms", () => {
  assert.equal(sanitizeMaStructureVisible("false"), false);
  assert.equal(sanitizeMaStructureVisible('"false"'), false);
  assert.equal(sanitizeMaStructureVisible("  FALSE  "), false); // trim + lowercase
  assert.equal(sanitizeMaStructureVisible("true"), true);
  assert.equal(sanitizeMaStructureVisible('"true"'), true);
  assert.equal(sanitizeMaStructureVisible(true), true);
  assert.equal(sanitizeMaStructureVisible(false), false);
});

// ── 4. Invalid / missing storage falls back to visible ────────────────────────

test("4. invalid or missing storage values fall back to VISIBLE (never a guess)", () => {
  const bad = ["", " ", "0", "1", "yes", "no", "maybe", "{}", "null", "undefined", '"nope"', "[false]", 123, 0, 1, {}, [], null, undefined];
  for (const value of bad) {
    assert.equal(sanitizeMaStructureVisible(value), true, `expected ${String(value)} to fall back to visible`);
  }
});

test("4b. a throwing storage (private mode / disabled) falls back to VISIBLE", () => {
  assert.equal(loadMaStructureVisible(memStorage({}, true)), true);
  assert.doesNotThrow(() => loadMaStructureVisible(memStorage({}, true)));
});

test("4c. a corrupted payload cannot break the panel", () => {
  for (const raw of ["{oops", "[", "undefined", "NaN"]) {
    assert.equal(loadMaStructureVisible(memStorage({ [MA_STRUCTURE_VISIBILITY_STORAGE_KEY]: raw })), true);
  }
});

// ── 5 / 6. Hide persists false, restore persists true ─────────────────────────

test("5/6. hide persists false and restore persists true (guarded round-trip)", () => {
  const store = memStorage({});

  saveMaStructureVisible(false, store); // user clicks the header eye
  assert.equal(store.map.get(MA_STRUCTURE_VISIBILITY_STORAGE_KEY), "false");
  assert.equal(loadMaStructureVisible(store), false);

  saveMaStructureVisible(true, store); // user clicks the restore control
  assert.equal(store.map.get(MA_STRUCTURE_VISIBILITY_STORAGE_KEY), "true");
  assert.equal(loadMaStructureVisible(store), true);
});

test("5b/6b. save writes ONLY the dedicated key and never throws when denied", () => {
  const store = memStorage({ "aura.chart.settings.v1": "{}", "aura.chart.templates.v1": "[]" });
  saveMaStructureVisible(false, store);
  saveMaStructureVisible(true, store);
  assert.deepEqual(
    [...store.map.keys()],
    ["aura.chart.settings.v1", "aura.chart.templates.v1", MA_STRUCTURE_VISIBILITY_STORAGE_KEY],
  );
  assert.doesNotThrow(() => saveMaStructureVisible(false, memStorage({}, true)));
});

test("5c. the toggle flip itself: visible ⇒ hide, hidden ⇒ show", () => {
  assert.equal(toggleMaStructureVisible(true), false);
  assert.equal(toggleMaStructureVisible(false), true);
  // Total + involutive: two clicks always land back on the original state.
  assert.equal(toggleMaStructureVisible(toggleMaStructureVisible(true)), true);
  assert.doesNotThrow(() => toggleMaStructureVisible(undefined));
});

test("5d/6d. FULL LIFECYCLE — first visit visible → hide → reload hidden → restore → reload visible", () => {
  const store = memStorage({});

  // A harness mirroring the component's exact wiring: a lazy
  // useState(loadMaStructureVisible) initialiser, a PURE
  // toggleMaStructureVisible updater, and a save that fires only on a real
  // change. `click()` is the button's onClick; `mount()` is a fresh page load.
  const mount = () => {
    const state = { visible: loadMaStructureVisible(store) };
    return {
      state,
      click: () => {
        const next = toggleMaStructureVisible(state.visible); // pure updater
        if (next !== state.visible) saveMaStructureVisible(next, store);
        state.visible = next;
      },
    };
  };

  // 1st mount, nothing stored → panel is shown.
  let panel = mount();
  assert.equal(panel.state.visible, true);

  // User clicks the header eye → hidden, and false is persisted.
  panel.click();
  assert.equal(panel.state.visible, false);
  assert.equal(store.map.get(MA_STRUCTURE_VISIBILITY_STORAGE_KEY), "false");

  // Reload the page (fresh mount) → still hidden. No chart reload happened;
  // only this panel's visibility was remembered.
  panel = mount();
  assert.equal(panel.state.visible, false);

  // User clicks the restore control → visible again, true persisted.
  panel.click();
  assert.equal(panel.state.visible, true);
  assert.equal(store.map.get(MA_STRUCTURE_VISIBILITY_STORAGE_KEY), "true");

  // Reload → visible.
  assert.equal(mount().state.visible, true);
});

// ── Wiring: native buttons, contents UNMOUNTED ───────────────────────────────

test("wiring: the header carries a native <button> hide control with a11y name + tooltip", () => {
  assert.match(PANEL, /<button\s+type="button"\s+className="ma-structure-toggle"/);
  assert.match(PANEL, /aria-label="Hide Moving Average Structure"/);
  assert.match(PANEL, /title="Hide Moving Average Structure"/);
  assert.match(PANEL, /aria-pressed=\{true\}/); // keyboard-reachable + state announced
});

test("wiring: hidden state renders a compact native restore control", () => {
  assert.match(PANEL, /<button\s+type="button"\s+className="ma-structure-restore"/);
  assert.match(PANEL, /aria-label="Show Moving Average Structure"/);
  assert.match(PANEL, /title="Show Moving Average Structure"/);
  assert.match(PANEL, /aria-pressed=\{false\}/);
  assert.match(PANEL, /<EyeOffIcon \/>/); // an icon, not a large button
});

test("wiring: hidden state UNMOUNTS the contents instead of making them transparent", () => {
  const guard = PANEL.indexOf("if (!visible) {");
  const collapsed = PANEL.indexOf("ma-structure--collapsed");
  const snapshot = PANEL.indexOf("const { snapshot } = evaluation;");
  const title = PANEL.indexOf("MOVING AVERAGE STRUCTURE");
  assert.notEqual(guard, -1, "missing the hidden early return");
  assert.ok(guard < collapsed, "collapsed shell must be inside the hidden branch");
  assert.ok(collapsed < snapshot, "hidden branch returns before the panel body is rendered");
  assert.ok(snapshot < title, "the full panel title renders only in the visible branch");

  // No opacity / visibility / display trick is used to "hide" the panel.
  for (const trick of [/opacity:\s*0/, /visibility:\s*hidden/, /display:\s*"none"/]) {
    assert.ok(!trick.test(PANEL), `hidden state must unmount, not use ${trick}`);
  }
});

test("wiring: visibility state is NOT an input to the MA derivation", () => {
  // The useMemo computing EMA9/EMA20/SMA20 keeps its original deps, so a toggle
  // cannot trigger an indicator recalculation.
  assert.match(PANEL, /\}, \[bars, liveCandle, bucketSec\]\);/);
  // Only the persist effect observes `visible`.
  assert.match(PANEL, /saveMaStructureVisible\(visible\);[\s\S]{0,40}\}, \[visible\]\);/);
});

// ── 7. Toggling does not alter chart / timeframe / data state ─────────────────

test("7a. the toggle path can reach no chart, data, timeframe or websocket API", () => {
  const forbidden = [
    "setData(",
    "applyOptions(",
    "addCandlestickSeries",
    "scrollToRealTime",
    "subscribeCrosshairMove",
    "timeFrame()",
    "priceScale(",
    "new WebSocket",
    "fetch(",
  ];
  for (const token of forbidden) {
    assert.ok(!PANEL.includes(token), `panel must not touch ${token}`);
  }
  // The click handlers do exactly two things: keep the chart from seeing the
  // press, and flip visibility.
  const handlers = PANEL.match(/onClick=\{\(e\) => \{[\s\S]*?\}\}/g) ?? [];
  assert.equal(handlers.length, 2, "expected exactly the hide + restore click handlers");
  for (const h of handlers) {
    assert.match(h, /e\.stopPropagation\(\);/);
    assert.match(h, /toggleVisible\(\);/);
  }
});

test("7b. no preventDefault — mouse and touch activation stay native", () => {
  assert.ok(!PANEL.includes("preventDefault"), "panel must never preventDefault");
  // Both controls stop the press reaching the chart (a pointerdown would
  // otherwise pan the plot or start a replay candle-pick).
  assert.equal((PANEL.match(/onPointerDown=\{stopChartPointer\}/g) ?? []).length, 2);
  assert.equal((PANEL.match(/onDoubleClick=\{stopChartPointer\}/g) ?? []).length, 2);
  assert.match(PANEL, /const stopChartPointer = \(e: \{ stopPropagation: \(\) => void \}\): void => \{/);
});

test("7c. TradingChart wiring is unchanged — same props, no visibility prop, no remount", () => {
  const mount = TRADING_CHART.match(/<MaStructurePanel[\s\S]*?\/>/);
  assert.ok(mount, "MaStructurePanel mount not found");
  for (const prop of [
    "bars={visibleBars}",
    "liveCandle={session ? null : liveCandle}",
    "bucketSec={bucketSec}",
    "replayActive={session !== null}",
    "resetKey=",
    "rightInset={priceScaleInset}",
  ]) {
    assert.ok(mount[0].includes(prop), `missing existing prop ${prop}`);
  }
  // Visibility is panel-local: no prop and no key (a key change would remount
  // the chart subtree), and no App-level plumbing was introduced.
  assert.ok(!/visible=|hidden=|showMa/i.test(mount[0]));
  assert.ok(!/<MaStructurePanel[^>]*\bkey=/.test(mount[0]));
});

test("7d. the panel still exposes the same live region and unchanged content", () => {
  assert.match(PANEL, /role="status"/);
  assert.match(PANEL, /aria-label="Moving Average Structure"/);
  for (const text of ["CURRENT STRUCTURE", "LIVE RELATIONSHIPS", "EMA9 • EMA20 • SMA20", "SLOPE"]) {
    assert.ok(PANEL.includes(text), `panel content changed — missing ${text}`);
  }
});

test("7e. the toggle reuses the chart's EXISTING eye iconography, out of the a11y tree", () => {
  assert.match(PANEL, /function EyeIcon\(\)/);
  assert.match(PANEL, /function EyeOffIcon\(\)/);
  const EYE_PATH = "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z";
  assert.ok(PANEL.includes(EYE_PATH), "eye path diverged from the shared icon");
  assert.ok(
    readSrc("src/components/TradingChart/ActiveIndicatorsOverlay.tsx").includes(EYE_PATH),
    "shared eye path missing from the indicator legend",
  );
  // Decorative glyphs — the accessible name lives on the host button.
  assert.match(PANEL, /<EyeIcon \/>\s*<\/button>/);
});

// ── Visual language: compact, subtle, dark-theme, non-interfering ────────────
test("visual: the panel container still ignores pointer events; only buttons re-enable them", () => {
  assert.match(cssRule(".ma-structure"), /pointer-events: none;/);
  const controls = cssRulesFor(".ma-structure-toggle");
  assert.match(controls, /pointer-events: auto;/);
  assert.match(controls, /touch-action: manipulation;/); // touch: no 300ms tap delay
  assert.match(controls, /cursor: pointer;/);
  assert.match(controls, /background: transparent;/);
  assert.match(controls, /color: var\(--muted\);/); // subtle, not a primary button
});

test("visual: the toggle is compact and visually secondary to the title", () => {
  const toggle = cssRule(".ma-structure-toggle");
  assert.match(toggle, /width: 16px;/);
  assert.match(toggle, /height: 16px;/);
  assert.match(toggle, /flex: none;/);
  // Hover/focus tints with the EXISTING accent token — never a bright primary.
  const hover = cssRulesFor(".ma-structure-toggle:focus-visible");
  assert.match(hover, /color: var\(--accent\);/);
  assert.match(hover, /background: var\(--accent-soft\);/);
  // The badge keeps its own rules (unchanged LIVE / REPLAY colours).
  assert.match(cssRule(".ma-structure-badge.live"), /color: var\(--up\);/);
  assert.match(cssRule(".ma-structure-badge.replay"), /color: var\(--ck-warn\);/);
});

test("visual: the hidden shell drops the card chrome and keeps the panel's anchor", () => {
  const collapsed = cssRule(".ma-structure--collapsed");
  assert.match(collapsed, /background: none;/);
  assert.match(collapsed, /border: 0;/);
  assert.match(collapsed, /box-shadow: none;/);
  assert.match(collapsed, /padding: 0;/);
  assert.match(collapsed, /top: 44px;/); // same anchor row as the panel header
});

test("visual: the restore control stays unobtrusive and on-theme", () => {
  const restore = cssRule(".ma-structure-restore");
  assert.match(restore, /height: 20px;/);
  assert.match(restore, /border-radius: 5px;/);
  assert.match(restore, /opacity: 0\.75;/);
  assert.ok(
    !/linear-gradient|background: var\(--accent\);/.test(restore),
    "restore must not read as a primary button",
  );
  assert.match(cssRule(".ma-structure-restore-label"), /font-size: 0\.55rem;/);
  assert.match(cssRule(".ma-structure-restore-label"), /letter-spacing: 0\.1em;/);
});

test("visual: the header groups badge + eye without redesigning the panel", () => {
  assert.match(PANEL, /<span className="ma-structure-head-right">/);
  assert.match(PANEL, /ma-structure-badge \$\{replayActive \? "replay" : "live"\}/);
  // The space-between row and the title's typography are untouched.
  assert.match(cssRule(".ma-structure-head"), /justify-content: space-between;/);
  assert.match(cssRule(".ma-structure-head-right"), /display: inline-flex;/);
  assert.match(cssRule(".ma-structure-head-right"), /flex: none;/);
  assert.match(
    CSS,
    /\.ma-structure-title \{ color: var\(--accent\); font-size: 0\.6rem; font-weight: 800; letter-spacing: 0\.12em; \}/,
  );
});
