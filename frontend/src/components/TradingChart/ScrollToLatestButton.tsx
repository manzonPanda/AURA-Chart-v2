import { useEffect, useRef, useState } from "react";
import { isAtLatestEdge, shouldShowScrollToLatest } from "../../services/historyPagination";

export interface ChartTimeScaleLike {
  getVisibleRange: () => { from: number; to: number } | null;
  scrollToRealTime: () => void;
  subscribeVisibleTimeRangeChange: (cb: () => void) => void;
  unsubscribeVisibleTimeRangeChange: (cb: () => void) => void;
  /** Rendered height (px) of the bottom time axis — optional (older LWC). */
  height?: () => number;
}

export interface ChartLike {
  timeScale: () => ChartTimeScaleLike;
}

export interface ScrollToLatestButtonProps {
  /** CandleKit chart API (controller.getChart()), or null. */
  chart: ChartLike | null;
  /** Most recent REAL candle's epoch seconds (not a whitespace slot). */
  latestTsSec: number;
  /** Active timeframe in seconds (60/180/900/…). */
  bucketSec: number;
  /** True while a replay session owns the chart. */
  replayActive?: boolean;
  /**
   * Rendered right price-scale width (px), measured by TradingChart. The button
   * anchors LEFT of the axis (inset + gap) so it sits inside the candle plot
   * area, never covering the price axis. 0 = not measured yet → CSS fallback.
   */
  rightInset?: number;
}

/**
 * TradingView-style "scroll to most recent bar" control.
 *
 * Rendered as a tiny chevron pill anchored bottom-right of the chart plot,
 * just above the time axis. Hidden while at the live edge, during replay, or
 * when there are no candles. Clicking calls the chart's own scrollToRealTime(),
 * so the viewport pans to the latest registered bar WITHOUT reloading data —
 * whitespace gaps remain registered and intact.
 *
 * Uses the chart's actual LWC time-scale logical range (not pixel coords), so
 * large data gaps / market closures cannot distort the edge detection.
 */
export function ScrollToLatestButton({
  chart,
  latestTsSec,
  bucketSec,
  replayActive = false,
  rightInset = 0,
}: ScrollToLatestButtonProps) {
  const [show, setShow] = useState(false);
  /** Measured bottom time-axis height — the button sits just above it. */
  const [axisH, setAxisH] = useState(26);

  const tsRef = useRef<ChartTimeScaleLike | null>(null);
  const disposedRef = useRef(false);
  const showRef = useRef(false);

  useEffect(() => {
    if (!chart) return;
    const ts = chart.timeScale();
    tsRef.current = ts;
    disposedRef.current = false;

    const recalc = () => {
      if (disposedRef.current || !ts) return;
      // Time-axis height → keep the pill just above the axis, inside the plot.
      try {
        const h = ts.height?.();
        if (typeof h === "number" && Number.isFinite(h) && h > 0) {
          const next = Math.ceil(h);
          setAxisH((prev) => (prev === next ? prev : next));
        }
      } catch {
        /* keep the default axis height */
      }
      let range: { from: number; to: number } | null = null;
      try {
        range = ts.getVisibleRange();
      } catch {
        // ignore — LWC throws if no data yet
      }
      const atEdge = isAtLatestEdge(range, latestTsSec, bucketSec);
      const next = shouldShowScrollToLatest({
        atEdge,
        replayActive,
        hasCandles: Boolean(latestTsSec),
      });
      if (next !== showRef.current) {
        showRef.current = next;
        setShow(next);
      }
    };


    try {
      ts.subscribeVisibleTimeRangeChange(recalc);
    } catch {
      /* older LWC - polling fallback */
    }
    recalc();

    const iv = setInterval(recalc, 500);

    return () => {
      disposedRef.current = true;
      clearInterval(iv);
      try {
        ts.unsubscribeVisibleTimeRangeChange(recalc);
      } catch {
        /* noop */
      }
    };
  }, [chart, bucketSec, latestTsSec, replayActive]);

  const handleClick = () => {
    const ts = tsRef.current;
    if (!ts) return;
    try {
      ts.scrollToRealTime();
    } catch {
      /* noop */
    }
  };

  if (!show) return null;

  return (
    <button
      type="button"
      className="scroll-to-latest-btn"
      onClick={handleClick}
      aria-label="Scroll to most recent bar"
      title="Scroll to most recent bar"
      style={{
        // LEFT of the right price scale (inside the candle plot area).
        ...(rightInset > 0 ? { right: rightInset + 12 } : null),
        // Just above the bottom time axis.
        bottom: axisH + 6,
      }}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M5 7l5 5-5 5M11 7l5 5-5 5M17 7l5 5-5 5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
