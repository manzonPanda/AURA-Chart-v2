import { useEffect, useRef, useState } from "react";
import { LineStyle, type IPriceLine } from "lightweight-charts";

import { useChartApi } from "@getcandlekit/charts/react";

import { candleCloseCountdown } from "../../services/liveCandle";
import type { RealtimeCandleMsg } from "../../services/realtime";
import type { Candle } from "../../types/candle";

interface Props {
  /** Latest forming candle pushed by the backend (time = bucket start, epoch s). */
  liveCandle: RealtimeCandleMsg | null;
  /** History candles — price source until the first WS frame arrives. */
  candles: readonly Candle[];
  /** Selected timeframe bucket size in seconds (60 = 1m, 180 = 3m). */
  bucketSec: number;
}

/** Redraw cadence for the countdown. The VALUE is never taken from this
 *  timer's ticks — every run recomputes `nextBucketTime - Date.now()` from
 *  the candle's actual bucket boundary, so background-tab timer throttling can
 *  only delay a redraw, never skew the countdown. */
const REDRAW_INTERVAL_MS = 250;

/** Identifies the price line on the series (one per chart). */
const LIVE_PRICE_COUNTDOWN_ID = "aura-live-price-countdown";

/**
 * TradingView-style candle countdown rendered ON the right price scale, pinned
 * to the current/live price level of the forming candle (1m / 3m per the
 * selected timeframe). Rendered through Lightweight Charts' NATIVE price-line
 * mechanism — canvas-drawn, no HTML overlay, no footer badge:
 *
 *   - one `series.createPriceLine(...)` rides the forming candle's close:
 *     `axisLabelVisible` paints the PRICE pill on the right price axis and the
 *     `title` paints the `MM:SS` countdown pill on the pane edge right next to
 *     it — exactly how TradingView attaches the countdown to the price label.
 *     Both move vertically with the price (`applyOptions({ price })` per tick).
 *   - the series' automatic last-value label + price line are disabled, so
 *     this combined label IS the chart's single current-price marker.
 *   - the label is colored by the forming candle's direction (up/down), the
 *     same way the native last-price label was.
 *   - before the first WS frame the marker still pins the latest HISTORY close
 *     (title empty → price-only label), so the axis never loses its marker.
 *
 * Synchronization contract (see liveCandle.ts — UNCHANGED):
 *  - The countdown target is `liveCandle.time + bucketSec` — the REAL market
 *    bucket boundary reported by the backend stream, not a browser-accumulated
 *    duration. Every WS candle frame re-anchors it (1m → :00/:01/…, 3m →
 *    :00/:03/…), so a timeframe switch re-syncs automatically.
 *  - `remaining = closesAt - Date.now()` is recomputed on every redraw and on
 *    every visibilitychange, so returning from a throttled background tab
 *    snaps straight to the correct value.
 *  - When the wall clock crosses the boundary but the stream has not yet
 *    delivered the next candle, the display HOLDS at 00:00. This component
 *    never creates candles — the WS stream (LiveBarBridge) is the only candle
 *    authority, so no duplicates can appear at rollover.
 */
export function CandleCountdown({ liveCandle, candles, bucketSec }: Props) {
  const api = useChartApi();
  const [now, setNow] = useState(() => Date.now());
  /** The native price line, created lazily once a price exists. */
  const lineRef = useRef<IPriceLine | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), REDRAW_INTERVAL_MS);
    const onVisibility = (): void => {
      // Recompute immediately on tab focus (timers may have been throttled to
      // 1/min while hidden — don't wait for the next interval tick).
      setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Release the price line (and hand the marker role back) when the chart api
  // is replaced or the component unmounts. The controller may already be
  // destroyed (React StrictMode double-invoke) — every call is guarded.
  useEffect(() => {
    return () => {
      const line = lineRef.current;
      lineRef.current = null;
      if (!line) return;
      try {
        const series = api.controller.getSeries();
        series.removePriceLine(line);
        series.applyOptions({ lastValueVisible: true, priceLineVisible: true });
      } catch {
        /* chart already torn down */
      }
    };
  }, [api]);

  // Current price level = the forming candle's last tick price (the same
  // server truth LiveBarBridge paints), falling back to the newest history
  // candle before the stream's first frame.
  const lastHistory = candles.length > 0 ? candles[candles.length - 1] : undefined;
  const price = liveCandle ? liveCandle.close : (lastHistory?.close ?? null);
  const up = liveCandle ? liveCandle.close >= liveCandle.open : true;
  const countdown = candleCloseCountdown(liveCandle, bucketSec, now);

  useEffect(() => {
    if (price === null || !Number.isFinite(price)) return;
    const series = api.controller.getSeries();
    let line = lineRef.current;
    if (!line) {
      // First price available: take over the current-price marker role from
      // the series' automatic last-value label + price line, then attach our
      // combined price + countdown label at that level.
      try {
        series.applyOptions({ lastValueVisible: false, priceLineVisible: false });
      } catch {
        /* older LWC */
      }
      try {
        line = series.createPriceLine({
          id: LIVE_PRICE_COUNTDOWN_ID,
          price,
          color: "",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          lineVisible: false,
          axisLabelVisible: true,
          title: "",
        });
        lineRef.current = line;
      } catch {
        return;
      }
    }
    try {
      const theme = api.controller.getTheme();
      line.applyOptions({
        price,
        // Axis pill (price) + title pill (countdown) follow the candle's
        // direction, matching the native last-price label coloring.
        color: up ? theme.up : theme.down,
        title: countdown ? countdown.label : "",
      });
    } catch {
      /* series gone (chart recreated) — re-created on the next api change */
    }
  }, [api, price, up, countdown]);

  // Pure chart-side bridge: nothing is rendered into the DOM. The price pill
  // (right price axis) and the countdown pill (pane edge) are canvas-drawn by
  // Lightweight Charts at the current price's coordinate.
  return null;
}
