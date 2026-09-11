/**
 * Chart templates tests (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * Covers config/chartTemplates.ts — the Settings workflow's save/apply surface:
 *   - the built-in Default template always exists (and is never stored);
 *   - user templates round-trip through localStorage (`aura.chart.templates.v1`);
 *   - Save (upsert) updates an existing user template; Save As mints a SEPARATE
 *     template; duplicate names are refused, never silently overwritten;
 *   - the built-in Default cannot be modified or deleted by ANY operation;
 *   - loading a template restores the complete settings snapshot;
 *   - active-template resolution + dirty tracking behave correctly.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_DEFAULT_TEMPLATE,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_NAME,
  createTemplate,
  deleteTemplate,
  findTemplate,
  isTemplateDirty,
  templateNameExists,
    upsertTemplate,
  CHART_TEMPLATES_STORAGE_KEY,
  allTemplates,
  activeTemplate,
  loadChartTemplates,
  saveChartTemplates,
  templateSettings,
} from "../src/config/chartTemplates.ts";
import {
  defaultChartSettings,
  sanitizeChartSettings,
} from "../src/config/chartSettings.ts";

/** In-memory localStorage stand-in. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    _map: map,
  };
}

// ── built-in Default always exists ────────────────────────────────────────────

test("Default template always exists, even with empty storage", () => {
  const storage = fakeStorage();
  const saved = loadChartTemplates(storage);
  assert.equal(saved.length, 0, "Default is NOT stored in user storage");
  const all = allTemplates(saved);
  assert.equal(all.length, 1, "Default is prepended at read time");
  assert.equal(all[0].id, DEFAULT_TEMPLATE_ID);
  assert.equal(all[0].name, DEFAULT_TEMPLATE_NAME);
  assert.equal(all[0].settings, BUILT_IN_DEFAULT_TEMPLATE.settings);
});

test("Default template is a frozen code constant — never stored, never shadowed", () => {
  assert.equal(Object.isFrozen(BUILT_IN_DEFAULT_TEMPLATE), true, "frozen at the source");
  const storage = fakeStorage({ [CHART_TEMPLATES_STORAGE_KEY]: JSON.stringify([{ id: "default", name: "Default" }]) });
  const all = allTemplates(loadChartTemplates(storage));
  assert.equal(all.filter((t) => t.id === "default").length, 1, "no shadow Default stored");
  assert.deepEqual(all[0].settings, sanitizeChartSettings(null), "constant settings are the default profile");
});

// ── user template creation + persistence ──────────────────────────────────────

test("createTemplate mints an id, timestamps and a sanitized snapshot", () => {
  const base = defaultChartSettings().symbol.candles;
  const settings = { ...defaultChartSettings(), appearance: { theme: "Dracula" }, symbol: { candles: { ...base, upColor: "#112233" } } };
  const tpl = createTemplate("  NY Killzone Setup  ", settings, 1000);
  assert.equal(tpl.id.startsWith("tpl-"), true, "collision-resistant id");
  assert.equal(tpl.name, "NY Killzone Setup", "trimmed");
  assert.equal(tpl.createdAt, 1000);
  assert.equal(tpl.updatedAt, 1000);
  assert.equal(tpl.settings.appearance.theme, "Dracula");
  assert.equal(tpl.settings.symbol.candles.upColor, "#112233");
});

// ── Save (update) vs Save As (new) ───────────────────────────────────────────

test("Save (upsertTemplate) replaces an existing user template IN PLACE — id stable", () => {
  const base = createTemplate("Gold Session", defaultChartSettings(), 100);
  const updated = { ...base, settings: { ...defaultChartSettings(), appearance: { theme: "Nord" } }, updatedAt: 200 };
  const saved = upsertTemplate([base], updated);
  assert.equal(saved.length, 1, "no second entry created");
  assert.equal(saved[0].id, base.id, "stable id");
  assert.equal(saved[0].settings.appearance.theme, "Nord");
  assert.equal(saved[0].updatedAt, 200);
});

test("Save As (upsert as NEW) creates a SEPARATE template (distinct id)", () => {
  const base = createTemplate("Scalping", defaultChartSettings(), 100);
  const asNew = createTemplate("Scalping v2", { ...defaultChartSettings(), appearance: { theme: "Dracula" } }, 200);
  const saved = upsertTemplate([base], asNew);
  assert.equal(saved.length, 2, "two distinct templates now exist");
  const ids = saved.map((t) => t.id);
  assert.equal(new Set(ids).size, 2, "distinct ids");
  assert.notEqual(saved[0].id, saved[1].id);
});

test("duplicate template names are detected (never silently overwritten)", () => {
  const saved = [createTemplate("Gold Session", defaultChartSettings(), 100)];
  assert.equal(templateNameExists(saved, "gold session  "), true, "case + whitespace insensitive");
  assert.equal(templateNameExists(saved, "GOLD SESSION"), true);
  assert.equal(templateNameExists(saved, "Gold  Session"), true, "internal whitespace tolerant");
  assert.equal(templateNameExists(saved, "Gold Session 2"), false);
});

// ── Default immutability under Save / Save As / Delete ────────────────────────

test("Default template CANNOT be overwritten via upsertTemplate", () => {
  const shadow = { ...BUILT_IN_DEFAULT_TEMPLATE, settings: { ...defaultChartSettings(), appearance: { theme: "Dracula" } } };
  const saved = [createTemplate("mine", defaultChartSettings(), 10)];
  const after = upsertTemplate(saved, shadow);
  assert.deepEqual(after, saved, "Default shadow refused, user list untouched");
  assert.equal(allTemplates(after).find((t) => t.id === "default")?.settings.appearance.theme, defaultChartSettings().appearance.theme);
});

test("deleteTemplate CANNOT delete the built-in Default", () => {
  const saved = [
    createTemplate("A", defaultChartSettings(), 1),
    createTemplate("B", defaultChartSettings(), 2),
  ];
  const after = deleteTemplate(saved, DEFAULT_TEMPLATE_ID);
  assert.deepEqual(after, saved, "built-in Default cannot be removed");
  const all = allTemplates(after);
  assert.equal(all.filter((t) => t.id === "default").length, 1, "Default still present for consumers");
});

test("deleting an UNKNOWN user id is a safe no-op", () => {
  const saved = [createTemplate("A", defaultChartSettings(), 1)];
  assert.deepEqual(deleteTemplate(saved, "does-not-exist"), saved);
});

// ── loading restores the complete snapshot / active + dirty ──────────────────

test("activeTemplate falls back to Default for an unknown/deleted template id", () => {
  const saved = [createTemplate("mine", defaultChartSettings(), 1)];
  const dangling = { ...defaultChartSettings(), activeTemplateId: "deleted-id" };
  const active = activeTemplate(saved, dangling);
  assert.equal(active.id, DEFAULT_TEMPLATE_ID, "falls back to the built-in Default");
});

test("isTemplateDirty: false when settings match the active template; true after a change", () => {
  const settings = defaultChartSettings();
  settings.appearance.theme = "Dracula";
  const tpl = createTemplate("mine", settings, 100);
    const eq = (a, b) =>
    JSON.stringify(sanitizeChartSettings(a)) === JSON.stringify(sanitizeChartSettings(b));
  assert.equal(isTemplateDirty(BUILT_IN_DEFAULT_TEMPLATE, defaultChartSettings(), eq), false, "Default vs itself = clean");
  assert.equal(isTemplateDirty(tpl, settings, eq), false, "matches active template = clean");
  const modified = { ...settings, symbol: { candles: { ...settings.symbol.candles, body: false } } };
  assert.equal(isTemplateDirty(tpl, modified, eq), true, "a changed candle flag = dirty");
});

test("loading a template restores the complete settings snapshot via templateSettings", () => {
  const base = defaultChartSettings().symbol.candles;
  const settings = { ...defaultChartSettings(), appearance: { theme: "Nord" }, symbol: { candles: { ...base, upColor: "#aabbcc", body: false } } };
  const tpl = createTemplate("complete", settings, 100);
  const restored = templateSettings(tpl);
  assert.deepEqual(restored, sanitizeChartSettings(settings), "complete snapshot restored, sanitized");
});

test("findTemplate resolves across saved users + the built-in Default", () => {
  const saved = [createTemplate("saved", defaultChartSettings(), 1)];
  assert.equal(findTemplate(saved, "default"), BUILT_IN_DEFAULT_TEMPLATE, "built-in found");
  assert.equal(findTemplate(saved, "missing"), undefined, "missing → undefined");
  const found = findTemplate(saved, saved[0].id);
  assert.equal(found?.id, saved[0].id, "user template found by id");
});

