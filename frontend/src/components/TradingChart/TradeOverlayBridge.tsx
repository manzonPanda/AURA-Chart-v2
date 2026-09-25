/**
 * React bridge for the HISTORICAL MT5 TRADE OVERLAY (P3-B) — same pattern as
 * GapShading/GapRegionsBridge: attaches the series primitive to the chart's
 * main series once per controller and repaints in place when the overlay set
 * changes. Pure presentation: never mutates candle data, never re-renders the
 * chart's React tree, never registers a second series.
 *
 * Visibility rules:
 *   * `overlays` empty or undefined ⇒ nothing is attached or drawn
 *     (zero behavior change for callers that do not opt in).
 *   * `enabled` false (replay session active) ⇒ overlays are cleared —
 *     historical trade markers would mislead on a simulated chart.
 *   * `formingBucketSec` is the current forming bucket (epoch SECONDS, same
 *     value WhitespaceBridge receives via `liveCandle.time`); open trades
 *     extend their band to it. Accepted in seconds or ms — normalized here.
 *   * `bucketSec` is the chart's CURRENT candle timeframe (60 on 1m, 180 on
 *     3m — TradingChart's `resolutionToBucketSec(resolution)`). The primitive
 *     brackets exact execution times between registered points on THAT grid,
 *     so exact-time positioning follows the chart instead of a hard-coded
 *     60-second assumption (the P3-D 3m rendering defect).
 */
import { useEffect, useMemo, useRef } from "react";

import { useChartApi } from "@getcandlekit/charts/react";

import { TradeOverlayPrimitive } from "./TradeOverlayPrimitive";
import { formingBucketToMs } from "../../services/tradeOverlay";
import type {
  LiveTradeOverlay,
  RiskLevelOverlay,
  TradeOverlay,
} from "../../services/tradeOverlay";

export { formingBucketToMs };

export function TradeOverlayBridge({
  overlays,
  liveOverlays,
  riskLevels,
  formingBucketSec,
  bucketSec,
  enabled,
}: {
  overlays: readonly TradeOverlay[];
  /** Live MT5 positions for the CHART instrument (read-only descriptors). */
  liveOverlays?: readonly LiveTradeOverlay[] | undefined;
  /** Informational account-risk levels (read-only descriptors). */
  riskLevels?: readonly RiskLevelOverlay[] | undefined;
  formingBucketSec: number | null | undefined;
  bucketSec: number;
  enabled: boolean;
}): null {
  const api = useChartApi();
  const primRef = useRef<TradeOverlayPrimitive | null>(null);

  // Attach once per chart controller (re-attaches after chart recreation).
  useEffect(() => {
    const controller = api.controller;
    if (!controller) return;
    const host = (controller as unknown as { getSeries?: () => unknown }).getSeries?.() as
      | { attachPrimitive?: (p: unknown) => void }
      | undefined
      | null;
    if (!host) return;
    if (!primRef.current) primRef.current = new TradeOverlayPrimitive();
    try {
      host.attachPrimitive?.(primRef.current);
    } catch {
      /* older LWC without primitive support — overlay degrades silently */
    }
  }, [api]);

  // Repaint in place when the geometry changes (attachPrimitive → requestUpdate).
  const formingMs = useMemo(() => formingBucketToMs(formingBucketSec), [formingBucketSec]);
  useEffect(() => {
    if (!primRef.current) return;
    if (!enabled) {
      primRef.current.setOverlays([], null, bucketSec);
      // Replay clears historical geometry, so the live/risk layer must be
      // cleared with it — a simulated chart must never show live MT5 state.
      primRef.current.setLiveOverlays([], []);
      return;
    }
    primRef.current.setOverlays(overlays, formingMs, bucketSec);
  }, [overlays, formingMs, enabled, bucketSec]);

  // The LIVE layer is updated independently of the historical layer: a state
  // refetch that changes only floating P&L or SL/TP repaints without touching
  // the completed P3 path. Both arrays are empty when there is no live state,
  // so account switches and the absence of open positions clear the layer.
  useEffect(() => {
    if (!primRef.current) return;
    if (!enabled) return;
    primRef.current.setLiveOverlays(liveOverlays ?? [], riskLevels ?? []);
  }, [liveOverlays, riskLevels, enabled]);

  return null;
}
