/**
 * Chart display settings (Invert Scale) tests (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * Covers: defaults, localStorage round-trip, corrupted/partial storage
 * sanitization, and throwing-storage guards. The React side (App) consumes
 * exactly these pure pieces and the InvertScaleBridge applies the resulting
 * value to Lightweight Charts' native price-scale option.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CHART_SETTINGS_STORAGE_KEY,
  defaultChartSettings,
  loadChartSettings,
  sanitizeChartSettings,
  saveChartSettings,
} from "../src/config/chartSettings.ts";

/** In-memory localStorage stand-in (also proves no `window` is required). */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    _map: map,
  };
}

// ── defaults + sanitization ───────────────────────────────────────────────────

test("defaultChartSettings: Invert Scale starts OFF", () => {
  assert.deepEqual(defaultChartSettings(), { invertScale: false });
});

test("sanitizeChartSettings: accepts a valid persisted object; non-boolean fields fall back to defaults", () => {
  assert.deepEqual(sanitizeChartSettings({ invertScale: true }), { invertScale: true });
  assert.deepEqual(sanitizeChartSettings({ invertScale: false }), { invertScale: false });
  assert.deepEqual(sanitizeChartSettings({ invertScale: "yes" }), { invertScale: false });
  assert.deepEqual(sanitizeChartSettings({ invertScale: 1 }), { invertScale: false });
});

test("sanitizeChartSettings: null, arrays and non-objects fall back to defaults", () => {
  assert.deepEqual(sanitizeChartSettings(null), defaultChartSettings());
  assert.deepEqual(sanitizeChartSettings(undefined), defaultChartSettings());
  assert.deepEqual(sanitizeChartSettings([]), defaultChartSettings());
  assert.deepEqual(sanitizeChartSettings("garbage"), defaultChartSettings());
  assert.deepEqual(sanitizeChartSettings(42), defaultChartSettings());
});

// ── localStorage persistence ──────────────────────────────────────────────────

test("saveChartSettings/loadChartSettings round-trips through the storage key", () => {
  const storage = fakeStorage();
  assert.deepEqual(loadChartSettings(storage), defaultChartSettings());
  saveChartSettings({ invertScale: true }, storage);
  assert.equal(storage._map.get(CHART_SETTINGS_STORAGE_KEY), JSON.stringify({ invertScale: true }));
  assert.deepEqual(loadChartSettings(storage), { invertScale: true });
});

test("loadChartSettings: missing storage entry → defaults", () => {
  assert.deepEqual(loadChartSettings(fakeStorage()), { invertScale: false });
});

test("loadChartSettings: corrupted JSON falls back to defaults", () => {
  const storage = fakeStorage({ [CHART_SETTINGS_STORAGE_KEY]: "{not json" });
  assert.deepEqual(loadChartSettings(storage), defaultChartSettings());
});

test("loadChartSettings: wrong-shaped stored value sanitizes per field", () => {
  const storage = fakeStorage({ [CHART_SETTINGS_STORAGE_KEY]: JSON.stringify({ invertScale: "ON" }) });
  assert.deepEqual(loadChartSettings(storage), { invertScale: false });
  const on = fakeStorage({ [CHART_SETTINGS_STORAGE_KEY]: JSON.stringify({ invertScale: true, extra: 1 }) });
  assert.deepEqual(loadChartSettings(on), { invertScale: true }, "unknown fields are ignored, known ones kept");
});

test("loadChartSettings/saveChartSettings survive throwing storage (private mode)", () => {
  const boomGet = { getItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(loadChartSettings(boomGet), defaultChartSettings());
  const boomSet = { getItem: () => null, setItem: () => { throw new Error("blocked"); } };
  assert.doesNotThrow(() => saveChartSettings({ invertScale: true }, boomSet));
});