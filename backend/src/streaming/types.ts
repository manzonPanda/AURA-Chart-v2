/**
 * Shared types for the IG real-time streaming layer.
 */

/** Overall streaming connection status reported to the frontend + diagnostic. */
export type StreamState = "CONNECTING" | "LIVE" | "RECONNECTING" | "DISCONNECTED";

/** A tick received from IG Lightstreamer (constructed from CHART:epic:TICK). */
export interface IngTick {
  /** Epoch milliseconds from the market (UTM) when available, else now. */
  tsMs: number;
  /** Mid-of-bid/offer or last-traded price used to build candles (rounded). */
  price: number;
  /** Per-tick traded volume when IG provides it. */
  volume: number;
  /** Raw bid / offer for diagnostics (never printed to clients). */
  bid?: number;
  offer?: number;
  /** Last traded price field value, when the feed emitted one. */
  ltp?: number;
  /** Server arrival time (epoch ms) — for gap / UTM-skew analysis. */
  arriveMs: number;
  /** Raw Lightstreamer UTM when usable (epoch ms), else undefined. */
  utmMs?: number;
  /** Unrounded price BEFORE the 1-decimal rounding (diagnostics only). */
  priceRaw: number;
  /** Which field produced `price` (MID | BID | OFR | LTP). */
  priceField: "MID" | "BID" | "OFR" | "LTP";
}

/**
 * A just-closed candle PLUS the per-bucket diagnostics collected while it was
 * forming. `open/high/low/close` are exactly what the chart received (rounded
 * 1-decimal MID). `rawO…rawC` are the unrounded prices BEFORE the rounding
 * step — kept separately so we can tell whether rounding alone shifted our
 * OHLC versus the IG website's candles.
 */
/**
 * Persistence classification of a closed candle (stored in ohlc_candles.status).
 *
 *   partial     the collector's first tick for the bucket arrived well after
 *               the bucket boundary — a restart/reconnect happened mid-bucket.
 *   completed   the collector had coverage from (near) the bucket boundary.
 *   backfilled  the row was written by the future IG historical backfill job.
 *
 * LIVE is intentionally absent: the forming candle is an in-memory/realtime
 * state and only enters the database at rollover.
 */
export type CandleStatus = "partial" | "completed" | "backfilled";

export interface ClosedCandle extends RealtimeCandle {
  /** Number of ticks aggregated into this candle. */
  tickCount: number;
  /** Market (UTM) timestamp of the first/last tick — epoch ms. */
  firstTickMs: number;
  lastTickMs: number;
  /** Unrounded MID OHLC as-received (diagnostics only — not the chart values). */
  rawOpen?: number;
  rawHigh?: number;
  rawLow?: number;
  rawClose?: number;
  /**
   * Explicit status override (e.g. 'backfilled' from the future backfill job).
   * When omitted, CandleStore classifies from firstTickMs vs bucket start.
   */
  status?: CandleStatus;
}

/**
 * A currently-forming (or just-closed) candle. `time` is the bar's bucket-start
 * as epoch SECONDS — the `time` field the real-time websocket emits and which
 * the frontend feeds to `series.update()`.
 */
export interface RealtimeCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}