/**
 * Capital.com WebSocket streaming client (migration Phase 4).
 *
 * Mirrors the IG stream seam (`streaming/igStream.ts`) so Phase 5 wiring into
 * RealtimeService is a drop-in: `start(handler)` emits `IngTick`s — the SAME
 * normalized forming-candle shape the aggregators already consume — and
 * `stop()` tears the socket down without touching provider-agnostic
 * aggregation/persistence/relay.
 *
 * Protocol (Capital.com streaming):
 *   wss://api-streaming-capital.backend-capital.com/connect
 *   Headers: CST + X-SECURITY-TOKEN (FRESH per connect — sessions expire
 *   ~10 min, so tokens are never reused across reconnects).
 *   Subscribe:  { destination: "OHLCMarketData.subscribe",
 *                 payload: { markets: [symbol], periods: ["MINUTE"] } }
 *   Candles:    { destination: "candles", payload: { candles: [...] } }
 *   Quotes:     { destination: "quote", payload: { bid, ask, ... } } —
 *               counted for liveness but NEVER converted into ticks (a
 *               mid-price OHLC rewrite would corrupt the aggregator's
 *               open/high/low truth; only real OHLC frames emit ticks).
 *
 * Price basis (approved): midpoint of bid/ask per field,
 *   mid = round(((bid + ask) / 2) * 10^decimals) / 10^decimals
 * Timestamps: `snapshotTimeUTC` is authoritative (ISO-8601 UTC → epoch ms).
 * The local-time `snapshotTime` field is never parsed (would mis-store
 * local wall-clock as UTC).
 *
 * Reconnect: exponential backoff (1s base → 30s cap), fresh session per
 * attempt, idle watchdog terminates silent sockets. No token/credential is
 * ever logged — diagnostics count frames, never print payloads.
 */
import { WebSocket } from "ws";
import { parseCapitalTimestampAsUtc } from "./time.js";
import type { IngTick, StreamState } from "../streaming/types.js";

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
  /** Fresh-session provider — wired to CapitalClient in Phase 5. */
  sessionProvider: () => Promise<CapitalStreamSession>;
  /** Tick consumer — the RealtimeService aggregator seam (was start(handler)). */
  onTick: CapitalTickHandler;
  /** Reconnect backoff tuning (defaults: 1s base, 30s cap). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Silent-socket watchdog (default 120s without any frame → reconnect). */
  idleTimeoutMs?: number;
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
  | { kind: "pong" }
  | { kind: "ignored"; reason: string };

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

  // Quote frames (bid/ask snapshots): liveness only — never tick material.
  if (
    destination.toLowerCase().includes("quote") ||
    destination.includes("marketData") ||
    num(payload.bid) !== undefined ||
    num(payload.ask) !== undefined
  ) {
    return { kind: "ignored", reason: "quote-frame" };
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

  /** Frame diagnostics — counters only (never payloads/tokens). */
  readonly stats = { frames: 0, ticks: 0, ignored: 0, reconnects: 0 };

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
  } {
    return {
      ticks: this.stats.ticks,
      lastPrice: this.lastPrice,
      lastTickAt: this.lastTickAt,
      updatesReceived: this.stats.frames,
      noPriceUpdates: this.stats.ignored,
    };
  }

  private reportState(state: StreamState): void {
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
      "wss://api-streaming-capital.backend-capital.com/connect";
    const headers: Record<string, string> = {
      CST: session.cst,
      "X-SECURITY-TOKEN": session.xSecurityToken,
    };
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
      this.reportState("LIVE");
      try {
        ws.send(
          JSON.stringify({
            destination: "OHLCMarketData.subscribe",
            payload: { markets: [this.deps.symbol], periods: ["MINUTE"] },
          }),
        );
      } catch {
        /* close handler drives reconnect */
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
        const freshBucket = this.prevBurstTsMs !== parsed.tsMs;
        const delta = freshBucket
          ? parsed.cumVolume
          : Math.max(0, parsed.cumVolume - this.prevCumVolume);
        this.prevBurstTsMs = parsed.tsMs;
        this.prevCumVolume = parsed.cumVolume;
        const ticks = parsed.ticks;
        if (ticks.length > 0) {
          ticks[ticks.length - 1].volume = delta;
          this.lastPrice = ticks[ticks.length - 1].price;
          this.lastTickAt = Date.now();
        }
        this.stats.ticks += ticks.length;
        for (const t of ticks) this.deps.onTick(t);
      } else if (parsed.kind === "pong") {
        try {
          ws.send(JSON.stringify({ destination: "ping", payload: {} }));
        } catch {
          /* close handler drives reconnect */
        }
      } else {
        this.stats.ignored += 1;
      }
    });
    ws.on("error", () => {
      /* close handler drives reconnect */
    });
    ws.on("close", () => {
      this.clearIdle();
      if (this.ws === ws) this.ws = null;
      if (this.running && !this.stopped) {
        this.reportState("RECONNECTING");
        this.scheduleReconnect();
      }
    });
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
