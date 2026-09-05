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
