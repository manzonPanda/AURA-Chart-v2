/**
 * Pine indicator warmup policy — framework-free, unit-testable.
 *
 * AURA's Pine engines (EmaBridge / SmaBridge / PineBridge → PinerWorkerEngine)
 * receive ONLY the candles in the selected history horizon by default. Indicators
 * that depend on prior context (EMA(200), SMA(200), fractals, custom scripts with
 * `max_bars_back`, killzone sessions) therefore start cold on the first visible
 * bar, producing misleading early values until enough real bars accumulate inside
 * the viewport.
 *
 * This module decides HOW MANY prior (real-only) candles to fetch as a "warmup"
 * slice that is fed to Pine for calculation but kept OUT of the chart display.
 *
 * Design contract (approved architecture):
 *   - visible range        = [historyHorizonStart, now)          → DISPLAY only
 *   - calculation range    = [historyHorizonStart - warmup, now) → Pine input
 *   - warmup candles are REAL candles only (never whitespace/gap slots)
 *   - warmup is determined dynamically from the active indicator set, not a fixed
 *     arbitrary constant
 *   - warmup is CAP'd at MAX_WARMUP_BARS (browser/Pine cost protection)
 *   - MINUTE_3 warmup is computed in the SOURCE timeframe (MINUTE_1) then derived
 *     to MINUTE_3, so no off-by-one bucket misalignment occurs
 *   - replay warmup is strictly BEFORE the replay cutoff — no future leakage
 *
 * Custom Pine indicators: Piner's `ScriptMetadata` exposes `historySlotCount`
 * (builtin-derived auto-history) but NOT the user-declared `max_bars_back` /
 * `security(...)` lookahead. A fragile parser is intentionally NOT built; unknown
 * scripts fall back to `DEFAULT_CUSTOM_WARMUP` (documented, bounded, safe).
 */

/** Hard cap on warmup bars — protects browser/Pine from runaway lookbacks. */
export const MAX_WARMUP_BARS = 2000;

/**
 * Safe fallback for custom Pine indicators whose required lookback cannot be
 * determined from metadata. Chosen to comfortably seed common TA ops without
 * pushing a 6-month load into Pine. If a custom script genuinely needs more,
 * the chart still functions correctly — only the very first `fallback` bars of
 * that indicator are cold (documented, not a data-loss bug).
 */
export const DEFAULT_CUSTOM_WARMUP = 500;

/**
 * EMA warmup: the seed is the SMA of the first `period` closes (TradingView
 * convention, see services/ema.ts). A 5x period multiplier covers the
 * ~5-7 half-life decay to practical convergence without over-fetching.
 */
function emaWarmup(period: number): number {
  return Math.min(period * 5, MAX_WARMUP_BARS);
}

/**
 * SMA warmup: exactly `period - 1` prior bars so the first visible SMA point
 * has a full window. SMA has no memory beyond its window, so no extra decay.
 */
function smaWarmup(period: number): number {
  return Math.max(period - 1, 0);
}

/**
 * Fractal warmup: a fractal is confirmed from the N-bar lookback on BOTH sides.
 * AURA's default fractal uses a 2-bar-left / 2-bar-right window. We request 5
 * to be safe across custom left/right configs.
 */
function fractalWarmup(): number {
  return 5;
}

/**
 * Killzone/session warmup: killzones anchor to a session boundary. We need at
 * most one prior session's worth of candles to resolve a session starting just
 * before the visible horizon. Bounded to 50 1-minute bars.
 */
function killzoneWarmup(): number {
  return Math.min(50, MAX_WARMUP_BARS);
}

/**
 * Custom Pine indicator warmup.
 *
 * Piner's compiled `metadata` exposes `historySlotCount` (engine-allocated
 * auto-history slot count, a LOWER bound on derived-leaf state), but the
 * user-declared `max_bars_back` directive is NOT surfaced in `ScriptMetadata`.
 * A fragile regex over raw Pine source is intentionally NOT built.
 *
 * Therefore: `historySlotCount` (if present) gives a conservative lower bound;
 * otherwise we use DEFAULT_CUSTOM_WARMUP. Capped at MAX_WARMUP_BARS.
 */
function customWarmup(historySlotCount?: number): number {
  const builtinSlots = 6;
  const fromMeta =
    historySlotCount && historySlotCount > builtinSlots
      ? Math.min(historySlotCount - builtinSlots, MAX_WARMUP_BARS)
      : 0;
  return Math.max(fromMeta, DEFAULT_CUSTOM_WARMUP);
}

/** Resolved warmup requirement for the active indicator set, in selected-tf bars. */
export interface ActiveIndicatorSpec {
  kind: "ema" | "sma" | "fractal" | "killzone" | "custom";
  enabled: boolean;
  period?: number;
  historySlotCount?: number;
}

/**
 * Compute the warmup bar count for the active indicator set.
 *
 * The returned count is in the SELECTED timeframe's bars (M1 or M3 bars).
 * For MINUTE_3, the loader must request equivalent M1 bars and derive — see
 * `requiredMinute1Bars`.
 */
export function requiredWarmupBars(active: ActiveIndicatorSpec[]): number {
  let max = 0;
  for (const ind of active) {
    if (!ind.enabled) continue;
    let w: number;
    switch (ind.kind) {
      case "ema":
        w = ind.period ? emaWarmup(ind.period) : 0;
        break;
      case "sma":
        w = ind.period ? smaWarmup(ind.period) : 0;
        break;
      case "fractal":
        w = fractalWarmup();
        break;
      case "killzone":
        w = killzoneWarmup();
        break;
      case "custom":
        w = customWarmup(ind.historySlotCount);
        break;
      default:
        w = 0;
    }
    if (w > max) max = w;
  }
  return Math.min(max, MAX_WARMUP_BARS);
}

/**
 * Convert a selected-timeframe warmup requirement into the number of MINUTE_1
 * source bars that must be fetched, so MINUTE_3 warmup is derived from M1
 * (never by subtracting an arbitrary number of M3 timestamps).
 *
 * For MINUTE_1, warmupBars pass through unchanged.
 */
export function requiredMinute1Bars(bucketSec: number, warmupBars: number): number {
  if (bucketSec <= 0) return warmupBars;
  const ratio = bucketSec / 60; // 1 for M1, 3 for M3
  return Math.ceil(warmupBars * ratio);
}

/**
 * Split a loaded bar array into [warmupBars, visibleBars]. Warmup bars are fed
 * to Pine (prepended to bridgeBars) but excluded from the chart display.
 *
 * `loaded` must be strictly ascending by `ts`. `warmupCount` is in the loaded
 * array's timeframe.
 */
export function splitWarmup<T extends { ts: number }>(
  loaded: readonly T[],
  warmupCount: number,
): { warmup: T[]; visible: T[] } {
  if (warmupCount <= 0) return { warmup: [], visible: [...loaded] };
  if (warmupCount >= loaded.length) return { warmup: [...loaded], visible: [] };
  return {
    warmup: loaded.slice(0, warmupCount),
    visible: loaded.slice(warmupCount),
  };
}
