/**
 * Chart display settings — frontend-only, persisted in localStorage.
 *
 * Architecture contract (same pattern as emaSettings.ts):
 *   - Settings are PURE presentation — they never touch candle data.
 *   - `invertScale` is a visual-only transformation of the main (right) price
 *     scale via Lightweight Charts' native `invertScale` price-scale option.
 *     OHLC values, candle order, crosshair values and the time axis are
 *     completely untouched.
 *   - `appearance.theme` selects a registered chart theme (see
 *     config/chartThemes.ts — a registry of CandleKit `ChartTheme` overrides;
 *     no duplicate theme engine lives here).
 *   - `symbol.candles` configures the candlestick series' rendered palette
 *     (body/borders/wick enable + bull/bear colors) — applied to the EXISTING
 *     series via `applyOptions` (see CandleStyleBridge.tsx), never by
 *     recreating the series or rewriting data.
 *   - `activeTemplateId` tracks which chart template (see
 *     config/chartTemplates.ts) is currently applied. The built-in "Default"
 *     template is a code constant — this id only ever POINTS at a template;
 *     the pointing never mutates the built-in.
 *   - Stored under `aura.chart.settings.v1` (versioned), validated on load so
 *     a corrupted entry falls back to the defaults instead of breaking the
 *     chart.
 *   - Storage is injectable so unit tests can run without a `window`.
 */

/** localStorage key — display configuration ONLY, never chart data. */
export const CHART_SETTINGS_STORAGE_KEY = "aura.chart.settings.v1";

/** localStorage key — user chart templates (see chartTemplates.ts). */
export const CHART_TEMPLATES_STORAGE_KEY = "aura.chart.templates.v1";

/** Which theme (config/chartThemes.ts registry id) the chart renders. */
export const DEFAULT_THEME_ID = "Fractal Classic";

/** Id of the BUILT-IN Default template (config/chartTemplates.ts constant). */
export const DEFAULT_TEMPLATE_ID = "default";

/** AURA's default bull/bear candle palette (CandleKit's dark baseline). */
export const DEFAULT_CANDLE_UP_COLOR = "#26a69a";
export const DEFAULT_CANDLE_DOWN_COLOR = "#ef5350";

/**
 * Candlestick series appearance — the Symbol section of the Chart Settings
 * modal. Enable flags + the bull/bear body colors the borders and wicks
 * derive from (mirrors the TradingView "Candles" block).
 */
export interface CandleSettings {
  /** Render candle bodies. */
  body: boolean;
  /** Render candle borders (drawn around the body). */
  borders: boolean;
  /** Render wicks (high/low stems). */
  wick: boolean;
  /** Bullish/up color (borders + wick inherit unless the theme overrides). */
  upColor: string;
  /** Bearish/down color (borders + wick inherit unless the theme overrides). */
  downColor: string;
}

export interface ChartSettings {
  /**
   * Visual price-scale inversion (TradingView-style "Invert Scale"): when
   * true, higher prices render LOWER on the main pane and lower prices render
   * HIGHER. A pure scale transform — the underlying price data is unchanged.
   */
  invertScale: boolean;
  /** Appearance section — the selected chart theme id. */
  appearance: {
    theme: string;
  };
  /** Symbol section — candlestick series appearance. */
  symbol: {
    candles: CandleSettings;
  };
  /**
   * Currently-applied chart template id (Default = the built-in constant).
   * Tracking ONLY — templates live in chartTemplates.ts; this never mutates
   * one, least of all the built-in Default.
   */
  activeTemplateId: string;
}

/** Fresh default candle appearance (AURA's classic bull/bear palette). */
export function defaultCandleSettings(): CandleSettings {
  return {
    body: true,
    borders: true,
    wick: true,
    upColor: DEFAULT_CANDLE_UP_COLOR,
    downColor: DEFAULT_CANDLE_DOWN_COLOR,
  };
}

/**
 * Fresh default settings (also the corrupted-storage fallback): classic
 * candle palette, the built-in Default template active.
 */
export function defaultChartSettings(): ChartSettings {
  return {
    invertScale: false,
    appearance: { theme: DEFAULT_THEME_ID },
    symbol: { candles: defaultCandleSettings() },
    activeTemplateId: DEFAULT_TEMPLATE_ID,
  };
}

/**
 * Any hex (#rgb/#rgba/#rrggbb/#rrggbbaa, case-insensitive) → a canonical
 * lowercase #rrggbb for <input type="color"> round-trips. Non-hex input
 * (rgba(), named colors, junk) → null so the caller falls back per field.
 */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const c = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) return `#${m[1].split("").map((x) => x + x).join("")}`;
  m = /^#([0-9a-f]{4})$/.exec(c);
  if (m) {
    const [r, g, b] = m[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^#[0-9a-f]{6,8}$/.test(c)) return c.slice(0, 7);
  return null;
}

/** Validate a candle block (unknown shapes fall back PER FIELD). */
function sanitizeCandleSettings(raw: unknown): CandleSettings {
  const out = defaultCandleSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const cr = (typeof r.candles === "object" && r.candles !== null && !Array.isArray(r.candles)
    ? r.candles
    : r) as Record<string, unknown>;
  if (typeof cr.body === "boolean") out.body = cr.body;
  if (typeof cr.borders === "boolean") out.borders = cr.borders;
  if (typeof cr.wick === "boolean") out.wick = cr.wick;
  const up = normalizeHexColor(cr.upColor);
  if (up) out.upColor = up;
  const down = normalizeHexColor(cr.downColor);
  if (down) out.downColor = down;
  return out;
}

/**
 * Validate arbitrary (possibly corrupted) stored data into always-usable
 * settings. Unknown shapes fall back PER FIELD to the defaults. The result
 * contains ONLY whitelisted fields — top-level junk (e.g. stray `upColor`
 * keys) is dropped, keeping settings presentation-shaped.
 */
export function sanitizeChartSettings(raw: unknown): ChartSettings {
  const out = defaultChartSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.invertScale === "boolean") out.invertScale = r.invertScale;
  const app = (typeof r.appearance === "object" && r.appearance !== null && !Array.isArray(r.appearance)
    ? r.appearance
    : {}) as Record<string, unknown>;
  if (typeof app.theme === "string" && app.theme.trim()) {
    out.appearance.theme = app.theme.trim().slice(0, 64);
  }
  out.symbol.candles = sanitizeCandleSettings(r.symbol);
  if (typeof r.activeTemplateId === "string" && r.activeTemplateId.trim()) {
    out.activeTemplateId = r.activeTemplateId.trim().slice(0, 64);
  }
  return out;
}

/** Deep structural equality of two settings objects (sanitized comparison —
 * every construction path spreads/sanitizes the same shape). */
export function chartSettingsEqual(a: ChartSettings, b: ChartSettings): boolean {
  return JSON.stringify(sanitizeChartSettings(a)) === JSON.stringify(sanitizeChartSettings(b));
}

/** storage → settings (guarded: missing/private-mode/corrupted → defaults). */
export function loadChartSettings(
  storage: { getItem(key: string): string | null } = window.localStorage,
): ChartSettings {
  try {
    const raw = storage.getItem(CHART_SETTINGS_STORAGE_KEY);
    if (!raw) return defaultChartSettings();
    return sanitizeChartSettings(JSON.parse(raw));
  } catch {
    return defaultChartSettings();
  }
}

/** settings → storage (sanitized so the persisted JSON is always complete). */
export function saveChartSettings(
  settings: ChartSettings,
  storage: { setItem(key: string, value: string): void } = window.localStorage,
): void {
  try {
    storage.setItem(CHART_SETTINGS_STORAGE_KEY, JSON.stringify(sanitizeChartSettings(settings)));
  } catch {
    /* storage unavailable — setting stays session-only */
  }
}