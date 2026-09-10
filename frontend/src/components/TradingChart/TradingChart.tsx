import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ChartView,
  ReplayControls,
  createReplayController,
  useChartApi,
  type Bar,
  type ChartViewApi,
  type ReplayController,
} from "@getcandlekit/charts/react";
import {
  TickMarkType,
  type ChartOptions,
  type DeepPartial,
  type TickMarkFormatter,
  type TimeFormatterFn,
} from "lightweight-charts";
import {
  formatManilaDayHHMM,
  formatManilaDateTimeFull,
  formatManilaHHMM,
  formatManilaHHMMSS,
} from "../../services/timefmt";
import {
  type RealtimeCandleMsg,
  type RealtimeStatus,
  alignToBucketStart,
  resolutionToBucketSec,
} from "../../services/realtime";
import { diag, iso, logUpdateBar, maybeLogChartBlock } from "../../services/diagnostics";
import { candleCloseCountdown, planLiveUpdate, type LiveBar } from "../../services/liveCandle";
import { defaultEmaSettings, type EmaSettings } from "../../config/emaSettings";
import type { SmaSettings } from "../../config/smaSettings";
import type { ImportedPineIndicator, PineRunStatus } from "../../services/pineImport";
import type { PineSymbolMeta } from "../../services/pineEngineTypes";
import type { HorizonCalendar } from "../../services/marketCalendar";
import type { Candle, CandleGap } from "../../types/candle";
import { ActiveIndicatorsOverlay } from "./ActiveIndicatorsOverlay";
import { CandleCountdownPrimitive, type CountdownCandle } from "./CandleCountdownPrimitive";
import { ChartContextMenu } from "./ChartContextMenu";
import { EmaBridge } from "./EmaBridge";
import { InvertScaleBridge } from "./InvertScaleBridge";
import { InvertDebugProbe } from "./invertDebug"; // ⚠ TEMP debug probe (?debugInvert)
import { MaStructurePanel } from "./MaStructurePanel";
import { PineBridge } from "./PineBridge";
import { SmaBridge } from "./SmaBridge";
import { ScrollToLatestButton } from "./ScrollToLatestButton";
import {
  REPLAY_SYMBOL,
  buildReplayManifest,
  findReplayIndex,
  replayEngineOptions,
} from "../../services/replay";
import {
  isNearHistoryEdge,
  shouldShowLoadMore,
  type HistoryStatus,
} from "../../services/historyPagination";
import { resolveGapBands } from "../../services/gapRegions";
import { GapRegionsPrimitive } from "./GapRegionsPrimitive";
import { WhitespaceBridge } from "./WhitespaceBridge";
import { buildWhitespacePlan } from "../../services/whitespaceRows";
import { mergeBridgeBars } from "../../services/pineSeries";

/**
 * DATA GAP shading — attaches the gap primitive to the chart's main series
 * and repaints it whenever the loaded candles or the derived gaps change.
 * Presentation-only: gaps never enter the candle arrays (Pine, the Trading
 * Behavior Engine and persistence are untouched). Suppressed during replay —
 * the chart then shows simulated bars and live-outage bands would mislead.
 */
function GapShading({
  candles,
  gaps,
  bucketSec,
  enabled,
}: {
  candles: readonly Candle[];
  gaps: readonly CandleGap[] | undefined;
  bucketSec: number;
  enabled: boolean;
}): null {
  const api = useChartApi();
  const primRef = useRef<GapRegionsPrimitive | null>(null);
  const bands = useMemo(
    () => (enabled ? resolveGapBands(candles, gaps ?? [], bucketSec) : []),
    [candles, gaps, bucketSec, enabled],
  );

  // Attach once per chart controller (re-attaches after chart recreation).
  useEffect(() => {
    const controller = api.controller;
    if (!controller) return;
    const host = (controller as unknown as { getSeries?: () => unknown }).getSeries?.() as
      | { attachPrimitive?: (p: unknown) => void }
      | undefined
      | null;
    if (!host) return;
    if (!primRef.current) primRef.current = new GapRegionsPrimitive();
    try {
      host.attachPrimitive?.(primRef.current);
    } catch {
      /* older LWC without primitive support — gap shading degrades silently */
    }
  }, [api]);

  // Repaint in place when the geometry changes (attachPrimitive → requestUpdate).
  useEffect(() => {
    primRef.current?.setBands(bands);
  }, [bands]);

  return null;
}

/** Redraw cadence for the countdown pill. The VALUE is never taken from this
 *  timer's ticks — every run recomputes `closesAt − Date.now()` from the
 *  candle's ACTUAL bucket boundary (`candleCloseCountdown`), so a throttled
 *  background tab can only delay a repaint, never skew the countdown. */
const COUNTDOWN_REDRAW_MS = 250;

/**
 * CURRENT-CANDLE CLOSE-COUNTDOWN MARKER — a tiny "MM:SS" pill drawn
 * immediately right of the forming candle, via a series primitive
 * (CandleCountdownPrimitive). Presentation-only canvas text: nothing is
 * rendered into the DOM, no candle data is created or modified.
 *
 * Candle authority (same as the OHLC strip): the LIVE forming candle from the
 * WS stream (`liveCandle`) — never an invented bar. The countdown target is
 * `time + bucketSec`: the REAL market bucket boundary reported by the backend
 * stream, not a browser-accumulated duration. Every WS frame re-anchors it
 * (1m → :00/:01/:02…, 3m → :00/:03/:06…) and every redraw re-derives
 * `remaining = closesAt − now`. When the wall clock crosses the boundary
 * before the next frame lands, the display HOLDS at 00:00.
 *
 * During a replay session the marker is HIDDEN: a countdown counts LIVE
 * market time, which does not exist on a replaying (historical) chart (the
 * same rule the old price-axis countdown followed). There is no "follow the
 * replay candle" mode for a countdown — a historical candle's close is in the
 * past, so "time remaining" would be meaningless.
 */
function CountdownMarker({
  liveCandle,
  bucketSec,
  replayActive,
}: {
  liveCandle: RealtimeCandleMsg | null;
  /** Selected timeframe bucket size in seconds (60 = 1m, 180 = 3m). */
  bucketSec: number;
  /** Replay owns the chart while a session is active — no countdown. */
  replayActive: boolean;
}): null {
  const api = useChartApi();
  const primRef = useRef<CandleCountdownPrimitive | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Attach once per chart controller (re-attaches after chart recreation).
  useEffect(() => {
    const controller = api.controller;
    if (!controller) return;
    const host = (controller as unknown as { getSeries?: () => unknown }).getSeries?.() as
      | { attachPrimitive?: (p: unknown) => void }
      | undefined
      | null;
    if (!host) return;
    if (!primRef.current) primRef.current = new CandleCountdownPrimitive();
    try {
      host.attachPrimitive?.(primRef.current);
    } catch {
      /* older LWC without primitive support — marker degrades silently */
    }
  }, [api]);

  // Live-only timer. The ticker just re-renders; the countdown itself is
  // always re-derived from the candle's bucket boundary below.
  useEffect(() => {
    if (replayActive) return;
    const id = window.setInterval(() => setNow(Date.now()), COUNTDOWN_REDRAW_MS);
    const onVisibility = (): void => setNow(Date.now());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [replayActive]);

  // Build the pill ONLY from a forming live candle; its tsMs is the aligned
  // bucket start so the anchor lands exactly on the candle's x slot.
  const cd = liveCandle && Number.isFinite(liveCandle.time) && !replayActive
    ? candleCloseCountdown(liveCandle, bucketSec, now)
    : null;
  const marker: CountdownCandle | null =
    liveCandle && cd && Number.isFinite(liveCandle.close)
      ? { tsMs: cd.bucketStartMs, close: liveCandle.close, label: cd.label }
      : null;

  // Feed the primitive ONLY when a displayed value actually changes — a new
  // bucket (rollover), a fresh close (the pill's Y tracks the forming close),
  // or the label rolling to the next second. Identity-only renders must not
  // re-issue a repaint.
  const feedRef = useRef<{ m: CountdownCandle } | null>(null);
  useEffect(() => {
    const prev = feedRef.current;
    const same =
      marker === null
        ? prev === null
        : prev !== null &&
          marker.tsMs === prev.m.tsMs &&
          marker.close === prev.m.close &&
          marker.label === prev.m.label;
    if (same) return;
    feedRef.current = marker === null ? null : { m: marker };
    primRef.current?.setMarker(marker);
  }, [marker]);

  return null;
}


interface Props {
  candles: readonly Candle[];
  /** Detected market-data gaps (broker outages) — rendered as shaded regions. */
  gaps?: CandleGap[];
  /** Timeframe id (MINUTE_1 | MINUTE_3) — used for stream bucket alignment. */
  resolution?: string;
  /** Latest forming candle pushed by the backend (time = bucket start, epoch s). */
  liveCandle?: RealtimeCandleMsg | null;
  streamStatus?: RealtimeStatus;
  loading?: boolean;
  /** EMA overlay configuration (localStorage-persisted in App). */
  emaSettings?: EmaSettings;
  /** SMA overlay configuration (localStorage-persisted in App). */
  smaSettings?: SmaSettings;
  /** Imported Pine indicators (localStorage-persisted in App). */
  pineIndicators?: ImportedPineIndicator[];
  /** Active instrument metadata → syminfo (mintick etc.) for scripts. */
  pineSymbol?: PineSymbolMeta | null;
  /** Instrument's market calendar (from /api/instruments) — drives the
   *  session-aware future time-axis horizon (breaks/weekends excluded). */
  marketCalendar?: HorizonCalendar | null;
  /** Runtime status reporter for imported Pine indicators. */
  onPineStatus?: (id: string, status: PineRunStatus) => void;
  /**
   * Visual price-scale inversion (TradingView-style "Invert Scale"). A pure
   * viewport transform on the main right price scale — OHLC data, candle
   * order, crosshair values and the time axis are all untouched. Persisted
   * in App via chartSettings.ts.
   */
  invertScale?: boolean;
  /**
   * Right-click context-menu action — REUSES App's existing control (no
   * duplicated state): the chart's context menu reflects `invertScale` and
   * this callback invokes the exact handler the menu item uses.
   */
  onToggleInvertScale?: () => void;
  /** Instrument scope key (used to scope a replay session). */
  replaySymbol?: string;
  /**
   * "Load More History" — called when the user clicks the historical-edge
   * control. App owns the fetch + merge; TradingChart only captures the
   * viewport first so the prepend repaint stays visually anchored.
   */
  onLoadMoreHistory?: () => void;
  /** Incremental-history state for the edge control (loading/exhausted/error). */
  historyStatus?: HistoryStatus;
  /**
   * Quote-candle reporter — pushes the composed OHLC-readout candle
   * (crosshair hover ?? replay cursor ?? latest bar) UP to App's unified
   * header, which renders the strip. The chart remains the single source of
   * truth; this is a presentation-only relocation of the old bottom footer.
   */
  onQuoteCandle?: (candle: Candle | null) => void;
  /** Replay entry armed ("click a candle to start") — owned by App's header button. */
  replayPicking?: boolean;
  /** Arms/disarms the replay candle-pick (App header button toggle). */
  onReplayPickingChange?: (picking: boolean) => void;
  /** Reports replay UI state so App's header entry button can hide/disable:
   *  `active` = a session is running (the in-plot dock owns the controls),
   *  `canEnter` = there is data to replay. */
  onReplayStateChange?: (state: { active: boolean; canEnter: boolean }) => void;
  /** Indicator setters forwarded to the upper-left ActiveIndicatorsOverlay. */
  onEmaChange?: (next: EmaSettings) => void;
  onSmaChange?: (next: SmaSettings) => void;
  onPineChange?: (next: ImportedPineIndicator[]) => void;
  onOpenIndicatorSettings?: (id: string) => void;
}

function asBar(c: { ts: number; open: number; high: number; low: number; close: number; volume?: number }): Bar {
  return {
    ts: c.ts,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    ...(c.volume !== undefined && Number.isFinite(c.volume) ? { volume: c.volume } : {}),
  };
}

/**
 * Stable empty series passed to ChartView while Replay is active. With a
 * constant identity the ChartView `data` effect never re-fires mid-session,
 * so the replay subscription is the SINGLE painter (CandleKit examples pass a
 * static `[]` for exactly this reason) and no parent re-render can ever leak
 * the full (future) history onto a replaying chart.
 */
const NO_BARS: readonly Bar[] = [];

/** Stable no-op for optional replay-pick wiring (keeps deps arrays honest). */
const NOOP = (): void => {};

/**
 * Smooth-tick animation for the forming (current) candle.
 *
 * IG ticks arrive as discrete WS frames; without animation the candle's close
 * would SNAP between consecutive tick prices. Instead we glide the close from
 * where it currently sits toward the latest tick over `SMOOTH_DURATION_MS`
 * using requestAnimationFrame, so the current bar "moves" up/down
 * smoothly as ticks stream in. Wicks (high/low) are always painted at the
 * bucket's true running extremes — only the body close glides.
 */
const SMOOTH_DURATION_MS = 300;
/** Ease-out: start fast, settle gently into each tick. */
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
/** Clamp a value to the [0, 1] tween range. */
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Minimal, version-agnostic handles into the underlying Lightweight Charts API. */
interface TimeScaleApi {
  getVisibleRange(): { from: number; to: number } | null;
  /** Restore an exact visible window (used to keep the viewport anchored when
   *  older history is prepended — LWC's own visible-range API). */
  setVisibleRange(range: { from: number; to: number }): void;
  scrollToRealTime(): void;
  fitContent(): void;
  subscribeVisibleTimeRangeChange(cb: () => void): void;
  unsubscribeVisibleTimeRangeChange(cb: () => void): void;
  subscribeSizeChange(cb: () => void): void;
  unsubscribeSizeChange(cb: () => void): void;
}
interface PriceScaleApi {
  width(): number;
}
interface ChartApi {
  timeScale(): TimeScaleApi;
  priceScale(id: string): PriceScaleApi;
  subscribeCrosshairMove(cb: (param: unknown) => void): void;
  unsubscribeCrosshairMove(cb: (param: unknown) => void): void;
}

function toCandle(
  ts: number,
  v: { open: number; high: number; low: number; close: number; volume?: number },
): Candle {
  return {
    ts,
    open: v.open, high: v.high, low: v.low, close: v.close,
    ...(v.volume !== undefined ? { volume: v.volume } : {}),
  };
}


/**
 * Consumes the ChartView context and pushes each backend candle into the chart
 * through `controller.updateBar(...)` — the incremental update path. CandleKit
 * compares the bar's `ts` (epoch-ms) against the last bar: equal → REPLACES the
 * forming candle in place (no OHLC merging!), newer → appends (bucket
 * rollover), older → discarded. Those REPLACE semantics are why the paint plan
 * (liveCandle.ts) must always carry true, merged OHLC: whatever we paint last
 * is exactly what the bar keeps.
 *
 * Handoff guarantee: CandleKit's `setData` (fired by ChartView on every history
 * load / timeframe switch / Refresh) REPLACES the whole bar array. We re-apply
 * the latest live candle on the controller bus "data" event so the forming bar
 * is never lost between a history snapshot and the next tick — and because IG's
 * last historical row IS the forming bucket, equal-ts frames merge into it (no
 * duplicate 11:00 candle).
 *
 * BACKGROUND-TAB SAFETY (the doji fix): browsers fully pause
 * requestAnimationFrame while the tab is hidden. The old implementation let the
 * rAF "glide" own the painted close, so a tab hidden mid-bucket froze the
 * displayed close and the bucket rolled over committed with close ≈ open — a
 * doji with real wicks. Now:
 *   - `truthRef` holds the authoritative OHLC merged from every WS frame
 *     (open = first price of the bucket, high = max, low = min, close = latest);
 *   - hidden tabs commit truth DIRECTLY (no rAF) on every frame — each WS frame
 *     is a full server snapshot, so batched/delayed delivery converges by
 *     last-write-wins;
 *   - a bucket rollover re-commits the closing bucket's true final OHLC before
 *     appending the next bar (a frozen glide can never be a candle's last word);
 *   - becoming visible again flushes the truth immediately.
 * The glide survives only as a ≤300 ms cosmetic layer on visible tabs.
 *
  * Price source note: backend builds candles from MID (bid+offer)/2 for
 * CFD parity with the IG platform chart; BID → OFR → LTP as fallback.
 */
function LiveBarBridge({
  liveCandle,
  bucketSec,
  replayActive = false,
}: {
  liveCandle: RealtimeCandleMsg | null;
  bucketSec: number;
  /** When Replay Mode is active, the live stream continues updating its internal
   *  truth but DOES NOT paint — replay owns the chart during the session. */
  replayActive?: boolean;
}) {
  const api = useChartApi();
  const liveRef = useRef(liveCandle);
  liveRef.current = liveCandle;
  const replayActiveRef = useRef(replayActive);
  replayActiveRef.current = replayActive;
  /** Authoritative merged OHLC of the forming bucket (see liveCandle.ts). */
  const truthRef = useRef<LiveBar | null>(null);

  // Animation state — kept in a ref (never re-renders). `ts`/`open` are fixed
  // for the whole bucket; `close` is the currently-displayed body tip that we
  // glide toward the newest tick price, and `tHigh`/`tLow`/`tClose` are the
  // latest candle frame's true running extremes + target close.
  const anim = useRef({
    raf: 0,
    running: false,
    startTs: 0,      // performance.now() when the current glide started
    startClose: 0,   // displayed close the glide is coming FROM
    ts: 0,
    open: 0,
    close: 0,
    volume: 0,
    tHigh: 0,
    tLow: 0,
    tClose: 0,
  });

  useEffect(() => {
    const controller = api.controller;
    if (!controller) return;

    // One requestAnimationFrame step of the glide: lerp the displayed close
    // toward the target with ease-out, paint wicks at the true running extremes.
    const glide = (): void => {
      const a = anim.current;
      const t = clamp01((performance.now() - a.startTs) / SMOOTH_DURATION_MS);
      a.close = a.startClose + (a.tClose - a.startClose) * easeOutCubic(t);
      controller.updateBar(
        asBar({ ts: a.ts, open: a.open, high: a.tHigh, low: a.tLow, close: a.close, volume: a.volume }),
      );
      diag.updateBarCalls += 1;
      if (t < 1) {
        a.raf = requestAnimationFrame(glide);
      } else {
        a.raf = 0;
        a.running = false; // settled on the target close; idle until next tick
      }
    };

    const cancelGlide = (): void => {
      const a = anim.current;
      if (a.raf) {
        cancelAnimationFrame(a.raf);
        a.raf = 0;
      }
      a.running = false;
    };

    /** Point the glide at a bar's truth (baseline = its true close). */
    const syncAnim = (bar: LiveBar): void => {
      const a = anim.current;
      a.ts = bar.ts;
      a.open = bar.open;
      a.close = bar.close;
      a.startClose = bar.close;
      a.startTs = performance.now();
      a.tHigh = bar.high;
      a.tLow = bar.low;
      a.tClose = bar.close;
      a.volume = bar.volume ?? 0;
    };

    const paintBar = (bar: LiveBar): void => {
      controller.updateBar(asBar(bar));
      diag.updateBarCalls += 1;
    };

    const applyFrame = (msg: RealtimeCandleMsg | null): void => {
      if (!msg) return;
      // Replay Mode owns the chart — the live stream keeps merging into
      // `truthRef` but must NEVER paint into the replay timeline.
      if (replayActiveRef.current) return;
      // rAF is PAUSED while the tab is hidden — never plan an animation there.
      const hidden = document.visibilityState === "hidden";
      const plan = planLiveUpdate(truthRef.current, msg, bucketSec, { hidden });

      if (plan.skipped || !plan.truth) {
        diag.updateBarSkipped += 1;
        console.info(
          `[CHART] updateBar SKIPPED (stale/unsound): frame ${iso(alignToBucketStart(msg.time * 1000, bucketSec))}` +
            ` vs forming bucket ${iso(truthRef.current?.ts ?? 0)}`,
        );
        return;
      }
      truthRef.current = plan.truth;
      const bars = controller.getBars();

      if (plan.rollover) {
        // Bucket rollover (or first frame). The plan's commits are ordered:
        // [prevTruth?] re-commits the just-closed bucket with its TRUE final
        // OHLC — a frozen/mid-glide close can never be a closed candle's last
        // word — then the new bucket's truth is appended. No glide across a
        // boundary: the open must not animate.
        let seededEmpty = bars.length === 0;
        for (const bar of plan.commits) {
          if (seededEmpty) {
            // LIGHTWEIGHT CHARTS FIX: series.update() silently drops the FIRST
            // bar when the series is empty (e.g. history unavailable) — seed
            // with a one-row setData instead.
            controller.setData([asBar(bar)]);
            diag.dataSeeded += 1;
            seededEmpty = false;
          } else {
            paintBar(bar);
          }
        }
        cancelGlide();
        syncAnim(plan.truth);
        const closed = plan.commits.length > 1 ? plan.commits[0] : null;
        if (closed) {
          console.info(
            `[CHART] ROLLOVER closed ${iso(closed.ts)} O=${closed.open} H=${closed.high} L=${closed.low} C=${closed.close}` +
              ` → new bucket ${iso(plan.truth.ts)} bucket=${bucketSec}s`,
          );
        }
        logUpdateBar(plan.truth.ts / 1000, plan.truth.close);
        maybeLogChartBlock(bars.length + (closed ? 1 : 0), bars[0]?.ts ?? null, plan.truth.ts);
        return;
      }

      if (hidden) {
        // BACKGROUND TAB: rAF never fires, so a glide-owned close would freeze
        // (the doji bug). Commit the merged truth DIRECTLY — every WS frame is
        // a full server snapshot, so batched/delayed delivery still converges
        // on the correct OHLC via last-write-wins.
        cancelGlide();
        syncAnim(plan.truth);
        paintBar(plan.truth);
        return;
      }

      // Visible, same bucket — re-target the cosmetic glide toward the truth,
      // animating FROM where the candle currently sits so consecutive ticks
      // blend into a smooth curve. Wicks always paint the true extremes; the
      // truth itself is re-committed at rollover and on tab focus (below).
      const a = anim.current;
      if (a.ts !== plan.truth.ts) syncAnim(plan.truth); // rebase if anim lagged
      a.tHigh = plan.truth.high;
      a.tLow = plan.truth.low;
      a.tClose = plan.truth.close;
      a.volume = plan.truth.volume ?? a.volume;
      a.startTs = performance.now();
      a.startClose = a.close;
      if (!a.running) {
        a.running = true;
        a.raf = requestAnimationFrame(glide);
      }
    };

    applyFrame(liveCandle);
    // Re-apply the newest live candle AFTER every full-history setData
    // (initial load, timeframe switch, Refresh). Child effects run before the
    // parent's setData effect, so this must go through the bus "data" event,
    // which CandleKit emits at the end of setData. During Replay the "data"
    // event is for the REPLAY slices — the live candle must not leak in.
    const offData = controller.bus.on("data", () => {
      if (replayActiveRef.current) return;
      applyFrame(liveRef.current);
    });

    // Tab-focus reconciliation: repaint the bucket truth immediately when the
    // tab becomes visible again so a close frozen mid-glide while hidden can
    // never survive past the focus event.
        const onVisibility = (): void => {
      if (document.visibilityState !== "visible") return;
      // Replay owns the chart while active — repainting the live forming
      // candle here would corrupt the replay timeline with present-day truth.
      if (replayActiveRef.current) return;
      const truth = truthRef.current;
      if (!truth) return;
      cancelGlide();
      syncAnim(truth);
      paintBar(truth);
      console.info(
        `[CHART] visibilitychange → visible: forming candle reconciled bucket=${iso(truth.ts)} C=${truth.close}`,
      );
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      offData();
      document.removeEventListener("visibilitychange", onVisibility);
      cancelGlide();
    };
  }, [liveCandle, bucketSec, api]);

  return null;
}

/**
 * Chart-viewport + crosshair plumbing — no rendering/styling changes here.
 *
 *  - After EVERY full history data set (initial load, timeframe switch,
 *    Refresh — CandleKit fires the bus "data" event at the end of setData) the
 *    viewport is left exactly where the user has it. The auto-follow
 *    behaviour was REMOVED: the chart never slides right on its own. The
 *    Scroll-to-latest button is the only way back to the live edge.
 *  - EXCEPTION: when "Load More History" captured a visible range, the next
 *    prepend repaint restores that exact window (the user stays anchored on
 *    the candles they were reading).
 *  - Emits the crosshair-hovered candle — or `null` (→ fall back to the latest
 *    forming/historical candle) — to the OHLC readout.
 */
function ViewportBridge({
  candles,
  bucketSec,
  onCrosshairCandle,
  preserveRangeRef,
  onNearHistoryEdge,
}: {
  candles: readonly Candle[];
  bucketSec: number;
  onCrosshairCandle: (c: Candle | null) => void;
  /** When set (by the "Load More History" click) the NEXT bus-"data" repaint —
   *  the prepend — restores this exact visible window instead of leaving the
   *  bar layout to shift underneath the user, keeping the historical viewport
   *  anchored. Structural type: a mutable ref to the captured LWC visible range. */
  preserveRangeRef?: { current: { from: number; to: number } | null } | null;
  /** Reports whether the visible range's left edge sits near the oldest
   *  loaded candle (reveals the "Load More History" control). */
  onNearHistoryEdge?: (near: boolean) => void;
}) {
  const api = useChartApi();
  const candlesRef = useRef(candles);
  const nearEdgeRef = useRef(false);
  const nearEdgeCbRef = useRef(onNearHistoryEdge);
  nearEdgeCbRef.current = onNearHistoryEdge;
  candlesRef.current = candles;

  useEffect(() => {
    const controller = api.controller;
    if (!controller) return;
    const lwc = controller.getChart() as unknown as ChartApi;
    const ts = lwc.timeScale();
    const series = controller.getSeries();
    let disposed = false;

    const onMove = (param: unknown) => {
      if (disposed) return;
      const p = param as { time?: unknown; seriesData?: { get?(k: unknown): unknown } } | null;
      const raw =
        p && p.seriesData && typeof p.seriesData.get === "function"
          ? p.seriesData.get(series)
          : undefined;
      if (raw && typeof raw === "object" && "open" in raw) {
        const v = raw as { open: number; high: number; low: number; close: number; volume?: number; time?: number };
        onCrosshairCandle(toCandle(typeof v.time === "number" ? v.time * 1000 : Date.now(), v));
      } else {
        // Crosshair not over a real candle (empty space) -> fall back to latest.
        onCrosshairCandle(null);
      }
    };

    const onPan = () => {
      if (disposed) return;
      let range: { from: number; to: number } | null = null;
      try {
        range = ts.getVisibleRange();
      } catch {
        /* older LWC */
      }
      // Historical-edge proximity → reveal/hide the "Load More History" control.
      const edgeCb = nearEdgeCbRef.current;
      if (edgeCb) {
        const oldest = candlesRef.current[0];
        const near =
          range && oldest
            ? isNearHistoryEdge(range.from, oldest.ts / 1000, bucketSec)
            : false;
        if (near !== nearEdgeRef.current) {
          nearEdgeRef.current = near;
          edgeCb(near);
        }
      }
    };

    const applyViewportAfterData = () => {
      const captured = preserveRangeRef?.current ?? null;
      if (!captured) return; // Auto-follow removed: the user's viewport is never moved.
      // Prepend repaint: put the user back on the exact candles they were
      // viewing (the captured times still resolve to the same candles —
      // prepends are strictly older and never re-time existing bars).
      if (preserveRangeRef) preserveRangeRef.current = null;
      try {
        ts.setVisibleRange(captured);
      } catch {
        /* older LWC — keep the current view */
      }
    };

    try { ts.subscribeVisibleTimeRangeChange(onPan); } catch { /* older LWC */ }
    onPan();
    applyViewportAfterData();
    // Re-align after every full-history setData (CandleKit emits "data" there).
    const offData = controller.bus.on("data", applyViewportAfterData);

    try { lwc.subscribeCrosshairMove(onMove); } catch { /* crosshair disabled */ }
    return () => {
      disposed = true;
      offData();
      try { lwc.unsubscribeCrosshairMove(onMove); } catch { /* noop */ }
      try { ts.unsubscribeVisibleTimeRangeChange(onPan); } catch { /* noop */ }
    };
  }, [api, bucketSec, onCrosshairCandle]);

  return null;
}

/**
 * Renders the candlestick chart via CandleKit (on top of Lightweight Charts).
 *
 * The initial snapshot is the REST history (`candles`), aligned to bucket-start
 * timestamps so the live stream and the history share a single UTC time base
 * (epoch ms at the Bar level; CandleKit converts to epoch seconds for LWC).
 * Realtime bars are applied incrementally via `updateBar` (never a full data
 * replacement per tick). NO indicators (EMA etc.) are attached — indicators are
 * a separate future task.
 *
 * Viewport is TradingView-style: autoFit is DISABLED so loading 500 candles
 * does not squash them into the full width; instead the chart opens at a
 * readable bar spacing, right-aligned on the latest candle (see
 * ViewportBridge), with 8 bars of right margin like TradingView's default.
 */
export function TradingChart({
  candles,
  gaps,
  resolution = "",
  liveCandle = null,
  streamStatus = "DISCONNECTED",
  loading = false,
  emaSettings = defaultEmaSettings(),
  smaSettings,
  pineIndicators = [],
  pineSymbol = null,
  marketCalendar = null,
  onPineStatus,
  invertScale = false,
  onToggleInvertScale,
  replaySymbol,
  onLoadMoreHistory,
  historyStatus,
  onQuoteCandle,
  replayPicking = false,
  onReplayPickingChange,
  onReplayStateChange,
  onEmaChange,
  onSmaChange,
  onPineChange,
  onOpenIndicatorSettings,
}: Props) {
  const [crosshairCandle, setCrosshairCandle] = useState<Candle | null>(null);
  // When history is empty (e.g. IG allowance exhausted), ChartView still needs
  // at least one bar so Lightweight Charts can render / accept series.update().
  // We accumulate live candles in a state array and merge into each bucket.
  // NEVER call setData per tick — only on NEW buckets or history sync.
  // Intrabucket ticks are handled by LiveBarBridge's incremental updateBar.
      const [liveCandles, setLiveCandles] = useState<Bar[]>([]);

  // ── Closed-live-bucket ledger ────────────────────────────────────────────────
  // App's `candles` history is frozen at load — live bucket rollovers are only
  // painted into the CandleKit controller (LiveBarBridge), never written back to
  // state. The indicator bridges (EMA/SMA/Pine) build their input from a frozen
  // history slice + the single forming candle, so every live bucket that closes
  // after the last history load silently disappears from the Pine input.
  //
  // This ledger captures each genuinely-closed live bucket exactly once so the
  // bridges can reconstruct the complete:
  //   [historical bars] + [closed-live ledger] + [forming candle]
  // series. It is:
  //   - scoped to the current instrument + timeframe (reset on switch / refresh);
  //   - only populated in LIVE mode (cleared and unused during replay);
  //   - never fed to ChartView / history / pagination / viewport.
  const [closedLiveBars, setClosedLiveBars] = useState<Bar[]>([]);
  // Track the previous forming candle's bucket time to detect rollovers WITHOUT
  // stale React closures — refs always hold the latest value inside effects.
  const prevFormingTsRef = useRef<number | null>(null);
  // Ref storing the previous forming candle's full OHLC (for rollover capture).
  const prevFormingBarRef = useRef<RealtimeCandleMsg | null>(null);

  const bucketSec = resolutionToBucketSec(resolution);

  useEffect(() => {
    if (candles.length > 0) {
      // Drop the live-only copy when real history is present. CRITICAL: reuse
      // the SAME array reference when it is already empty. A naive
      // `setLiveCandles([])` mints a new identity on EVERY live tick, which
      // changes the `data`/`bars` prop identity of ChartView and re-fires its
      // setData effect per tick — visibly snapping the viewport to the right
      // edge on every price update (full data replacement per tick).
      setLiveCandles((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    if (!liveCandle) return;
    // Live-only mode (no history): reconcile through the SAME planner as
    // LiveBarBridge — stale frames skipped, OHLC merged per contract
    // (open immutable, high=max, low=min, close=latest, volume=server
    // cumulative, NOT additive), hidden tabs get direct truth commits.
    setLiveCandles((prev) => {
      const last = prev.length > 0 ? prev[prev.length - 1] : null;
      const plan = planLiveUpdate(last, liveCandle, bucketSec, {
        hidden: document.visibilityState === "hidden",
      });
      if (plan.skipped || !plan.truth) return prev;
      if (plan.rollover) {
        const next = [...prev];
        if (last && plan.commits.length > 1) next[next.length - 1] = asBar(plan.commits[0]);
        next.push(asBar(plan.truth));
        console.info(
          `[CHART] ROLLOVER prevBucket=${last ? iso(last.ts) : "(seed)"} ` +
            `newBucket=${iso(plan.truth.ts)} barsBefore=${prev.length} barsAfter=${next.length} ` +
            `setData=${prev.length === 0 ? true : false} updateBar=${prev.length > 0 ? true : false}`,
        );
        return next; // new array reference → ChartView setData once per rollover
      }
      if (last) {
        // Same bucket — merge into the last bar in place. We return the *same*
        // array reference so no setData fires (LiveBarBridge owns the paint).
        last.high = plan.truth.high;
        last.low = plan.truth.low;
        last.close = plan.truth.close;
        if (plan.truth.volume !== undefined) last.volume = plan.truth.volume;
        return prev;
      }
      return prev;
    });
      }, [candles.length, liveCandle, bucketSec]);

  // ── Closed-live-bucket capture (LIVE mode only) ──────────────────────────────
  // When history IS present, the `liveCandles` effect above early-returns and
  // never sees rollovers. This parallel effect runs on every live tick whenever
  // history exists, detects bucket rollovers by comparing the forming candle's
  // bucket time against the previous frame, and commits the previous forming
  // candle's TRUE OHLC to the closed-live ledger — exactly once per bucket.
  //
  // Each WS `liveCandle` is a full server OHLC snapshot of the forming bucket
  // (TCP-ordered, last-write-wins). So the last frame before a rollover IS the
  // closed bucket's final OHLC — there is no glide/animated value here.
  //
  // Stale-closure safety: refs hold the live values (`prevFormingTsRef.current`,
  // `prevFormingBarRef.current`), so the comparison is always against the real
  // previous frame, not a closure snapshot. No tick is missed and no bucket is
  // recorded twice: we only push when the bucket time strictly advances, and
  // dedup by ts on insert.
  useEffect(() => {
    if (candles.length === 0) {
      // Live-only mode: liveCandles accumulates the full series; no ledger needed.
      prevFormingTsRef.current = liveCandle ? liveCandle.time : null;
      prevFormingBarRef.current = liveCandle ?? null;
      return;
    }
    if (!liveCandle) return;

    const prevTs = prevFormingTsRef.current;

    // Rollover: the forming bucket advanced → the previous bucket is now closed.
    if (prevTs !== null && liveCandle.time > prevTs) {
      const prev = prevFormingBarRef.current;
      if (prev) {
        const bucketMs = bucketSec * 1000;
        const prevBucketTs = Math.floor((prev.time * 1000) / bucketMs) * bucketMs;
        const closedBar: Bar = {
          ts: prevBucketTs,
          open: prev.open,
          high: prev.high,
          low: prev.low,
          close: prev.close,
          ...(Number.isFinite(prev.volume) ? { volume: prev.volume } : {}),
        };
        setClosedLiveBars((prevList) => {
          // Dedup by bucket ts — never record the same rollover twice.
          if (prevList.some((b) => b.ts === prevBucketTs)) return prevList;
          return [...prevList, closedBar];
        });
      }
    }

    // Store the current forming frame for the next rollover detection.
    prevFormingTsRef.current = liveCandle.time;
    prevFormingBarRef.current = liveCandle;
  }, [liveCandle, candles.length, bucketSec]);




  const data = useMemo<Bar[]>(() => {
    if (candles.length > 0) {
      return candles.map((c) => asBar({ ...c, ts: alignToBucketStart(c.ts, bucketSec) }));
    }
    return liveCandles;
    }, [candles, bucketSec, liveCandles]);

  // ── Closed-live-bucket ledger reset ───────────────────────────────────────────
  // The ledger is scoped to the current instrument + timeframe. When the
  // instrument changes (candles cleared by App) or the timeframe changes
  // (bucketSec changes), reset the refs AND the ledger state so stale
  // candles from another context can never leak into the new stream.
  useEffect(() => {
    setClosedLiveBars([]);
    prevFormingTsRef.current = null;
    prevFormingBarRef.current = null;
  }, [candles, bucketSec]);

  // OHLC strip: crosshair-hovered candle takes priority, else the latest forming candle.
  const last: Candle | undefined = liveCandle
    ? {
        ts: liveCandle.time * 1000,
        open: liveCandle.open,
        high: liveCandle.high,
        low: liveCandle.low,
        close: liveCandle.close,
        ...(liveCandle.volume !== undefined && Number.isFinite(liveCandle.volume) ? { volume: liveCandle.volume } : {}),
      }
    : candles[candles.length - 1];

  // ── Display timezone: Asia/Manila (UTC+08:00) ─────────────────────────────
  // Data timestamps stay UTC epoch seconds everywhere (DB, IG UTM, live WS).
  // Only the RENDERED labels — time-axis ticks and the crosshair time label —
  // are formatted in Philippine time via Lightweight Charts formatters.
  // PH is a fixed +8 whole-hour offset (no DST), so any whole-minute bucket
  // grid (1m / 3m — :00 / :03 / :06 …) is identical in UTC and PH — zero
  // alignment risk.
  const manilaChartOptions = useMemo<DeepPartial<ChartOptions>>(
    () => ({
      timeScale: {
        barSpacing: 9,
        rightOffset: 8,
        // TradingView-style future-time breathing room: keep the latest REAL
        // candle rightOffset bars away from the right edge and let the axis
        // render future time labels in that empty area.
        //
        // AUTO-FOLLOW REMOVED: the chart must never slide right on its own.
        // `shiftVisibleRangeOnNewBar` stays `false` (CandleKit's base default,
        // chosen so replay never auto-scrolls). With `true`, LWC advances the
        // time scale with every appended realtime bar — that automatic
        // right-march is exactly the behavior the "Auto" feature provided and
        // was removed by request.
        shiftVisibleRangeOnNewBar: false,
        // WhitespaceBridge re-sets the trailing-slot series on every rollover,
        // and LWC classifies that setData as a whitespace-replacing update.
        // With this flag left disabled, even that refresh never nudges the
        // viewport right — the user's position always wins. (The right-side
        // future-space labels still render from the whitespace slots; the
        // scale simply does not chase them.)
        allowShiftVisibleRangeOnWhitespaceReplacement: false,
        // Missing-gap whitespace slots PARTICIPATE in grid lines, tick marks
        // and crosshair snapping — the IG-like empty-time behavior. This is
        // already the LWC default for standard charts; set explicitly to
        // document the contract the whitespace feature relies on.
        ignoreWhitespaceIndices: false,
        tickMarkFormatter: ((time: unknown, tickMarkType: TickMarkType) => {
          const tsMs = Number(time) * 1000;
          switch (tickMarkType) {
            case TickMarkType.Year:
            case TickMarkType.Month:
            case TickMarkType.DayOfMonth:
              return formatManilaDayHHMM(tsMs);
            case TickMarkType.TimeWithSeconds:
              return formatManilaHHMMSS(tsMs);
            case TickMarkType.Time:
            default:
              return formatManilaHHMM(tsMs);
          }
        }) as TickMarkFormatter,
      },
      localization: {
        // Crosshair time label (the tooltip's time) — full PH date+time.
        timeFormatter: ((time: unknown) =>
          formatManilaDateTimeFull(Number(time) * 1000)) as TimeFormatterFn,
      },
    }),
    [],
  );

  // ── Replay Mode — CandleKit-native (mirrors examples/replay) ───────────────
  // The ReplayController is the single source of truth: CandleKit's own
  // <ReplayControls> drives play/pause/step/speed/seek, and ONE subscription
  // paints `getBarsUpToCursor()` onto the chart series on every engine state
  // change — the official example's exact pattern (setData uniformly handles
  // entry, forward ticks, backward steps and seeks; updateBar is never used).
  // AURA adds only what the demo doesn't have: live-paint suppression,
  // cursor-scoped indicator inputs, candle-pick entry and a clean exit.
  const [chartApi, setChartApi] = useState<ChartViewApi | null>(null);

  /** LWC chart handle (controller.getChart()), memoized for the ScrollToLatest button. */
  const lwcChart = useMemo<ChartApi | null>(() => {
    if (!chartApi?.controller) return null;
    try {
      return chartApi.controller.getChart() as unknown as ChartApi;
    } catch {
      return null;
    }
  }, [chartApi]);

  /**
   * Rendered width of the right price scale (px; 0 = not measurable yet). The
   * MA Structure overlay anchors LEFT of it so the panel never covers the price
   * axis — re-measured on chart resize / timeframe switch via the effect below.
   */
  const [priceScaleInset, setPriceScaleInset] = useState(0);
  /** Chart container (`.chart-canvas-wrap`) — the right-click context menu's
      positioning context and right-click area (see ChartContextMenu). */
  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const [session, setSession] = useState<{
    rc: ReplayController;
    manifest: Parameters<ReplayController["load"]>[0];
    interval: string;
  } | null>(null);
  // Replay ENTRY state lives in App's unified header button (the old
  // `.replay-bar` row is gone); this component only CONSUMES it for the
  // candle-pick effect and disarms it when a session starts.
  const picking = replayPicking;
  const setPicking = onReplayPickingChange ?? NOOP;
    /** Replay-visible bars (cursor slice) feeding the indicator bridges + OHLC. */
  const visibleRef = useRef<readonly Bar[]>(NO_BARS);
  // The bump (not the value) is what matters: it re-renders the ref-reads
  // (visibleBars / replayCursorCandle) after every engine state change.
  const [, bumpVisible] = useReducer((n: number) => n + 1, 0);

  // TIME-SCALE WHITESPACE slots (epoch ms) — the timestamps WhitespaceBridge
  // registers for detected data gaps. Presentation-only: the Pine engine and
  // every indicator keep running on REAL candles; these slots exist solely so
  // drawing anchors can be remapped onto the shifted logical grid. Empty
  // during replay — the replay timeline is compacted (no whitespace).
  //
  // Deliberately WITHOUT opts.live: these slots feed PineBridge's drawing-anchor
  // REMAP, whose future-extension formula `logical + slots.length` assumes
  // every slot PRECEDES the future logicals. The 8 LIVE trailing slots sit
  // AFTER the last candle — they fill the rightOffset breathing room on the
  // axis (WhitespaceBridge registers them) but must NOT shift future engine
  // logicals, or extrapolated drawing edges (session boxes) would land 8 bars
  // too far right.
  const whitespaceSlots = useMemo(
    () => (session ? [] : buildWhitespacePlan(candles, gaps ?? [], bucketSec).slots),
    [session, candles, gaps, bucketSec],
  );

  // Measure the right price scale's ACTUAL rendered width once the chart is
  // ready, and keep it current as the chart resizes (browser width, chart
  // width, timeframe switches all flow through LWC's size-change event). The
  // MA Structure panel consumes this as its right inset — never an arbitrary
  // fixed offset — so the axis labels always stay readable.
  useEffect(() => {
    if (!chartApi) return;
    const chart = chartApi.controller.getChart() as unknown as ChartApi | null;
    if (!chart) return;
    const report = (): void => {
      try {
        const w = chart.priceScale("right").width();
        setPriceScaleInset(Number.isFinite(w) && w > 0 ? Math.ceil(w) : 0);
      } catch {
        /* price-scale API unsupported — the CSS fallback offset stays */
      }
    };
    report();
    // Let LWC settle its layout after the first paint, then re-measure.
    const raf = requestAnimationFrame(() => requestAnimationFrame(report));
    const timeScale = chart.timeScale();
    if (timeScale && typeof timeScale.subscribeSizeChange === "function") {
      timeScale.subscribeSizeChange(report);
    }
    return () => {
      cancelAnimationFrame(raf);
      try {
        timeScale?.unsubscribeSizeChange?.(report);
      } catch {
        /* chart already torn down */
      }
    };
  }, [chartApi, bucketSec]);

  // ── Incremental history ("Load More History") ───────────────────────────────
  // App owns the fetch/merge; this component owns the VIEWPORT CONTRACT and the
  // edge control. On click we snapshot the exact visible window BEFORE the
  // prepend repaint; ViewportBridge restores it on the bus-"data" event that
  // follows the setData — the user stays visually anchored on the same candles.
  const preserveRangeRef = useRef<{ from: number; to: number } | null>(null);
  const [nearEdge, setNearEdge] = useState(false);
  const handleLoadMore = useCallback(() => {
    if (session || !onLoadMoreHistory || !data.length) return;
    if (historyStatus?.loading || historyStatus?.exhausted) return;
    try {
      const chart = chartApi?.controller.getChart() as unknown as ChartApi | null;
      const range = chart?.timeScale().getVisibleRange() ?? null;
      if (range) preserveRangeRef.current = { from: range.from, to: range.to };
    } catch {
      /* viewport capture unsupported — the restore simply won't engage */
    }
    onLoadMoreHistory();
  }, [session, onLoadMoreHistory, historyStatus, chartApi, data.length]);

  // Enter: the picked candle becomes the replay start (the last visible bar
  // before playback). The manifest wraps the ALREADY-LOADED history — the
  // source array is never mutated and nothing is refetched.
  const enterReplay = useCallback(
    (startTs: number) => {
      if (!chartApi || session || data.length === 0) return;
      const interval = resolution || "DEFAULT";
      const { manifest, dates } = buildReplayManifest({
        id: `${replaySymbol ?? REPLAY_SYMBOL}|${interval}|${startTs}`,
        symbol: REPLAY_SYMBOL,
        interval,
        bars: data,
        startTs,
      });
      const rc = createReplayController(replayEngineOptions(dates));
      visibleRef.current = NO_BARS; // hide the future until the first slice lands
      setPicking(false);
      setSession({ rc, manifest, interval });
    },
    [chartApi, session, data, resolution, replaySymbol, setPicking],
  );

  const exitReplay = useCallback(() => setSession(null), []);

  // The single paint loop (CandleKit example pattern). Runs after ChartView
  // has cleared its series (child effects first), so the future candles can
  // never flash on entry. Unsubscribing + unloading here is also the exit
  // path and the unmount cleanup.
  useEffect(() => {
    if (!session || !chartApi) return;
    const { rc, manifest, interval } = session;
    const unsub = rc.subscribe((s) => {
      if (s.status !== "ready") return;
      const slice = rc.getBarsUpToCursor(REPLAY_SYMBOL, interval);
      visibleRef.current = slice;
      try {
        chartApi.controller.setData(slice);
      } catch {
        /* chart already torn down */
      }
      bumpVisible();
    });
    void rc.load(manifest);
    return () => {
      unsub();
      try {
        rc.unload();
      } catch {
        /* already idle */
      }
    };
  }, [session, chartApi]);

  // Scope guard: an instrument/timeframe change invalidates the replay cursor
  // — exit cleanly instead of carrying it across datasets. (A mid-session
  // history refetch intentionally does NOT exit: replay is a frozen in-memory
  // simulation, and exiting would repaint the refetched dataset.)
  useEffect(() => {
    setSession((s) => (s ? null : s));
    setPicking(false);
  }, [replaySymbol, resolution]);

  // Candle-pick entry: while armed (and idle), a click on a historical candle
  // reports its bucket ts as the replay start point (LWC subscribeClick).
  useEffect(() => {
    if (!chartApi || !picking || session) return;
    const chart = chartApi.controller.getChart() as unknown as {
      subscribeClick?(h: (param: unknown) => void): void;
      unsubscribeClick?(h: (param: unknown) => void): void;
    } | null;
    if (!chart || typeof chart.subscribeClick !== "function") return;
    const series = chartApi.controller.getSeries();
    const onClick = (param: unknown) => {
      const p = param as { seriesData?: { get?(k: unknown): unknown } | null };
      const raw =
        p && p.seriesData && typeof p.seriesData.get === "function"
          ? p.seriesData.get(series)
          : undefined;
      const time =
        raw && typeof raw === "object" ? (raw as { time?: number }).time : undefined;
      if (typeof time === "number" && Number.isFinite(time)) enterReplay(time * 1000);
    };
    try {
      chart.subscribeClick(onClick);
    } catch {
      /* click unsupported */
    }
    return () => {
      try {
        chart.unsubscribeClick?.(onClick);
      } catch {
        /* noop */
      }
    };
  }, [chartApi, picking, session, enterReplay]);

  // ── Replay hotkeys (session-scoped) ─────────────────────────────────────────
  // → step forward one bar · ← step back one bar · Space play/pause.
  // Bound ONLY while a replay session exists (the live chart keeps arrow/space
  // for its own scrolling), and never hijacks keys while the user is typing in
  // an input/textarea/contentEditable.
  useEffect(() => {
    if (!session) return;
    const rc = session.rc;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        rc.step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        rc.step(-1);
      } else if (e.key === " " || e.code === "Space") {
        e.preventDefault(); // keep the page from scrolling
        const st = rc.getState();
        if (st.status === "ready") {
          if (st.playing) rc.pause();
          else rc.play();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  // Replay-visible bars: the cursor slice during a session, the full dataset
  // otherwise. Ref-reads are re-rendered into view by `visibleTick`.
  const visibleBars = session ? visibleRef.current : data;
  // The bar under the replay cursor — the OHLC strip's "current" candle while
  // replay is active (a crosshair hover still wins).
  const replayCursorCandle: Candle | null = (() => {
    if (!session) return null;
    const vis = visibleRef.current;
    if (vis.length === 0) return null;
    const idx = findReplayIndex(data, vis[vis.length - 1].ts);
    return idx >= 0 ? data[idx] ?? null : null;
  })();
  const replayActive = session !== null;

  // ── Bridge bars: authoritative series for EMA / SMA / Pine ──────────────────
  // During LIVE mode: historical bars + closed-live ledger + forming candle.
  // During REPLAY: the cursor slice (visibleBars) — no ledger, no forming, so
  // indicators can NEVER see live future data or closed-live buckets.
  //
  // Declared AFTER `session`/`visibleBars` so the useMemo closure captures the
  // final values (a TDZ reference here throws at runtime — this is the
  // "Cannot access 'session' before initialization" crash from the bridge
  // wiring landing above the replay state declarations).
  const bridgeBars = useMemo<readonly Bar[]>(() => {
    if (session) {
      // Replay: use the cursor slice exactly as before.
      return visibleBars;
    }
    // Live: merge historical + closed-live ledger + forming candle into the
    // complete, strictly-ordered, no-duplicates series the bridges need.
    return mergeBridgeBars(
      candles.length > 0
        ? candles.map((c) => asBar({ ...c, ts: alignToBucketStart(c.ts, bucketSec) }))
        : liveCandles,
      closedLiveBars,
      liveCandle ?? null,
      bucketSec,
    );
  }, [session, candles, bucketSec, liveCandles, closedLiveBars, liveCandle, visibleBars]);

  // ── Unified-header reporting (the old bottom `.chart-footer` is gone) ──────
  // Quote candle (crosshair ?? replay cursor ?? latest) is pushed UP to App,
  // which renders the OHLC strip in the top header. App's setter is
  // value-guarded (ts/OHLC), so the fresh `last` object identities minted on
  // renders that don't change any displayed value can never loop.
  const quoteCandle = crosshairCandle ?? replayCursorCandle ?? last;
  useEffect(() => {
    onQuoteCandle?.(quoteCandle);
  }, [onQuoteCandle, quoteCandle]);

  // Replay UI state for the header entry button: hidden while a session is
  // active (the in-plot dock takes over), disabled with nothing to replay.
  const replayUiState = useMemo(
    () => ({ active: session !== null, canEnter: data.length > 0 }),
    [session, data.length],
  );
  useEffect(() => {
    onReplayStateChange?.(replayUiState);
  }, [onReplayStateChange, replayUiState]);

  return (
    <div className="trading-chart" data-stream={streamStatus}>
      {/* Replay entry lives in App's unified top header. While a session is
          active, CandleKit's native ReplayControls + Exit render as a floating
          dock bottom-center INSIDE the plot area (.replay-dock), so the header
          chrome and the right price scale are never covered. */}
      <div className="chart-canvas-wrap" ref={chartWrapRef}>
        <ChartView
          data={session ? NO_BARS : data}
          seriesType="candlestick"
          theme="dark"
          showVolume={false}
          autoFit={false}
          chartOptions={manilaChartOptions}
          onReady={setChartApi}
        >
          <LiveBarBridge liveCandle={liveCandle} bucketSec={bucketSec} replayActive={replayActive} />
          <ViewportBridge
            candles={candles}
            bucketSec={bucketSec}
            onCrosshairCandle={setCrosshairCandle}
            preserveRangeRef={preserveRangeRef}
            onNearHistoryEdge={setNearEdge}
          />
          {/* Visual price-scale inversion ("Invert Scale") — native LWC
              price-scale transform on the main right scale. Candles, EMAs and
              pane-0 overlays invert together; separate indicator panes are
              untouched. No data is modified. */}
          <InvertScaleBridge invertScale={invertScale} />
          {/* ⚠ TEMP diagnostic probe — inert unless ?debugInvert / aura.debug.invert=1 */}
          <InvertDebugProbe invertScale={invertScale} />
          {/* Compact MM:SS close-countdown pill beside the current/live candle
              — a tiny time-remaining-to-close marker rendered by a series
              primitive (no DOM, no fake candles). The countdown derives from
              the candle's real bucket boundary (closesAt − now) and re-anchors
              on every WS frame, so it rides rollovers automatically. Hidden
              during Replay: a countdown counts LIVE market time, which does
              not exist on a replaying (historical) chart. */}
          <CountdownMarker
            liveCandle={liveCandle}
            bucketSec={bucketSec}
            replayActive={session !== null}
          />
          {/* EMA 9 / EMA 20 overlays — plain LWC line series on the price
              pane, recalculated from the SELECTED timeframe's candles with the
              forming candle's server truth (see services/ema.ts). While replay
              is active the bars are the cursor slice and the present-day
              forming candle is withheld, so indicators can never see the
              future. */}
                                        <EmaBridge
            bars={bridgeBars}
            liveCandle={session ? null : liveCandle}
            bucketSec={bucketSec}
            settings={emaSettings}
          />
          {/* SMA overlay — pure moving average on the SELECTED timeframe's
              candles, same lifecycle + anti-look-ahead guarantees as EmaBridge
              (cursor slice during Replay, live truth merged per tick). */}
          {smaSettings && (
                        <SmaBridge
              bars={bridgeBars}
              liveCandle={session ? null : liveCandle}
              bucketSec={bucketSec}
              settings={smaSettings}
            />
          )}
          {/* Imported Pine indicators — same generic Piner engine path as the
              EMAs, rendered via native LWC panes when overlay=false. */}
                    <PineBridge
            bars={bridgeBars}
            liveCandle={session ? null : liveCandle}
            bucketSec={bucketSec}
            indicators={pineIndicators}
            symbol={pineSymbol}
            onStatus={onPineStatus}
            whitespaceSlots={whitespaceSlots}
          />
          {/* DATA GAP shading — presentation-only band primitive attached to the
              main series; hidden while a replay session owns the chart. */}
          <GapShading candles={candles} gaps={gaps} bucketSec={bucketSec} enabled={!session} />
          {/* TIME-SCALE WHITESPACE — invisible LWC series registering the
              missing-gap timestamps as real empty time slots (IG-style).
              Cleared during a replay session, restored on exit. */}
          <WhitespaceBridge
            candles={candles}
            gaps={gaps}
            bucketSec={bucketSec}
            replayActive={session !== null}
            calendar={marketCalendar}
            formingBucketSec={liveCandle?.time ?? null}
          />
        </ChartView>
        {/* Upper-left indicator legend — compact TradingView-style control
            overlay for currently-active indicators. Lives inside the chart
            plot area so it moves with the chart, never the page. Rendered
            only when App supplies the shared-state handlers AND some
            indicator state exists (the legend is pure state reflection). */}
        {onEmaChange &&
          onSmaChange &&
          onPineChange &&
          onOpenIndicatorSettings &&
          (emaSettings || smaSettings || (pineIndicators?.length ?? 0) > 0) && (
            <ActiveIndicatorsOverlay
              emaSettings={emaSettings ?? defaultEmaSettings}
              smaSettings={smaSettings}
              imported={pineIndicators ?? []}
              onEmaChange={onEmaChange}
              onSmaChange={onSmaChange}
              onPineChange={onPineChange}
              onOpenSettings={onOpenIndicatorSettings}
            />
          )}

        {/* Historical-edge control — subtle pill, top-left, revealed only when
            the user pans near the oldest loaded candle. Hidden during Replay
            (a replaying chart is a frozen dataset, never paginated). */}
        {historyStatus && shouldShowLoadMore({
          replayActive: session !== null,
          exhausted: historyStatus.exhausted,
          nearEdge,
          hasData: data.length > 0,
        }) && (
          historyStatus.exhausted ? (
            <div className="history-more history-more--end">No more history</div>
          ) : (
            <button
              type="button"
              className="history-more"
              onClick={handleLoadMore}
              disabled={historyStatus.loading}
            >
              {historyStatus.loading
                ? "Loading history…"
                : historyStatus.error
                  ? `Retry · ${historyStatus.error}`
                  : "Load More History"}
            </button>
          )
        )}
        {loading && <div className="chart-spinner">…</div>}
        {/* Moving Average Structure (EMA9 • EMA20 • SMA20) — trader-facing
            overlay panel. Same anti-look-ahead contract as the bridges: the
            bars are the replay cursor slice during Replay and the forming
            candle's live truth is withheld, so structure/gaps can never see
            the future or mix replay state into live data. resetKey re-seeds
            the gap-trend history on instrument / timeframe / replay streams. */}
        <MaStructurePanel
          bars={visibleBars}
          liveCandle={session ? null : liveCandle}
          bucketSec={bucketSec}
          replayActive={session !== null}
          resetKey={`${replaySymbol ?? ""}|${bucketSec}|${session ? "replay" : "live"}`}
          rightInset={priceScaleInset}
        />
        {/* Replay dock — CandleKit's native ReplayControls + Exit, floating
            bottom-center INSIDE the plot area so the top header chrome and the
            right price scale stay unobstructed while a session is active. */}
        {session && (
          <div className="replay-dock" data-replay="active">
            <ReplayControls controller={session.rc} formatTime={formatManilaHHMMSS} />
            <button type="button" className="replay-dock-exit" onClick={exitReplay}>
              Exit Replay
            </button>
          </div>
        )}
        {/* Scroll-to-latest nav — TradingView-style arrow, bottom-right of the
            plot. Hidden at the live edge and during Replay; clicking pans back
            to the latest candle without reloading data (whitespace gaps intact). */}
        <ScrollToLatestButton
          chart={lwcChart}
          latestTsSec={data.length > 0 ? data[data.length - 1].ts / 1000 : 0}
          bucketSec={bucketSec}
          replayActive={session !== null}
          rightInset={priceScaleInset}
        />
        {/* Right-click context menu — chart UI overlay (presentation-only).
            Reflects App's EXISTING Invert Scale state and invokes the SAME
            action the menu item uses; it never touches candle data, Pine,
            whitespace or replay state. scopeKey = instrument | timeframe
            | replay: a change closes the menu so the toggle never goes stale. */}
        <ChartContextMenu
          containerRef={chartWrapRef}
          invertScale={invertScale}
          onToggleInvertScale={onToggleInvertScale}
          scopeKey={`${replaySymbol ?? ""}|${bucketSec}|${session ? "replay" : "live"}`}
        />
      </div>
    </div>
  );
}
