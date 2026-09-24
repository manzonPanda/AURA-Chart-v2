import { useEffect, useState } from "react";
import { diag, logWsCandleFrame } from "./diagnostics";
import { type EmaAlertStateMsg } from "./emaAlertApi.js";
import {
  buildRealtimeWsUrl,
  clockOffsetFromStatus,
  initialStream,
  isFrameForInstrument,
  mergeClosedFrame,
  type RealtimeCandleMsg,
  type RealtimeStatusMsg,
  type RealtimeStream,
} from "./realtimeCore.js";

// Stream types + pure primitives live in realtimeCore.ts (framework-free —
// unit-testable without importing React); re-exported here for BC.
export type {
  CandlePhase,
  CandleSource,
  RealtimeStatus,
  RealtimeStatusMsg,
  RealtimeCandleMsg,
  RealtimeStream,
} from "./realtimeCore.js";
export { buildRealtimeWsUrl, initialStream, isFrameForInstrument };

// Re-export the per-timeframe alert state types from the API module — the WS
// message shape mirrors the REST state exactly (single source of truth).
export type { EmaAlertStateMsg, EmaAlertUnitState } from "./emaAlertApi.js";

/** Mirrors the backend RESOLUTION_BUCKET_SEC map (single source of truth is the server). */
const RESOLUTION_BUCKET_SEC: Record<string, number> = {
  MINUTE_1: 60,
  MINUTE_3: 180,
};

export function resolutionToBucketSec(resolution: string): number {
  return RESOLUTION_BUCKET_SEC[resolution] ?? 180;
}

/** Floor an epoch-ms timestamp to the start of its timeframe bucket (epoch ms). */
export function alignToBucketStart(tsMs: number, bucketSec: number): number {
  const bucketMs = bucketSec * 1000;
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

/**
 * Opens the backend realtime relay (`/ws`, proxied by Vite). The browser never
 * talks to IG and never holds tokens; every status we show comes from the
 * backend telling us what IG Lightstreamer is actually doing.
 *
 * Reconnects the socket with capped exponential backoff while the UI stays up;
 * the server-owned Lightstreamer reconnection/resync is what drives LIVE/RECONNECTING states.
 */
export function useRealtimeStream(
  resolution: string | undefined,
  epic: string | undefined,
  epoch: number,
): RealtimeStream {
  const [stream, setStream] = useState<RealtimeStream>(() => initialStream());

  useEffect(() => {
    if (!resolution) return;

    // CLEAN INSTRUMENT BOUNDARY (Phase 3): every (re)subscription — instrument
    // switch, timeframe change, manual refresh, tab-resync — starts from a
    // BLANK stream. The previous instrument's forming candle, tick counter and
    // last-tick age can never leak into the new selection; the backend re-seeds
    // the forming candle + alert snapshot on the new socket.
    setStream(initialStream("CONNECTING"));

    let socket: WebSocket | null = null;
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;

    const connect = () => {
      if (cancelled) return;
      const url = buildRealtimeWsUrl(resolution, epic);

      setStream((prev) => ({ ...prev, status: attempts > 0 ? "RECONNECTING" : "CONNECTING" }));

      socket = new WebSocket(url);
      socket.onopen = () => {
        attempts = 0;
      };
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as
            | RealtimeStatusMsg
            | RealtimeCandleMsg
            | { type: string };
          // STALE-FRAME GUARD (Phase 3): frames carry their instrument's epic;
          // frames for a DIFFERENT instrument are dropped before any state
          // update — realtime data can never mix across instruments.
          const frameEpic = (msg as { epic?: string }).epic;
          if (!isFrameForInstrument(frameEpic, epic ?? "")) {
            console.info(`[WS] dropped frame for different instrument epic=${frameEpic ?? "(none)"}`);
            return;
          }
          diag.wsFramesReceived += 1;
          if (msg.type === "status" && "status" in msg) {
            diag.wsStatusFrames += 1;
            const sm = msg as RealtimeStatusMsg;
            console.info(
              `[WS] status frame #${diag.wsStatusFrames} status=${sm.status} ticks=${sm.ticks}` +
                (sm.lastTickAt ? ` lastTickAt=${new Date(sm.lastTickAt).toISOString()}` : " lastTickAt=never"),
            );
            setStream((prev) => ({
              ...prev,
              status: sm.status,
              ticks: sm.ticks ?? prev.ticks,
              lastPrice: sm.price ?? prev.lastPrice,
              lastTickAt: sm.lastTickAt ?? prev.lastTickAt,
              // SERVER-CLOCK CALIBRATION: bucket boundaries are server-anchored,
              // so the countdown counts against `Date.now() + clockOffsetMs`.
              // An uncalibrated/older frame keeps the previous offset instead of
              // resetting a good calibration to 0.
              clockOffsetMs: clockOffsetFromStatus(sm.serverNowMs, Date.now()) ?? prev.clockOffsetMs,
            }));
          } else if (msg.type === "candle" && "time" in msg) {
            diag.wsCandleFrames += 1;
            const c = msg as RealtimeCandleMsg;
            logWsCandleFrame(c.timeframe, c.time, c.close);
            // EXPLICIT AUTHORITY ROUTING (never inferred from arrival order):
            //   source:"ohlc" phase:"closed"  → the authoritative CLOSED candle.
            //     It goes to the closed-live ledger and CANNOT touch the forming
            //     candle, so a closed bucket is never "re-opened" by a frame.
            //   anything else (ohlc/quote, forming) → the live DISPLAY snapshot.
            const source = c.source ?? "ohlc";
            const phase = c.phase ?? "forming";
            if (source === "ohlc" && phase === "closed") {
              console.info(
                `[WS] closed candle tf=${c.timeframe} bucket=${new Date(c.time * 1000).toISOString()} C=${c.close}`,
              );
              setStream((prev) => ({
                ...prev,
                closed: mergeClosedFrame(prev.closed, c),
                lastPrice: c.close ?? prev.lastPrice,
              }));
              return;
            }
            // Forming display frame: replace the live forming snapshot, but never
            // REWIND it — a forming frame for an older bucket than the one the
            // display already shows is dropped (the authoritative CLOSED frame
            // for that older bucket still lands through the branch above).
            setStream((prev) => {
              if (prev.candle && Number.isFinite(prev.candle.time) && c.time < prev.candle.time) {
                return prev;
              }
              return { ...prev, candle: c, lastPrice: c.close ?? prev.lastPrice };
            });
          } else if (msg.type === "emaAlert" && "state" in msg) {
            // Server-side EMA alert state (pending confirmations, confirmed
            // reversals). Display-only — detection never runs in the browser.
            const a = msg as { type: "emaAlert"; state: EmaAlertStateMsg };
            setStream((prev) => ({ ...prev, emaAlert: a.state }));
          } else if (msg.type === "trade" && "action" in msg) {
            // P3-C: ADVISORY live trade-event trigger. The backend relays an
            // additive {type:"trade"} frame when MT5 writes trade rows (existing
            // SSE → /ws path). The browser NEVER trusts the frame's payload — it
            // bumps a counter that App.tsx observes to trigger a bounded refetch
            // through the unchanged P2 REST chain. The refetch rebuilds overlays
            // via buildTradeOverlays + reconcileTradeOverlays. Zero payload
            // reconstruction happens here.
            // P3-D: the frame's accountId travels as a HINT ONLY (Part 8) —
            // App.tsx compares it against the selected account and skips the
            // refetch entirely for a foreign account's event.
            const t = msg as { type: "trade"; action: string; accountId?: unknown };
            const eventAccountId =
              typeof t.accountId === "string" && t.accountId.trim() ? t.accountId : null;
            setStream((prev) => ({
              ...prev,
              tradeRefresh: prev.tradeRefresh + 1,
              tradeRefreshAccountId: eventAccountId,
            }));
          }
        } catch {
          /* non-JSON frame — ignore */
        }
      };
      socket.onclose = () => {
        socket = null;
        if (cancelled) return;
        setStream((prev) => ({ ...prev, status: "RECONNECTING" }));
        const delay = Math.min(1000 * 2 ** attempts, 30_000);
        attempts += 1;
        timer = window.setTimeout(connect, delay);
      };
      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          /* no-op */
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, [resolution, epic, epoch]);

  return stream;
}