/**
 * Framework-free realtime primitives — NO React import.
 *
 * Node's type-stripping test runner cannot import React's CJS build by name,
 * so everything the unit tests must exercise (WS URL building, the stale-frame
 * instrument guard, the clean-switch stream reset) lives here; the React hook
 * (useRealtimeStream in ./realtime.ts) consumes these pure pieces.
 */
import { type EmaAlertStateMsg } from "./emaAlertApi.ts";

/** Connection states reported by the BACKEND (mirrors IG Lightstreamer). */
export type RealtimeStatus = "CONNECTING" | "LIVE" | "RECONNECTING" | "DISCONNECTED";

export interface RealtimeStatusMsg {
  type: "status";
  status: RealtimeStatus;
  ticks: number;
  price: number | null;
  /** Server-clock epoch ms of the last REAL IG tick (0 = none ever). */
  lastTickAt?: number;
  /** Which instrument's status this frame carries (Phase 1 backend; absent
   *  from pre-multi-instrument servers — treated as pass-through). */
  epic?: string;
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
  /** Which instrument's candle this frame carries (Phase 1 backend). */
  epic?: string;
}

export interface RealtimeStream {
  /** Truthful IG stream state (never guessed from the socket being open). */
  status: RealtimeStatus;
  ticks: number;
  lastPrice: number | null;
  /** Server-clock epoch ms of the last REAL IG tick (0 = none ever). */
  lastTickAt: number;
  /** Most recent forming candle from the backend. */
  candle: RealtimeCandleMsg | null;
  /** Latest EMA-reversal alert state broadcast (server-side detection). */
  emaAlert: EmaAlertStateMsg | null;
}

/** The CLEAN-SWITCH boundary: every instrument/timeframe/epoch (re)subscription
 *  starts from this blank state, so the previous instrument's forming candle,
 *  counters and last tick can never leak into the new selection. The backend
 *  re-seeds the forming candle + alert snapshot on every new socket. */
export function initialStream(status: RealtimeStatus = "DISCONNECTED"): RealtimeStream {
  return { status, ticks: 0, lastPrice: null, lastTickAt: 0, candle: null, emaAlert: null };
}

/** Build the backend relay URL for ONE instrument + timeframe. */
export function buildRealtimeWsUrl(
  resolution: string,
  epic: string | undefined,
  loc: { protocol: string; host: string } = {
    protocol: typeof window === "undefined" ? "http:" : window.location.protocol,
    host: typeof window === "undefined" ? "localhost:8787" : window.location.host,
  },
): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ res: resolution });
  if (epic) params.set("epic", epic);
  return `${scheme}://${loc.host}/ws?${params.toString()}`;
}

/**
 * STALE-FRAME GUARD: should this WS frame update the UI for `selectedEpic`?
 *   - no selection resolved yet → accept (backend serves its default, DAX);
 *   - frame without `epic` → accept (older backend, historic behavior);
 *   - otherwise the frame's epic must match the selection exactly — a Gold
 *     frame can never update a DAX view or vice versa.
 */
export function isFrameForInstrument(frameEpic: string | null | undefined, selectedEpic: string): boolean {
  if (!selectedEpic) return true;
  if (!frameEpic) return true;
  return frameEpic === selectedEpic;
}