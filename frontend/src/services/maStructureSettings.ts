/**
 * MA STRUCTURE PANEL settings — PURE helpers (no React, no chart, no engine).
 *
 * ARCHITECTURAL CONTRACT — the panel's own configuration, deliberately
 * SEPARATE from the visible chart overlays:
 *
 *   • These periods configure the PANEL's INTERNAL structural calculation.
 *     They are NOT the chart's EMA/SMA indicators and never read, write or
 *     depend on `emaSettings` / `smaSettings` / `EMA_SLOTS`. Changing the
 *     visible EMA 15 → EMA 30 leaves this untouched, and changing the panel's
 *     slow EMA 20 → 21 leaves the chart untouched.
 *   • The panel computes its own EMA/SMA from candle data
 *     (`services/ema.ts` / `services/sma.ts`) — see MaStructurePanel.tsx —
 *     so deleting every visible EMA/SMA overlay changes nothing here.
 *
 * Persistence follows AURA's guarded-localStorage convention (same as
 * `config/chartSettings.ts` / `services/timeframeSelection.ts`): missing,
 * unreadable, corrupted or storage-denied all fall back to the DEFAULTS, and
 * a failed write leaves the settings session-only.
 *
 * Deliberately NOT in ChartSettings: that object is chart TEMPLATE state (see
 * `config/chartTemplates.ts` snapshots the whole object), so a panel
 * configuration stored there would let applying a template silently rewrite
 * the panel. This gets its own versioned key.
 *
 * Kept SEPARATE from `aura.ma.structure.visibility.v1`
 * (services/maStructureVisibility.ts): hiding the panel must not erase its
 * configuration, and reconfiguring it must not un-hide the panel.
 */
import { isValidEmaPeriod } from "./ema.ts";
import { isValidSmaPeriod } from "./sma.ts";

/**
 * Versioned localStorage key for the PANEL's configuration only — never MA
 * values, never chart data.
 */
export const MA_STRUCTURE_SETTINGS_STORAGE_KEY = "aura.ma.structure.settings.v1";

/** Storage surface (injectable for tests; defaults to localStorage). */
export interface MaStructureSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Longest accepted panel title (defends the header layout + storage). */
export const MAX_MA_STRUCTURE_TITLE_LENGTH = 40;

/** Default title — stored VERBATIM, never uppercased by this module. */
export const DEFAULT_MA_STRUCTURE_TITLE = "Moving Average Structure";

/** The panel's own configuration. Display-only + calculation periods. */
export interface MaStructureSettings {
  /**
   * Panel title. Stored as typed — the UI applies its own `text-transform`,
   * matching the existing typography. Display only: never affects a value.
   */
  title: string;
  /** Fast EMA period for the structural comparison. */
  emaFastPeriod: number;
  /** Slow EMA period for the structural comparison. */
  emaSlowPeriod: number;
  /** SMA period for the structural comparison. */
  smaPeriod: number;
}

/** Fresh defaults (also the corrupted-storage fallback) — 9 / 20 / 20. */
export function defaultMaStructureSettings(): MaStructureSettings {
  return {
    title: DEFAULT_MA_STRUCTURE_TITLE,
    emaFastPeriod: 9,
    emaSlowPeriod: 20,
    smaPeriod: 20,
  };
}
/**
 * Title sanitizer: trims, collapses whitespace, rejects empty/overlong and
 * non-strings by falling back to the default.
 */
export function sanitizeMaStructureTitle(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_MA_STRUCTURE_TITLE;
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, MAX_MA_STRUCTURE_TITLE_LENGTH);
  return cleaned.length > 0 ? cleaned : DEFAULT_MA_STRUCTURE_TITLE;
}

/**
 * Validate an arbitrary (possibly corrupted) stored shape into always-usable
 * settings. Every field falls back INDEPENDENTLY, so one bad value never
 * discards the rest.
 *
 * Period bounds deliberately REUSE the chart overlays' own validators
 * (`isValidEmaPeriod` 1–500, `isValidSmaPeriod` 1–1000) — "consistent with the
 * existing EMA/SMA configuration". They already reject 0, negatives, floats,
 * NaN, ±Infinity and non-numbers, so nothing extra is imposed here.
 */
export function sanitizeMaStructureSettings(raw: unknown): MaStructureSettings {
  const out = defaultMaStructureSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.title = sanitizeMaStructureTitle(r.title);
  if (isValidEmaPeriod(r.emaFastPeriod)) out.emaFastPeriod = r.emaFastPeriod;
  if (isValidEmaPeriod(r.emaSlowPeriod)) out.emaSlowPeriod = r.emaSlowPeriod;
  if (isValidSmaPeriod(r.smaPeriod)) out.smaPeriod = r.smaPeriod;
  return out;
}

/**
 * storage → settings (guarded: missing / unreadable / malformed JSON /
 * private-mode → the defaults). The panel can never fail to render because of
 * this preference.
 */
export function loadMaStructureSettings(
  storage: MaStructureSettingsStorage = window.localStorage,
): MaStructureSettings {
  try {
    const raw = storage.getItem(MA_STRUCTURE_SETTINGS_STORAGE_KEY);
    if (!raw) return defaultMaStructureSettings();
    return sanitizeMaStructureSettings(JSON.parse(raw));
  } catch {
    return defaultMaStructureSettings();
  }
}

/**
 * settings → storage (sanitized, so the persisted JSON is always complete).
 * Guarded write: a storage failure leaves the settings session-only.
 */
export function saveMaStructureSettings(
  settings: MaStructureSettings,
  storage: MaStructureSettingsStorage = window.localStorage,
): void {
  try {
    storage.setItem(
      MA_STRUCTURE_SETTINGS_STORAGE_KEY,
      JSON.stringify(sanitizeMaStructureSettings(settings)),
    );
  } catch {
    /* storage unavailable — settings stay session-only */
  }
}

/** Structural equality — used to skip a no-op save (mirrors chartSettings). */
export function maStructureSettingsEqual(a: MaStructureSettings, b: MaStructureSettings): boolean {
  return (
    sanitizeMaStructureTitle(a.title) === sanitizeMaStructureTitle(b.title) &&
    a.emaFastPeriod === b.emaFastPeriod &&
    a.emaSlowPeriod === b.emaSlowPeriod &&
    a.smaPeriod === b.smaPeriod
  );
}

/**
 * Display label for one structural series, derived from the LIVE settings:
 * `{emaFastPeriod: 8} → "EMA8"`, `{smaPeriod: 50} → "SMA50"`. This is what
 * removes "EMA20" from the rendered labels.
 */
export function maSeriesLabel(
  kind: "fast" | "slow" | "sma",
  settings: MaStructureSettings,
): string {
  const period =
    kind === "fast" ? settings.emaFastPeriod
    : kind === "slow" ? settings.emaSlowPeriod
    : settings.smaPeriod;
  return `${kind === "sma" ? "SMA" : "EMA"}${period}`;
}