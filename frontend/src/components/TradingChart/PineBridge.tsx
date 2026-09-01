import { useEffect, useRef } from "react";
import {
  AreaSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineWidth,
  type SeriesMarker,
  type Time,
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
  type PineMarkerPoint,
  type PineVisual,
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

// ── chart-state types ────────────────────────────────────────────────────────

/** Series we own for data-driven visuals (line/histogram/area). */
type DataEntry = {
  series: ISeriesApi<"Line"> | ISeriesApi<"Histogram"> | ISeriesApi<"Area">;
  kind: "line" | "histogram" | "area";
  stepLine: boolean;
  /** Painted-shape guard: setData (shape change) vs update (forming tick). */
  painted: { count: number; firstTs: number; lastTs: number } | null;
};

/**
 * Everything the bridge owns for one imported indicator. Markers and price
 * lines need a HOST series: overlay scripts anchor to the chart's candle
 * series; separate-pane scripts anchor to their own first data series, or an
 * invisible "carrier" series created on demand (fed with the candle closes).
 */
type IndicatorChartState = {
  paneIndex: number;
  data: Map<string, DataEntry>;
  carriers: Map<number, ISeriesApi<"Line">>;
  markerPlugins: Map<number, ISeriesMarkersPluginApi<Time>>;
  priceLines: IPriceLine[];
  priceLineSig: string;
  priceLineHost: ISeriesApi<"Line"> | null;
};

/**
 * Renders every ENABLED imported Pine indicator through the SHARED
 * PineIndicatorEngine — the exact same generic execution architecture as
 * EmaBridge (authoritative `effectiveCloseSeries` input, memoized runs, no
 * re-transpile per frame). ONE engine instance serves all imported
 * indicators; each `computeScriptVisuals` call compiles once and extracts ALL
 * of the script's renderable outputs from a single PineTS run.
 *
 * Visual coverage (PineTS 0.9.33 — verified at runtime):
 *   plot() line/stepline  → LineSeries (LineType.WithSteps for steplines)
 *   plot(style_histogram|columns) → HistogramSeries (base 0, per-bar colors)
 *   plot(style_area)      → AreaSeries
 *   hline(price, …)       → createPriceLine on the pane's anchor series
 *   plotshape()/plotchar()→ LWC series markers (createSeriesMarkers):
 *                           triangle/arrow → arrowUp/arrowDown, circle/square
 *                           kept; char renders as circle + its character as
 *                           text (LWC cannot draw arbitrary glyphs — documented
 *                           limitation, never faked as lines).
 *
 * Data flow (identical guarantees as EmaBridge — doji-bug safe):
 *   IG tick → WS candle snapshot → liveCandle prop → effectiveCloseSeries()
 *   → PineIndicatorEngine → PineVisual[] → Lightweight Charts series/markers.
 * The rAF-animated close is NEVER an input; background tabs stay safe.
 *
 * Panes: overlay=true scripts paint on the main price pane (priceScaleId
 * "right", markers/price lines anchor to the candle series); overlay=false
 * scripts each get their own native LWC pane (addSeries(…, paneIndex)).
 */
export function PineBridge({ bars, liveCandle, bucketSec, indicators, onStatus }: Props) {
  const api = useChartApi();
  const engineRef = useRef<PineIndicatorEngine>(new PineIndicatorEngine());
  /** Per-indicator chart state (series, markers, price lines). */
  const stateRef = useRef<Map<string, IndicatorChartState>>(new Map());
  /** Signature of the last-built layout (avoids rebuilds on input edits). */
  const layoutSigRef = useRef<string>("");
  /** Last reported status per id — only changes are pushed to App. */
  const lastStatusRef = useRef<Map<string, string>>(new Map());
  const indicatorsRef = useRef<readonly ImportedPineIndicator[]>(indicators);
  indicatorsRef.current = indicators;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const newState = (paneIndex: number): IndicatorChartState => ({
    paneIndex,
    data: new Map(),
    carriers: new Map(),
    markerPlugins: new Map(),
    priceLines: [],
    priceLineSig: "",
    priceLineHost: null,
  });

  /** Desired pane assignment: overlay → 0, each separate-pane script → 1..n. */
  const desiredLayout = (list: readonly ImportedPineIndicator[]): { id: string; overlay: boolean; paneIndex: number }[] => {
    const out: { id: string; overlay: boolean; paneIndex: number }[] = [];
    let pane = 1;
    for (const ind of list) {
      if (!ind.enabled) continue;
      out.push({ id: ind.id, overlay: ind.overlay, paneIndex: ind.overlay ? 0 : pane++ });
    }
    return out;
  };

  const report = (id: string, status: PineRunStatus): void => {
    const sig = status.ok ? "ok" : `err:${status.message ?? ""}`;
    if (lastStatusRef.current.get(id) === sig) return;
    lastStatusRef.current.set(id, sig);
    onStatusRef.current?.(id, status);
  };

  /** Clear one indicator's painted outputs (data, markers, price lines). */
  const clearPainted = (st: IndicatorChartState): void => {
    for (const entry of st.data.values()) {
      try {
        entry.series.setData([]);
      } catch {
        /* series gone (chart recreated) */
      }
      entry.painted = null;
    }
    for (const plugin of st.markerPlugins.values()) {
      try {
        plugin.setMarkers([]);
      } catch {
        /* plugin gone */
      }
    }
    removePriceLines(st);
  };

  const removePriceLines = (st: IndicatorChartState): void => {
    if (!st.priceLineHost) return;
    for (const line of st.priceLines) {
      try {
        st.priceLineHost.removePriceLine(line);
      } catch {
        /* series gone */
      }
    }
    st.priceLines = [];
    st.priceLineSig = "";
  };

  /** Tear down EVERYTHING owned by the bridge (series, carriers, panes). */
  const teardownAll = (chart: IChartApi): void => {
    for (const st of stateRef.current.values()) {
      const series: ISeriesApi<"Line">[] = [
        ...[...st.data.values()].map((e) => e.series as ISeriesApi<"Line">),
        ...st.carriers.values(),
      ];
      for (const s of series) {
        try {
          chart.removeSeries(s);
        } catch {
          /* chart already torn down */
        }
      }
    }
    stateRef.current = new Map();
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
  };

  // ── creation helpers ───────────────────────────────────────────────────────

  const toLineData = (p: { ts: number; value: number; color?: string }) => ({
    time: (p.ts / 1000) as UTCTimestamp,
    value: p.value,
    ...(p.color ? { color: p.color } : {}),
  });

  /** Hex (#RGB/#RRGGBB/#RRGGBBAA) → rgba() with the given alpha (area fills). */
  const withAlpha = (color: string, alpha: number): string => {
    let c = color.trim();
    const m3 = /^#([0-9a-f]{3})([0-9a-f]{2})?$/i.exec(c);
    if (m3 && !m3[2]) {
      // #RGB → #RRGGBB (each digit doubled)
      c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    }
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
    if (!m) return color;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const ownAlpha = m[2] ? parseInt(m[2], 16) / 255 : 1;
    return `rgba(${r}, ${g}, ${b}, ${(Math.max(0, Math.min(1, alpha)) * ownAlpha).toFixed(3)})`;
  };

  type HorizontalVisual = Extract<PineVisual, { type: "horizontal" }>;

  /**
   * Sync one indicator's chart state to a fresh PineVisual[] — creates series/
   * plugins lazily, repaints data (setData on shape change, update on forming
   * tick), (re)draws price lines and merges markers. Returns true when
   * anything was visibly painted this run.
   */
  const applyVisuals = (
    chart: IChartApi,
    st: IndicatorChartState,
    visuals: PineVisual[],
    candleSeries: ISeriesApi<"Line"> | null,
    barsNow: readonly Bar[],
  ): boolean => {
    const seenData = new Set<string>();
    const markers: SeriesMarker<Time>[] = [];
    const hlines = visuals.filter((v): v is HorizontalVisual => v.type === "horizontal");
    let paintedAny = false;

    for (const v of visuals) {
      if (v.type === "line" || v.type === "histogram" || v.type === "area") {
        const ident = v.key;
        seenData.add(ident);
        let entry = st.data.get(ident);
        if (!entry || entry.kind !== v.type || (v.type === "line" && entry.stepLine !== v.stepLine)) {
          if (entry) {
            try {
              chart.removeSeries(entry.series as ISeriesApi<"Line">);
            } catch {
              /* already gone */
            }
            st.data.delete(ident);
            entry = undefined;
          }
          try {
            const base = {
              priceLineVisible: false,
              ...(st.paneIndex === 0 ? { priceScaleId: "right" } : {}),
            };
            const color = v.color ?? "#38bdf8";
            // histogram visuals carry no script linewidth — default 2.
            const width = ((v.type === "histogram" ? undefined : v.lineWidth) ?? 2) as LineWidth;
            if (v.type === "line") {
              const s = chart.addSeries(
                LineSeries,
                {
                  ...base,
                  color,
                  lineWidth: width,
                  lineType: v.stepLine ? LineType.WithSteps : LineType.Simple,
                  pointMarkersVisible: false,
                  crosshairMarkerRadius: 3,
                },
                st.paneIndex,
              );
              entry = { series: s, kind: "line", stepLine: v.stepLine, painted: null };
            } else if (v.type === "histogram") {
              const s = chart.addSeries(HistogramSeries, { ...base, color }, st.paneIndex);
              entry = { series: s, kind: "histogram", stepLine: false, painted: null };
            } else {
              const s = chart.addSeries(
                AreaSeries,
                {
                  ...base,
                  lineColor: color,
                  topColor: withAlpha(color, 0.35),
                  bottomColor: withAlpha(color, 0.04),
                  lineWidth: width,
                },
                st.paneIndex,
              );
              entry = { series: s, kind: "area", stepLine: false, painted: null };
            }
            st.data.set(ident, entry);
          } catch {
            continue; // series creation failed (pane gone) — skip this visual
          }
        }
        entry = entry!;
        if (entry.kind !== v.type) continue;
        const series = entry.series as ISeriesApi<"Line">;
        try {
          if (v.data.length === 0) {
            if (entry.painted !== null) {
              series.setData([]);
              entry.painted = null;
            }
            continue;
          }
          const first = v.data[0]!;
          const last = v.data[v.data.length - 1]!;
          const shapeUnchanged =
            entry.painted !== null &&
            entry.painted.count === v.data.length &&
            entry.painted.firstTs === first.ts &&
            entry.painted.lastTs === last.ts;
          if (shapeUnchanged) {
            // Only the forming bucket's values moved — replace the last point.
            series.update(toLineData(last));
          } else {
            series.setData(v.data.map(toLineData));
            entry.painted = { count: v.data.length, firstTs: first.ts, lastTs: last.ts };
          }
          paintedAny = true;
        } catch {
          /* series gone (chart recreated) — re-created by the layout effect */
        }
      } else if (v.type === "marker") {
        for (const m of v.data as PineMarkerPoint[]) {
          markers.push({
            time: (m.ts / 1000) as UTCTimestamp,
            position: m.position,
            shape: m.shape,
            color: m.color ?? "#38bdf8",
            ...(m.text ? { text: m.text } : {}),
          });
        }
      }
    }
    // Markers: LWC requires time-sorted arrays; one merged set per pane.
    const plugin =
      markers.length > 0
        ? ensureMarkerPlugin(chart, st, candleSeries, barsNow)
        : st.markerPlugins.get(st.paneIndex) ?? null;
    if (plugin) {
      try {
        markers.sort((a, b) => (a.time as number) - (b.time as number));
        plugin.setMarkers(markers);
        if (markers.length > 0) paintedAny = true;
      } catch {
        /* plugin/series gone */
      }
    }

    // hlines → price lines on the pane's host (candle series for overlays).
    const hlineSig = hlines
      .map((h) => `${h.key}:${h.price}:${h.color ?? ""}:${h.lineWidth ?? 1}:${h.lineStyle}`)
      .join("|");
    if (hlines.length > 0) {
      const host = priceLineHostFor(chart, st, candleSeries, barsNow);
      if (host && hlineSig !== st.priceLineSig) {
        removePriceLines(st);
        st.priceLineHost = host;
        for (const h of hlines) {
          try {
            st.priceLines.push(
              host.createPriceLine({
                price: h.price,
                color: h.color ?? "#787b86",
                lineWidth: (h.lineWidth ?? 1) as LineWidth,
                lineStyle:
                  h.lineStyle === "dotted"
                    ? LineStyle.Dotted
                    : h.lineStyle === "dashed"
                      ? LineStyle.Dashed
                      : LineStyle.Solid,
                title: h.title,
                axisLabelVisible: true,
              }),
            );
          } catch {
            /* host series gone */
          }
        }
        st.priceLineSig = hlineSig;
        if (st.priceLines.length > 0) paintedAny = true;
      }
    } else if (st.priceLineSig !== "") {
      removePriceLines(st);
    }

    // Visuals that vanished from this run (e.g. warmup-only) stop painting.
    for (const [ident, entry] of st.data) {
      if (!seenData.has(ident) && entry.painted !== null) {
        try {
          (entry.series as ISeriesApi<"Line">).setData([]);
        } catch {
          /* series gone */
        }
        entry.painted = null;
      }
    }

    return paintedAny;
  };

  // ── effects ────────────────────────────────────────────────────────────────

  // Controller lifecycle — full teardown + engine reset when the chart
  // controller changes (chart recreation).
  useEffect(() => {
    if (!api) return;
    const chart: IChartApi = api.controller.getChart();
    layoutSigRef.current = JSON.stringify(desiredLayout(indicators));
    return () => {
      teardownAll(chart);
      lastStatusRef.current = new Map();
      layoutSigRef.current = "";
      engineRef.current.dispose();
      engineRef.current = new PineIndicatorEngine();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Layout change (import / remove / enable / overlay flag) → full rebuild.
  // Series are created lazily by the data effect; this only needs to clear.
  useEffect(() => {
    if (!api) return;
    const sig = JSON.stringify(desiredLayout(indicators));
    if (sig === layoutSigRef.current) return;
    layoutSigRef.current = sig;
    teardownAll(api.controller.getChart());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, indicators]);

  // Data — recompute from the authoritative candle state on every candle
  // frame / history load / indicator or input change. setCandles and the
  // result cache short-circuit everything that didn't actually change.
  useEffect(() => {
    if (!api) return;
    const chart: IChartApi = api.controller.getChart();
    // CandleKit's candle series hosts overlay markers + price lines. Cast:
    // those APIs are series-type independent (documented in the header).
    const candleSeries = (api.controller as unknown as { getSeries?: () => unknown }).getSeries?.() as
      | ISeriesApi<"Line">
      | undefined
      | null;
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
        const ind = indicatorsRef.current.find((x) => x.id === s.id);
        if (!ind) return;

        let st = stateRef.current.get(s.id);
        if (!st) {
          st = newState(s.paneIndex);
          stateRef.current.set(s.id, st);
        }
        st.paneIndex = s.paneIndex;

        let rawError: string | null = null;
        let run: { visuals: PineVisual[] } | null = null;
        try {
          run = await engineRef.current.computeScriptVisuals(
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

        if (run === null) {
          clearPainted(st);
          report(s.id, { ok: false, message: friendlyPineError(rawError ?? "Pine Script execution failed") });
          return;
        }

        const painted = applyVisuals(chart, st, run.visuals, candleSeries ?? null, bars);
        report(
          s.id,
          painted
            ? { ok: true }
            : {
                ok: false,
                message:
                  run.visuals.length === 0
                    ? "Compiled — but nothing AURA can render (see the indicator's import details)."
                    : "No finite values yet — waiting for enough candles.",
              },
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

  /** Invisible per-pane anchor series so markers/price lines always have a host. */
  const ensureCarrier = (
    chart: IChartApi,
    st: IndicatorChartState,
    barsNow: readonly Bar[],
  ): ISeriesApi<"Line"> | null => {
    const existing = st.carriers.get(st.paneIndex);
    if (existing) return existing;
    let carrier: ISeriesApi<"Line"> | null = null;
    try {
      carrier = chart.addSeries(
        LineSeries,
        {
          color: "rgba(0,0,0,0)",
          lineWidth: 1,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
          pointMarkersVisible: false,
          ...(st.paneIndex === 0 ? { priceScaleId: "right" } : {}),
        },
        st.paneIndex,
      );
      // Feed the candle closes so markers/price lines have bar anchors.
      carrier.setData(
        (barsNow as readonly { ts: number; close: number }[]).map((b) => ({
          time: (b.ts / 1000) as UTCTimestamp,
          value: b.close,
        })),
      );
      st.carriers.set(st.paneIndex, carrier);
    } catch {
      /* older LWC without pane support */
    }
    return carrier;
  };

  /** Marker plugin per pane — overlays anchor to the candle series, panes to a carrier. */
  const ensureMarkerPlugin = (
    chart: IChartApi,
    st: IndicatorChartState,
    candleSeries: ISeriesApi<"Line"> | null,
    barsNow: readonly Bar[],
  ): ISeriesMarkersPluginApi<Time> | null => {
    const existing = st.markerPlugins.get(st.paneIndex);
    if (existing) return existing;
    const host = st.paneIndex === 0 && candleSeries ? candleSeries : ensureCarrier(chart, st, barsNow);
    if (!host) return null;
    try {
      const plugin = createSeriesMarkers(host, []);
      st.markerPlugins.set(st.paneIndex, plugin);
      return plugin;
    } catch {
      return null;
    }
  };

  /** Price-line host: candle series for overlays, else own/carrier series. */
  const priceLineHostFor = (
    chart: IChartApi,
    st: IndicatorChartState,
    candleSeries: ISeriesApi<"Line"> | null,
    barsNow: readonly Bar[],
  ): ISeriesApi<"Line"> | null => {
    if (st.priceLineHost) return st.priceLineHost;
    if (st.paneIndex === 0 && candleSeries) return candleSeries;
    for (const entry of st.data.values()) return entry.series as ISeriesApi<"Line">;
    return ensureCarrier(chart, st, barsNow);
  };