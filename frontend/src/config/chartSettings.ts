/**
 * Chart display settings — frontend-only, persisted in localStorage.
 *
 * Architecture contract (same pattern as emaSettings.ts):
 *   - Settings are PURE presentation — they never touch candle data.
 *   - `invertScale` is a visual-only transformation of the main (right) price
 *     scale via Lightweight Charts' native `invertScale` price-scale option.
 *     OHLC values, candle order, crosshair values and the time axis are
 *     completely untouched.
 *   - Stored under `aura.chart.settings`, validated on load so a corrupted
 *     entry falls back to the defaults instead of breaking the chart.
 *   - Storage is injectable so unit tests can run without a `window`.
 */

/** localStorage key — display configuration ONLY, never chart data. */
export const CHART_SETTINGS_STORAGE_KEY = "aura.chart.settings";

export interface ChartSettings {
  /**
   * Visual price-scale inversion (TradingView-style "Invert Scale"): when
   * true, higher prices render LOWER on the main pane and lower prices render
   * HIGHER. A pure scale transform — the underlying price data is unchanged.
   */
  invertScale: boolean;
}

/** Fresh default settings (also the corrupted-storage fallback). */
export function defaultChartSettings(): ChartSettings {
  return { invertScale: false };
}

/**
 * Validate arbitrary (possibly corrupted) stored data into always-usable
 * settings. Unknown shapes fall back PER FIELD to the defaults.
 */
export function sanitizeChartSettings(raw: unknown): ChartSettings {
  const out = defaultChartSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.invertScale === "boolean") out.invertScale = r.invertScale;
  return out;
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

/** settings → storage (guarded: storage errors are non-fatal, session-only). */
export function saveChartSettings(
  settings: ChartSettings,
  storage: { setItem(key: string, value: string): void } = window.localStorage,
): void {
  try {
    storage.setItem(CHART_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable — setting stays session-only */
  }
}