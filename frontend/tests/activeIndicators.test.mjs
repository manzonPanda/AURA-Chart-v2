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
  removeIndicator,
  setIndicatorVisible,
} from "../src/services/activeIndicators.ts";

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

test("delete: EMA/SMA disable via the existing fixed-slot lifecycle (config kept)", () => {
  const ema = defaultEmaSettings();
  const sma = defaultSmaSettings();
  const p1 = removeIndicator(ema, null, [], "ema20");
  assert.equal(p1.ema.ema20.enabled, false);
  assert.equal(p1.ema.ema20.period, ema.ema20.period, "period preserved for re-enable");
  const p2 = removeIndicator(ema, sma, [], "sma");
  assert.equal(p2.sma.enabled, false);
  assert.equal(p2.sma.color, sma.color);
});

test("delete: no-op returns an empty patch (already disabled / unknown id)", () => {
  const ema = defaultEmaSettings();
  ema.ema9.enabled = false;
  assert.deepEqual(removeIndicator(ema, null, [], "ema9"), {});
  assert.deepEqual(removeIndicator(ema, null, [pine("p1", "A", null)], "ghost"), {});
});

// ── Multiple indicators + state synchronization ────────────────────────────

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
