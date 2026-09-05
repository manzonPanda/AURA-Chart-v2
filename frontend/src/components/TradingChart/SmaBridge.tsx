import { useEffect, useRef } from "react";
import {
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineWidth,
  type UTCTimestamp,
} from "lightweight-charts";

import { useChartApi } from "@getcandlekit/charts/react";
import type { Bar } from "@getcandlekit/charts/react";

import { effectiveCloseSeries } from "../../services/ema";
import { calculateSMA, type SmaPoint } from "../../services/sma";
import type { SmaSettings } from "../../config/smaSettings";
import type { RealtimeCandleMsg } from "../../services/realtime";

interface Props {
  /** The chart's bucket-aligned candles (history or live-only accumulation). */
  bars: readonly Bar[];
  /** Latest forming candle pushed by the backend (time = bucket start, epoch s). */
  liveCandle: RealtimeCandleMsg | null;
  /** Selected timeframe bucket size in seconds (60 = 1m, 180 = 3m). */
  bucketSec: number;
  /** SMA configuration (localStorage-persisted in App). */
  settings: SmaSettings;
}

/** One line-data point for LWC (epoch seconds — the chart's time base). */
const toLineData = (p: SmaPoint) => ({ time: (p.ts / 1000) as UTCTimestamp, value: p.value });

/**
 * Renders the SMA overlay as a NORMAL Lightweight Charts line series on the
 * main price pane (priceScaleId "right" → same scale as the candles). No custom
 * rendering primitives, no CandleKit indicator registry — just LWC, exactly like
 * EmaBridge but computed purely (no PineTS).
 *
 * Data flow (authoritative-truth only):
 *   candles → effectiveCloseSeries() (WS truth REPLACES the forming bucket's
 *   close) → calculateSMA(period) → line. The forming candle's SERVER truth is
 *   the input — never the rAF-animated close — so background-tab throttling and
 *   the cosmetic glide cannot skew SMA values.
 *
 * Anti-look-ahead: the `bars` prop is ALREADY the replay cursor slice while a
 * Replay session is active (handed down from TradingChart as `visibleBars`), so
 * this bridge can only ever see candle state up to the cursor. Background
 * history pagination can never leak in.
 *
 * Paint strategy: full `setData` when the point shape changes (history load /
 * prepend, timeframe switch, settings change, bucket rollover), `update(last)`
 * while only the forming candle's close moves (per-tick, cheap).
 */
export function SmaBridge({ bars, liveCandle, bucketSec, settings }: Props) {
  const api = useChartApi();
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  /** Painted shape, to decide setData (shape change) vs update (tick). */
  const paintedRef = useRef<{ count: number; firstTs: number; lastTs: number } | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Series lifecycle — created once per chart controller, removed on teardown.
  useEffect(() => {
    const chart: IChartApi = api.controller.getChart();
    const cfg = settingsRef.current;
    const series = chart.addSeries(LineSeries, {
      color: cfg.color,
      lineWidth: cfg.width as LineWidth,
      priceScaleId: "right",
      visible: cfg.enabled,
      lastValueVisible: true,
      priceLineVisible: false,
    });
    seriesRef.current = series;
    paintedRef.current = null;

    // Fresh settings hash → revisit options on the existing series.
    return () => {
      chart.removeSeries(series);
      seriesRef.current = null;
      paintedRef.current = null;
    };
  }, [api]);

  // Settings (color / width / visibility) update live without a data rebuild.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    try {
      series.applyOptions({
        color: settings.color,
        lineWidth: settings.width as LineWidth,
        visible: settings.enabled,
      });
    } catch {
      /* noop */
    }
  }, [settings]);

  // Data — recompute from the authoritative candle state on every candle
  // frame / history load / settings change.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const painted = paintedRef.current;

    const clear = (): void => {
      if (!painted) return;
      try {
        series.setData([]);
      } catch {
        /* noop */
      }
      paintedRef.current = null;
    };

    if (!settingsRef.current.enabled) {
      clear();
      return;
    }

    // effectiveCloseSeries merges the forming candle's SERVER truth into the
    // close stream (same bucket → replace; newer bucket → append; older →
    // ignore). SMA is then computed over the SELECTED timeframe's bucket-
    // aligned candles — always, regardless of whether they arrived from an
    // initial load, Load More History prepend, or the live overlay.
    const closes = effectiveCloseSeries(bars, liveCandle, bucketSec);
    const points = calculateSMA(closes, settingsRef.current.period);

    if (points.length === 0) {
      // Insufficient history for this period — show nothing (never a
      // partially-seeded, misleading line).
      clear();
      return;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const shapeUnchanged =
      painted !== null &&
      painted.count === points.length &&
      painted.firstTs === first.ts &&
      painted.lastTs === last.ts;
    try {
      if (shapeUnchanged) {
        // Only the forming bucket's close moved — replace the last point.
        series.update(toLineData(last));
      } else {
        series.setData(points.map(toLineData));
        paintedRef.current = {
          count: points.length,
          firstTs: first.ts,
          lastTs: last.ts,
        };
      }
    } catch {
      /* series gone (chart recreated) — re-created on the next api change */
    }
  }, [api, bars, liveCandle, bucketSec, settings]);

  // Pure chart-side bridge: nothing rendered into the DOM.
  return null;
}