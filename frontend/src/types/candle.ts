/**
 * The single normalized candle format used throughout the frontend.
 * `ts` is an epoch-millisecond UTC timestamp of the bar CLOSE — this is
 * exactly CandleKit's `Bar` input shape, so chart data needs no conversion.
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
