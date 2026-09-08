/**
 * TIME-SCALE WHITESPACE bridge — owns the invisible LWC series that registers
 * the missing-gap timestamps on the chart's horizontal time scale.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Architecture contract (see services/whitespaceRows.ts for the pure logic):
 *
 *  - The series is created through the RAW LWC chart api
 *    (`api.controller.getChart().addSeries(...)`, the exact EmaBridge
 *    pattern). CandleKit's bar pipeline (`controller.setData/updateBar/
 *    getBars`) is NEVER touched — it requires OHLC and feeds replay.
 *  - `visible: false` keeps the series unrendered and outside autoscale
 *    (LWC filters invisible series out of `_internal_visibleSerieses()`),
 *    but LWC's DataLayer registers ALL series data — whitespace rows
 *    included — on the time scale, which is the entire point.
 *  - Data = real-candle anchor rows (bounding each gap) + OHLC-free
 *    `WhitespaceData` rows for the missing buckets. The anchor rows MERGE
 *    into existing time points (same timestamps as real candles), so the
 *    series adds only the missing slots to the scale.
 *  - During a replay session the payload is cleared (`setData([])` — LWC
 *    removes the series' time points) and restored on exit, mirroring
 *    GapShading's `enabled={!session}`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useMemo, useRef } from "react";
import {
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import { useChartApi } from "@getcandlekit/charts/react";

import type { Candle, CandleGap } from "../../types/candle.ts";
import { buildWhitespacePlan } from "../../services/whitespaceRows.ts";

/** Matches `chart.addSeries(LineSeries, ...)` (LWC default `Time` generic). */
type WhitespaceSeries = ISeriesApi<"Line">;

export function WhitespaceBridge({
  candles,
  gaps,
  bucketSec,
  replayActive,
}: {
  candles: readonly Candle[];
  /** Detected market-data gaps (epoch ms) — only these establish slots. */
  gaps: readonly CandleGap[] | undefined;
  bucketSec: number;
  /** Replay owns the chart while active — whitespace must vanish. */
  replayActive: boolean;
}): null {
  const api = useChartApi();
  const seriesRef = useRef<WhitespaceSeries | null>(null);

  // Series lifecycle — created once per chart controller, removed on teardown.
  useEffect(() => {
    if (!api) return;
    let chart: IChartApi;
    try {
      chart = api.controller.getChart();
    } catch {
      return; // controller not ready / already torn down
    }
    let series: WhitespaceSeries | null = null;
    try {
      series = chart.addSeries(LineSeries, {
        visible: false, // never rendered — timestamps only (LWC still registers them)
        priceScaleId: "right", // harmless: invisible series is excluded from autoscale
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
    } catch {
      return; // older LWC without addSeries — whitespace degrades to compaction
    }
    seriesRef.current = series;
    return () => {
      seriesRef.current = null;
      try {
        chart.removeSeries(series!); // also removes its time points from the scale
      } catch {
        /* chart already torn down */
      }
    };
  }, [api]);

  // Whitespace payload — recomputed ONLY when the underlying data changes
  // (memoized: a fresh object identity per render would re-run setData).
  const plan = useMemo(() => {
    if (replayActive) return { slots: [] as readonly number[], anchors: [] }; // replay: no whitespace
    return buildWhitespacePlan(candles, gaps ?? [], bucketSec);
  }, [candles, gaps, bucketSec, replayActive]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    // Ascending merged series: real-candle anchor rows (MERGE into the existing
    // time points of the real candles) + OHLC-free whitespace rows (NEW time
    // points = the missing slots). LWC `Time` is epoch SECONDS.
    const anchorRows: LineData<UTCTimestamp>[] = plan.anchors.map((a) => ({
      time: (a.time / 1000) as UTCTimestamp,
      value: a.value,
    }));
    const slotRows: WhitespaceData<UTCTimestamp>[] = plan.slots.map((t) => ({
      time: (t / 1000) as UTCTimestamp,
    }));
    const rows: (LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] = [
      ...anchorRows,
      ...slotRows,
    ].sort((a, b) => Number(a.time) - Number(b.time));
    try {
      series.setData(rows);
    } catch {
      /* non-ascending edge during a transient data swap — next effect repaints */
    }
  }, [plan]);

  return null;
}

