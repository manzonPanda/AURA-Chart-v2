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

import {
  calculateEMA,
  effectiveCloseSeries,
  type EmaPoint,
} from "../../services/ema";
import {
  PineIndicatorEngine,
  type PineBar,
  type PineLiveCandle,
  type PinePoint,
} from "../../services/pineEngine";
import { EMA_SLOTS, type EmaSettings } from "../../config/emaSettings";
import type { RealtimeCandleMsg } from "../../services/realtime";

interface Props {
  /** The chart's bucket-aligned candles (history or live-only accumulation). */
  bars: readonly Bar[];
  /** Latest forming candle pushed by the backend (time = bucket start, epoch s). */
  liveCandle: RealtimeCandleMsg | null;
  /** Selected timeframe bucket size in seconds (60 = 1m, 180 = 3m). */
  bucketSec: number;
  /** EMA configuration (localStorage-persisted in App). */
  settings: EmaSettings;
}

/** One line-data point for LWC (epoch seconds — the chart's time base). */
const toLineData = (p: EmaPoint) => ({ time: (p.ts / 1000) as UTCTimestamp, value: p.value });

/**
 * Renders the two EMA overlays as NORMAL Lightweight Charts line series on the
 * main price pane (priceScaleId "right" → same scale as the candles). No
 * custom rendering primitives, no CandleKit indicator registry — just LWC.
 *
 * Data flow (authoritative-truth only, doji-bug safe):
 *   IG tick → WS candle snapshot → `liveCandle` prop → effectiveCloseSeries()
 *   (WS truth REPLACES the forming bucket's close) → PineIndicatorEngine
 *   (PineTS `ta.ema`) → line. If PineTS has insufficient history, the ema.ts
 *   oracle is used as a fallback. The rAF-animated close is NEVER an input, so
 *   background-tab throttling and the cosmetic glide cannot skew EMA values;
 *   on tab return the next WS frame (a full server snapshot) re-anchors both
 *   the candle and the EMA.
 *
 * Paint strategy: full `setData` when the point shape changes (history load,
 * timeframe switch, settings change, bucket rollover — closed candles never
 * mutate, so historical EMA points are stable), `update(lastPoint)` while only
 * the forming candle's close moves (per-tick, cheap).
 */
export function EmaBridge({ bars, liveCandle, bucketSec, settings }: Props) {
  const api = useChartApi();
  /** slot id → its LWC line series. */
  const seriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  /** Per-slot painted shape, to decide setData (shape change) vs update (tick). */
  const paintedRef = useRef<Map<string, { count: number; firstTs: number; lastTs: number }>>(new Map());
  /**
   * PineTS indicator engine — held for the chart controller's life so the
   * compiled PineScript `Indicator`(s) and runtime instance are reused across
   * frames (no re-transpile, no per-frame instance creation). Recreated only
   * when `api` (the chart controller) changes; disposed on teardown.
   */
  const engineRef = useRef<PineIndicatorEngine>(new PineIndicatorEngine());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Series lifecycle — created once per chart controller, removed on teardown.
  useEffect(() => {
    const chart: IChartApi = api.controller.getChart();
    const map = new Map<string, ISeriesApi<"Line">>();
    for (const slot of EMA_SLOTS) {
      const cfg = settingsRef.current[slot.id];
      try {
        map.set(
          slot.id,
          chart.addSeries(LineSeries, {
            color: cfg.color,
            lineWidth: cfg.width as LineWidth,
            priceScaleId: "right", // overlay the main price series' scale
            priceLineVisible: false, // no horizontal line across the pane
            lastValueVisible: true, // EMA value pill on the right axis
            pointMarkersVisible: false,
            crosshairMarkerRadius: 3,
            visible: cfg.enabled,
          }),
        );
      } catch {
        /* older LWC — skip this slot */
      }
    }
    seriesRef.current = map;
    return () => {
      for (const series of map.values()) {
        try {
          chart.removeSeries(series);
        } catch {
          /* chart already torn down */
        }
      }
      seriesRef.current = new Map();
      paintedRef.current = new Map();
      engineRef.current.dispose();
      engineRef.current = new PineIndicatorEngine();
    };
  }, [api]);

  // Configuration changes — style only, never recreate the series.
  useEffect(() => {
    for (const slot of EMA_SLOTS) {
      const series = seriesRef.current.get(slot.id);
      if (!series) continue;
      const cfg = settings[slot.id];
      try {
        series.applyOptions({
          color: cfg.color,
          lineWidth: cfg.width as LineWidth,
          visible: cfg.enabled,
        });
      } catch {
        /* noop */
      }
    }
  }, [settings]);

  // Data — recompute from the authoritative candle state on every candle
  // frame / history load / settings change.
  useEffect(() => {
    // Keep the PineTS engine in lock-step with the chart's authoritative state.
    // `setCandles` is a no-op when the close stream is unchanged, so rAF/stale
    // frames that didn't move the authoritative candle short-circuit cheaply.
    const pineBars = (bars as readonly Bar[]) as readonly PineBar[];
    const pineLive: PineLiveCandle | null = liveCandle
      ? { time: liveCandle.time, open: liveCandle.open, high: liveCandle.high, low: liveCandle.low, close: liveCandle.close, volume: liveCandle.volume }
      : null;
    engineRef.current.setCandles(pineBars, pineLive, bucketSec);

    void Promise.all(
      EMA_SLOTS.map(async (slot) => {
        const series = seriesRef.current.get(slot.id);
        if (!series) return;
        const cfg = settings[slot.id];
        const painted = paintedRef.current.get(slot.id);

        const clear = (): void => {
          if (!painted) return;
          try {
            series.setData([]);
          } catch {
            /* noop */
          }
          paintedRef.current.delete(slot.id);
        };

        if (!cfg.enabled) {
          clear();
          return;
        }

        // Primary path: PineTS ta.ema(). Fallback oracle: ema.ts — used only
        // when PineTS has insufficient history (returns null) or fails.
        let points: EmaPoint[] = [];
        const pinePoints: PinePoint[] | null = await engineRef.current.compute("ema", { period: cfg.period });
        if (pinePoints && pinePoints.length > 0) {
          points = pinePoints;
        } else {
          const closes = effectiveCloseSeries(bars, liveCandle, bucketSec);
          points = calculateEMA(closes, cfg.period);
        }

        if (points.length === 0) {
          // Insufficient history for this period — show nothing (never a
          // partially-seeded, misleading line).
          clear();
          return;
        }

        const first = points[0];
        const last = points[points.length - 1];
        const shapeUnchanged =
          painted !== undefined &&
          painted.count === points.length &&
          painted.firstTs === first.ts &&
          painted.lastTs === last.ts;
        try {
          if (shapeUnchanged) {
            // Only the forming bucket's close moved — replace the last point.
            series.update(toLineData(last));
          } else {
            series.setData(points.map(toLineData));
            paintedRef.current.set(slot.id, {
              count: points.length,
              firstTs: first.ts,
              lastTs: last.ts,
            });
          }
        } catch {
          /* series gone (chart recreated) — re-created on the next api change */
        }
      }),
    ).catch(() => {
      /* one bad slot must not break the others */
    });
  }, [api, bars, liveCandle, bucketSec, settings]);

  // Pure chart-side bridge: nothing rendered into the DOM.
  return null;
}
