/**
 * Pine indicator SETTINGS tests — the metadata→control mapping for the
 * Indicator Settings modal's Inputs + Style tabs (TradingView-style), and the
 * render-level style-override contract in PineBridge.
 *
 *   npm --prefix frontend run test
 *
 * Covers the audit's findings:
 *   - input kinds Piner reports vs which the engine accepts as overrides
 *     (int/float/bool/string/color editable; SOURCE now editable via leaf-name
 *     strings; timeframe/symbol/session/enum stay read-only — engine crashes
 *     on changed overrides, verified by tests/probe-inputs.mjs);
 *   - group/tooltip metadata captured and grouped for the Inputs tab;
 *   - style overrides (visible/color/lineWidth) sanitized + applied at render;
 *   - one authoritative config: the modal's drafts route into App's
 *     importedPine slice and PineBridge consumes the SAME record.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  groupPineInputMeta,
  sanitizeInputValue,
  sanitizePinerInput,
} from "../src/services/pineImport.ts";
import {
  isDefaultPlotStyle,
  sanitizeStyleOverrides,
  PINE_PLOT_WIDTHS,
} from "../src/services/pineStyle.ts";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ── metadata: kind → editable/read-only + group/tooltip capture ──────────────

test("sanitizePinerInput: editable kinds keep their type; source defval stays null", () => {
  const m = sanitizePinerInput({ key: "len", kind: "int", default: 20, title: "Length", minval: 1, maxval: 50, step: 1 });
  assert.equal(m.varId, "len");
  assert.equal(m.type, "int");
  assert.equal(m.defval, 20);
  assert.equal(m.minval, 1);

  const src = sanitizePinerInput({ key: "s", kind: "source", default: null, title: "Source" });
  assert.equal(src.type, "source");
  assert.equal(src.defval, null, "source carries no storable default (script's series applies)");
});

test("sanitizePinerInput: group/tooltip metadata is captured (was dropped before)", () => {
  const m = sanitizePinerInput({
    key: "a",
    kind: "int",
    default: 1,
    title: "A",
    group: "Group One",
    tooltip: "The A input",
  });
  assert.equal(m.group, "Group One");
  assert.equal(m.tooltip, "The A input");
});

test("sanitizePinerInput: read-only engine kinds pass through for honest read-only display", () => {
  const tf = sanitizePinerInput({ key: "tf", kind: "timeframe", default: "60", title: "TF" });
  assert.equal(tf.type, "timeframe");
  assert.equal(tf.defval, "60");
  const sy = sanitizePinerInput({ key: "sy", kind: "symbol", default: "AAPL", title: "Sym" });
  assert.equal(sy.type, "symbol");
  const en = sanitizePinerInput({ key: "e", kind: "enum", default: "A", title: "E" });
  assert.equal(en.type, "enum");
});

// ── grouping (Inputs tab → TradingView-style sections) ──────────────────────

test("groupPineInputMeta: ungrouped first, groups in first-appearance order", () => {
  const meta = [
    { varId: "g1", title: "One", type: "int", defval: 1, group: "Group B" },
    { varId: "u1", title: "Ungrouped", type: "int", defval: 2 },
    { varId: "u2", title: "Ungrouped 2", type: "int", defval: 3 },
    { varId: "g2", title: "Two", type: "int", defval: 4, group: "Group A" },
    { varId: "g3", title: "Three", type: "int", defval: 5, group: "Group B" },
  ];
  const groups = groupPineInputMeta(meta);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].group, null, "ungrouped inputs come first");
  assert.deepEqual(groups[0].items.map((m) => m.varId), ["u1", "u2"]);
  assert.equal(groups[1].group, "Group B");
  assert.deepEqual(groups[1].items.map((m) => m.varId), ["g1", "g3"], "same group coalesces, order preserved");
  assert.equal(groups[2].group, "Group A");
  assert.deepEqual(groups[2].items.map((m) => m.varId), ["g2"]);
});

test("groupPineInputMeta: empty input → no groups", () => {
  assert.deepEqual(groupPineInputMeta([]), []);
});

// ── input value sanitization (incl. the newly-editable source kind) ─────────

test("sanitizeInputValue: source accepts only verified leaf-name strings", () => {
  const meta = { varId: "s", title: "S", type: "source", defval: null };
  assert.equal(sanitizeInputValue(meta, "close"), "close");
  assert.equal(sanitizeInputValue(meta, "hlc3"), "hlc3");
  assert.equal(sanitizeInputValue(meta, "ohlc4"), "ohlc4");
  assert.equal(sanitizeInputValue(meta, "bogus_series"), null, "unknown source → fallback (null → omitted)");
  assert.equal(sanitizeInputValue(meta, 5), null, "non-string → fallback");
});

test("sanitizeInputValue: existing kinds still validate", () => {
  const intMeta = { varId: "n", title: "N", type: "int", defval: 10, minval: 1, maxval: 100 };
  assert.equal(sanitizeInputValue(intMeta, 50), 50);
  assert.equal(sanitizeInputValue(intMeta, 500), 100, "clamped to maxval");
  assert.equal(sanitizeInputValue(intMeta, "bad"), 10, "non-number → default");
  const colorMeta = { varId: "c", title: "C", type: "color", defval: "#ff0000" };
  assert.equal(sanitizeInputValue(colorMeta, "#00FF00"), "#00ff00");
  assert.equal(sanitizeInputValue(colorMeta, "red"), "#ff0000", "non-hex → default");
});
// ── style overrides (Style tab → render-time application) ───────────────────

test("sanitizeStyleOverrides: valid overrides pass through; junk drops per-field", () => {
  const clean = sanitizeStyleOverrides({
    "Plot A": { visible: false, color: "#FF0000", lineWidth: 3 },
    "Plot B": { color: "#00ff00" },
    "Plot C": { visible: true, lineWidth: 7, color: "not-a-color", visibleJunk: true },
    "__proto__": { color: "#000000" },
  });
  assert.deepEqual(clean, {
    "Plot A": { visible: false, color: "#ff0000", lineWidth: 3 },
    "Plot B": { color: "#00ff00" },
    // lineWidth 7 clamps to 4; identity visible:true is pruned; bad color drops.
    "Plot C": { lineWidth: 4 },
  });
  // The literal "__proto__" key sets the object's prototype rather than an
  // entry — verify the sanitizer only carries the real plot overrides.
  assert.deepEqual(Object.keys(clean), ["Plot A", "Plot B", "Plot C"]);
});

test("sanitizeStyleOverrides: empty/absent/stale entries → empty map", () => {
  assert.deepEqual(sanitizeStyleOverrides(undefined), {});
  assert.deepEqual(sanitizeStyleOverrides(null), {});
  assert.deepEqual(sanitizeStyleOverrides("nope"), {});
  assert.deepEqual(sanitizeStyleOverrides({ Plot: { color: "red" } }), {}, "non-hex color drops the key");
});

test("isDefaultPlotStyle: identity is default; any real override is not", () => {
  assert.equal(isDefaultPlotStyle(undefined), true);
  assert.equal(isDefaultPlotStyle({}), true);
  assert.equal(isDefaultPlotStyle({ visible: true }), true);
  assert.equal(isDefaultPlotStyle({ visible: false }), false);
  assert.equal(isDefaultPlotStyle({ color: "#ff0000" }), false);
  assert.equal(isDefaultPlotStyle({ lineWidth: 2 }), false);
});

test("PINE_PLOT_WIDTHS offers the same 1–4 widths as the EMA/SMA modal", () => {
  assert.deepEqual(PINE_PLOT_WIDTHS, [1, 2, 3, 4]);
});
// ── wiring contracts (source-level, same style as the other .test.mjs) ──────

test("modal: source inputs render a price-source dropdown with Default (script)", () => {
  const code = stripComments(readSrc("src/components/Indicators/IndicatorSettingsModal.tsx"));
  assert.ok(code.includes('case "source":'), "source input gets its own control");
  assert.ok(code.includes("Default (script)"), "script default is a first-class option");
  assert.ok(code.includes("PRICE_SOURCES.map"), "the dropdown is driven by AURA's existing PRICE_SOURCES");
  assert.ok(code.includes("PRICE_SOURCE_LABEL[s]"), "existing source labels reused");
});

test("modal: grouped Inputs tab + Defaults reset + per-plot Style rows + style in Apply", () => {
  const code = stripComments(readSrc("src/components/Indicators/IndicatorSettingsModal.tsx"));
  assert.ok(code.includes("groupPineInputMeta("), "Inputs tab groups by the script's group metadata");
  assert.ok(code.includes('className="iset-group-title"'), "group header rendered");
  assert.ok(code.includes("resetPineDefaults"), "Defaults restores script defaults");
  assert.ok(code.includes("sanitizeInputValue(m, undefined)"), "Defaults rebuilds the import-time input shape");
  assert.ok(code.includes("inputs: pineInputs ?? {}, style: pineStyle ?? {}"), "Apply carries style overrides");
  assert.ok(code.includes("aria-label={`${p.title} visibility`}"), "Style rows expose visibility toggle");
  assert.ok(code.includes("PINE_PLOT_WIDTHS.map"), "Style rows expose the shared width options");
});

test("PineBridge: renderer consumes style overrides at series creation/paint", () => {
  const code = stripComments(readSrc("src/components/TradingChart/PineBridge.tsx"));
  assert.ok(code.includes("style[ident]"), "bridge reads the override map per visual key");
  assert.ok(code.includes("override?.visible === false"), "hidden plots are skipped");
  assert.ok(code.includes("resolveStyle("), "override-resolved color/width");
  assert.ok(code.includes("stripColor"), "uniform color override strips per-bar script colors");
  assert.ok(code.includes("st.styleSigRef"), "style-change-only series re-create");
  assert.ok(code.includes("ind.style ?? EMPTY_STYLE"), "bridge applies the SAME record the modal edits");
});

test("App: settings Apply routes style overrides into the existing indicator record", () => {
  const app = stripComments(readSrc("src/App.tsx"));
  assert.ok(app.includes("inputs: next.inputs"), "inputs still routed");
  assert.ok(app.includes("merged.style = next.style"), "style overrides routed alongside");
  assert.ok(app.includes("if (x.id !== next.id) return x;"), "map-replace preserves instance + order");
  assert.ok(app.includes("delete"), "empty style is dropped so cleared overrides truly reset");
});