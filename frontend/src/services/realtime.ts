import { useEffect, useState } from "react";
import { diag, logWsCandleFrame } from "./diagnostics";
import { type EmaAlertStateMsg } from "./emaAlertApi.js";

/** Connection states reported by the BACKEND (mirrors IG Lightstreamer). */
export type RealtimeStatus = "CONNECTING" | "LIVE" | "RECONNECTING" | "DISCONNECTED";

export interface RealtimeStatusMsg {
  type: "status";
  status: RealtimeStatus;
  ticks: number;
  price: number | null;
  /** Server-clock epoch ms of the last REAL IG tick (0 = none ever). */
  lastTickAt?: number;
}

/** A candle update pushed by the server. `time` is the bucket start (epoch SECONDS). */
export interface RealtimeCandleMsg {
  type: "candle";
  timeframe: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface RealtimeStream {
  /** Truthful IG stream state (never guessed from the socket being open). */
  status: RealtimeStatus;
  ticks: number;
  lastPrice: number | null;
  /** Server-clock epoch ms of the last REAL IG tick (0 = none ever).
   *  `LIVE` alone means "Lightstreamer connected" — check this to know whether
   *  ticks are actually flowing (drives the CONNECTED · NO TICKS display). */
  lastTickAt: number;
  /** Most recent forming candle from the backend. */
  candle: RealtimeCandleMsg | null;
     /** Latest EMA-reversal alert state broadcast (server-side detection). */
  emaAlert: EmaAlertStateMsg | null;
}

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
  const [stream, setStream] = useState<RealtimeStream>({
    status: "DISCONNECTED",
    ticks: 0,
    lastPrice: null,
    lastTickAt: 0,
    candle: null,
    emaAlert: null,
  });

  useEffect(() => {
    if (!resolution) return;

    let socket: WebSocket | null = null;
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;

    const connect = () => {
      if (cancelled) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const params = new URLSearchParams({ res: resolution });
      if (epic) params.set("epic", epic);
      const url = `${scheme}://${window.location.host}/ws?${params.toString()}`;

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