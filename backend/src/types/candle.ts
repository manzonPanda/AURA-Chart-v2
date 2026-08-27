/**
 * Normalized candle type shared by the backend and (through the API shape) the
 * frontend. `ts` is an epoch-millisecond UTC timestamp of the bar CLOSE,
 * matching CandleKit's `Bar`/`RawBar` input format so no extra conversion is
 * needed in the UI.
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

export interface HealthResponse {
  ok: boolean;
  instrumentConfigured: boolean;
  environment: string;
}