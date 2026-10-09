/**
 * MA STRUCTURE SETTINGS — panel periods + title persistence (Node
 * type-stripping runner):  npm --prefix frontend run test
 *
 * The PANEL's own configuration (title + its OWN structural EMA/SMA periods),
 * persisted in `aura.ma.structure.settings.v1` — a dedicated key, deliberately
 * NOT ChartSettings (template state) and NOT the visibility key.
 *
 * Also pins the INDEPENDENCE contract that matters most: these periods drive
 * the panel's own `calculateEMA` / `calculateSMA`, never the visible chart
 * overlays, so the engine's DISPLAY labels follow the settings while every
 * structural identity, gap-history key and calculation stays untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MA_STRUCTURE_TITLE,
  MA_STRUCTURE_SETTINGS_STORAGE_KEY,
  MAX_MA_STRUCTURE_TITLE_LENGTH,
  defaultMaStructureSettings,
  loadMaStructureSettings,
  maSeriesLabel,
  maStructureSettingsEqual,
  sanitizeMaStructureSettings,
  sanitizeMaStructureTitle,
  saveMaStructureSettings,
} from "../src/services/maStructureSettings.ts";
import { MA_STRUCTURE_VISIBILITY_STORAGE_KEY } from "../src/services/maStructureVisibility.ts";
import { MAX_EMA_PERIOD } from "../src/services/ema.ts";
import { MAX_SMA_PERIOD } from "../src/services/sma.ts";
import {
  emptyGapHistory,
  evaluateMaStructure,
  resolveSeriesLabel,
  structureOrderLabel,
} from "../src/services/movingAverageStructure.ts";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");
/** Strip block + line comments so independence scans evaluate CODE only —
 *  a doc comment that NAMES a forbidden symbol must not trip the guard. */
const readCode = (rel) => readSrc(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

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

// ── 1. Defaults ──────────────────────────────────────────────────────────────

test("1. default MA Structure settings are 9 / 20 / 20 with the standard title", () => {
  assert.deepEqual(defaultMaStructureSettings(), {
    title: "Moving Average Structure",
    emaFastPeriod: 9,
    emaSlowPeriod: 20,
    smaPeriod: 20,
  });
  assert.equal(MA_STRUCTURE_SETTINGS_STORAGE_KEY, "aura.ma.structure.settings.v1");
  assert.equal(loadMaStructureSettings(memStorage({})).emaFastPeriod, 9);
});

// ── 2. Valid settings load ───────────────────────────────────────────────────

test("2. valid settings load exactly", () => {
  const store = memStorage({
    [MA_STRUCTURE_SETTINGS_STORAGE_KEY]: JSON.stringify({
      title: "AURA MA Structure",
      emaFastPeriod: 8,
      emaSlowPeriod: 21,
      smaPeriod: 50,
    }),
  });
  assert.deepEqual(loadMaStructureSettings(store), {
    title: "AURA MA Structure",
    emaFastPeriod: 8,
    emaSlowPeriod: 21,
    smaPeriod: 50,
  });
});

// ── 3. Invalid title falls back ──────────────────────────────────────────────

test("3. an invalid title falls back to the default, and casing is preserved", () => {
  assert.equal(sanitizeMaStructureTitle("   "), DEFAULT_MA_STRUCTURE_TITLE);
  assert.equal(sanitizeMaStructureTitle(""), DEFAULT_MA_STRUCTURE_TITLE);
  assert.equal(sanitizeMaStructureTitle(null), DEFAULT_MA_STRUCTURE_TITLE);
  assert.equal(sanitizeMaStructureTitle(42), DEFAULT_MA_STRUCTURE_TITLE);
  assert.equal(sanitizeMaStructureTitle({}), DEFAULT_MA_STRUCTURE_TITLE);
  assert.equal(sanitizeMaStructureTitle("  AURA   MA  "), "AURA MA", "inner whitespace collapses");
  assert.equal(sanitizeMaStructureTitle("x".repeat(200)).length, MAX_MA_STRUCTURE_TITLE_LENGTH);
  // Stored verbatim — the UPPERCASE header is a CSS transform, not the value.
  assert.equal(sanitizeMaStructureTitle("aura ma structure"), "aura ma structure");
});
// ── 4/5/6/7. Invalid periods fall back individually ──────────────────────────

test("4. invalid EMA periods fall back to the defaults (per field)", () => {
  for (const bad of [0, -1, -20, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "12", null, undefined, {}]) {
    const out = sanitizeMaStructureSettings({ emaFastPeriod: bad, emaSlowPeriod: bad });
    assert.equal(out.emaFastPeriod, 9, `fast rejected: ${String(bad)}`);
    assert.equal(out.emaSlowPeriod, 20, `slow rejected: ${String(bad)}`);
  }
});

test("5. negative periods are rejected", () => {
  const out = sanitizeMaStructureSettings({ emaFastPeriod: -5, emaSlowPeriod: -1, smaPeriod: -99 });
  assert.deepEqual([out.emaFastPeriod, out.emaSlowPeriod, out.smaPeriod], [9, 20, 20]);
});

test("6. zero periods are rejected", () => {
  const out = sanitizeMaStructureSettings({ emaFastPeriod: 0, emaSlowPeriod: 0, smaPeriod: 0 });
  assert.deepEqual([out.emaFastPeriod, out.emaSlowPeriod, out.smaPeriod], [9, 20, 20]);
});

test("7. non-numeric periods are rejected", () => {
  const out = sanitizeMaStructureSettings({ emaFastPeriod: "20", emaSlowPeriod: true, smaPeriod: [] });
  assert.deepEqual([out.emaFastPeriod, out.emaSlowPeriod, out.smaPeriod], [9, 20, 20]);
});

test("7b. bounds match the chart overlays' own limits (no artificial narrowing)", () => {
  // The panel reuses isValidEmaPeriod / isValidSmaPeriod — same 1..500 / 1..1000.
  assert.equal(sanitizeMaStructureSettings({ emaFastPeriod: 1 }).emaFastPeriod, 1);
  assert.equal(sanitizeMaStructureSettings({ emaFastPeriod: MAX_EMA_PERIOD }).emaFastPeriod, MAX_EMA_PERIOD);
  assert.equal(sanitizeMaStructureSettings({ emaFastPeriod: MAX_EMA_PERIOD + 1 }).emaFastPeriod, 9);
  assert.equal(sanitizeMaStructureSettings({ smaPeriod: MAX_SMA_PERIOD }).smaPeriod, MAX_SMA_PERIOD);
  assert.equal(sanitizeMaStructureSettings({ smaPeriod: MAX_SMA_PERIOD + 1 }).smaPeriod, 20);
});

test("7c. one bad field never discards the good ones", () => {
  const out = sanitizeMaStructureSettings({
    title: "My Structure",
    emaFastPeriod: 8,
    emaSlowPeriod: -3,
    smaPeriod: 50,
  });
  assert.equal(out.title, "My Structure");
  assert.equal(out.emaFastPeriod, 8, "valid fast kept");
  assert.equal(out.emaSlowPeriod, 20, "invalid slow fell back on its own");
  assert.equal(out.smaPeriod, 50, "valid SMA kept");
});

// ── 8. Save / load round-trip ────────────────────────────────────────────────

test("8. settings survive a save → load round-trip", () => {
  const store = memStorage({});
  const next = { title: "AURA MA Structure", emaFastPeriod: 8, emaSlowPeriod: 21, smaPeriod: 50 };
  saveMaStructureSettings(next, store);
  assert.deepEqual(JSON.parse(store.map.get(MA_STRUCTURE_SETTINGS_STORAGE_KEY)), next);
  assert.deepEqual(loadMaStructureSettings(store), next);
});

test("8b. malformed / denied storage degrades to defaults without throwing", () => {
  for (const raw of ["{oops", "[", "", "null", "undefined", "NaN"]) {
    assert.deepEqual(
      loadMaStructureSettings(memStorage({ [MA_STRUCTURE_SETTINGS_STORAGE_KEY]: raw })),
      defaultMaStructureSettings(),
      `malformed payload tolerated: ${raw}`,
    );
  }
  assert.deepEqual(loadMaStructureSettings(memStorage({}, true)), defaultMaStructureSettings());
  assert.doesNotThrow(() => saveMaStructureSettings(defaultMaStructureSettings(), memStorage({}, true)));
});

test("8c. equality skips a no-op save", () => {
  const a = { title: "X", emaFastPeriod: 9, emaSlowPeriod: 20, smaPeriod: 20 };
  assert.equal(maStructureSettingsEqual(a, { ...a }), true);
  assert.equal(maStructureSettingsEqual(a, { ...a, emaSlowPeriod: 21 }), false);
  assert.equal(maStructureSettingsEqual(a, { ...a, title: "Y" }), false);
});
// ── 9/10. Configured periods + labels reach the engine ───────────────────────

test("9/10. the engine renders labels from the configured periods, not 9/20/20", () => {
  const settings = { title: "AURA MA Structure", emaFastPeriod: 8, emaSlowPeriod: 21, smaPeriod: 50 };
  assert.equal(maSeriesLabel("fast", settings), "EMA8");
  assert.equal(maSeriesLabel("slow", settings), "EMA21");
  assert.equal(maSeriesLabel("sma", settings), "SMA50");

  const labels = {
    EMA9: maSeriesLabel("fast", settings),
    EMA20: maSeriesLabel("slow", settings),
    SMA20: maSeriesLabel("sma", settings),
  };
  assert.equal(structureOrderLabel(101, 100, 99, 1e-9, labels), "EMA8 > EMA21 > SMA50");
  // The default call (no labels) still yields the historical string.
  assert.equal(structureOrderLabel(101, 100, 99), "EMA9 > EMA20 > SMA20");
  assert.equal(resolveSeriesLabel("EMA20", { EMA20: "EMA21" }), "EMA21");
  assert.equal(resolveSeriesLabel("EMA20"), "EMA20", "identity is the fallback");
  assert.equal(resolveSeriesLabel("EMA20", { EMA20: "" }), "EMA20", "blank falls back");
});

test("9b. pair LABELS follow the settings while identities and gap keys do not", () => {
  const labels = { EMA9: "EMA8", EMA20: "EMA21", SMA20: "SMA50" };
  const ev = evaluateMaStructure({
    ema9: 101,
    ema20: 100,
    sma20: 99,
    ts: 1_704_153_600_000,
    history: emptyGapHistory(),
    labels,
  });
  const rel = ev.snapshot.relationships;
  assert.deepEqual(
    rel.map((r) => `${r.firstLabel}/${r.secondLabel}`),
    ["EMA8/EMA21", "EMA8/SMA50", "EMA21/SMA50"],
  );
  // Stable identities + gap-history keys are UNCHANGED by the labels.
  assert.deepEqual(rel.map((r) => r.pair), ["EMA9_EMA20", "EMA9_SMA20", "EMA20_SMA20"]);
  assert.deepEqual(rel.map((r) => `${r.firstId}-${r.secondId}`), ["EMA9-EMA20", "EMA9-SMA20", "EMA20-SMA20"]);
  assert.equal(ev.snapshot.orderLabel, "EMA8 > EMA21 > SMA50");
  assert.equal(ev.snapshot.structure, "BULLISH", "classification is display-independent");
});

// ── 11. Panel title + periods ────────────────────────────────────────────────

test("11. the panel renders the configured title and computes with its own periods", () => {
  const src = readSrc("src/components/TradingChart/MaStructurePanel.tsx");
  const code = readCode("src/components/TradingChart/MaStructurePanel.tsx");
  assert.match(src, /<span className="ma-structure-title">\{settings\.title\}<\/span>/);
  assert.ok(!src.includes("MOVING AVERAGE STRUCTURE</span>"), "the literal title is gone");
  assert.match(src, /calculateEMA\(closes, settings\.emaFastPeriod\)/);
  assert.match(src, /calculateEMA\(closes, settings\.emaSlowPeriod\)/);
  assert.match(src, /calculateSMA\(closes, settings\.smaPeriod\)/);
  // The hardcoded structural constants are no longer imported by the panel.
  assert.ok(!/MA_STRUCTURE_EMA_FAST|MA_STRUCTURE_EMA_SLOW|MA_STRUCTURE_SMA_PERIOD/.test(code));
  // INDEPENDENCE OF THE CALCULATION — the settings service (the panel's own
  // persistence) must never touch chart indicator state. The panel component
  // MAY receive overlay rows as a CONTROL SURFACE (see the next test); what
  // matters is that nothing here can influence a computed value.
  const settingsCode = readCode("src/services/maStructureSettings.ts");
  for (const token of ["emaSettings", "smaSettings", "EMA_SLOTS", "EmaConfig", "SmaConfig", "activeIndicators"]) {
    assert.ok(!settingsCode.includes(token), `maStructureSettings must not reference ${token}`);
  }
});

test("11c. the panel receives overlay rows as a CONTROL SURFACE only", () => {
  const code = readCode("src/components/TradingChart/MaStructurePanel.tsx");

  // 1. The panel takes a neutral, non-indicator row type — it never imports
  //    the indicator model or config types.
  for (const token of ["emaSettings", "smaSettings", "EMA_SLOTS", "EmaSettings", "SmaSettings", "defaultEmaSettings", "activeIndicators", "EmaConfig"]) {
    assert.ok(!code.includes(token), `panel must not import/reference ${token}`);
  }

  // 2. The overlay rows are declared PRESENTATION ONLY and are not part of the
  //    structure derivation's dependency list.
  const memoDeps = code.match(/\}, \[([^\]]*)\]\);/g)?.join(" ") ?? "";
  assert.ok(!memoDeps.includes("overlays"), "overlay rows must not be a structure input");

  // 3. The derivation reads only candles + the panel's own settings.
  assert.match(code, /calculateEMA\(closes, settings\.emaFastPeriod\)/);
  assert.match(code, /calculateSMA\(closes, settings\.smaPeriod\)/);

  // 4. The structure derivation body NEVER mentions overlay rows. This is the
  //    real contract: hiding an overlay cannot change a computed value.
  const memoBody = code.slice(code.indexOf("const { evaluation, slopes } = useMemo"), code.indexOf("}, [bars, liveCandle, bucketSec"));
  assert.notEqual(memoBody.length > 0, false, "structure useMemo located");
  for (const token of ["overlays", "onToggleOverlay", "onAddOverlay", "o.visible", "o.active"]) {
    assert.ok(!memoBody.includes(token), `structure derivation must not read ${token}`);
  }
  // …and the panel body outside the settings form never branches on them
  // either, so an overlay toggle can never gate a render branch.
  const beforeForm = code.slice(0, code.indexOf("function MaStructureSettingsForm"));
  assert.ok(!/visible \? |\.visible\b|\.active\b/.test(beforeForm), "no render branch keys off overlay state");
});

test("11d. the header Indicators menu no longer carries the Overlays row", () => {
  const menu = readCode("src/components/Indicators/IndicatorsMenu.tsx");
  assert.ok(!menu.includes("removedOverlays"), "header menu must not own the re-add list");
  assert.ok(!menu.includes("onAddOverlay"), "header menu must not own the re-add action");
  const app = readCode("src/App.tsx");
  assert.ok(!/<IndicatorsMenu[\s\S]*?removedOverlays/.test(app), "App must not pass removedOverlays");
  // The re-add surface lives in the panel's settings popover instead.
  assert.match(readCode("src/components/TradingChart/MaStructurePanel.tsx"), /className="ma-structure-overlay-add"/);
});

test("11b. the engine still documents the historical structural periods as defaults", () => {
  const engine = readSrc("src/services/movingAverageStructure.ts");
  assert.match(engine, /MA_STRUCTURE_EMA_FAST = 9/);
  assert.match(engine, /MA_STRUCTURE_EMA_SLOW = 20/);
  assert.match(engine, /MA_STRUCTURE_SMA_PERIOD = 20/);
});

// ── 12. Visibility preference stays a separate key ───────────────────────────

test("12. settings and visibility are SEPARATE preferences under separate keys", () => {
  assert.notEqual(MA_STRUCTURE_SETTINGS_STORAGE_KEY, MA_STRUCTURE_VISIBILITY_STORAGE_KEY);
  const store = memStorage({});
  saveMaStructureSettings({ title: "Kept", emaFastPeriod: 8, emaSlowPeriod: 21, smaPeriod: 50 }, store);
  assert.deepEqual([...store.map.keys()], [MA_STRUCTURE_SETTINGS_STORAGE_KEY]);
  // Neither ChartSettings (template state) nor the visibility module owns it.
  assert.ok(!readSrc("src/config/chartSettings.ts").includes(MA_STRUCTURE_SETTINGS_STORAGE_KEY));
  assert.ok(!readSrc("src/services/maStructureVisibility.ts").includes(MA_STRUCTURE_SETTINGS_STORAGE_KEY));
});