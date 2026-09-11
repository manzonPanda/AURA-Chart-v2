/**
 * Chart settings + templates tests (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * Covers the extended ChartSettings model (invertScale / appearance.theme /
 * symbol.candles / activeTemplateId) and its presentation-only localStorage
 * persistence (`aura.chart.settings.v1`):
 *   - default settings returned when storage is empty;
 *   - invalid/corrupted/wrong-shaped storage falls back safely per field;
 *   - each user-facing field round-trips through storage (theme, the three
 *     candle element toggles, the two candle colors);
 *   - storage errors (private mode) are non-fatal.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CHART_SETTINGS_STORAGE_KEY,
  DEFAULT_CANDLE_DOWN_COLOR,
  DEFAULT_CANDLE_UP_COLOR,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_THEME_ID,
  defaultChartSettings,
  defaultCandleSettings,
  loadChartSettings,
  saveChartSettings,
  sanitizeChartSettings,
} from "../src/config/chartSettings.ts";

/** In-memory localStorage stand-in (also proves no `window` is required). */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    _map: map,
  };
}

// ── defaults ──────────────────────────────────────────────────────────────────

test("defaultChartSettings: invertScale starts OFF, theme/active template defaulted", () => {
  const d = defaultChartSettings();
  assert.equal(d.invertScale, false);
  assert.equal(d.appearance.theme, DEFAULT_THEME_ID);
  assert.equal(d.activeTemplateId, DEFAULT_TEMPLATE_ID);
});

test("defaultCandleSettings: candles enabled with AURA's classic bull/bear palette", () => {
  assert.deepEqual(defaultCandleSettings(), {
    body: true,
    borders: true,
    wick: true,
    upColor: DEFAULT_CANDLE_UP_COLOR,
    downColor: DEFAULT_CANDLE_DOWN_COLOR,
  });
});

test("defaultChartSettings() returns fresh, independent instances", () => {
  const a = defaultChartSettings();
  const b = defaultChartSettings();
  assert.notEqual(a, b, "each call mints a fresh object");
  assert.notEqual(a.symbol.candles, b.symbol.candles, "candle block is nested fresh");
  assert.deepEqual(a, b);
});

// ── sanitization ──────────────────────────────────────────────────────────────

test("sanitizeChartSettings: null/array/non-object → full defaults", () => {
  for (const bad of [null, undefined, [], "garbage", 42, true]) {
    assert.deepEqual(sanitizeChartSettings(bad), defaultChartSettings(), String(bad));
  }
});

test("sanitizeChartSettings: only whitelisted fields are kept, junk is dropped", () => {
  const sanitized = sanitizeChartSettings({
    invertScale: "ON",
    upColor: "red",
    bearishColor: "blue",
    appearance: { theme: 123 },
    symbol: { notCandles: "x" },
  });
       const d = sanitized;
  assert.equal(d.upColor, undefined);
  assert.equal(d.bearishColor, undefined);
});

test("sanitizeChartSettings: a valid full profile is accepted field by field", () => {
  const next = sanitizeChartSettings({
    invertScale: true,
    appearance: { theme: "Dracula" },
    symbol: { candles: { body: false, borders: true, wick: false, upColor: "#ff0000", downColor: "#00ff00" } },
    activeTemplateId: "tpl-xyz",
  });
  assert.equal(next.invertScale, true);
  assert.equal(next.appearance.theme, "Dracula");
  assert.deepEqual(next.symbol.candles, {
    body: false,
    borders: true,
    wick: false,
    upColor: "#ff0000",
    downColor: "#00ff00",
  });
  assert.equal(next.activeTemplateId, "tpl-xyz");
});

test("sanitizeChartSettings: 3-digit and 4-digit hex colors normalize to #rrggbb for the picker", () => {
  const s = sanitizeChartSettings({
    symbol: { candles: { upColor: "#0f0", downColor: "#ff0000ff" } },
  });
  assert.equal(s.symbol.candles.upColor, "#00ff00");
  assert.equal(s.symbol.candles.downColor, "#ff0000");
});

// ── localStorage round-trips (one source of truth per field) ─────────────────

test("saveChartSettings/loadChartSettings round-trip the COMPLETE settings snapshot", () => {
  const storage = fakeStorage();
  assert.deepEqual(loadChartSettings(storage), defaultChartSettings(), "empty → defaults");
  const next = defaultChartSettings();
  next.invertScale = true;
  next.appearance.theme = "Dracula";
  next.symbol.candles.body = false;
  next.symbol.candles.borders = true;
  next.symbol.candles.wick = false;
  next.symbol.candles.upColor = "#aabbcc";
  next.symbol.candles.downColor = "#ddeeff";
  next.activeTemplateId = "tpl-1";
  saveChartSettings(next, storage);
  assert.equal(storage._map.get(CHART_SETTINGS_STORAGE_KEY), JSON.stringify(sanitizeChartSettings(next)));
  assert.deepEqual(loadChartSettings(storage), sanitizeChartSettings(next), "loads back exactly");
});

test("theme selection persists (appearance.theme round-trip)", () => {
  const storage = fakeStorage();
  const s = defaultChartSettings();
  s.appearance.theme = "Nord";
  saveChartSettings(s, storage);
  assert.equal(loadChartSettings(storage).appearance.theme, "Nord");
});

test("candle Body toggle persists", () => {
  const storage = fakeStorage();
  const s = defaultChartSettings();
  s.symbol.candles.body = false;
  saveChartSettings(s, storage);
  assert.equal(loadChartSettings(storage).symbol.candles.body, false);
});

test("candle Borders toggle persists", () => {
  const storage = fakeStorage();
  const s = defaultChartSettings();
  s.symbol.candles.borders = false;
  saveChartSettings(s, storage);
  assert.equal(loadChartSettings(storage).symbol.candles.borders, false);
});

test("candle Wick toggle persists", () => {
  const storage = fakeStorage();
  const s = defaultChartSettings();
  s.symbol.candles.wick = false;
  saveChartSettings(s, storage);
  assert.equal(loadChartSettings(storage).symbol.candles.wick, false);
});

test("candle colors persist", () => {
  const storage = fakeStorage();
  const s = defaultChartSettings();
  s.symbol.candles.upColor = "#112233";
  s.symbol.candles.downColor = "#445566";
  saveChartSettings(s, storage);
  const loaded = loadChartSettings(storage).symbol.candles;
  assert.equal(loaded.upColor, "#112233");
  assert.equal(loaded.downColor, "#445566");
});

test("invertScale and activeTemplateId persist", () => {
  const storage = fakeStorage();
  const s = defaultChartSettings();
  s.invertScale = true;
  s.activeTemplateId = "tpl-active";
  saveChartSettings(s, storage);
  const loaded = loadChartSettings(storage);
  assert.equal(loaded.invertScale, true);
  assert.equal(loaded.activeTemplateId, "tpl-active");
});

// ── corrupted / invalid storage ───────────────────────────────────────────────

test("loadChartSettings: missing storage entry → defaults", () => {
  assert.deepEqual(loadChartSettings(fakeStorage()), defaultChartSettings());
});

test("loadChartSettings: corrupted JSON falls back to defaults", () => {
  const storage = fakeStorage({ [CHART_SETTINGS_STORAGE_KEY]: "{not json" });
  assert.deepEqual(loadChartSettings(storage), defaultChartSettings());
});

test("loadChartSettings: wrong-shaped stored value sanitizes per field", () => {
  const storage = fakeStorage({
    [CHART_SETTINGS_STORAGE_KEY]: JSON.stringify({ invertScale: "ON", upColor: "red", extra: 1 }),
  });
  const loaded = loadChartSettings(storage);
  assert.equal(loaded.invertScale, false, "non-boolean falls back");
  assert.equal(loaded.upColor, undefined, "junk dropped");
  assert.equal(loaded.appearance.theme, DEFAULT_THEME_ID);
  assert.deepEqual(loaded.symbol.candles, defaultCandleSettings());
});

test("loadChartSettings: partially-valid profile keeps the good fields, fills the rest", () => {
  const storage = fakeStorage({
    [CHART_SETTINGS_STORAGE_KEY]: JSON.stringify({ invertScale: true, appearance: { theme: "Solarized" } }),
  });
  const loaded = loadChartSettings(storage);
  assert.equal(loaded.invertScale, true);
  assert.equal(loaded.appearance.theme, "Solarized");
  assert.deepEqual(loaded.symbol.candles, defaultCandleSettings(), "missing candle block defaulted");
  assert.equal(loaded.activeTemplateId, DEFAULT_TEMPLATE_ID);
});

test("saveChartSettings/loadChartSettings survive throwing storage (private mode)", () => {
  const boomGet = { getItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(loadChartSettings(boomGet), defaultChartSettings());
  const boomSet = { getItem: () => null, setItem: () => { throw new Error("blocked"); } };
  assert.doesNotThrow(() => saveChartSettings({ invertScale: true }, boomSet));
});

test("storage key is versioned (aura.chart.settings.v1)", () => {
  assert.equal(CHART_SETTINGS_STORAGE_KEY, "aura.chart.settings.v1");
});

