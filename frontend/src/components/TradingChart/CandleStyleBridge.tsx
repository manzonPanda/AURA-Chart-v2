import { useEffect } from "react";

import { useChartApi } from "@getcandlekit/charts/react";

import type { CandleSettings } from "../../config/chartSettings";
import {
  candleElementOptions,
  effectiveCandleColors,
  TRANSPARENT_CANDLE_COLOR,
  type CandleElementOptions,
} from "./candleColors";

/** Fully-transparent color — hides an element (body/border/wick) at paint. */
export const TRANSPARENT_COLOR = TRANSPARENT_CANDLE_COLOR;

/**
 * Derive the candlestick series options from the Symbol settings + AURA's
 * Invert-Scale color semantics. PURE function (unit-tested): the six LWC
 * color options plus the native `borderVisible`/`wickVisible` flags.
 *
 * Authority model (single source of truth — settings.symbol.candles):
 *   - `candles.upColor/downColor` are the series' bull/bear colors (default =
 *     AURA's #26a69a/#ef5350 baseline). The selected THEME colors the chart
 *     chrome (background/grid/axis/crosshair/lines); the Symbol pickers own
 *     the candles specifically — TradingView parity.
 *   - AURA Invert-Scale semantics apply on TOP of the picked colors
 *     (`effectiveCandleColors` swaps bull/bear while inverted — the same
 *     derivation InvertScaleBridge uses with theme colors).
 *   - Body/borders/wick element toggles ride the tested `candleElementOptions`
 *     derivation: body → transparent colors (no native body-visibility
 *     option), borders/wick → native `borderVisible`/`wickVisible` flags.
 */
export function candleStyleOptions(
  candles: CandleSettings,
  invertScale: boolean,
): CandleElementOptions {
  const palette = effectiveCandleColors(candles.upColor, candles.downColor, invertScale);
  return candleElementOptions(palette, candles);
}

interface Props {
  /** The Symbol section's candle appearance (App-owned, persisted). */
  candles: CandleSettings;
  /** Current Invert-Scale state — its color swap rides the SAME derivation. */
  invertScale: boolean;
}

/**
 * Applies the Symbol settings to the EXISTING candlestick series via the
 * supported series-options API (`series.applyOptions`) — no second series, no
 * data rewrite, no canvas access. The native LWC colorer derives per-candle
 * colors from raw OHLC at paint time and reads these options, so every
 * historical candle recolors immediately and live ticks follow automatically
 * on every data path (setData / updateBar / the live glide).
 *
 * Ordering contract with InvertScaleBridge: both subscribe to CandleKit's
 * "theme" bus event (CandleKit's own mount-time `setTheme`/`styleSeries` fires
 * AFTER child effects and would reset a persisted palette). This bridge is
 * rendered as the LATER sibling, so its subscription fires LAST and the
 * Symbol-styled palette wins over InvertScaleBridge's theme-based fallback —
 * while InvertScaleBridge's own pinned application remains intact as the
 * base semantics. On an Invert-Scale toggle both effects re-run in sibling
 * order and this bridge re-asserts the user palette (with AURA's invert
 * swap applied on top) — one authority, no clobber loops.
 */
export function CandleStyleBridge({ candles, invertScale }: Props) {
  const api = useChartApi();

  useEffect(() => {
    const controller = api.controller;
    const apply = (): void => {
      try {
        const series = controller.getSeries();
        series.applyOptions(candleStyleOptions(candles, invertScale));
      } catch {
        /* chart already torn down */
      }
    };
    apply();
    // Re-assert whenever CandleKit restyles the series (mount-time setTheme
    // fires after this effect — same reason InvertScaleBridge subscribes).
    const offTheme = controller.bus.on("theme", apply);
    return () => {
      offTheme();
    };
  }, [api, candles, invertScale]);

  // Pure chart-side bridge: nothing rendered into the DOM.
  return null;
}