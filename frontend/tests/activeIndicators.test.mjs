/**
 * Active-indicators legend (upper-left chart overlay) — pure-model tests.
 *
 * The overlay component (ActiveIndicatorsOverlay.tsx) is a thin renderer over
 * services/activeIndicators.ts; these tests pin the model contract the UI
 * depends on: list building/ordering, the settings-id contract (row id ===
 * the id the Indicators menu expands), eye visibility toggling, deletion,
 * multiple indicators, Pine entries, and patch/state synchronization
 * (minimal immutable patches — never a second source of truth).
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { defaultEmaSettings } from "../src/config/emaSettings.ts";
import { defaultSmaSettings } from "../src/config/smaSettings.ts";
import {
  buildActiveIndicatorList,
  listBuiltInOverlayControls,
  listRemovedOverlays,
  removeIndicator,
  setIndicatorActive,
  setIndicatorVisible,
} from "../src/services/activeIndicators.ts";
import { emptyGapHistory, evaluateMaStructure } from "../src/services/movingAverageStructure.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");

/** Minimal imported-Pine fixture (structurally a subset of ImportedPineIndicator). */
function pine(id, name, color, enabled = true) {
  return {
    id,
    name,
    source: `//@version=6\nindicator("${name}")`,
    enabled,
    overlay: true,
    inputs: {},
    inputMeta: [],
    plotMeta: color ? [{ key: "plot", title: "plot", type: "line", color }] : [],
    createdAt: 1_704_153_600_000,
  };
}

// ── List building / ordering ────────────────────────────────────────────────

test("list: EMA slots render first with live period names", () => {
  const ema = defaultEmaSettings();
  ema.ema9.period = 12;
  const rows = buildActiveIndicatorList(ema, undefined, []);
  assert.deepEqual(
    rows.map((r) => [r.id, r.kind, r.name]),
    [
      ["ema9", "ema", "EMA 12"],
      ["ema20", "ema", "EMA 20"],
    ],
  );
  assert.ok(rows.every((r) => r.visible), "default slots are enabled");
  assert.equal(rows[0].color, ema.ema9.color);
});

test("list: deterministic order EMA → SMA → imported Pine", () => {
  const rows = buildActiveIndicatorList(defaultEmaSettings(), defaultSmaSettings(), [
    pine("p2", "Smart Money Concepts", "#ff0000"),
    pine("p1", "VWAP", "#00ff00"),
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["ema9", "ema20", "sma", "p2", "p1"],
  );
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["ema", "ema", "sma", "pine", "pine"],
  );
});

test("list: SMA row only present when configured; name shows the live period", () => {
  const sma = defaultSmaSettings();
  sma.period = 50;
  const rows = buildActiveIndicatorList(defaultEmaSettings(), sma, []);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].name, "SMA 50");
  const withoutSma = buildActiveIndicatorList(defaultEmaSettings(), null, []);
  assert.deepEqual(withoutSma.map((r) => r.id), ["ema9", "ema20"]);
});

test("list: hidden indicators STAY listed (eye state visible while configurable)", () => {
  const ema = defaultEmaSettings();
  ema.ema9.enabled = false;
  const sma = { ...defaultSmaSettings(), enabled: false };
  const rows = buildActiveIndicatorList(ema, sma, [pine("p1", "Hidden Script", null, false)]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.visible]),
    [["ema9", false], ["ema20", true], ["sma", false], ["p1", false]],
  );
});

// ── Settings-id contract (gear opens the EXISTING menu at this id) ─────────

test("settings: row ids are the canonical ids the Indicators menu expands", () => {
  const rows = buildActiveIndicatorList(defaultEmaSettings(), defaultSmaSettings(), [
    pine("abc123", "My Script", null),
  ]);
  // App's handleOpenIndicatorSettings feeds these ids straight into the
  // menu's expandedId — the ids must come from the same key space.
  const menuIds = new Set(["ema9", "ema20", "sma", "abc123"]);
  for (const row of rows) assert.ok(menuIds.has(row.id), `id ${row.id} must be a menu id`);
});

// ── Visibility toggle (eye) ─────────────────────────────────────────────────

test("visibility: hiding EMA 9 changes ONLY enabled — period/color/width preserved", () => {
  const ema = defaultEmaSettings();
  const patch = setIndicatorVisible(ema, null, [], "ema9", false);
  assert.ok(patch.ema && !patch.sma && !patch.pine, "minimal patch touches only the ema slice");
  const next = patch.ema;
  assert.equal(next.ema9.enabled, false);
  assert.equal(next.ema9.period, ema.ema9.period);
  assert.equal(next.ema9.color, ema.ema9.color);
  assert.equal(next.ema9.width, ema.ema9.width);
  assert.equal(next.ema20.enabled, true, "other slot untouched");
  assert.deepEqual(next.ema20, ema.ema20);
});

test("visibility: showing a hidden SMA re-enables it (config preserved)", () => {
  const sma = { ...defaultSmaSettings(), enabled: false, period: 200 };
  const patch = setIndicatorVisible(defaultEmaSettings(), sma, [], "sma", true);
  assert.ok(patch.sma && !patch.ema && !patch.pine);
  assert.equal(patch.sma.enabled, true);
  assert.equal(patch.sma.period, 200);
});

test("visibility: Pine toggle flips only that script's enabled flag", () => {
  const list = [pine("p1", "A", "#111111", true), pine("p2", "B", "#222222", false)];
  const patch = setIndicatorVisible(defaultEmaSettings(), null, list, "p2", true);
  assert.ok(patch.pine && !patch.ema && !patch.sma);
  assert.equal(patch.pine.find((x) => x.id === "p2").enabled, true);
  assert.equal(patch.pine.find((x) => x.id === "p1").enabled, true, "sibling untouched");
  assert.equal(patch.pine.length, 2);
});

test("visibility: no-op returns an EMPTY patch (no state churn)", () => {
  const ema = defaultEmaSettings();
  const list = [pine("p1", "A", null, true)];
  assert.deepEqual(setIndicatorVisible(ema, null, list, "ema9", true), {});
  assert.deepEqual(setIndicatorVisible(ema, null, list, "p1", true), {});
  assert.deepEqual(setIndicatorVisible(ema, null, list, "missing-id", false), {});
  assert.deepEqual(setIndicatorVisible(ema, null, list, "sma", true), {}, "no SMA configured → no-op");
});

// ── Delete ──────────────────────────────────────────────────────────────────

test("delete: Pine indicator is removed from the list; others unaffected", () => {
  const list = [pine("p1", "A", null), pine("p2", "B", null), pine("p3", "C", null)];
  const patch = removeIndicator(defaultEmaSettings(), null, list, "p2");
  assert.ok(patch.pine);
  assert.deepEqual(patch.pine.map((x) => x.id), ["p1", "p3"]);
});

test("delete: EMA/SMA are truly REMOVED (active:false) with their configuration preserved", () => {
  const ema = defaultEmaSettings();
  const sma = defaultSmaSettings();
  const p1 = removeIndicator(ema, null, [], "ema20");
  // `active:false` is what makes the row vanish from the legend entirely.
  assert.equal(p1.ema.ema20.active, false);
  assert.equal(p1.ema.ema20.period, ema.ema20.period, "period preserved for re-adding");
  assert.equal(p1.ema.ema20.color, ema.ema20.color, "color preserved");
  assert.equal(p1.ema.ema20.width, ema.ema20.width, "width preserved");
  const p2 = removeIndicator(ema, sma, [], "sma");
  assert.equal(p2.sma.active, false);
  assert.equal(p2.sma.color, sma.color);
  assert.equal(p2.sma.period, sma.period);
  // A REMOVED slot drops out of the legend — the whole point of the change.
  assert.deepEqual(buildActiveIndicatorList(p1.ema, p2.sma, []).map((r) => r.id), ["ema9"]);
});

test("delete: no-op returns an empty patch (already removed / unknown id)", () => {
  const ema = defaultEmaSettings();
  ema.ema9.active = false;
  assert.deepEqual(removeIndicator(ema, null, [], "ema9"), {});
  assert.deepEqual(removeIndicator(ema, null, [pine("p1", "A", null)], "ghost"), {});
});

// ── PART 13: removable built-ins, re-add, and MA Structure independence ─────

test("remove: each built-in overlay can be removed and leaves the legend entirely", () => {
  let ema = defaultEmaSettings();
  let sma = defaultSmaSettings();
  assert.deepEqual(buildActiveIndicatorList(ema, sma, []).map((r) => r.id), ["ema9", "ema20", "sma"]);

  // Fast EMA removed.
  ema = removeIndicator(ema, sma, [], "ema9").ema;
  assert.deepEqual(buildActiveIndicatorList(ema, sma, []).map((r) => r.id), ["ema20", "sma"]);

  // Slow EMA removed.
  ema = removeIndicator(ema, sma, [], "ema20").ema;
  assert.deepEqual(buildActiveIndicatorList(ema, sma, []).map((r) => r.id), ["sma"]);

  // SMA removed — the whole built-in set is gone.
  sma = removeIndicator(ema, sma, [], "sma").sma;
  assert.deepEqual(buildActiveIndicatorList(ema, sma, []), [], "every built-in can be removed");
});

test("remove: a HIDDEN overlay is still removable (removal is not the eye toggle)", () => {
  let ema = defaultEmaSettings();
  const sma = defaultSmaSettings();
  // Hide first, then remove — both axes are distinct.
  ema = setIndicatorVisible(ema, sma, [], "ema9", false).ema;
  assert.equal(ema.ema9.enabled, false);
  assert.equal(buildActiveIndicatorList(ema, sma, []).find((r) => r.id === "ema9").visible, false);
  ema = removeIndicator(ema, sma, [], "ema9").ema;
  assert.equal(buildActiveIndicatorList(ema, sma, []).some((r) => r.id === "ema9"), false);
});

test("re-add: restores the overlay WITH its preserved period and colour", () => {
  let ema = defaultEmaSettings();
  let sma = defaultSmaSettings();
  ema.ema9.period = 15; // the user's customisation
  ema.ema9.color = "#ff00ff";
  sma.period = 50;

  ema = removeIndicator(ema, sma, [], "ema9").ema;
  sma = removeIndicator(ema, sma, [], "sma").sma;

  // The Indicators menu surfaces them as re-addables, labelled from the
  // PRESERVED configuration (not a reset default).
  assert.deepEqual(listRemovedOverlays(ema, sma), [
    { id: "ema9", kind: "ema", name: "EMA 15", color: "#ff00ff" },
    { id: "sma", kind: "sma", name: "SMA 50", color: sma.color },
  ]);

  const back = setIndicatorActive(ema, sma, true, "ema9");
  assert.equal(back.ema.ema9.active, true);
  assert.equal(back.ema.ema9.enabled, true, "re-added overlays are visible");
  assert.equal(back.ema.ema9.period, 15, "period is NOT reset");
  assert.equal(back.ema.ema9.color, "#ff00ff", "colour is NOT reset");
  assert.equal(back.sma, undefined, "only the touched slice is patched");

  ema = back.ema;
  sma = setIndicatorActive(ema, sma, true, "sma").sma;
  assert.deepEqual(buildActiveIndicatorList(ema, sma, []).map((r) => [r.id, r.name, r.visible]), [
    ["ema9", "EMA 15", true],
    ["ema20", "EMA 20", true],
    ["sma", "SMA 50", true],
  ]);
});

test("re-add: no-op when already active, and Pine ids are never re-addable", () => {
  const ema = defaultEmaSettings();
  const sma = defaultSmaSettings();
  assert.deepEqual(setIndicatorActive(ema, sma, true, "ema9"), {}, "already active+visible");
  assert.deepEqual(setIndicatorActive(ema, sma, true, "p1"), {}, "Pine ids are not re-addable");
  assert.deepEqual(setIndicatorActive(ema, null, true, "sma"), {}, "no SMA configured");
});

test("removing overlays does NOT affect MA Structure (the panel is independent)", () => {
  const ema = defaultEmaSettings();
  const sma = defaultSmaSettings();
  // Wipe every built-in overlay the way a user would.
  let e = removeIndicator(ema, sma, [], "ema9").ema;
  e = removeIndicator(e, sma, [], "ema20").ema;
  const gone = removeIndicator(e, sma, [], "sma").sma;
  assert.deepEqual(buildActiveIndicatorList(e, gone, []), [], "no visible overlays remain");

  // The MA Structure service is pure maths over VALUES — it has no notion of
  // indicator state, so it produces identical output regardless.
  const input = { ema9: 101, ema20: 100, sma20: 99, ts: 1_704_153_600_000, history: emptyGapHistory() };
  const withOverlays = evaluateMaStructure({ ...input, history: emptyGapHistory() });
  const withoutOverlays = evaluateMaStructure({ ...input, history: emptyGapHistory() });
  assert.deepEqual(withoutOverlays.snapshot, withOverlays.snapshot);
  assert.equal(withoutOverlays.snapshot.structure, "BULLISH");
  assert.equal(withoutOverlays.snapshot.relationships.length, 3, "all three pairs still evaluate");
});

test("the MA Structure settings store never imports indicator state", () => {
  // Scan CODE only — doc comments legitimately NAME the symbols deliberately
  // unused. The PANEL may take overlay rows as a control surface, but its
  // persistence layer must stay fully decoupled.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const settings = strip(readSrc("src/services/maStructureSettings.ts"));
  for (const token of ["emaSettings", "smaSettings", "EMA_SLOTS", "EmaConfig", "SmaConfig", "activeIndicators"]) {
    assert.ok(!settings.includes(token), `maStructureSettings must not reference ${token}`);
  }
  // The indicator model never reaches for the panel's calculation.
  for (const f of ["src/services/activeIndicators.ts", "src/config/emaSettings.ts", "src/config/smaSettings.ts"]) {
    const src = strip(readSrc(f));
    assert.ok(!/maStructure|MaStructure/i.test(src), `${f} must not depend on the MA Structure panel`);
  }
});

test("the panel settings popover offers hide/unhide + re-add for the built-in overlays", () => {
  const panel = readSrc("src/components/TradingChart/MaStructurePanel.tsx");
  // Neutral row prop type + intent callbacks (no indicator imports).
  assert.match(panel, /overlays\?: readonly MaOverlayControl\[\]/);
  assert.match(panel, /onToggleOverlay\?: \(id: string, visible: boolean\) => void/);
  assert.match(panel, /onAddOverlay\?: \(id: string\) => void/);
  // Eye for an ACTIVE overlay, "+ Add" for a REMOVED one.
  assert.match(panel, /aria-label=\{`\$\{o\.visible \? "Hide" : "Show"\} \$\{o\.name\} on the chart`\}/);
  assert.match(panel, /aria-label=\{`Add \$\{o\.name\} back to the chart`\}/);
  assert.match(panel, /onClick=\{\(\) => onToggleOverlay\?\.\(o\.id, !o\.visible\)\}/);
  assert.match(panel, /onClick=\{\(\) => onAddOverlay\?\.\(o\.id\)\}/);
  // The chart supplies them through the SAME pure helpers the legend uses.
  const chart = readSrc("src/components/TradingChart/TradingChart.tsx");
  assert.match(chart, /overlays=\{listBuiltInOverlayControls\(emaSettings, smaSettings\)\}/);
  assert.match(chart, /setIndicatorVisible\(emaSettings, smaSettings, pineIndicators \?\? \[\], id, visible\)/);
  assert.match(chart, /setIndicatorActive\(emaSettings, smaSettings, true, id\)/);
});

test("listBuiltInOverlayControls: reports every built-in with BOTH axes", () => {
  const ema = defaultEmaSettings();
  ema.ema20.period = 15;
  const sma = defaultSmaSettings();
  assert.deepEqual(listBuiltInOverlayControls(ema, sma), [
    { id: "ema9", kind: "ema", name: "EMA 9", color: ema.ema9.color, visible: true, active: true },
    { id: "ema20", kind: "ema", name: "EMA 15", color: ema.ema20.color, visible: true, active: true },
    { id: "sma", kind: "sma", name: "SMA 20", color: sma.color, visible: true, active: true },
  ]);

  // Hidden + removed are distinguished.
  const hiddenEma = setIndicatorVisible(ema, sma, [], "ema9", false).ema;
  const removedSma = removeIndicator(hiddenEma, sma, [], "sma").sma;
  const rows = listBuiltInOverlayControls(hiddenEma, removedSma);
  assert.equal(rows.find((r) => r.id === "ema9").visible, false);
  assert.equal(rows.find((r) => r.id === "ema9").active, true, "hidden is still listed");
  assert.equal(rows.find((r) => r.id === "sma").active, false, "removed is not listed");
  assert.equal(rows.find((r) => r.id === "sma").name, "SMA 20", "name from the preserved period");
  // No SMA configured at all → no SMA row (never a phantom control).
  assert.equal(listBuiltInOverlayControls(ema, null).some((r) => r.id === "sma"), false);
});

test("activeIndicators: the added exports exist and keep the immutable-patch contract", () => {
  assert.equal(typeof listRemovedOverlays, "function");
  assert.equal(typeof setIndicatorActive, "function");
  // listRemovedOverlays is a pure read — it never mutates.
  const ema = defaultEmaSettings();
  const before = JSON.stringify(ema);
  listRemovedOverlays(ema, defaultSmaSettings());
  assert.equal(JSON.stringify(ema), before);
  // Removing twice is a no-op (already inactive).
  const once = removeIndicator(ema, defaultSmaSettings(), [], "ema9").ema;
  assert.deepEqual(removeIndicator(once, defaultSmaSettings(), [], "ema9"), {});
});

test("multi: full legend round-trips through toggle+delete without touching other slices", () => {
  const ema0 = defaultEmaSettings();
  const sma0 = defaultSmaSettings();
  const pine0 = [pine("p1", "A", "#101010"), pine("p2", "B", "#202020")];

  // One action at a time — exactly what the overlay's apply() does.
  const s1 = setIndicatorVisible(ema0, sma0, pine0, "ema9", false).ema;
  const s2 = setIndicatorVisible(ema0, s1, pine0, "p2", false).pine;
  const s3 = removeIndicator(ema0, sma0, s2, "p1").pine;

  const rows = buildActiveIndicatorList(s1, sma0, s3);
  assert.deepEqual(
    rows.map((r) => [r.id, r.visible]),
    [["ema9", false], ["ema20", true], ["sma", true], ["p2", false]],
  );
  // The original state objects were never mutated (immutability contract).
  assert.equal(ema0.ema9.enabled, true);
  assert.equal(pine0.length, 2);
  assert.equal(pine0[1].enabled, true); // p2's toggle produced a NEW list
  assert.equal(pine0[0].enabled, true);
});

test("sync: list derivation is a pure read — calling it never mutates state", () => {
  const ema = defaultEmaSettings();
  const sma = defaultSmaSettings();
  const list = [pine("p1", "A", null)];
  const before = JSON.stringify([ema, sma, list]);
  buildActiveIndicatorList(ema, sma, list);
  setIndicatorVisible(ema, sma, list, "ema20", false);
  removeIndicator(ema, sma, list, "p1");
  assert.equal(JSON.stringify([ema, sma, list]), before);
});
