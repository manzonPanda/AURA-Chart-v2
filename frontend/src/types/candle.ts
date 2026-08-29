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
