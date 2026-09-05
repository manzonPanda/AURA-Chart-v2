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
import type { Candle } from "../../types/candle";
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
import { planLiveUpdate, type LiveBar } from "../../services/liveCandle";
import { defaultEmaSettings, type EmaSettings } from "../../config/emaSettings";
import type { ImportedPineIndicator, PineRunStatus } from "../../services/pineImport";
import { CandleCountdown } from "./CandleCountdown";
import { EmaBridge } from "./EmaBridge";
import { InvertScaleBridge } from "./InvertScaleBridge";
import { InvertDebugProbe } from "./invertDebug"; // ⚠ TEMP debug probe (?debugInvert)
import { OHLCReadout } from "./OHLCReadout";
import { PineBridge } from "./PineBridge";
import {
  REPLAY_SYMBOL,
  buildReplayManifest,
  findReplayIndex,
  replayEngineOptions,
} from "../../services/replay";

interface Props {
  candles: readonly Candle[];
  /** Timeframe id (MINUTE_1 | MINUTE_3) — used for stream bucket alignment. */
  resolution?: string;
  /** Latest forming candle pushed by the backend (time = bucket start, epoch s). */
  liveCandle?: RealtimeCandleMsg | null;
  streamStatus?: RealtimeStatus;
  loading?: boolean;
  /** When true the viewport follows the latest bar; when false the user's pan is respected. */
  autoFollow?: boolean;
  /** EMA overlay configuration (localStorage-persisted in App). */
  emaSettings?: EmaSettings;
  /** Imported Pine indicators (localStorage-persisted in App). */
  pineIndicators?: ImportedPineIndicator[];
  /** Runtime status reporter for imported Pine indicators. */
  onPineStatus?: (id: string, status: PineRunStatus) => void;
  /**
   * Visual price-scale inversion (TradingView-style "Invert Scale"). A pure
   * viewport transform on the main right price scale — OHLC data, candle
   * order, crosshair values and the time axis are all untouched. Persisted
   * in App via chartSettings.ts.
   */
  invertScale?: boolean;
  /** Instrument scope key (used to scope a replay session). */
  replaySymbol?: string;
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
  scrollToRealTime(): void;
  fitContent(): void;
  subscribeVisibleTimeRangeChange(cb: () => void): void;
  unsubscribeVisibleTimeRangeChange(cb: () => void): void;
}
interface ChartApi {
  timeScale(): TimeScaleApi;
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
 *    viewport scrolls to the real-time edge, so the latest candle is always on
 *    screen while the user is following.
 *  - Tracks whether the user panned away from the real-time edge; once panned,
 *    it stops forcing the viewport back on every tick (LWC only auto-shifts
 *    when the visible range sits at the realtime edge anyway).
 *  - Emits the crosshair-hovered candle — or `null` (→ fall back to the latest
 *    forming/historical candle) — to the OHLC readout.
 */
function ViewportBridge({
  candles,
  liveCandle,
  bucketSec,
  autoFollow = true,
  onCrosshairCandle,
  replayCursor = null,
}: {
  candles: readonly Candle[];
  liveCandle: RealtimeCandleMsg | null;
  bucketSec: number;
  autoFollow: boolean;
  onCrosshairCandle: (c: Candle | null) => void;
  /** While Replay is active the "latest" bar is the replay cursor bar, never
   *  the live candle — the crosshair/OHLC and the follow-edge stay replay-
   *  scoped. */
  replayCursor?: Candle | null;
}) {
  const api = useChartApi();
  const candlesRef = useRef(candles);
  const liveRef = useRef(liveCandle);
  const autoRef = useRef(autoFollow);
  const replayCursorRef = useRef<Candle | null>(replayCursor);
  replayCursorRef.current = replayCursor;
  const followingRef = useRef(true);
  candlesRef.current = candles;
  liveRef.current = liveCandle;
  autoRef.current = autoFollow;

  useEffect(() => {
    const controller = api.controller;
    if (!controller) return;
    const lwc = controller.getChart() as unknown as ChartApi;
    const ts = lwc.timeScale();
    const series = controller.getSeries();
    let disposed = false;

    const latestCandle = (): Candle | null => {
      // Replay active → the current bar is the replay cursor bar.
      if (replayCursorRef.current) return replayCursorRef.current;
      const lc = liveRef.current;
      if (lc) {
        return toCandle(alignToBucketStart(lc.time * 1000, bucketSec), {
          open: lc.open, high: lc.high, low: lc.low, close: lc.close,
          ...(lc.volume !== undefined && Number.isFinite(lc.volume) ? { volume: lc.volume } : {}),
        });
      }
      const arr = candlesRef.current;
      return arr.length > 0 ? arr[arr.length - 1] : null;
    };

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
      try {
        const range = ts.getVisibleRange();
        const lastSec = (latestCandle()?.ts ?? 0) / 1000;
        followingRef.current = !range || !lastSec || range.to >= lastSec - bucketSec;
      } catch {
        followingRef.current = true;
      }
    };

    const scrollToLatest = () => {
      // Auto ON + user at the realtime edge → keep the latest candle visible.
      // Auto OFF or panned away → never move the user's viewport.
      if (autoRef.current && followingRef.current) {
        try { ts.scrollToRealTime(); } catch { /* older LWC */ }
      }
    };

    try { ts.subscribeVisibleTimeRangeChange(onPan); } catch { /* older LWC */ }
    onPan();
    scrollToLatest();
    // Re-align after every full-history setData (CandleKit emits "data" there).
    const offData = controller.bus.on("data", scrollToLatest);

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
  resolution = "",
  liveCandle = null,
  streamStatus = "DISCONNECTED",
  loading = false,
  autoFollow = true,
  emaSettings = defaultEmaSettings(),
  pineIndicators = [],
  onPineStatus,
  invertScale = false,
  replaySymbol,
}: Props) {
  const [crosshairCandle, setCrosshairCandle] = useState<Candle | null>(null);
  // When history is empty (e.g. IG allowance exhausted), ChartView still needs
  // at least one bar so Lightweight Charts can render / accept series.update().
  // We accumulate live candles in a state array and merge into each bucket.
  // NEVER call setData per tick — only on NEW buckets or history sync.
  // Intrabucket ticks are handled by LiveBarBridge's incremental updateBar.
  const [liveCandles, setLiveCandles] = useState<Bar[]>([]);

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

  const data = useMemo<Bar[]>(() => {
    if (candles.length > 0) {
      return candles.map((c) => asBar({ ...c, ts: alignToBucketStart(c.ts, bucketSec) }));
    }
    return liveCandles;
  }, [candles, bucketSec, liveCandles]);

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
  const [session, setSession] = useState<{
    rc: ReplayController;
    manifest: Parameters<ReplayController["load"]>[0];
    interval: string;
  } | null>(null);
  const [picking, setPicking] = useState(false);
    /** Replay-visible bars (cursor slice) feeding the indicator bridges + OHLC. */
  const visibleRef = useRef<readonly Bar[]>(NO_BARS);
  // The bump (not the value) is what matters: it re-renders the ref-reads
  // (visibleBars / replayCursorCandle) after every engine state change.
  const [, bumpVisible] = useReducer((n: number) => n + 1, 0);

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
    [chartApi, session, data, resolution, replaySymbol],
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

  return (
    <div className="trading-chart" data-stream={streamStatus}>
      {/* Replay chrome — CandleKit's native ReplayControls is the entire replay
          UI (play/pause/step/speed/seek/progress); AURA adds only the entry
          button and Exit (the demo hardcodes both), styled with CandleKit's
          own .ck-replay-btn class. Slim top row, in flow — no floating dock. */}
      <div className="replay-bar">
        {session ? (
          <>
            <ReplayControls controller={session.rc} formatTime={formatManilaHHMMSS} />
            <button type="button" className="ck-replay-btn" onClick={exitReplay}>
              Exit Replay
            </button>
          </>
        ) : (
          data.length > 0 && (
            <button
              type="button"
              className="ck-replay-btn"
              onClick={() => setPicking((v) => !v)}
            >
              {picking ? "Click a candle to start Replay…" : "Replay"}
            </button>
          )
        )}
      </div>
      <div className="chart-canvas-wrap">
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
            liveCandle={liveCandle}
            bucketSec={bucketSec}
            autoFollow={autoFollow}
            onCrosshairCandle={setCrosshairCandle}
            replayCursor={replayCursorCandle ?? undefined}
          />
          {/* Visual price-scale inversion ("Invert Scale") — native LWC
              price-scale transform on the main right scale. Candles, EMAs and
              pane-0 overlays invert together; separate indicator panes are
              untouched. No data is modified. */}
          <InvertScaleBridge invertScale={invertScale} />
          {/* ⚠ TEMP diagnostic probe — inert unless ?debugInvert / aura.debug.invert=1 */}
          <InvertDebugProbe invertScale={invertScale} />
          {/* TradingView-style countdown ON the right price scale, pinned to
              the forming candle's price level (native LWC price line; renders
              no DOM). Stays attached to the live price on 1m and 3m.
              Hidden while Replay is active: the countdown counts LIVE market
              time, which does not exist on a replaying (historical) chart. */}
          {!session && (
            <CandleCountdown liveCandle={liveCandle} candles={candles} bucketSec={bucketSec} invertScale={invertScale} />
          )}
          {/* EMA 9 / EMA 20 overlays — plain LWC line series on the price
              pane, recalculated from the SELECTED timeframe's candles with the
              forming candle's server truth (see services/ema.ts). While replay
              is active the bars are the cursor slice and the present-day
              forming candle is withheld, so indicators can never see the
              future. */}
          <EmaBridge
            bars={visibleBars}
            liveCandle={session ? null : liveCandle}
            bucketSec={bucketSec}
            settings={emaSettings}
          />
          {/* Imported Pine indicators — same generic PineTS engine path as the
              EMAs, rendered via native LWC panes when overlay=false. */}
          <PineBridge
            bars={visibleBars}
            liveCandle={session ? null : liveCandle}
            bucketSec={bucketSec}
            indicators={pineIndicators}
            onStatus={onPineStatus}
          />
        </ChartView>
        {loading && <div className="chart-spinner">…</div>}
      </div>
      <div className="chart-footer">
        <OHLCReadout candle={crosshairCandle ?? replayCursorCandle ?? last} invertScale={invertScale} />
      </div>
    </div>
  );
}