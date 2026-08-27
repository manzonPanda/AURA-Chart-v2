/**
 * Timeframe definitions. Each UI timeframe maps to a real IG resolution that
 * the backend forwards to the IG `/prices/{epic}` endpoint — no fake
 * resolutions.
 */
export interface TimeframeOption {
  key: string;
  label: string;
  /** IG REST resolution identifier. */
  resolution: string;
}

export const TIMEFRAMES: TimeframeOption[] = [
  { key: "m1", label: "1m", resolution: "MINUTE" },
  { key: "m5", label: "5m", resolution: "MINUTE_5" },
  { key: "m15", label: "15m", resolution: "MINUTE_15" },
  { key: "h1", label: "1h", resolution: "HOUR" },
  { key: "h4", label: "4h", resolution: "HOUR_4" },
  { key: "D1", label: "1D", resolution: "DAY" },
];

export const DEFAULT_TIMEFRAME_KEY = "m15";

/** Fetched candles per timeframe. */
export const CANDLE_LIMIT = 500;
