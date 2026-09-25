/**
 * Framework-free realtime primitives — NO React import.
 *
 * Node's type-stripping test runner cannot import React's CJS build by name,
 * so everything the unit tests must exercise (WS URL building, the stale-frame
 * instrument guard, the clean-switch stream reset) lives here; the React hook
 * (useRealtimeStream in ./realtime.ts) consumes these pure pieces.
 */
import { type EmaAlertStateMsg } from "./emaAlertApi.ts";
import type { LivePositionVisualFrame } from "./livePositionVisual.ts";

/** Connection states reported by the BACKEND (mirrors IG Lightstreamer). */
export type RealtimeStatus = "CONNECTING" | "LIVE" | "RECONNECTING" | "DISCONNECTED";

export interface RealtimeStatusMsg {
  type: "status";
  status: RealtimeStatus;
  ticks: number;
  price: number | null;
  /** Server-clock epoch ms of the last REAL IG tick (0 = none ever). */
  lastTickAt?: number;
  /**
   * SERVER CLOCK (additive): the server's own `Date.now()` at send time.
   * Bucket boundaries are server-anchored, so the countdown calibrates against
   * this (`clockOffsetMs = serverNowMs − Date.now()`) instead of trusting the
   * browser clock. Absent from older backends → no calibration is applied.
   */
  serverNowMs?: number;
  /** Which instrument's status this frame carries (Phase 1 backend; absent
   *  from pre-multi-instrument servers — treated as pass-through). */
  epic?: string;
}

/**
 * Source of a candle frame — the explicit authority class, never inferred from
 * arrival order:
 *   "ohlc"  → the backend aggregator's authoritative OHLC (Capital OHLC stream);
 *   "quote" → the Capital marketData mid-derived live DISPLAY overlay.
 */
export type CandleSource = "ohlc" | "quote";

/**
 * Lifecycle phase of a candle frame:
 *   "forming" → the bucket is still open (a display snapshot, replaced per tick);
 *   "closed"  → the bucket received its AUTHORITATIVE CLOSED candle and is
 *               henceforth IMMUTABLE (the exact persisted OHLC).
 */
export type CandlePhase = "forming" | "closed";

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
  /** Authority class (absent on older backends → treated as authoritative OHLC). */
  source?: CandleSource;
  /** Lifecycle phase (absent on older backends → treated as "forming"). */
  phase?: CandlePhase;
}

export interface RealtimeStream {
  /** Truthful IG stream state (never guessed from the socket being open). */
  status: RealtimeStatus;
  ticks: number;
  lastPrice: number | null;
  /** Server-clock epoch ms of the last REAL IG tick (0 = none ever). */
  lastTickAt: number;
  /** Most recent FORMING candle from the backend (never a closed one). */
  candle: RealtimeCandleMsg | null;
  /**
   * Authoritative CLOSED candles received on this stream, ascending by bucket,
   * deduped by bucket time (a re-delivered closed bucket REPLACES its record).
   * The chart consumes them as an immutable ledger: a closed bucket is never
   * mutated by a later quote/forming frame.
   */
  closed: RealtimeCandleMsg[];
  /**
   * SERVER-CLOCK CALIBRATION: `serverNowMs − Date.now()` measured on the last
   * status frame (0 = uncalibrated). Bucket boundaries are SERVER-anchored, so
   * the countdown adds this offset to the local clock instead of trusting it.
   */
  clockOffsetMs: number;
  emaAlert: EmaAlertStateMsg | null;
  /**
   * Monotonic counter bumped by an ADVISORY /ws {type:"trade"} frame (P3-C).
   * The browser never trusts the frame's payload — it triggers a bounded
   * refetch of trade rows through the unchanged P2 REST chain, which
   * rebuilds overlays via buildTradeOverlays + reconcileTradeOverlays.
   * Zero behavioral change for callers that never observe it.
   */
  tradeRefresh: number;
  /**
   * P3-D: the `accountId` tag of the MOST RECENT trade advisory (null when
   * the upstream event carried none). A HINT ONLY — App.tsx refetches the
   * SELECTED account through the unchanged P2 REST chain solely when this
   * matches the selection; a foreign account's event must not drive this
   * chart. Reset to null on every clean instrument/stream boundary.
   */
  tradeRefreshAccountId: string | null;
  /** Latest authenticated ephemeral P&L/R hint; never an authoritative snapshot. */
  tradeVisual: LivePositionVisualFrame | null;
}

/** The CLEAN-SWITCH boundary: every instrument/timeframe/epoch (re)subscription
 *  starts from this blank state, so the previous instrument's forming candle,
 *  counters and last tick can never leak into the new selection. The backend
 *  re-seeds the forming candle + alert snapshot on every new socket. */
export function initialStream(status: RealtimeStatus = "DISCONNECTED"): RealtimeStream {
  return {
    status,
    ticks: 0,
    lastPrice: null,
    lastTickAt: 0,
    candle: null,
    closed: [],
    clockOffsetMs: 0,
    emaAlert: null,
    tradeRefresh: 0,
    tradeRefreshAccountId: null,
    tradeVisual: null,
  };
}

/**
 * Clock offset implied by a status frame: `serverNowMs − clientNowMs`.
 * Returns null when the frame carries no usable server clock (older backend) or
 * the measurement is not finite — the caller then keeps its previous offset
 * rather than resetting a good calibration.
 */
export function clockOffsetFromStatus(
  serverNowMs: number | null | undefined,
  clientNowMs: number,
): number | null {
  if (typeof serverNowMs !== "number" || !Number.isFinite(serverNowMs)) return null;
  if (!Number.isFinite(clientNowMs)) return null;
  return serverNowMs - clientNowMs;
}

/** Bounded FIFO cap for {@link RealtimeStream.closed}. */
const MAX_CLOSED_LEDGER = 256;

/**
 * Merge one candle frame into the closed-candle ledger (append-only, ascending,
 * deduped by bucket time). A closed frame for a bucket already in the ledger
 * REPLACES it — the authoritative value always wins — while a closed frame for
 * an older bucket is inserted in order (the 3M case: authoritative closes can
 * arrive one bucket behind the wall-clock/quote display).
 */
export function mergeClosedFrame(
  ledger: readonly RealtimeCandleMsg[],
  frame: RealtimeCandleMsg,
): RealtimeCandleMsg[] {
  const idx = ledger.findIndex((c) => c.time === frame.time);
  const next =
    idx >= 0
      ? ledger.map((c, i) => (i === idx ? frame : c))
      : [...ledger, frame].sort((a, b) => a.time - b.time);
  return next.length > MAX_CLOSED_LEDGER
    ? next.slice(next.length - MAX_CLOSED_LEDGER)
    : next;
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

/** Authenticate the EXISTING market-data socket for additive P3-C trade events. */
export function buildTradeAuthFrame(token: string | null): string | null {
  if (!token) return null;
  return JSON.stringify({ type: "auth", token });
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