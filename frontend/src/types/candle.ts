/**
 * The single normalized candle format used throughout the frontend.
 * `ts` is an epoch-millisecond UTC timestamp of the bar's BUCKET START —
 * identical to IG's snapshotTimeUTC boundary and to the realtime aggregator's
 * `floor(tick/interval)*interval` bucket, so history and live share one time
 * base and merge by exact timestamp in CandleKit's `Bar` shape.
 */
export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface CandlesResponse {
  epic: string;
  resolution: string;
  count: number;
  candles: Candle[];
}

/**
 * A detected market-data gap — an expected market bucket where no candle
 * exists. These are NOT synthetic candles; they are derived intervals that
 * the chart renders as a shaded "DATA GAP" region.
 *
 * `startTime` / `endTime` are epoch-MILLISECONDS (bucket-start UTC), matching
 * `Candle.ts`. `reason` is informational for future expansion.
 */
export interface CandleGap {
  instrument: string;
  timeframe: string;
  startTime: number;
  endTime: number;
  reason?: "broker_gap" | "missing_data";
}
