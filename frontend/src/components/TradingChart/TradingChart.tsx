import { useEffect, useMemo, useRef, useState } from "react";
import { ChartView, useChartApi, type Bar } from "@getcandlekit/charts/react";
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
import { OHLCReadout } from "./OHLCReadout";

interface Props {
  candles: readonly Candle[];
  /** IG resolution id (MINUTE | MINUTE_3) — used for stream bucket alignment. */
  resolution?: string;
  /** Latest forming candle pushed by the backend (time = bucket start, epoch s). */
  liveCandle?: RealtimeCandleMsg | null;
  streamStatus?: RealtimeStatus;
  loading?: boolean;
  /** When true the viewport follows the latest bar; when false the user's pan is respected. */
  autoFollow?: boolean;
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
 * Smooth-tick animation for the forming (current) candle.
 *
 * IG ticks arrive as discrete WS frames; without animation the candle's close
 * would SNAP between consecutive tick prices. Instead we glide the close from
 * where it currently sits toward the latest tick over `SMOOTH_DURATION_MS`
 * using requestAnimationFrame, so the current 3-minute bar "moves" up/down
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
 * through `controller.updateBar(...)` — the incremental, non-destructive update
 * path. CandleKit compares the bar's `ts` (epoch-ms) against the last bar:
 * equal → updates the forming candle in place, newer → appends (bucket
 * rollover), older → discarded. So the rightmost candle moves with every live
 * tick and rolls over cleanly at the timeframe boundary.
 *
 * Handoff guarantee: CandleKit's `setData` (fired by ChartView on every history
 * load / timeframe switch / Refresh) REPLACES the whole bar array. We re-apply
 * the latest live candle on the controller bus "data" event so the forming bar
 * is never lost between a history snapshot and the next tick — and because IG's
 * last historical row IS the forming bucket, equal-ts frames merge into it (no
 * duplicate 11:00 candle).
 *
  * Price source note: backend builds candles from MID (bid+offer)/2 for
 * CFD parity with the IG platform chart; BID → OFR → LTP as fallback.
 */
function LiveBarBridge({
  liveCandle,
  bucketSec,
}: {
  liveCandle: RealtimeCandleMsg | null;
  bucketSec: number;
}) {
  const api = useChartApi();
  const liveRef = useRef(liveCandle);
  liveRef.current = liveCandle;

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

    const apply = (msg: RealtimeCandleMsg | null): void => {
      if (!msg) return;
      const ts = alignToBucketStart(msg.time * 1000, bucketSec);
      const bars = controller.getBars();
      const lastTs = bars.length > 0 ? bars[bars.length - 1].ts : 0;

      // Guard against out-of-order timestamps (stale stream frames after a
      // timeframe switch). Equal ts merges into the forming candle.
      if (ts < lastTs) {
        diag.updateBarSkipped += 1;
        console.info(
          `[CHART] updateBar SKIPPED (out of order): frame ${iso(ts)} < last bar ${iso(lastTs)}`,
        );
        return;
      }

      // LIGHTWEIGHT CHARTS FIX: series.update() silently drops the FIRST bar
      // when the series is empty (e.g. history REST was 429 / allowance
      // exhausted). Seed the series with a one-row setData so the forming
      // candle is actually visible; after this updateBar is the incremental path.
      if (bars.length === 0) {
        controller.setData([
          asBar({
            ts,
            open: msg.open,
            high: msg.high,
            low: msg.low,
            close: msg.close,
            volume: msg.volume,
          }),
        ]);
        diag.dataSeeded += 1;
        console.info(
          `[CHART] SEEDED empty series with first live candle ts=${iso(ts)} close=${msg.close}`,
        );
        const a = anim.current;
        if (a.raf) {
          cancelAnimationFrame(a.raf);
          a.raf = 0;
        }
        a.ts = ts;
        a.open = msg.open;
        a.close = msg.close;
        a.volume = msg.volume ?? 0;
        a.tHigh = msg.high;
        a.tLow = msg.low;
        a.tClose = msg.close;
        a.running = false;
        a.startClose = msg.close;
        return;
      }

      const a = anim.current;

      // New bucket (rollover) OR full-history re-sync: commit instantly rather
      // than gliding across a candle boundary (open must not animate).
      if (a.ts !== ts) {
        if (a.raf) {
          cancelAnimationFrame(a.raf);
          a.raf = 0;
        }
        a.running = false;
        a.ts = ts;
        a.open = msg.open;
        a.close = msg.close;
        a.volume = msg.volume ?? 0;
        a.tHigh = msg.high;
        a.tLow = msg.low;
        a.tClose = msg.close;
        a.startClose = msg.close;
        controller.updateBar(
          asBar({
            ts,
            open: msg.open,
            high: msg.high,
            low: msg.low,
            close: msg.close,
            volume: msg.volume,
          }),
        );
        diag.updateBarCalls += 1;
        const rollover = ts > lastTs;
        logUpdateBar(ts / 1000, msg.close);
        if (rollover) {
          console.info(
            `[CHART] new bucket ${iso(ts)} (previous candle closed) timeframe bucket=${bucketSec}s — updateBar #${diag.updateBarCalls}`,
          );
        }
        maybeLogChartBlock(bars.length + (rollover ? 1 : 0), bars[0].ts, ts);
        return;
      }

      // Same bucket — a fresh IG tick. Re-target the glide toward it, animating
      // FROM where the candle currently sits so consecutive ticks blend into a
      // smooth up/down curve (rather than snapping on every frame).
      a.tHigh = msg.high;
      a.tLow = msg.low;
      a.tClose = msg.close;
      a.volume = msg.volume ?? a.volume;
      a.startTs = performance.now();
      a.startClose = a.close;
      if (!a.running) {
        a.running = true;
        a.raf = requestAnimationFrame(glide);
      }
    };

    apply(liveCandle);
    // Re-apply the newest live candle AFTER every full-history setData
    // (initial load, timeframe switch, Refresh). Child effects run before the
    // parent's setData effect, so this must go through the bus "data" event,
    // which CandleKit emits at the end of setData.
    const offData = controller.bus.on("data", () => apply(liveRef.current));
    return () => {
      offData();
      const a = anim.current;
      if (a.raf) {
        cancelAnimationFrame(a.raf);
        a.raf = 0;
        a.running = false;
      }
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
}: {
  candles: readonly Candle[];
  liveCandle: RealtimeCandleMsg | null;
  bucketSec: number;
  autoFollow: boolean;
  onCrosshairCandle: (c: Candle | null) => void;
}) {
  const api = useChartApi();
  const candlesRef = useRef(candles);
  const liveRef = useRef(liveCandle);
  const autoRef = useRef(autoFollow);
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
    const ts = alignToBucketStart(liveCandle.time * 1000, bucketSec);
    const bar = asBar({
      ts,
      open: liveCandle.open,
      high: liveCandle.high,
      low: liveCandle.low,
      close: liveCandle.close,
      volume: liveCandle.volume,
    });
    setLiveCandles((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.ts === ts) {
        // Same bucket — update the last bar's high/low/close in place.
        // ChartView's ChartView will NOT see a new data prop reference (we
        // return the *same* array), so no setData fires — the incremental
        // LiveBarBridge.updateBar path owns this.
        last.high = Math.max(last.high, bar.high);
        last.low = Math.min(last.low, bar.low);
        last.close = bar.close;
        last.volume = (last.volume ?? 0) + (bar.volume ?? 0);
        return prev; // same array reference → no re-render of ChartView
      }
      // New bucket — append. This creates a NEW array reference so ChartView
      // calls setData once for the new bar (not per tick, only on rollover).
      console.info(
        `[CHART] ROLLOVER prevBucket=${prev.length > 0 ? iso(prev[prev.length - 1].ts) : "(seed)"} ` +
          `newBucket=${iso(ts)} barsBefore=${prev.length} barsAfter=${prev.length + 1} ` +
          `setData=${prev.length === 0 ? true : false} updateBar=${prev.length > 0 ? true : false}`,
      );
      return [...prev, bar];
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
  // PH is a fixed +8 whole-hour offset (no DST), so the 3-minute bucket grid
  // (:00 / :03 / :36 …) is identical in UTC and PH — zero alignment risk.
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

  return (
    <div className="trading-chart" data-stream={streamStatus}>
      <div className="chart-canvas-wrap">
        <ChartView
          data={data}
          seriesType="candlestick"
          theme="dark"
          showVolume
          autoFit={false}
          chartOptions={manilaChartOptions}
        >
          <LiveBarBridge liveCandle={liveCandle} bucketSec={bucketSec} />
          <ViewportBridge
            candles={candles}
            liveCandle={liveCandle}
            bucketSec={bucketSec}
            autoFollow={autoFollow}
            onCrosshairCandle={setCrosshairCandle}
          />
        </ChartView>
        {loading && <div className="chart-spinner">…</div>}
      </div>
      <div className="chart-footer">
        <OHLCReadout candle={crosshairCandle ?? last} />
      </div>
    </div>
  );
}