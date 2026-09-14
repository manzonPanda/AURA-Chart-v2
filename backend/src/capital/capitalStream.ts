/**
 * Capital.com WebSocket streaming client (migration Phase 4).
 *
 * Implements the `StreamClientLike` seam so wiring into RealtimeService is a
 * drop-in: `start(handler)` emits `IngTick`s — the SAME normalized
 * forming-candle shape the aggregators consume — and `stop()` tears the socket
 * down without touching provider-agnostic aggregation/persistence/relay.
 * (IG streaming has been retired — there is no fallback.)
 *
 * Protocol (Capital.com streaming):
 *   wss://api-streaming-capital.backend-capital.com/connect
 *   Headers: X-CAP-API-KEY + CST + X-SECURITY-TOKEN (FRESH per connect —
 *   sessions expire ~10 min, so tokens are never reused across reconnects).
 *   Auth headers are built via deps.authHeaders() (which reuses
 *   CapitalClient.streamingHeaders()) so credential handling is NOT duplicated
 *   in the stream and is never logged.
 *   Subscribe:  { destination: "OHLCMarketData.subscribe", correlationId,
 *                 cst, securityToken,
 *                 payload: { epics:[symbol], resolutions:["MINUTE"], type:"classic" } }
 *   OHLC live:  { destination: "ohlc.event", payload:{ t, h, l, o, c,
 *                               priceType:"bid"|"ask", lastTradedVolume } } —
 *               bid/ask arrive as SEPARATE frames for the same `t` (epoch-ms
 *               bucket-open ts); the client pairs them into a midpoint burst.
 *   Candles:    { destination: "candles", payload: { candles: [...] } }
 *   Quotes:     { destination: "quote"|"marketData", payload: { bid, offer } } —
 *               subscribed via a SECOND destination on the SAME socket
 *               ("marketData.subscribe", sent right after the OHLC subscribe —
 *               Capital enforces one streaming session per account, so the
 *               quote stream MUST multiplex on the existing socket). Quote
 *               frames drive the LIVE DISPLAY forming candle (bid/ask midpoint,
 *               paired + deduped); they are NEVER routed into the persistence
 *               aggregator — the MINUTE OHLC stream remains the only candle
 *               truth for PostgreSQL. A quote subscription rejection/timeout
 *               disables ONLY the display path (log + continue OHLC-only).
 *   Keepalive:  bare "#ping" text frames / {destination:"ping"} — answered with
 *               the documented application-level ping (unchanged).
 *
 * Price basis (approved): midpoint of bid/ask per field,
 *   mid = round(((bid + ask) / 2) * 10^decimals) / 10^decimals
 * Timestamps: `snapshotTimeUTC` is authoritative (ISO-8601 UTC → epoch ms).
 * The local-time `snapshotTime` field is never parsed (would mis-store
 * local wall-clock as UTC).
 *
 * Keepalive: a 30s application-level `ping` (documented Capital destination,
 *               carrying correlationId + cst + securityToken) is sent while
 *               the socket is OPEN — production GOLD streams were terminated
 *               by Capital's edge ~60s after the last frame (close 1006)
 *               despite once-per-minute OHLC traffic.
 * Reconnect: exponential backoff (1s base → 30s cap), fresh session per
 * attempt; the 120s idle watchdog remains as the silent-socket safety net.
 * No token/credential is ever logged — diagnostics count frames, never
 * print payloads.
 */
import { WebSocket } from "ws";
import { parseCapitalTimestampAsUtc } from "./time.js";
import type { IngTick, StreamState } from "../streaming/types.js";

/**
 * Production Capital.com streaming entrypoint. The `/connect` path is REQUIRED
 * by Capital.com — a bare WSS host is rejected (HTTP 404 / close code 1006),
 * which was the original GOLD stream failure.
 */
export const CAPITAL_STREAMING_DEFAULT_URL =
  "wss://api-streaming-capital.backend-capital.com/connect";

/**
 * Application-level keepalive cadence (30s). Capital's docs recommend pinging
 * "at least once every 10 minutes" to keep the session alive, but production
 * GOLD streams are terminated by Capital's edge ~60s after the last received
 * frame (close code 1006) when only the once-per-minute OHLC frames flow —
 * so AURA pings every 30s, comfortably inside that window. 0/negative
 * disables (tests); configurable via deps.heartbeatIntervalMs.
 */
export const CAPITAL_HEARTBEAT_INTERVAL_MS = 30_000;

/** Session tokens handed to the stream (fresh per connect; never logged). */
export interface CapitalStreamSession {
  cst: string;
  xSecurityToken: string;
}

/** Forming-candle consumer — the RealtimeService aggregator seam. */
export type CapitalTickHandler = (tick: IngTick) => void;

/** Structural subset of `ws`'s WebSocket the client needs (test-seamable). */
export interface WebSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
  terminate(): unknown;
  readonly readyState: number;
}

export interface CapitalStreamDeps {
  /** Capital.com market symbol — AURA Gold is "GOLD" (verified search hit). */
  symbol: string;
  /** Quoting decimals (Gold = 2) — mid is rounded onto this grid. */
  decimals: number;
  /** Defaults to CAPITAL_STREAMING_URL, then the production endpoint. */
  streamingUrl?: string;
  /**
   * Connect-time auth headers builder. Reuses CapitalClient.streamingHeaders()
   * so the WS handshake carries X-CAP-API-KEY + (fresh) CST + X-SECURITY-TOKEN
   * without the stream duplicating credential handling. Values are secrets:
   * returned only to the socket constructor, never logged.
   */
  authHeaders: (session: CapitalStreamSession) => Record<string, string>;
  /** Fresh-session provider — wired to CapitalClient in Phase 5. */
  sessionProvider: () => Promise<CapitalStreamSession>;
  /** Tick consumer — the RealtimeService aggregator seam (was start(handler)). */
  onTick: CapitalTickHandler;
  /**
   * QUOTE consumer — the LIVE DISPLAY seam. Called with one bid/ask midpoint
   * IngTick per genuine Capital quote price change (marketData stream, paired
   * + deduped). NEVER invoked for OHLC frames, and its ticks must NEVER be
   * routed into the persistence aggregator — quotes drive the forming-candle
   * display overlay only (RealtimeService.handleQuoteTick).
   */
  onQuote?: (quote: IngTick) => void;
  /**
   * How long to wait for the first quote frame after subscribing before the
   * quote stream is declared unavailable (default 15s; 0/negative disables —
   * tests). A timeout or a server rejection disables ONLY the quote display
   * path: the OHLC stream, heartbeat, reconnect and persistence are untouched.
   */
  quoteProbeTimeoutMs?: number;
  /** Reconnect backoff tuning (defaults: 1s base, 30s cap). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Silent-socket watchdog (default 120s without any frame → reconnect). */
  idleTimeoutMs?: number;
  /**
   * Application-level keepalive cadence in ms (default 30s, see
   * CAPITAL_HEARTBEAT_INTERVAL_MS). 0/negative disables (tests).
   */
  heartbeatIntervalMs?: number;
  /** Injectable socket factory (tests); defaults to a real `ws` socket. */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocketLike;
  /** Optional stream-state observer (RealtimeService's onState seam). */
  onState?: (state: StreamState) => void;
}

// ── Frame parsing (pure, exported for tests) ─────────────────────────────────

/** Number from unknown JSON (strings tolerated, NaN/garbage rejected). */
function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Approved pricing: bid/ask midpoint on the instrument's quoting grid. */
export function capitalMid(bid: number, ask: number, decimals: number): number {
  const q = 10 ** decimals;
  return Math.round(((bid + ask) / 2) * q) / q;
}

/**
 * Extract the quote's bid/ask from a Capital quote payload — string-or-number
 * tolerant, plus the documented `offer`/`ofr` aliases for the ask side. The
 * exact production frame shape is verified at runtime; parsing stays tolerant
 * of every documented variation (bid / ask / offer / ofr, bidPrice/askPrice).
 */
export function quoteBidAsk(payload: Record<string, unknown>): { bid?: number; ask?: number } {
  const bid = num(payload.bid) ?? num(payload.bidPrice);
  const ask = num(payload.ask) ?? num(payload.offer) ?? num(payload.ofr) ?? num(payload.askPrice);
  return {
    ...(bid !== undefined ? { bid } : {}),
    ...(ask !== undefined ? { ask } : {}),
  };
}

/**
 * Quote market timestamp (epoch ms), tolerating the documented variations:
 *   `t` (epoch ms, like ohlc.event) → `snapshotTimeUTC` (tz-less ISO → UTC via
 *   the shared Capital rule) → `timestamp`/`time` (ms, or s → ×1000).
 * Returns undefined when the frame carries no usable timestamp (the caller
 * then falls back to arrival time — which can never bucket into the future).
 */
export function quoteTimestampMs(payload: Record<string, unknown>): number | undefined {
  const t = num(payload.t);
  if (t !== undefined && t > 1e12) return t;
  const iso = payload.snapshotTimeUTC ?? payload.snapshotTime;
  if (typeof iso === "string") {
    const ms = parseCapitalTimestampAsUtc(iso);
    if (Number.isFinite(ms)) return ms;
  }
  const raw = num(payload.timestamp) ?? num(payload.time);
  if (raw !== undefined && raw > 1e12) return raw;
  if (raw !== undefined && raw > 1e9 && raw < 1e12) return raw * 1000;
  return undefined;
}

/**
 * Extract {bid, ask} from one OHLC field. Tolerates the documented shapes:
 *   { open: { bid, ask } }   { openPrice: { bid, ask } }   { openBid, openAsk }
 */
function fieldBidAsk(field: unknown): { bid: number; ask: number } | undefined {
  if (field && typeof field === "object") {
    const o = field as Record<string, unknown>;
    const bid = num(o.bid);
    const ask = num(o.ask) ?? num(o.ofr);
    if (bid !== undefined && ask !== undefined) return { bid, ask };
  }
  return undefined;
}

/** Mid of one OHLC field across nested ({open}/{openPrice}) or flat shapes. */
function fieldMid(candle: Record<string, unknown>, key: string, decimals: number): { mid: number; raw: number; bid?: number; ask?: number } | undefined {
  const nested = fieldBidAsk(candle[key]) ?? fieldBidAsk(candle[`${key}Price`]);
  if (nested) {
    return {
      mid: capitalMid(nested.bid, nested.ask, decimals),
      raw: (nested.bid + nested.ask) / 2,
      bid: nested.bid,
      ask: nested.ask,
    };
  }
  // Documented `<field>Price: { <field>Bid, <field>Ask }` nested shape.
  const wrapped = candle[`${key}Price`];
  if (wrapped && typeof wrapped === "object") {
    const wo = wrapped as Record<string, unknown>;
    const bid = num(wo[`${key}Bid`]);
    const ask = num(wo[`${key}Ask`]);
    if (bid !== undefined && ask !== undefined) {
      return {
        mid: capitalMid(bid, ask, decimals),
        raw: (bid + ask) / 2,
        bid,
        ask,
      };
    }
  }
  const bid = num(candle[`${key}Bid`]);
  const ask = num(candle[`${key}Ask`]);
  if (bid !== undefined && ask !== undefined) {
    return {
      mid: capitalMid(bid, ask, decimals),
      raw: (bid + ask) / 2,
      bid,
      ask,
    };
  }
  return undefined;
}

/**
 * ISO-8601 UTC string → epoch ms via the SHARED Capital rule: tz-less strings
 * parse as UTC wall clock (snapshotTimeUTC is the authoritative timestamp) —
 * identical to the REST parser, so the live stream and historical rows can
 * never disagree about a bucket's UTC instant.
 */
function parseIsoMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = parseCapitalTimestampAsUtc(v);
  return Number.isFinite(ms) ? ms : undefined;
}

export interface ParseFrameOptions {
  symbol: string;
  decimals: number;
}

export type ParsedFrame =
  | { kind: "tick-burst"; tsMs: number; cumVolume: number; ticks: IngTick[] }
  | {
      kind: "ohlc-side";
      side: "bid" | "ask";
      tsMs: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }
  | {
      /** One Capital quote frame (marketData stream) — the LIVE DISPLAY source. */
      kind: "quote";
      bid?: number;
      ask?: number;
      /** Market timestamp (epoch ms) when the frame carries one; else undefined. */
      tsMs?: number;
    }
  | { kind: "quote-rejected"; code: string }
  | { kind: "pong" }
  | { kind: "ignored"; reason: string };

/** One bid or ask OHLC quadrant from a Capital `ohlc.event` frame. */
interface OhlcValues {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * One candle record → a synthetic [open, high, low, close] POINT-tick burst.
 *
 * The Capital.com OHLC stream emits full candle SNAPSHOTS (bid+ask OHLC per
 * frame), while the aggregator consumes POINT ticks (max/min/last-close-wins,
 * order-tolerant, volume-additive when > 0). Replaying the mid OHLC as an
 * ordered burst reproduces the streamed candle EXACTLY: true high/low survive
 * the max/min replay (critical for DOL High/Low killzone levels) and close
 * wins because it is the burst's final tick.
 *
 * Volume: the frame's volume is BUCKET-CUMULATIVE, so burst ticks carry 0 and
 * the raw cumulative value travels out-of-band (`cumVolume`); the stateful
 * client computes the per-frame DELTA and attributes it to the burst's final
 * tick — never multiplying volume by frame count.
 */
function tickFromCandle(
  c: Record<string, unknown>,
  symbol: string,
  decimals: number,
): ParsedFrame {
  void symbol; // diagnostics-only: the aggregator never reads the epic
  const tsMs = parseIsoMs(c.snapshotTimeUTC);
  if (tsMs === undefined) return { kind: "ignored", reason: "missing-snapshotTimeUTC" };
  const open = fieldMid(c, "open", decimals);
  const high = fieldMid(c, "high", decimals);
  const low = fieldMid(c, "low", decimals);
  const close = fieldMid(c, "close", decimals);
  if (open === undefined || high === undefined || low === undefined || close === undefined) {
    return { kind: "ignored", reason: "missing-bid-or-ask-side" };
  }
  const arriveMs = Date.now();
  // Volume: tolerate both `volume` and `lastTradedVolume` (Capital's REST +
  // streaming shapes). Bucket-cumulative; the client converts to deltas.
  const cumVolume = num(c.volume) ?? num(c.lastTradedVolume) ?? 0;
  const midTick = (m: { mid: number; raw: number; bid?: number; ask?: number }): IngTick => ({
    tsMs,
    price: m.mid,
    volume: 0,
    ...(m.bid !== undefined ? { bid: m.bid } : {}),
    ...(m.ask !== undefined ? { offer: m.ask } : {}),
    arriveMs,
    priceRaw: m.raw,
    priceField: "MID",
  });
  const ticks: IngTick[] = [
    midTick(open),
    midTick(high),
    midTick(low),
    midTick(close),
  ];
  return { kind: "tick-burst", tsMs, cumVolume, ticks };
}

/**
 * Parse one streaming frame. Pure and exported for tests. `reason` strings
 * never embed payload values (no token leakage through diagnostics).
 */
export function parseStreamFrame(raw: string, opts: ParseFrameOptions): ParsedFrame {
  // Keepalive — must be checked BEFORE JSON.parse (bare "#ping" is not JSON).
  if (typeof raw === "string" && raw.trim() === "#ping") {
    return { kind: "pong" };
  }
  let env: unknown;
  try {
    env = JSON.parse(raw);
  } catch {
    return { kind: "ignored", reason: "not-json" };
  }
  if (!env || typeof env !== "object") return { kind: "ignored", reason: "not-object" };
  const envelope = env as Record<string, unknown>;
  const destination = typeof envelope.destination === "string" ? envelope.destination : "";

  // Keepalive: mirror the ping so the socket stays healthy.
  if (destination === "ping" || destination === "#ping") {
    return { kind: "pong" };
  }

  const payload =
    envelope.payload && typeof envelope.payload === "object"
      ? (envelope.payload as Record<string, unknown>)
      : {};

  // OHLC event (Capital live streaming): one side (bid/ask) of a 1-minute
  // bucket emitted as flat o/h/l/c + `t` (epoch-ms bucket-OPEN timestamp) +
  // `lastTradedVolume`. bid and ask arrive as SEPARATE frames for the same `t`;
  // the stateful client pairs them (see CapitalStreamClient.handleOhlcSide).
  if (destination === "ohlc.event") {
    const pt = payload.priceType;
    const side = typeof pt === "string" ? pt.toLowerCase() : "";
    if (side !== "bid" && side !== "ask") {
      return { kind: "ignored", reason: "ohlc-event-unknown-side" };
    }
    const t = num(payload.t);
    const o = num(payload.o);
    const h = num(payload.h);
    const l = num(payload.l);
    const c = num(payload.c);
    if (
      t === undefined ||
      o === undefined ||
      h === undefined ||
      l === undefined ||
      c === undefined
    ) {
      return { kind: "ignored", reason: "ohlc-event-incomplete" };
    }
    return {
      kind: "ohlc-side",
      side,
      tsMs: t,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: num(payload.lastTradedVolume) ?? 0,
    };
  }

  // OHLC frames: a candles array (tolerant of the destination name).
  const candlesRaw = Array.isArray(payload.candles)
    ? payload.candles
    : destination.toLowerCase().includes("candle") || destination.includes("OHLC")
      ? payload.candles
      : undefined;
  if (Array.isArray(candlesRaw)) {
    const list = candlesRaw as unknown[];
    const forming = list.length > 0 ? list[list.length - 1] : undefined;
    if (!forming || typeof forming !== "object") {
      return { kind: "ignored", reason: "empty-candles" };
    }
    return tickFromCandle(forming as Record<string, unknown>, opts.symbol, opts.decimals);
  }

  // Quote frames (bid/ask snapshots): the LIVE DISPLAY source. They are parsed
  // into a `quote` frame and paired client-side into a bid/ask midpoint that
  // feeds ONLY the forming-candle display overlay — never the persistence
  // aggregator (quote mids must never become the persisted OHLC source). A
  // quote-shaped frame WITHOUT prices (subscription acks, keepalives) stays
  // liveness-only, and a subscription rejection surfaces as `quote-rejected`
  // so the client can disable the display path without touching the socket.
  if (
    destination.toLowerCase().includes("quote") ||
    destination.includes("marketData") ||
    num(payload.bid) !== undefined ||
    num(payload.ask) !== undefined
  ) {
    const errorCode = typeof payload.errorCode === "string" ? payload.errorCode : undefined;
    if (errorCode) return { kind: "quote-rejected", code: errorCode };
    const { bid, ask } = quoteBidAsk(payload);
    if (bid === undefined && ask === undefined) {
      return { kind: "ignored", reason: "quote-frame" };
    }
    const tsMs = quoteTimestampMs(payload);
    return {
      kind: "quote",
      ...(bid !== undefined ? { bid } : {}),
      ...(ask !== undefined ? { ask } : {}),
      ...(tsMs !== undefined ? { tsMs } : {}),
    };
  }

  return {
    kind: "ignored",
    reason: destination ? `unknown-destination:${destination}` : "no-destination",
  };
}

// ── Streaming client ─────────────────────────────────────────────────────────

const OPEN = 1; // ws readyState OPEN

/**
 * CapitalStreamClient — one symbol, one MINUTE-OHLC subscription, resilient
 * reconnect. `start()` connects + subscribes and forwards parsed `IngTick`s
 * to the handler until `stop()`. Every (re)connect acquires FRESH session
 * tokens via `sessionProvider` (Capital sessions expire ~10 minutes).
 */
export class CapitalStreamClient {
  private ws: WebSocketLike | null = null;
  private running = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Application-level keepalive interval (Capital `ping` destination). */
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Latest session tokens — redactables only, never logged. */
  private lastSession: CapitalStreamSession | null = null;
  /** Latest mid price seen (getStats seam). */
  private lastPrice: number | null = null;
  /** Epoch ms of the latest tick forwarded (getStats seam). */
  private lastTickAt = 0;
  /** Bucket volume-basis state: the OHLC stream's volume is bucket-cumulative;
      these track the previous frame so the class emits per-frame DELTAS
      (attribution to the burst's closing tick) instead of double-counting
      cumulative volume per snapshot. Deliberately NOT reset on reconnect —
      resuming mid-bucket deltas correctly against the pre-disconnect frame. */
  private prevBurstTsMs: number | null = null;
  private prevCumVolume = 0;

  /** Latest reported state (safe diagnostic label; never a credential). */
  private currentState: StreamState = "DISCONNECTED";
  /** Monotonic subscribe correlationId (stable per client lifetime). */
  private nextCorrelationId = 1;
  /**
   * Live-stream bid/ask pairing buffer. Capital emits each side of a bucket as
   * a SEPARATE ohlc.event for the same epoch-ms `t`; we hold the partial side
   * until its counterpart arrives, then emit ONE midpoint burst. Capped so a
   * one-sided drop cannot grow unbounded; a lone side is never tick material,
   * so an incomplete candle is never persisted (closed MINUTE_1 candles are
   * written downstream only).
   */
  private ohlcBuffer: Map<number, { bid?: OhlcValues; ask?: OhlcValues }> =
    new Map();

  /**
   * Quote-stream (marketData) lifecycle for the LIVE DISPLAY path — per
   * CONNECTION. "pending" from subscribe until the first genuine quote frame
   * (→ "active") or a rejection/timeout (→ "rejected": display disabled,
   * OHLC-only continues). Reset on every (re)connect so the subscription is
   * re-established automatically with the existing OHLC subscription.
   */
  private quoteState: "pending" | "active" | "rejected" = "pending";
  /** One-shot probe: no quote frame within quoteProbeTimeoutMs → rejected. */
  private quoteProbeTimer: NodeJS.Timeout | null = null;
  /** Most recent valid quote sides (pairing buffer for side-specific frames). */
  private lastBid: number | undefined;
  private lastAsk: number | undefined;
  private lastBidAt = 0;
  private lastAskAt = 0;
  /** Last (bid, ask) pair a midpoint was emitted for — duplicate suppression. */
  private lastEmittedBid: number | undefined;
  private lastEmittedAsk: number | undefined;

  /** Frame diagnostics — counters only (never payloads/tokens). */
  readonly stats = {
    frames: 0,
    ticks: 0,
    ignored: 0,
    reconnects: 0,
    heartbeats: 0,
    /** Quote frames received on the marketData stream (any shape). */
    quoteFrames: 0,
    /** Genuine bid/ask midpoints emitted to the display seam (price changes). */
    quoteMids: 0,
    /** Quote frames skipped because neither side changed (no new price info). */
    quoteDeduped: 0,
    /** Quote frames with only one side and no usable/stale counterpart. */
    quoteUnpaired: 0,
    /** Quote subscription rejections / errors seen. */
    quoteErrors: 0,
  };

  constructor(private readonly deps: CapitalStreamDeps) {}

  get isConnected(): boolean {
    return this.ws?.readyState === OPEN;
  }

  /** Begin streaming (idempotent while already running) — IgStreamClient seam. */
  connect(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.reportState("CONNECTING");
    void this.openStream();
  }

  /** Tear down socket + timers; no further reconnects after this. */
  disconnect(): void {
    this.running = false;
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.reportState("DISCONNECTED");
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      }
    }
  }

  /** Secret VALUES held (CST / X-SECURITY-TOKEN) — crash-path redactor only. */
  redactables(): string[] {
    const out: string[] = [];
    if (this.lastSession?.cst) out.push(this.lastSession.cst);
    if (this.lastSession?.xSecurityToken) out.push(this.lastSession.xSecurityToken);
    return out;
  }

  /** Stats in the IgStreamClient.getStats shape (closed-candle diagnostics). */
  getStats(): {
    ticks: number;
    lastPrice: number | null;
    lastTickAt: number;
    updatesReceived: number;
    noPriceUpdates: number;
    quoteFrames: number;
    quoteMids: number;
    quoteDeduped: number;
    quoteUnpaired: number;
    quoteErrors: number;
    quoteState: string;
  } {
    return {
      ticks: this.stats.ticks,
      lastPrice: this.lastPrice,
      lastTickAt: this.lastTickAt,
      updatesReceived: this.stats.frames,
      noPriceUpdates: this.stats.ignored,
      quoteFrames: this.stats.quoteFrames,
      quoteMids: this.stats.quoteMids,
      quoteDeduped: this.stats.quoteDeduped,
      quoteUnpaired: this.stats.quoteUnpaired,
      quoteErrors: this.stats.quoteErrors,
      quoteState: this.quoteState,
    };
  }

  private reportState(state: StreamState): void {
    this.currentState = state;
    this.deps.onState?.(state);
  }

  private async openStream(): Promise<void> {
    if (!this.running || this.stopped) return;
    // FRESH tokens every connect — never reuse a possibly-expired session.
    let session: CapitalStreamSession;
    try {
      session = await this.deps.sessionProvider();
      this.lastSession = session;
    } catch {
      this.scheduleReconnect(); // session failure → backoff + retry
      return;
    }
    const url =
      this.deps.streamingUrl ??
      process.env.CAPITAL_STREAMING_URL ??
      CAPITAL_STREAMING_DEFAULT_URL;
    // Reuse CapitalClient.streamingHeaders() via deps.authHeaders so the WS
    // handshake carries X-CAP-API-KEY + CST + X-SECURITY-TOKEN without the
    // stream duplicating credential handling. Headers are never logged.
    const headers = this.deps.authHeaders(session);
    let ws: WebSocketLike;
    try {
      ws = this.deps.wsFactory
        ? this.deps.wsFactory(url, headers)
        : (new WebSocket(url, { headers }) as unknown as WebSocketLike);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.armIdleWatchdog();
      this.startHeartbeat(ws); // Capital app-level keepalive while OPEN
      this.reportState("LIVE");
      try {
        ws.send(
          JSON.stringify({
            destination: "OHLCMarketData.subscribe",
            correlationId: String(this.nextCorrelationId++),
            cst: session.cst,
            securityToken: session.xSecurityToken,
            payload: {
              epics: [this.deps.symbol],
              resolutions: ["MINUTE"],
              type: "classic",
            },
          }),
        );
      } catch {
        /* close handler drives reconnect */
      }
      // LIVE DISPLAY subscription: the marketData quote stream multiplexes on
      // THIS SAME authenticated socket (Capital allows ONE streaming session
      // per account — a second socket is always rejected with
      // "error.too-many.requests"). Same session credentials, sent right after
      // the OHLC subscribe. Re-armed on EVERY (re)connect. A failure to SEND
      // (or a server rejection / timeout, handled in the message path)
      // disables ONLY the quote display path — never the OHLC stream.
      this.quoteState = "pending";
      try {
        ws.send(
          JSON.stringify({
            destination: "marketData.subscribe",
            correlationId: String(this.nextCorrelationId++),
            cst: session.cst,
            securityToken: session.xSecurityToken,
            payload: { epics: [this.deps.symbol] },
          }),
        );
        this.armQuoteProbe();
      } catch {
        this.quoteState = "rejected"; // display path off; OHLC continues
        this.clearQuoteProbe();
        console.warn(
          `[STREAM:${this.deps.symbol}] quote subscribe send failed — continuing OHLC-only`,
        );
      }
    });
    ws.on("message", (data: unknown) => {
      this.stats.frames += 1;
      this.armIdleWatchdog(); // any frame proves liveness
      const raw =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : "";
      const parsed = parseStreamFrame(raw, {
        symbol: this.deps.symbol,
        decimals: this.deps.decimals,
      });
      if (parsed.kind === "tick-burst") {
        // Bucket-cumulative volume → per-frame delta, attributed to the
        // burst's closing tick (aggregator sums per-tick volume; open/high/
        // low replay ticks carry 0 so max/min replay never double-counts).
        this.emitBurst(parsed.tsMs, parsed.cumVolume, parsed.ticks);
      } else if (parsed.kind === "ohlc-side") {
        this.handleOhlcSide(parsed);
      } else if (parsed.kind === "quote") {
        this.handleQuote(parsed);
      } else if (parsed.kind === "quote-rejected") {
        this.handleQuoteRejected(parsed.code);
      } else if (parsed.kind === "pong") {
        // Server keepalive → answer with a VALID documented Capital ping
        // (correlationId + cst + securityToken). Any frame — including this
        // one — already re-armed the idle watchdog above.
        this.sendApplicationPing(ws);
      } else {
        this.stats.ignored += 1;
      }
    });
    ws.on("error", (...args: unknown[]) => {
      // Safe diagnostics: message/code/state + epic only. Session tokens are
      // scrubbed via redact() so a server reason never leaks credentials.
      const e = (args[0] ?? {}) as { message?: string; code?: string };
      console.warn(
        `[STREAM:${this.deps.symbol}] ws error: code=${e.code ?? "n/a"} ` +
          `msg=${this.redact(e.message ?? "error").slice(0, 200)} state=${this.currentState}`,
      );
    });
    ws.on("close", (...args: unknown[]) => {
      const code = args[0];
      const reason = args[1];
      const codeNum = typeof code === "number" ? code : 1006;
      const raw: string =
        typeof reason === "string"
          ? reason
          : Buffer.isBuffer(reason)
            ? reason.toString("utf8")
            : "";
      console.warn(
        `[STREAM:${this.deps.symbol}] ws closed: code=${codeNum} ` +
          `reason=${this.redact(raw).slice(0, 160)} state=${this.currentState}`,
      );
      this.clearIdle();
      this.clearHeartbeat(); // no orphaned keepalive survives a closed socket
      this.clearQuoteProbe(); // no quote probe survives a closed socket
      if (this.ws === ws) this.ws = null;
      if (this.running && !this.stopped) {
        this.reportState("RECONNECTING");
        this.scheduleReconnect();
      }
    });
  }

  /**
   * Forward a 4-tick OHLC burst: bucket-cumulative volume → per-tick delta
   * attributed to the burst's closing tick (open/high/low carry 0) — identical
   * accounting to the original inline block, shared by candles + ohlc pairs.
   */
  private emitBurst(tsMs: number, cumVolume: number, ticks: IngTick[]): void {
    const freshBucket = this.prevBurstTsMs !== tsMs;
    const delta = freshBucket
      ? cumVolume
      : Math.max(0, cumVolume - this.prevCumVolume);
    this.prevBurstTsMs = tsMs;
    this.prevCumVolume = cumVolume;
    if (ticks.length > 0) {
      ticks[ticks.length - 1].volume = delta;
      this.lastPrice = ticks[ticks.length - 1].price;
      this.lastTickAt = Date.now();
    }
    this.stats.ticks += ticks.length;
    for (const t of ticks) this.deps.onTick(t);
  }

  /**
   * Pair Capital's bid/ask ohlc.event frames (same epoch-ms bucket) into ONE
   * midpoint burst. A lone side is held in `ohlcBuffer` until its counterpart
   * arrives — a partial bucket never yields ticks, so an incomplete candle is
   * never persisted (closed MINUTE_1 candles are written downstream only).
   */
  private handleOhlcSide(
    side: Extract<ParsedFrame, { kind: "ohlc-side" }>,
  ): void {
    let bucket = this.ohlcBuffer.get(side.tsMs);
    if (!bucket) bucket = {};
    bucket[side.side] = {
      open: side.open,
      high: side.high,
      low: side.low,
      close: side.close,
      volume: side.volume,
    };
    // Bound the buffer: drop the oldest unpaired bucket on one-sided drops.
    if (this.ohlcBuffer.size > 4) {
      let oldest = side.tsMs;
      for (const k of this.ohlcBuffer.keys()) {
        if (k < oldest) oldest = k;
      }
      this.ohlcBuffer.delete(oldest);
    }
    this.ohlcBuffer.set(side.tsMs, bucket);

    const bid = bucket.bid;
    const ask = bucket.ask;
    if (!bid || !ask) return;

    const dec = this.deps.decimals;
    const midTick = (b: number, a: number): IngTick => ({
      tsMs: side.tsMs,
      price: capitalMid(b, a, dec),
      volume: 0,
      bid: b,
      offer: a,
      arriveMs: Date.now(),
      priceRaw: (b + a) / 2,
      priceField: "MID",
    });
    const ticks: IngTick[] = [
      midTick(bid.open, ask.open),
      midTick(bid.high, ask.high),
      midTick(bid.low, ask.low),
      midTick(bid.close, ask.close),
    ];
    // bid & ask frames carry identical bucket-cumulative volume; take the max
    // so a lagging side can't zero-out a real bucket's volume.
    const cumVolume = Math.max(bid.volume, ask.volume);
    this.ohlcBuffer.delete(side.tsMs);
    this.emitBurst(side.tsMs, cumVolume, ticks);
  }

  /**
   * Quote-frame lifecycle: on the FIRST genuine quote frame the stream becomes
   * "active" (probe cleared); quote data updates the latest-side buffer and —
   * when a usable bid/ask pair exists and at least one side changed — emits a
   * midpoint IngTick to the LIVE DISPLAY seam (deps.onQuote). NEVER routed to
   * deps.onTick, so quote mids can never reach the persistence aggregator.
   */
  private handleQuote(parsed: Extract<ParsedFrame, { kind: "quote" }>): void {
    this.stats.quoteFrames += 1;
    if (this.quoteState === "pending") {
      this.quoteState = "active";
      this.clearQuoteProbe();
      console.log(
        `[STREAM:${this.deps.symbol}] quote stream ACTIVE (marketData) — live intrabar updates enabled`,
      );
    }
    if (this.quoteState !== "active") return; // rejected → display path disabled

    const now = Date.now();
    if (parsed.bid !== undefined) {
      this.lastBid = parsed.bid;
      this.lastBidAt = now;
    }
    if (parsed.ask !== undefined) {
      this.lastAsk = parsed.ask;
      this.lastAskAt = now;
    }

    const bid = this.lastBid;
    const ask = this.lastAsk;
    // Side-specific frames: a midpoint needs BOTH sides, recent enough to be
    // the same market state (a stale counterpart would fabricate a mid that
    // was never quoted together).
    const QUOTE_STALE_MS = 30_000;
    if (bid === undefined || ask === undefined) {
      this.stats.quoteUnpaired += 1;
      return;
    }
    if (now - this.lastBidAt > QUOTE_STALE_MS || now - this.lastAskAt > QUOTE_STALE_MS) {
      this.stats.quoteUnpaired += 1;
      return;
    }
    // Duplicate suppression: neither side changed → no new price information.
    if (bid === this.lastEmittedBid && ask === this.lastEmittedAsk) {
      this.stats.quoteDeduped += 1;
      return;
    }

    // Timestamp sanity: a usable market ts must not be in the future (→ could
    // bucket a candle ahead of real time) nor ancient (→ stale bucket). Out of
    // range → arrival time, which can never create a future/duplicate bucket.
    const tsMs =
      parsed.tsMs !== undefined && parsed.tsMs <= now && now - parsed.tsMs <= 600_000
        ? parsed.tsMs
        : now;

    this.lastEmittedBid = bid;
    this.lastEmittedAsk = ask;
    this.stats.quoteMids += 1;
    this.deps.onQuote?.({
      tsMs,
      price: capitalMid(bid, ask, this.deps.decimals),
      volume: 0,
      bid,
      offer: ask,
      arriveMs: now,
      priceRaw: (bid + ask) / 2,
      priceField: "MID",
    });
  }

  /**
   * Quote subscription rejected by the server (e.g. "error.too-many.requests")
   * or the stream errored. FAILURE-SAFE: disable ONLY the quote display path —
   * log once, keep the socket, keep the OHLC stream / heartbeat / reconnect /
   * persistence exactly as they were. Never triggers a reconnect.
   */
  private handleQuoteRejected(code: string): void {
    this.stats.quoteErrors += 1;
    if (this.quoteState === "rejected") return;
    this.quoteState = "rejected";
    this.clearQuoteProbe();
    console.warn(
      `[STREAM:${this.deps.symbol}] quote stream rejected (code=${code}) — continuing OHLC-only`,
    );
  }

  /**
   * Probe: if no genuine quote frame arrives within quoteProbeTimeoutMs of the
   * subscribe, the quote stream is declared unavailable for THIS connection —
   * display path off, everything else untouched. Cleared by the first quote.
   */
  private armQuoteProbe(): void {
    this.clearQuoteProbe();
    const timeout = this.deps.quoteProbeTimeoutMs ?? 15_000;
    if (timeout <= 0) return; // 0/negative disables (tests)
    this.quoteProbeTimer = setTimeout(() => {
      this.quoteProbeTimer = null;
      if (this.quoteState === "pending") {
        this.quoteState = "rejected";
        console.warn(
          `[STREAM:${this.deps.symbol}] quote stream unavailable (no frames within ${Math.round(timeout / 1000)}s) — continuing OHLC-only`,
        );
      }
    }, timeout);
  }

  private clearQuoteProbe(): void {
    if (this.quoteProbeTimer) {
      clearTimeout(this.quoteProbeTimer);
      this.quoteProbeTimer = null;
    }
  }

  /** Scrub session tokens (CST / X-SECURITY-TOKEN) out of a diagnostic string. */
  private redact(text: string): string {
    if (!text) return "";
    let out = text;
    for (const secret of this.redactables()) {
      if (secret) out = out.split(secret).join("<REDACTED>");
    }
    return out;
  }

  /** Exponential backoff, capped; fresh session on every retry. */
  private scheduleReconnect(): void {
    if (!this.running || this.stopped) return;
    if (this.reconnectTimer) return;
    const base = this.deps.backoffBaseMs ?? 1_000;
    const max = this.deps.backoffMaxMs ?? 30_000;
    const delay = Math.min(max, base * 2 ** Math.min(this.reconnectAttempt, 20));
    this.reconnectAttempt += 1;
    this.stats.reconnects += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openStream();
    }, delay);
  }

  /**
   * Send Capital's documented application-level ping on the CURRENT session's
   * credentials: { destination:"ping", correlationId, cst, securityToken }.
   * Returns false when there is no session or the send throws (the close
   * handler drives reconnect). Never logs the payload (tokens are secrets).
   */
  private sendApplicationPing(ws: WebSocketLike): boolean {
    const session = this.lastSession;
    if (!session) return false;
    try {
      ws.send(
        JSON.stringify({
          destination: "ping",
          correlationId: String(this.nextCorrelationId++),
          cst: session.cst,
          securityToken: session.xSecurityToken,
        }),
      );
      this.stats.heartbeats += 1;
      return true;
    } catch {
      return false; // close handler drives reconnect
    }
  }

  /**
   * Periodic keepalive while OPEN: Capital's edge terminates quiet sockets
   * ~60s after the last frame (close 1006), so ping every 30s. Exactly one
   * timer per socket — startHeartbeat clears any previous timer first, and
   * each firing re-checks that ITS socket is still the live, OPEN one.
   */
  private startHeartbeat(ws: WebSocketLike): void {
    this.clearHeartbeat();
    const interval = this.deps.heartbeatIntervalMs ?? CAPITAL_HEARTBEAT_INTERVAL_MS;
    if (interval <= 0) return; // 0/negative disables (tests)
    this.heartbeatTimer = setInterval(() => {
      // Ping ONLY the live socket this timer was armed for, only while OPEN.
      if (this.ws !== ws || ws.readyState !== OPEN) return;
      this.sendApplicationPing(ws);
    }, interval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Silent-socket watchdog: no frames for idleTimeoutMs → hard terminate. */
  private armIdleWatchdog(): void {
    this.clearIdle();
    const idle = this.deps.idleTimeoutMs ?? 120_000;
    if (idle <= 0) return; // 0/negative disables (tests)
    this.idleTimer = setTimeout(() => {
      const ws = this.ws;
      if (ws) {
        try {
          ws.terminate(); // fires "close" → reconnect
        } catch {
          /* already gone */
        }
      }
    }, idle);
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearIdle();
    this.clearHeartbeat();
    this.clearQuoteProbe();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
