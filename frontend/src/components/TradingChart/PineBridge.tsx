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
  buildPlotMeta,
  pineInputBindings,
  type ImportedPineIndicator,
  type PinePlotMetaSnapshot,
  type PineRunStatus,
} from "../../services/pineImport";
import {
  type PineBar,
  type PineFillPoint,
  type PineLiveCandle,
  type PineMarkerPoint,
  type PineScriptEngine,
  type PineSymbolMeta,
  type PineVisual,
} from "../../services/pineEngineTypes";
import { createPineEngine } from "../../services/pineEngineFactory";
import { CoalescedFlights } from "../../services/pineCoalesce";
import type { PineLineStyle, PinePlotStyleOverride, PineStyleOverrides } from "../../services/pineStyle";
import type { RealtimeCandleMsg } from "../../services/realtime";
import { PineLabelPrimitive } from "./pineLabelPrimitive";
import { PineLineBoxPrimitive } from "./pineLineBoxPrimitive";
import { PineFillPrimitive, type PineFillRegion } from "./pineFillPrimitive";
import { linebrIdBase, linebrSegmentsToDrawings } from "../../services/pineDrawings";

/** Stable empty identity — optional-prop absence never changes effect deps. */
const EMPTY_SLOTS: readonly number[] = [];
/** Stable empty style-overrides map for indicators without a Style tab. */
const EMPTY_STYLE: PineStyleOverrides = {};

interface Props {
  /** The chart's bucket-aligned candles (history or live-only accumulation). */
  bars: readonly Bar[];
  /** Latest forming candle pushed by the backend (time = bucket start, epoch s). */
  liveCandle: RealtimeCandleMsg | null;
  /** Selected timeframe bucket size in seconds (60 = 1m, 180 = 3m). */
  bucketSec: number;
  /** Imported Pine indicators (localStorage-persisted in App). */
  indicators: readonly ImportedPineIndicator[];
  /** Active instrument metadata → syminfo (mintick etc.). */
  symbol?: PineSymbolMeta | null;
  /** Runtime status reporter (status-change guarded; safe to call every frame). */
  onStatus?: (id: string, status: PineRunStatus) => void;
  /**
   * Runtime Style-tab healer. After each successful engine run this reports the
   * freshly-built plotMeta (declared outputs ∪ rendered visuals — see
   * `buildPlotMeta`) so App can REPLACE an already-imported indicator's stale,
   * frozen-at-import `plotMeta`. Without this, an indicator imported before the
   * declared-output capture would keep missing the conditional / warmup-only
   * Style rows (the fractal_SMA.pine bug). The consumer must change-guard on
   * the array (identity-stable) so per-frame calls never loop.
   */
  onDeclared?: (id: string, plotMeta: PinePlotMetaSnapshot[]) => void;
  /**
   * Whitespace slot timestamps (epoch ms) the chart's time scale carries for
   * detected data gaps (WhitespaceBridge) — presentation-only metadata used to
   * remap drawing anchors onto the shifted logical grid. NEVER candle data:
   * the engine and all indicators keep running on real OHLC only.
   */
  whitespaceSlots?: readonly number[];
}

// ── chart-state types ────────────────────────────────────────────────────────

/** Series we own for data-driven visuals (line/histogram/area). */
type DataEntry = {
  series: ISeriesApi<"Line"> | ISeriesApi<"Histogram"> | ISeriesApi<"Area">;
  kind: "line" | "histogram" | "area";
  stepLine: boolean;
  /**
   * Pine `plot.style_linebr`. Tracked like `stepLine` so a script edit that
   * flips the style re-creates the entry instead of reusing one whose cached
   * `painted` shape guard was built for the other data shape.
   */
  breakOnNa: boolean;
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
  /** Renderer primitives for this indicator's `label.new()` drawings, per pane host. */
  labelPrimitives: Map<number, PineLabelPrimitive>;
  /** Renderer primitive for `force_overlay=true` labels (always pinned to the main pane). */
  overlayLabelPrimitive: PineLabelPrimitive | null;
  /** Renderer primitives for this indicator's `line.new()`/`box.new()` drawings, per pane host. */
  drawingPrimitives: Map<number, PineLineBoxPrimitive>;
  /** Overlay primitive for `force_overlay=true` lines/boxes (main pane). */
  overlayDrawingPrimitive: PineLineBoxPrimitive | null;
  /** Renderer primitives for this indicator's `fill()` regions, per pane host. */
  fillPrimitives: Map<number, PineFillPrimitive>;
  priceLines: IPriceLine[];
  priceLineSig: string;
  priceLineHost: ISeriesApi<"Line"> | null;
  /** Last-applied style overrides per visual key (style-change-only re-create). */
  styleSigRef: Map<string, string>;
};

/**
 * Renders every ENABLED imported Pine indicator through the SHARED
 * The configured Pine engine (services/pineEngineFactory) — the same generic
 * EmaBridge (authoritative `effectiveCloseSeries` input, memoized runs, no
 * re-transpile per frame). ONE engine instance serves all imported
 * indicators; each `computeScriptVisuals` call compiles once and extracts ALL
 * of the script's renderable outputs from a single engine run.
 *
 * Visual coverage (engine-verified at runtime):
 *   plot() line/stepline  → LineSeries (LineType.WithSteps for steplines)
 *   plot(style_histogram|columns) → HistogramSeries (base 0, per-bar colors)
 *   plot(style_area)      → AreaSeries
 *   hline(price, …)       → createPriceLine on the pane's anchor series
 *   plotshape()/plotchar()→ LWC series markers (createSeriesMarkers):
 *                           triangle/arrow → arrowUp/arrowDown, circle/square
 *                           kept; char renders as circle + its character as
 *                           text (LWC cannot draw arbitrary glyphs — documented
 *                           limitation, never faked as lines).
 *   label.new()           → pineLabelPrimitive canvas balloons
 *   line.new()/box.new()  → pineLineBoxPrimitive canvas lines/boxes
 *
 * Data flow (identical guarantees as EmaBridge — doji-bug safe):
 *   IG tick → WS candle snapshot → liveCandle prop → effectiveCloseSeries()
 *   → configured PineEngine → PineVisual[] → Lightweight Charts series/markers.
 * The rAF-animated close is NEVER an input; background tabs stay safe.
 *
 * Panes: overlay=true scripts paint on the main price pane (priceScaleId
 * "right", markers/price lines anchor to the candle series); overlay=false
 * scripts each get their own native LWC pane (addSeries(…, paneIndex)).
 */
export function PineBridge({
  bars,
  liveCandle,
  bucketSec,
  indicators,
  symbol,
  onStatus,
  onDeclared,
  whitespaceSlots,
}: Props) {
  // Whitespace slot timestamps for drawing-anchor remapping (see Props).
  const wsSlots = whitespaceSlots ?? EMPTY_SLOTS;
  const api = useChartApi();
  const engineRef = useRef<PineScriptEngine>(createPineEngine());
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

  // ── Per-indicator coalescing state ──────────────────────────────────────────
  // Killzone fix: at most ONE compute in flight per indicator. When realtime
  // frames arrive mid-flight we mark the indicator dirty (never enqueue) and
  // run exactly one follow-up when the flight resolves, against the engine's
  // latest candle state — so a slow drawing script stops being discarded by a
  // global generation counter that invalidates every computation on every tick.
  // Pure logic in services/pineCoalesce.ts (Node-testable).
  const flightsRef = useRef<CoalescedFlights>(new CoalescedFlights());

  // Latest-input refs — a dirty follow-up must re-read the CURRENT values
  // (not the effect closure that scheduled it), so the engine and the renderer
  // always act on the newest candles / forming bar.
  const barsRef = useRef<readonly Bar[]>(bars);
  barsRef.current = bars;
  const liveCandleRef = useRef<RealtimeCandleMsg | null>(liveCandle);
  liveCandleRef.current = liveCandle;
  const bucketSecRef = useRef<number>(bucketSec);
  bucketSecRef.current = bucketSec;
  const symbolRef = useRef<PineSymbolMeta | null>(symbol ?? null);
  symbolRef.current = symbol ?? null;

  const newState = (paneIndex: number): IndicatorChartState => ({
    paneIndex,
    data: new Map(),
    carriers: new Map(),
    markerPlugins: new Map(),
    labelPrimitives: new Map(),
    overlayLabelPrimitive: null,
    drawingPrimitives: new Map(),
    overlayDrawingPrimitive: null,
    fillPrimitives: new Map(),
    priceLines: [],
    priceLineSig: "",
    priceLineHost: null,
    styleSigRef: new Map(),
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

  /** Clear one indicator's painted outputs (data, markers, price lines, labels). */
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
    for (const prim of st.labelPrimitives.values()) {
      try {
        prim.setLabels([]);
      } catch {
        /* primitive gone */
      }
    }
    if (st.overlayLabelPrimitive) {
      try {
        st.overlayLabelPrimitive.setLabels([]);
      } catch {
        /* primitive gone */
      }
    }
    for (const prim of st.drawingPrimitives.values()) {
      try {
        prim.setDrawings([], []);
      } catch {
        /* primitive gone */
      }
    }
    if (st.overlayDrawingPrimitive) {
      try {
        st.overlayDrawingPrimitive.setDrawings([], []);
      } catch {
        /* primitive gone */
      }
    }
    for (const prim of st.fillPrimitives.values()) {
      try {
        prim.setFills([]);
      } catch {
        /* primitive gone */
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
    // Cancel every in-flight computation: any pending result becomes stale and
    // can never paint into the rebuilt chart; dirty follow-ups are dropped too.
    flightsRef.current.cancelAll();
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

  const toLineData = (
    p: { ts: number; value?: number; color?: string },
    stripColor = false,
  ) => ({
    time: (p.ts / 1000) as UTCTimestamp,
    // NO value => a pure WHITESPACE row ({ time } only). That is LWC's native
    // line-break mechanism: nothing is drawn across the bar, so the points
    // either side are NEVER joined — exactly Pine's `plot.style_linebr`.
    // Non-linebr plots emit no such rows, so their payload is unchanged.
    ...(typeof p.value === "number" ? { value: p.value } : {}),
    // A uniform color override replaces per-bar script colors entirely.
    ...(!stripColor && p.color ? { color: p.color } : {}),
  });

  /**
   * Resolve the style override the renderer should apply for one visual:
   * falls back to the script's own options when the override is absent (
   * `style[visualKey]`), preserving the exact current appearance.
   */
  const resolveStyle = (
    style: PineStyleOverrides,
    key: string,
    scriptColor: string | null,
    scriptWidth: number | null,
  ): { color: string | null; width: number | null; lineStyle: PineLineStyle | null } => {
    const o: PinePlotStyleOverride | undefined = style[key];
    if (!o) return { color: scriptColor, width: scriptWidth, lineStyle: null };
    return {
      color: typeof o.color === "string" ? o.color : scriptColor,
      width: typeof o.lineWidth === "number" ? o.lineWidth : scriptWidth,
      lineStyle: typeof o.lineStyle === "string" ? o.lineStyle : null,
    };
  };

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

  /**
   * Resolve one fill() visual into a PineFillRegion under its style override.
   *
   * Rules (mirroring the plot color rules):
   *   - No override ⇒ keep the script's per-bar / static colors verbatim.
   *   - `color` override ⇒ a uniform fill color that REPLACES every per-bar
   *     script color (the per-bar colors are stripped so the override is
   *     complete; the fill's own boundaries are untouched).
   *   - `opacity` override ⇒ the fill's alpha, applied to whichever color wins
   *     (override color, else the script color). The boundary PLOTS' colors are
   *     never touched — only the fill band is affected.
   * The region's `color` is the fallback for bars that carry no per-bar color.
   */
  const resolveFill = (
    style: PineStyleOverrides,
    key: string,
    scriptColor: string | null,
    data: readonly PineFillPoint[],
  ): PineFillRegion => {
    const o: PinePlotStyleOverride | undefined = style[key];
    const overrideColor = typeof o?.color === "string" ? o.color : null;
    const opacity = typeof o?.opacity === "number" ? Math.max(0, Math.min(1, o.opacity)) : null;
    const base = overrideColor ?? scriptColor ?? null;
    // Region fallback color (bars with no per-bar color): apply opacity on top.
    let regionColor = base ?? "#2962FF33";
    if (opacity !== null) {
      const src = base ?? "#2962FF";
      regionColor = withAlpha(src.startsWith("#") ? src : "#2962FF", opacity);
    }
    // When a color override is active, strip the per-bar colors so the uniform
    // override wins; otherwise preserve the script's per-bar colors exactly.
    const stripPerBar = overrideColor !== null;
    const points: PineFillPoint[] = stripPerBar
      ? data.map((p) => ({ ts: p.ts, ...(p.top !== undefined ? { top: p.top } : {}), ...(p.bottom !== undefined ? { bottom: p.bottom } : {}) }))
      : data.map((p) => ({
          ts: p.ts,
          ...(p.top !== undefined ? { top: p.top } : {}),
          ...(p.bottom !== undefined ? { bottom: p.bottom } : {}),
          // Apply an opacity override to the script's own per-bar color too.
          ...(p.color && opacity !== null
            ? { color: withAlpha(p.color.startsWith("#") ? p.color : "#2962FF", opacity) }
            : p.color
              ? { color: p.color }
              : {}),
        }));
    return { points, color: regionColor };
  };

  type HorizontalVisual = Extract<PineVisual, { type: "horizontal" }>;
type LinesVisual = Extract<PineVisual, { type: "lines" }>;
type BoxesVisual = Extract<PineVisual, { type: "boxes" }>;

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
    style: PineStyleOverrides,
  ): boolean => {
    const seenData = new Set<string>();
    const markers: SeriesMarker<Time>[] = [];
    const hlines = visuals.filter((v): v is HorizontalVisual => v.type === "horizontal");
    let paintedAny = false;
    /** True when THIS run carried a labels visual — its absence clears old drawings. */
    let seenLabels = false;
    /** True when THIS run carried a line/box visual — its absence clears old drawings. */
    let seenDrawings = false;
    /** A plot.style_linebr visual was seen this run (it owns the drawing primitive,
     *  so its segments must be re-pushed even when a run yields zero of them). */
    let sawLinebr = false;
    /** A fill() visual was seen this run (owns the fill primitive, so it must be
     *  re-pushed even when every bar is a gap). */
    let sawFill = false;
    // Merged line/box drawings for this run (both visuals feed ONE primitive).
    const paneLines: LinesVisual["lines"] = [];
    const overlayLines: LinesVisual["lines"] = [];
    const paneBoxes: BoxesVisual["boxes"] = [];
    const overlayBoxes: BoxesVisual["boxes"] = [];
    // Merged fill regions for this run (all fill() visuals feed ONE primitive).
    const paneFills: PineFillRegion[] = [];

    // Anchor context for the drawing primitives: real-candle times (engine
    // space) + the chart's whitespace slots (chart space). Primitives resolve
    // time anchors exactly on registered slots and remap bar_index anchors
    // across the inserted slots (services/pineDrawings `resolveAnchorX`).
    const anchorKlines = barsNow.map((b) => ({ openTime: b.ts, high: b.high, low: b.low }));

    for (const v of visuals) {
      if (v.type === "line" || v.type === "histogram" || v.type === "area") {
        const ident = v.key;
        const override = style[ident] as PinePlotStyleOverride | undefined;
        // Hidden override → skip painting WITHOUT registering the ident, so the
        // stale-cleanup below clears the previously-painted series DATA. The
        // series OBJECT stays in st.data and repaints on un-hide.
        if (override?.visible === false) continue;
        seenData.add(ident);
        // plot.style_linebr → independent horizontal SEGMENTS via the drawing
        // primitive, NOT a connected LineSeries. Lightweight Charts joins every
        // finite point of a LineSeries into one polyline (it drops the na
        // whitespace rows), so a slot reused for two different-priced levels
        // would be bridged by a diagonal. Each contiguous finite run becomes its
        // own horizontal PineLineDrawing (see linebrSegmentsToDrawings), so the
        // line genuinely BREAKS on na — exactly Pine's linebr semantics. This
        // path also carries no per-segment LWC series, so dense histories stay
        // cheap. Non-linebr lines (SMA/Bollinger/MA) keep the LineSeries path.
        if (v.type === "line" && v.breakOnNa) {
          const r = resolveStyle(style, ident, v.color ?? null, v.lineWidth ?? null);
          const segColor = r.color ?? "#38bdf8";
          const segWidth = (r.width ?? v.lineWidth ?? 2) as number;
          // Stable id base per visual key so redraws don't churn drawing ids.
          const idBase = linebrIdBase(ident);
          const segs = linebrSegmentsToDrawings(v.data, segColor, segWidth, idBase);
          seenDrawings = true;
          sawLinebr = true;
          for (const ln of segs) paneLines.push(ln);
          // A linebr visual no longer owns a data series; drop any stale one so
          // the seenData cleanup below can't leave an orphaned LineSeries.
          const stale = st.data.get(ident);
          if (stale) {
            try {
              chart.removeSeries(stale.series as ISeriesApi<"Line">);
            } catch {
              /* already gone */
            }
            st.data.delete(ident);
          }
          if (segs.length > 0) paintedAny = true;
          continue;
        }
        // Re-create when the STYLE changes (color/width) — applyOptions would
        // need extra plumbing across the Line/Histogram/Area union, so we keep
        // the freshest signature per ident and let the create-branch re-add.
        const styleSig = JSON.stringify(override ?? {});
        const styleChanged = st.styleSigRef.get(ident) !== styleSig;
        let entry = st.data.get(ident);
        if (
          !entry ||
          entry.kind !== v.type ||
          (v.type === "line" && entry.stepLine !== v.stepLine) ||
          (v.type === "line" && entry.breakOnNa !== (v.breakOnNa ?? false)) ||
          styleChanged
        ) {
          if (entry) {
            try {
              chart.removeSeries(entry.series as ISeriesApi<"Line">);
            } catch {
              /* already gone */
            }
            st.data.delete(ident);
            entry = undefined;
          }
          st.styleSigRef.set(ident, styleSig);
          try {
            const base = {
              priceLineVisible: false,
              ...(st.paneIndex === 0 ? { priceScaleId: "right" } : {}),
            };
            // Style overrides win over the script; otherwise fall back exactly.
            const r = resolveStyle(style, ident, v.color ?? null, v.type === "histogram" ? null : v.lineWidth ?? null);
            const color = r.color ?? "#38bdf8";
            // histogram visuals carry no script linewidth — default 2.
            const width = (r.width ?? (v.type === "histogram" ? undefined : v.lineWidth) ?? 2) as LineWidth;
            // lineStyle override → LWC LineStyle (only for line/area, not hist).
            const lineStyleOpt =
              r.lineStyle === "dashed"
                ? LineStyle.Dashed
                : r.lineStyle === "dotted"
                  ? LineStyle.Dotted
                  : undefined;
            if (v.type === "line") {
              const s = chart.addSeries(
                LineSeries,
                {
                  ...base,
                  color,
                  lineWidth: width,
                  ...(lineStyleOpt !== undefined ? { lineStyle: lineStyleOpt } : {}),
                  lineType: v.stepLine ? LineType.WithSteps : LineType.Simple,
                  pointMarkersVisible: false,
                  crosshairMarkerRadius: 3,
                },
                st.paneIndex,
              );
              entry = { series: s, kind: "line", stepLine: v.stepLine, breakOnNa: v.breakOnNa ?? false, painted: null };
            } else if (v.type === "histogram") {
              const s = chart.addSeries(HistogramSeries, { ...base, color }, st.paneIndex);
              entry = { series: s, kind: "histogram", stepLine: false, breakOnNa: false, painted: null };
            } else {
              const s = chart.addSeries(
                AreaSeries,
                {
                  ...base,
                  lineColor: color,
                  topColor: withAlpha(color, 0.35),
                  bottomColor: withAlpha(color, 0.04),
                  lineWidth: width,
                  ...(lineStyleOpt !== undefined ? { lineStyle: lineStyleOpt } : {}),
                },
                st.paneIndex,
              );
              entry = { series: s, kind: "area", stepLine: false, breakOnNa: false, painted: null };
            }
            st.data.set(ident, entry);
          } catch {
            continue; // series creation failed (pane gone) — skip this visual
          }
        }
        entry = entry!;
        if (entry.kind !== v.type) continue;
        const series = entry.series as ISeriesApi<"Line">;
        // A uniform color override replaces per-bar script colors (LWC series
        // color handles the rest — the per-point color must not fight it).
        const stripColor = typeof override?.color === "string";
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
            series.update(toLineData(last, stripColor));
          } else {
            series.setData(v.data.map((p) => toLineData(p, stripColor)));
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
      } else if (v.type === "labels") {
        // Pine label.new() drawings → canvas primitives. The pane primitive
        // paints on the same host as this indicator's markers/price lines
        // (candle series for overlays, a carrier series otherwise); a script
        // that no longer produces labels (or is replaying before its label
        // conditions fire) clears the drawing via setLabels([]) below.
        seenLabels = true;
        if (v.labels.length > 0) {
          const host = labelHostFor(chart, st, candleSeries, barsNow);
          if (host) {
            const prim = ensureLabelPrimitive(host, st, st.paneIndex);
            prim.setAnchorContext(anchorKlines, wsSlots);
            prim.setLabels(v.labels);
            paintedAny = true;
          }
        }
        if (v.overlayLabels.length > 0) {
          const overlayHost = candleSeries ?? ensureCarrier(chart, st, barsNow);
          if (overlayHost) {
            const prim = ensureOverlayLabelPrimitive(overlayHost, st);
            prim.setAnchorContext(anchorKlines, wsSlots);
            prim.setLabels(v.overlayLabels);
            paintedAny = true;
          }
        }
      } else if (v.type === "lines") {
        // Pine line.new() drawings → canvas primitives (same host + lifecycle
        // as labels). Both line and box visuals are MERGED into one primitive
        // per pane so their draw order stays coherent.
        seenDrawings = true;
        for (const ln of v.lines) paneLines.push(ln);
        for (const ln of v.overlayLines) overlayLines.push(ln);
      } else if (v.type === "boxes") {
        seenDrawings = true;
        for (const bx of v.boxes) paneBoxes.push(bx);
        for (const bx of v.overlayBoxes) overlayBoxes.push(bx);
      } else if (v.type === "fill") {
        // Pine fill(plot1, plot2, …) → the shared fill primitive. A hidden
        // override skips it; a color/opacity override resolves via resolveFill
        // (uniform color replaces per-bar colors; opacity scales the alpha).
        // The boundary plots/hlines keep their OWN colors — a fill override
        // never recolors what it shades.
        const override = style[v.key] as PinePlotStyleOverride | undefined;
        if (override?.visible === false) continue;
        sawFill = true;
        const region = resolveFill(style, v.key, v.color ?? null, v.data);
        paneFills.push(region);
      }
    }

    // Lines + boxes merged → one setDrawings per host. Runs whenever this run
    // carried any line/box/linebr art (sawLinebr included) so a linebr run that
    // yields ZERO segments still clears the previously-painted levels; the
    // !seenDrawings-clear below handles the fully-vanished case.
    if (sawLinebr || paneLines.length > 0 || paneBoxes.length > 0) {
      const host = labelHostFor(chart, st, candleSeries, barsNow);
      if (host) {
        const prim = ensureDrawingPrimitive(host, st, st.paneIndex);
        prim.setAnchorContext(anchorKlines, wsSlots);
        prim.setDrawings(paneLines, paneBoxes);
        paintedAny = true;
      }
    }
    if (overlayLines.length > 0 || overlayBoxes.length > 0) {
      const overlayHost = candleSeries ?? ensureCarrier(chart, st, barsNow);
      if (overlayHost) {
        const prim = ensureOverlayDrawingPrimitive(overlayHost, st);
        // Anchor-remap context MUST be set on the overlay primitive too —
        // otherwise its `anchorKlines`/`anchorSlots` stay empty and every
        // whitespace-remapped logical anchor falls back to the RAW engine
        // index (shifted left by the inserted slots). Same contract as the
        // pane path above and both label primitives.
        prim.setAnchorContext(anchorKlines, wsSlots);
        prim.setDrawings(overlayLines, overlayBoxes);
        paintedAny = true;
      }
    }
    // Fills merged → one setFills per host. Runs whenever this run carried a
    // fill visual (sawFill) so a run that yields zero regions still clears the
    // previously-painted fills; the !sawFill-clear below handles the vanished
    // case. Fills paint BEHIND the plots (zOrder "bottom" in the primitive).
    if (sawFill || paneFills.length > 0) {
      const host = labelHostFor(chart, st, candleSeries, barsNow);
      if (host) {
        const prim = ensureFillPrimitive(host, st, st.paneIndex);
        prim.setAnchorContext(anchorKlines, wsSlots);
        prim.setFills(paneFills);
        paintedAny = true;
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
    // Style overrides apply per hline key: a `visible:false` override removes
    // the line entirely; color/width/lineStyle replace the engine defaults
    // (Piner 0.13.0 does not surface the script's own hline styling, so the
    // override is the ONLY way to restyle an hline). The override is folded
    // into the signature so a style change re-creates the price lines.
    const hlineViews = hlines
      .map((h) => {
        const o = style[h.key] as PinePlotStyleOverride | undefined;
        return {
          h,
          hidden: o?.visible === false,
          color: (typeof o?.color === "string" ? o.color : h.color) ?? "#787b86",
          lineWidth: (typeof o?.lineWidth === "number" ? o.lineWidth : h.lineWidth) ?? 1,
          lineStyle: (o?.lineStyle ?? h.lineStyle) as "solid" | "dashed" | "dotted",
        };
      })
      .filter((x) => !x.hidden);
    const hlineSig = hlineViews
      .map((x) => `${x.h.key}:${x.h.price}:${x.color}:${x.lineWidth}:${x.lineStyle}`)
      .join("|");
    if (hlines.length > 0) {
      const host = priceLineHostFor(chart, st, candleSeries, barsNow);
      if (host && hlineSig !== st.priceLineSig) {
        removePriceLines(st);
        st.priceLineHost = host;
        for (const x of hlineViews) {
          try {
            st.priceLines.push(
              host.createPriceLine({
                price: x.h.price,
                color: x.color,
                lineWidth: x.lineWidth as LineWidth,
                lineStyle:
                  x.lineStyle === "dotted"
                    ? LineStyle.Dotted
                    : x.lineStyle === "dashed"
                      ? LineStyle.Dashed
                      : LineStyle.Solid,
                title: x.h.title,
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

    // A labels visual absent from this run (replay before conditions fire,
    // script edit, warmup-only) clears every previously-painted label.
    if (!seenLabels) {
      for (const prim of st.labelPrimitives.values()) {
        try {
          prim.setLabels([]);
        } catch {
          /* primitive gone */
        }
      }
      if (st.overlayLabelPrimitive) {
        try {
          st.overlayLabelPrimitive.setLabels([]);
        } catch {
          /* primitive gone */
        }
      }
    }

    // Same lifecycle for line/box drawings: a run without a lines/boxes
    // visual (replay before the drawing conditions fire, script edit) clears
    // every previously-painted line/box.
    if (!seenDrawings) {
      for (const prim of st.drawingPrimitives.values()) {
        try {
          prim.setDrawings([], []);
        } catch {
          /* primitive gone */
        }
      }
      if (st.overlayDrawingPrimitive) {
        try {
          st.overlayDrawingPrimitive.setDrawings([], []);
        } catch {
          /* primitive gone */
        }
      }
    }

    // Same lifecycle for fills: a run without a fill visual (script edit,
    // warmup-only, or every fill overridden off) clears the painted fills.
    if (!sawFill) {
      for (const prim of st.fillPrimitives.values()) {
        try {
          prim.setFills([]);
        } catch {
          /* primitive gone */
        }
      }
    }

    return paintedAny;
  };

  /**
   * Coalesced per-indicator computation flight.
   *
   * At most ONE compute per indicator is ever in flight. The caller (data
   * effect) marks the indicator dirty when realtime frames arrive while this
   * flight is running — never enqueuing a second compute. When this flight
   * resolves it paints its result (it is the only flight for its id, so it can
   * never overwrite a newer completed result), then runs EXACTLY ONE dirty
   * follow-up against the engine's LATEST candle state. No queue is ever built.
   *
   * Stale-result protection is PER INDICATOR / PER FLIGHT: each flight takes a
   * per-id generation token. Cancellation (layout change / teardown) bumps the
   * id's token, so a stale resolved compute can never paint over a newer exit.
   */
  const computeAndPaint = async (id: string): Promise<void> => {
    if (!api) return;
    const flights = flightsRef.current;
    const token = flights.begin(id);
    if (!token) return; // a flight is already in flight (the effect guards this too)

    const s = desiredLayout(indicatorsRef.current).find((x) => x.id === id);
    const ind = indicatorsRef.current.find((x) => x.id === id);
    if (!s || !ind) {
      // Indicator removed while this flight was pending — nothing to paint.
      flights.cancel(id);
      return;
    }

    let st = stateRef.current.get(id);
    if (!st) {
      st = newState(s.paneIndex);
      stateRef.current.set(id, st);
    }
    st.paneIndex = s.paneIndex;

    let rawError: string | null = null;
    let run: { visuals: PineVisual[]; diagnostics?: { declared?: unknown[] } } | null = null;
    try {
      run = await engineRef.current.computeScriptVisuals(
        {
          id: s.id,
          source: ind.source,
          // Shared helper keys the ENGINE side by varId (= Piner's deduped
          // input key), NOT the raw title — duplicate titles ("Length" /
          // "Length (2)") collide when keyed by title (see pineInputBindings).
          bindings: pineInputBindings(ind.inputMeta),
        },
        ind.inputs,
        (raw) => {
          rawError = raw;
        },
      );
    } catch (e) {
      rawError = e instanceof Error ? e.message : String(e);
    }

    // Stale-result protection (per indicator / per flight): a resolved compute
    // paints ONLY while its token is still the CURRENT flight for its id. A
    // cancelled flight (layout change / teardown) can never paint over a newer
    // exit.
    if (!flights.isCurrent(id, token)) {
      return;
    }

    const chart: IChartApi = api.controller.getChart();
    const candleSeries = (api.controller as unknown as { getSeries?: () => unknown }).getSeries?.() as
      | ISeriesApi<"Line">
      | undefined
      | null;

    try {
      if (run === null) {
        clearPainted(st);
        report(id, { ok: false, message: friendlyPineError(rawError ?? "Pine Script execution failed") });
      } else {
        // barsRef.current = the LATEST authoritative bridge bars (the forming
        // candle's truth merged in), so drawings/labels anchor to the newest data.
        const painted = applyVisuals(chart, st, run.visuals, candleSeries ?? null, barsRef.current, ind.style ?? EMPTY_STYLE);
        // Style-tab healer: rebuild the plotMeta from THIS live run (declared
        // outputs ∪ rendered visuals) and report it so App can replace the
        // indicator's stale, frozen-at-import plotMeta. This is what makes the
        // conditional / warmup-only Style rows (SMA-based MA, Bollinger bands,
        // their fill in fractal_SMA.pine) appear for an indicator imported
        // BEFORE the declared-output capture — no re-import required.
        if (onDeclared) {
          const declared = (run.diagnostics?.declared ?? []) as Parameters<typeof buildPlotMeta>[0];
          onDeclared(id, buildPlotMeta(declared, run.visuals));
        }
        report(
          id,
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
      }
    } catch {
      /* one bad indicator must not break the others */
    }

    // Release the flight; when an update arrived mid-flight, run exactly ONE
    // dirty follow-up against the engine's LATEST candle state — `setCandles`
    // is called on every frame before any kick, so the engine is already
    // current. At most one flight + one pending flag ever exist (no queue).
    if (flights.finish(id, token)) {
      void computeAndPaint(id);
    }
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
      engineRef.current = createPineEngine();
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
  //
  // PER-INDICATOR COALESCING (killzone fix): each enabled indicator gets at
  // most ONE computation in flight. When a realtime frame arrives while a
  // computation is running we do NOT enqueue another — we mark the indicator
  // dirty and keep the engine's candle state fresh (setCandles below). When
  // the running computation resolves it paints (it is the only flight for its
  // id, so it cannot overwrite a newer result), then exactly one dirty
  // follow-up runs against the latest engine state. Slow scripts (killzones,
  // heavy MAs) therefore keep painting under continuous ticks instead of being
  // discarded by a global generation counter that increments on every frame.
  useEffect(() => {
    if (!api) return;
    // 1. ALWAYS push the latest authoritative candle state into the engine —
    //    even while a prior computation is still in flight. The engine reads
    //    `this.klines` at execution time, so every follow-up operates on the
    //    newest data (pinePinerEngine `computeScriptVisuals`).
    const pineBars = (barsRef.current as readonly Bar[]) as readonly PineBar[];
    const live = liveCandleRef.current;
    const pineLive: PineLiveCandle | null = live
      ? {
          time: live.time,
          open: live.open,
          high: live.high,
          low: live.low,
          close: live.close,
          volume: live.volume,
        }
      : null;
    engineRef.current.setCandles(pineBars, pineLive, bucketSecRef.current, symbolRef.current);

    // 2. Kick coalesced recomputes — at most one flight per indicator; anything
    //    that changes mid-flight is marked dirty for exactly one follow-up.
    const flights = flightsRef.current;
    for (const s of desiredLayout(indicatorsRef.current)) {
      if (flights.isInFlight(s.id)) {
        flights.markDirty(s.id);
        continue;
      }
      void computeAndPaint(s.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, bars, liveCandle, bucketSec, indicators, symbol, whitespaceSlots]);

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
  /** Label primitive host: candle series for overlays, else own/carrier series (mirrors markers). */
  const labelHostFor = (
    chart: IChartApi,
    st: IndicatorChartState,
    candleSeries: ISeriesApi<"Line"> | null,
    barsNow: readonly Bar[],
  ): ISeriesApi<"Line"> | null => {
    if (st.paneIndex === 0 && candleSeries) return candleSeries;
    for (const entry of st.data.values()) return entry.series as ISeriesApi<"Line">;
    return ensureCarrier(chart, st, barsNow);
  };

  /** One label primitive per pane host (created once, repainted in place via setLabels). */
  const ensureLabelPrimitive = (
    host: ISeriesApi<"Line">,
    st: IndicatorChartState,
    paneIndex: number,
  ): PineLabelPrimitive => {
    const existing = st.labelPrimitives.get(paneIndex);
    if (existing) return existing;
    const prim = new PineLabelPrimitive();
    try {
      host.attachPrimitive(prim);
      st.labelPrimitives.set(paneIndex, prim);
    } catch {
      /* older LWC without primitive support — label drawings degrade silently */
    }
    return prim;
  };

  /** Overlay primitive for force_overlay=true labels — always on the main pane's host. */
  const ensureOverlayLabelPrimitive = (
    host: ISeriesApi<"Line">,
    st: IndicatorChartState,
  ): PineLabelPrimitive => {
    if (st.overlayLabelPrimitive) return st.overlayLabelPrimitive;
    const prim = new PineLabelPrimitive();
    try {
      host.attachPrimitive(prim);
      st.overlayLabelPrimitive = prim;
    } catch {
      /* older LWC without primitive support */
    }
    return prim;
  };

  /** One line/box primitive per pane host (mirrors label primitives). */
  const ensureDrawingPrimitive = (
    host: ISeriesApi<"Line">,
    st: IndicatorChartState,
    paneIndex: number,
  ): PineLineBoxPrimitive => {
    const existing = st.drawingPrimitives.get(paneIndex);
    if (existing) return existing;
    const prim = new PineLineBoxPrimitive();
    try {
      host.attachPrimitive(prim);
      st.drawingPrimitives.set(paneIndex, prim);
    } catch {
      /* older LWC without primitive support — drawings degrade silently */
    }
    return prim;
  };

  /** Overlay primitive for force_overlay=true lines/boxes — main pane host. */
  const ensureOverlayDrawingPrimitive = (
    host: ISeriesApi<"Line">,
    st: IndicatorChartState,
  ): PineLineBoxPrimitive => {
    if (st.overlayDrawingPrimitive) return st.overlayDrawingPrimitive;
    const prim = new PineLineBoxPrimitive();
    try {
      host.attachPrimitive(prim);
      st.overlayDrawingPrimitive = prim;
    } catch {
      /* older LWC without primitive support */
    }
    return prim;
  };

  /** One fill primitive per pane host (mirrors the line/box primitive). */
  const ensureFillPrimitive = (
    host: ISeriesApi<"Line">,
    st: IndicatorChartState,
    paneIndex: number,
  ): PineFillPrimitive => {
    const existing = st.fillPrimitives.get(paneIndex);
    if (existing) return existing;
    const prim = new PineFillPrimitive();
    try {
      host.attachPrimitive(prim);
      st.fillPrimitives.set(paneIndex, prim);
    } catch {
      /* older LWC without primitive support — fills degrade silently */
    }
    return prim;
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