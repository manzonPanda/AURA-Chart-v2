/**
 * AURA candle-color semantics — presentation-only. OHLC data is NEVER touched.
 *
 * AURA product behavior (intentional, differs from Lightweight Charts'
 * default): Invert Scale inverts the price axis AND swaps the rendered
 * bullish/bearish colors, so the visual "down = up" world stays internally
 * consistent:
 *
 *   invertScale = false:  close > open → bullish (#26a69a), close < open → bearish (#ef5350)
 *   invertScale = true :  close > open → bearish (#ef5350), close < open → bullish (#26a69a)
 *
 * Mechanism (supported LWC API — no canvas hacking): the native colorer
 * derives per-candle colors from RAW OHLC (`isUp = open <= close`) at paint
 * time and reads the series-level up/down color options. Swapping those
 * options therefore recolors every historical candle (option changes
 * invalidate the series pane views) and every future live tick (the colorer
 * runs per paint), on every data path (setData / updateBar / glide), without
 * mutating a single OHLC value or creating a second dataset.
 *
 * Doji rule matches the native colorer exactly: `close >= open` counts
 * bullish, so an inverted doji renders the bearish color.
 */

export type CandleColor = string;

/** The six series-level color options LWC's candlestick colorer consults. */
export interface CandleColorOptions {
  upColor: CandleColor;
  downColor: CandleColor;
  borderUpColor: CandleColor;
  borderDownColor: CandleColor;
  wickUpColor: CandleColor;
  wickDownColor: CandleColor;
}

/** Market direction from RAW OHLC — the native LWC colorer's exact rule. */
export function isBullishCandle(close: number, open: number): boolean {
  return close >= open;
}

/**
 * AURA direction semantics: `isBullish = close >= open`,
 * `effectiveBullish = invertScale ? !isBullish : isBullish`.
 * Pure comparison — prices are never negated, swapped or transformed.
 */
export function effectiveBullish(close: number, open: number, invertScale: boolean): boolean {
  const bull = isBullishCandle(close, open);
  return invertScale ? !bull : bull;
}

/**
 * Series color options for the current mode: which theme color the NATIVE
 * colorer should find in `upColor`/`downColor` (and border/wick equivalents)
 * so that the rendered result matches AURA's inverted semantics.
 */
export function effectiveCandleColors(
  bullishColor: CandleColor,
  bearishColor: CandleColor,
  invertScale: boolean,
): CandleColorOptions {
  const up = invertScale ? bearishColor : bullishColor;
  const down = invertScale ? bullishColor : bearishColor;
  return {
    upColor: up,
    downColor: down,
    borderUpColor: up,
    borderDownColor: down,
    wickUpColor: up,
    wickDownColor: down,
  };
}

// ── Symbol-section element visibility (Chart Settings → Candles block) ───────

/** Fully transparent — LWC paints NOTHING for a transparent series option. */
export const TRANSPARENT_CANDLE_COLOR = "rgba(0, 0, 0, 0)";

/** The Candles block's per-element enable flags (settings.symbol.candles). */
export interface CandleElementToggles {
  /** Render candle bodies. */
  body: boolean;
  /** Render candle borders (native LWC `borderVisible`). */
  borders: boolean;
  /** Render wicks (native LWC `wickVisible`). */
  wick: boolean;
}

/** The series options the visibility derivation yields. */
export type CandleElementOptions = CandleColorOptions & {
  wickVisible: boolean;
  borderVisible: boolean;
};

/**
 * Apply the Symbol section's element toggles to an (already swap-applied)
 * palette. PURE function (unit-tested):
 *   - body has NO native LWC visibility option → hidden by transparent
 *     up/down colors (borders/wick remain drawn when enabled);
 *   - borders/wick use the NATIVE `borderVisible`/`wickVisible` options.
 * All six colors always carry real values, so a toggle re-enable restores the
 * exact palette statelessly (no accumulation).
 */
export function candleElementOptions(
  palette: CandleColorOptions,
  toggles: CandleElementToggles,
): CandleElementOptions {
  return {
    upColor: toggles.body ? palette.upColor : TRANSPARENT_CANDLE_COLOR,
    downColor: toggles.body ? palette.downColor : TRANSPARENT_CANDLE_COLOR,
    borderUpColor: palette.borderUpColor,
    borderDownColor: palette.borderDownColor,
    wickUpColor: palette.wickUpColor,
    wickDownColor: palette.wickDownColor,
    borderVisible: toggles.borders,
    wickVisible: toggles.wick,
  };
}
