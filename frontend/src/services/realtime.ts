import { useEffect, useState } from "react";
import { diag, logWsCandleFrame } from "./diagnostics";
import { type EmaAlertStateMsg } from "./emaAlertApi.js";
import {
  buildRealtimeWsUrl,
  initialStream,
  isFrameForInstrument,
  type RealtimeCandleMsg,
  type RealtimeStatus,
  type RealtimeStatusMsg,
  type RealtimeStream,
} from "./realtimeCore.js";

// Stream types + pure primitives live in realtimeCore.ts (framework-free —
// unit-testable without importing React); re-exported here for BC.
export type { RealtimeStatus, RealtimeStatusMsg, RealtimeCandleMsg, RealtimeStream };
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
            }));
          } else if (msg.type === "candle" && "time" in msg) {
            diag.wsCandleFrames += 1;
            const c = msg as RealtimeCandleMsg;
            logWsCandleFrame(c.timeframe, c.time, c.close);
            // Update the forming candle + last price, but DO NOT touch
            // lastTickAt here: only backend status frames carry the real IG
            // tick timestamp. Overwriting it with Date.now() would mask real
            // tick latency and make the UI falsely show "LIVE" when ticks are
            // actually stale.
            setStream((prev) => ({
              ...prev,
              candle: c,
              lastPrice: c.close,
            }));
          } else if (msg.type === "emaAlert" && "state" in msg) {
            // Server-side EMA alert state (pending confirmations, confirmed
            // reversals). Display-only — detection never runs in the browser.
            const a = msg as { type: "emaAlert"; state: EmaAlertStateMsg };
            setStream((prev) => ({ ...prev, emaAlert: a.state }));
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