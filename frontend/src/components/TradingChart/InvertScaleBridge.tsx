import { useEffect } from "react";

import { useChartApi } from "@getcandlekit/charts/react";
import type { IChartApi } from "lightweight-charts";

import { effectiveCandleColors } from "./candleColors";

interface Props {
  /**
   * AURA "Invert Scale": when true the main right price scale is inverted
   * (native LWC `invertScale` — a pure, immediate viewport transform) AND the
   * candlestick palette swaps so bullish candles render the bearish color and
   * vice versa (AURA product semantics — see candleColors.ts).
   */
  invertScale: boolean;
}

/**
 * Applies the "Invert Scale" setting to the chart:
 *
 *   1. GEOMETRY — `chart.priceScale("right").applyOptions({ invertScale })`.
 *      Candles, EMA overlays and pane-0 Pine overlays share that scale and
 *      invert together; indicators in their own panes (pane > 0) are
 *      deliberately untouched.
 *   2. COLOR — `series.applyOptions(effectiveCandleColors(theme.up,
 *      theme.down, invertScale))`. Native LWC derives per-candle colors from
 *      raw OHLC at paint time and reads these series options, so this one
 *      call recolors every historical candle immediately (option changes
 *      invalidate the series pane views) and all future live ticks — no data
 *      rewrite, no setData, no series recreation, nothing to undo on refetch.
 *
 * Why a bridge component? CandleKit's `ChartController` owns the Lightweight
 * Charts instance for the ChartView's whole lifetime and `setData`/`updateBar`
 * never touch price-scale or series-color options, so applying here is both
 * immediate and durable. Keyed on `api` (re-applies if the chart is ever
 * recreated) and the setting itself (re-applies on every toggle).
 *
 * Why the bus subscription: CandleKit's `setTheme` re-asserts the series
 * palette via `styleSeries()` — including once at mount, AFTER this child
 * effect runs (parent effects fire last) — which would reset a persisted
 * inverted palette. Subscribing to the controller's "theme" event re-applies
 * the effective colors whenever CandleKit restyles, so the swapped palette
 * always wins.
 */
export function InvertScaleBridge({ invertScale }: Props) {
  const api = useChartApi();

  useEffect(() => {
    const controller = api.controller;
    const chart: IChartApi = controller.getChart();
    // 1) GEOMETRY — native price-scale inversion (pure viewport transform).
    try {
      chart.priceScale("right").applyOptions({ invertScale });
    } catch {
      /* older/edge LWC build without invertScale — noop keeps chart usable */
    }

    // 2) COLOR — AURA semantics: swap the rendered bull/bear palette while
    // inverted. Options-level only: the colorer keeps reading raw OHLC, so
    // historical bars recolor instantly and live ticks follow automatically.
    const applyColors = (): void => {
      try {
        const theme = controller.getTheme();
        const series = controller.getSeries();
        series.applyOptions(effectiveCandleColors(theme.up, theme.down, invertScale));
      } catch {
        /* chart already torn down */
      }
    };
    applyColors();

    // Re-assert whenever CandleKit restyles the series (its mount-time
    // setTheme fires AFTER this effect and would reset the swap).
    const offTheme = controller.bus.on("theme", applyColors);
    return () => {
      offTheme();
    };
  }, [api, invertScale]);

  // Pure chart-side bridge: nothing rendered into the DOM.
  return null;
}