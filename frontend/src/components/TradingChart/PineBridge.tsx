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
  friendlyPineError,
  type ImportedPineIndicator,
  type PineRunStatus,
} from "../../services/pineImport";
import {
  PineIndicatorEngine,
  type PineBar,
  type PineLiveCandle,
  type PineSeries,
} from "../../services/pineEngine";
import type { RealtimeCandleMsg } from "../../services/realtime";

interface Props {
  /** The chart's bucket-aligned candles (history or live-only accumulation). */
  bars: readonly Bar[];
  /** Latest forming candle pushed by the backend (time = bucket start, epoch s). */
  liveCandle: RealtimeCandleMsg | null;
  /** Selected timeframe bucket size in seconds (60 = 1m, 180 = 3m). */
  bucketSec: number;
  /** Imported Pine indicators (localStorage-persisted in App). */
  indicators: readonly ImportedPineIndicator[];
  /** Runtime status reporter (status-change guarded; safe to call every frame). */
  onStatus?: (id: string, status: PineRunStatus) => void;
}

/** One line-data point for LWC (epoch seconds — the chart's time base). */
const toLineData = (p: { ts: number; value: number; color?: string }) => ({
  time: (p.ts / 1000) as UTCTimestamp,
  value: p.value,
  ...(p.color ? { color: p.color } : {}),
});

interface DesiredSeries {
  id: string;
  overlay: boolean;
  paneIndex: number;
  plotKeys: string[];
}

interface SeriesEntry {
  series: ISeriesApi<"Line">;
}

/**
 * Renders every ENABLED imported Pine indicator through the SHARED
 * PineIndicatorEngine — the exact same generic execution architecture as
 * EmaBridge (authoritative `effectiveCloseSeries` input, memoized runs, no
 * re-transpile per frame). ONE engine instance serves all imported
 * indicators: each `computeScript` call compiles once and extracts ALL of the
 * script's `plot()` lines from a single PineTS run.
 *
 * Data flow (identical guarantees as EmaBridge — doji-bug safe):
 *   IG tick → WS candle snapshot → liveCandle prop → effectiveCloseSeries()
 *   → PineIndicatorEngine → plots → Lightweight Charts series.
 * The rAF-animated close is NEVER an input; background tabs stay safe.
 *
 * Panes: overlay=true scripts paint on the main price pane (priceScaleId
 * "right"); overlay=false scripts each get their own native LWC pane
 * (addSeries(…, paneIndex) — Lightweight Charts 5 creates panes on demand).
 */
export function PineBridge({ bars, liveCandle, bucketSec, indicators, onStatus }: Props) {
  const api = useChartApi();
  const engineRef = useRef<PineIndicatorEngine>(new PineIndicatorEngine());
  /** `${id}|${plotKey}` → its LWC line series. */
  const entriesRef = useRef<Map<string, SeriesEntry>>(new Map());
  /** Per-series painted shape, to decide setData (shape change) vs update (tick). */
  const paintedRef = useRef<Map<string, { count: number; firstTs: number; lastTs: number }>>(new Map());
  /** Signature of the last-built series layout (avoids rebuilds on input edits). */
  const layoutSigRef = useRef<string>("");
  /** Last reported status per id — only changes are pushed to App. */
  const lastStatusRef = useRef<Map<string, string>>(new Map());
  const indicatorsRef = useRef<readonly ImportedPineIndicator[]>(indicators);
  indicatorsRef.current = indicators;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  /**
   * Desired series layout for the current indicator list. Enabled only;
   * overlay scripts → pane 0, each non-overlay script → its own pane (1..n).
   */
  const desiredLayout = (list: readonly ImportedPineIndicator[]): DesiredSeries[] => {
    const out: DesiredSeries[] = [];
    let pane = 1;
    for (const ind of list) {
      if (!ind.enabled || ind.plotMeta.length === 0) continue;
      out.push({
        id: ind.id,
        overlay: ind.overlay,
        paneIndex: ind.overlay ? 0 : pane++,
        plotKeys: ind.plotMeta.map((p) => p.key),
      });
    }
    return out;
  };

  const clearSeries = (id: string, plotKey: string): void => {
    const entry = entriesRef.current.get(`${id}|${plotKey}`);
    if (!entry) return;
    try {
      entry.series.setData([]);
    } catch {
      /* series gone (chart recreated) */
    }
    paintedRef.current.delete(`${id}|${plotKey}`);
  };

  const report = (id: string, status: PineRunStatus): void => {
    const sig = status.ok ? "ok" : `err:${status.message ?? ""}`;
    if (lastStatusRef.current.get(id) === sig) return;
    lastStatusRef.current.set(id, sig);
    onStatusRef.current?.(id, status);
  };

  /** Tear down every imported series (and empty extra panes) and rebuild. */
  const rebuildSeries = (chart: IChartApi): void => {
    for (const entry of entriesRef.current.values()) {
      try {
        chart.removeSeries(entry.series);
      } catch {
        /* chart already torn down */
      }
    }
    entriesRef.current = new Map();
    paintedRef.current = new Map();
    // Drop leftover panes (descending so indices stay valid during removal).
    try {
      const paneCount = chart.panes().length;
      for (let i = paneCount - 1; i >= 1; i--) {
        try {
          chart.removePane(i);
        } catch {
          /* pane already gone */
        }
      }
    } catch {
      /* older LWC without panes — overlay-only */
    }

    for (const s of desiredLayout(indicatorsRef.current)) {
      const ind = indicatorsRef.current.find((x) => x.id === s.id);
      if (!ind) continue;
      for (const plotKey of s.plotKeys) {
        const meta = ind.plotMeta.find((p) => p.key === plotKey);
        try {
          const series = chart.addSeries(
            LineSeries,
            {
              color: meta?.color ?? "#38bdf8",
              lineWidth: (meta?.linewidth ?? 2) as LineWidth,
              // Overlay scripts share the main price scale; separate panes
              // own their scale implicitly.
              ...(s.overlay ? { priceScaleId: "right" } : {}),
              priceLineVisible: false,
              lastValueVisible: true,
              pointMarkersVisible: false,
              crosshairMarkerRadius: 3,
            },
            s.overlay ? 0 : s.paneIndex,
          );
          entriesRef.current.set(`${s.id}|${plotKey}`, { series });
        } catch {
          /* older LWC without pane support — skip this series */
        }
      }
    }
  };

  // Series lifecycle — rebuild when the chart controller changes or when the
  // series LAYOUT changes (import / remove / enable / overlay / plot keys).
  // Input-value edits keep the same layout signature → no rebuild, no flicker.
  useEffect(() => {
    if (!api) return;
    const chart: IChartApi = api.controller.getChart();
    const sig = JSON.stringify(desiredLayout(indicators));
    layoutSigRef.current = sig;
    rebuildSeries(chart);
    return () => {
      for (const entry of entriesRef.current.values()) {
        try {
          chart.removeSeries(entry.series);
        } catch {
          /* chart already torn down */
        }
      }
      entriesRef.current = new Map();
      paintedRef.current = new Map();
      layoutSigRef.current = "";
      engineRef.current.dispose();
      engineRef.current = new PineIndicatorEngine();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    if (!api) return;
    const sig = JSON.stringify(desiredLayout(indicators));
    if (sig === layoutSigRef.current) return;
    layoutSigRef.current = sig;
    rebuildSeries(api.controller.getChart());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, indicators]);

  // Data — recompute from the authoritative candle state on every candle
  // frame / history load / indicator or input change. setCandles and the
  // result cache short-circuit everything that didn't actually change.
  useEffect(() => {
    if (!api) return;
    const pineBars = (bars as readonly Bar[]) as readonly PineBar[];
    const pineLive: PineLiveCandle | null = liveCandle
      ? {
          time: liveCandle.time,
          open: liveCandle.open,
          high: liveCandle.high,
          low: liveCandle.low,
          close: liveCandle.close,
          volume: liveCandle.volume,
        }
      : null;
    engineRef.current.setCandles(pineBars, pineLive, bucketSec);

    void Promise.all(
      desiredLayout(indicators).map(async (s) => {
        const ind = indicators.find((x) => x.id === s.id);
        if (!ind) return;

        let rawError: string | null = null;
        let result: Map<string, PineSeries> | null = null;
        try {
          result = await engineRef.current.computeScript(
            {
              id: s.id,
              source: ind.source,
              bindings: ind.inputMeta.map((m) => ({ title: m.title, paramKey: m.varId })),
            },
            ind.inputs,
            (raw) => {
              rawError = raw;
            },
          );
        } catch (e) {
          rawError = e instanceof Error ? e.message : String(e);
        }

        if (result === null) {
          for (const plotKey of s.plotKeys) clearSeries(s.id, plotKey);
          report(s.id, { ok: false, message: friendlyPineError(rawError ?? "Pine Script execution failed") });
          return;
        }
        if (result.size === 0) {
          for (const plotKey of s.plotKeys) clearSeries(s.id, plotKey);
          report(s.id, { ok: false, message: "No renderable plot() lines in this script." });
          return;
        }

        let paintedAny = false;
        for (const [plotKey, pineSeries] of result) {
          const entry = entriesRef.current.get(`${s.id}|${plotKey}`);
          if (!entry) continue;
          const painted = paintedRef.current.get(`${s.id}|${plotKey}`);
          try {
            entry.series.applyOptions({
              color: pineSeries.color ?? "#38bdf8",
              lineWidth: (pineSeries.linewidth ?? 2) as LineWidth,
            });
          } catch {
            /* noop */
          }
          if (pineSeries.points.length === 0) {
            clearSeries(s.id, plotKey);
            continue;
          }
          const first = pineSeries.points[0];
          const last = pineSeries.points[pineSeries.points.length - 1];
          const shapeUnchanged =
            painted !== undefined &&
            painted.count === pineSeries.points.length &&
            painted.firstTs === first.ts &&
            painted.lastTs === last.ts;
          try {
            if (shapeUnchanged) {
              // Only the forming bucket's values moved — replace the last point.
              entry.series.update(toLineData(last));
            } else {
              entry.series.setData(pineSeries.points.map(toLineData));
              paintedRef.current.set(`${s.id}|${plotKey}`, {
                count: pineSeries.points.length,
                firstTs: first.ts,
                lastTs: last.ts,
              });
            }
            paintedAny = true;
          } catch {
            /* series gone (chart recreated) — re-created by the layout effect */
          }
        }
        report(
          s.id,
          paintedAny
            ? { ok: true }
            : { ok: false, message: "No finite plot values yet — waiting for enough candles." },
        );
      }),
    ).catch(() => {
      /* one bad indicator must not break the others */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, bars, liveCandle, bucketSec, indicators]);

  // Pure chart-side bridge: nothing rendered into the DOM.
  return null;
}
