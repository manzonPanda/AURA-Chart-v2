import { useEffect, useState } from "react";

import { candleCloseCountdown } from "../../services/liveCandle";
import type { RealtimeCandleMsg } from "../../services/realtime";
import { formatManilaHHMM } from "../../services/timefmt";

interface Props {
  /** Latest forming candle pushed by the backend (time = bucket start, epoch s). */
  liveCandle: RealtimeCandleMsg | null;
  /** Selected timeframe bucket size in seconds (60 = 1m, 180 = 3m). */
  bucketSec: number;
}

/** Redraw cadence for the countdown. The VALUE is never taken from this
 *  timer's ticks — every render recomputes `nextBucketTime - Date.now()` from
 *  the candle's actual bucket boundary, so background-tab timer throttling can
 *  only delay a redraw, never skew the countdown. */
const REDRAW_INTERVAL_MS = 250;

/**
 * TradingView-style "CLOSES IN mm:ss" (plus the close-time marker) for the
 * currently forming candle, for the SELECTED timeframe (1m / 3m).
 *
 * Synchronization contract (see liveCandle.ts):
 *  - The countdown target is `liveCandle.time + bucketSec` — the REAL market
 *    bucket boundary reported by the backend stream, not a browser-accumulated
 *    duration. Every WS candle frame re-anchors it.
 *  - `remaining = closesAt - Date.now()` is recomputed on every redraw and on
 *    every visibilitychange, so returning from a throttled background tab
 *    snaps straight to the correct value.
 *  - When the wall clock crosses the boundary but the stream has not yet
 *    delivered the next candle, the display HOLDS at 00:00. This component
 *    never creates candles — the WS stream (LiveBarBridge) is the only candle
 *    authority, so no duplicates can appear at rollover.
 */
export function CandleCountdown({ liveCandle, bucketSec }: Props) {
  const [now, setNow] = useState(() => Date.now());

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

  const countdown = candleCloseCountdown(liveCandle, bucketSec, now);
  if (!countdown) return null;

  return (
    <span
      className={`candle-countdown${countdown.active ? "" : " held"}`}
      aria-live="off"
      title={`Forming candle bucket ${new Date(countdown.bucketStartMs).toISOString()} (UTC) closes ` +
        `${new Date(countdown.closesAtMs).toISOString()} (UTC)`}
    >
      <span className="cc-label">CLOSES IN</span>
      <span className="cc-value">{countdown.label}</span>
      <span className="cc-at" title="Candle close time — Asia/Manila (UTC+08:00)">
        {formatManilaHHMM(countdown.closesAtMs)}
      </span>
    </span>
  );
}
