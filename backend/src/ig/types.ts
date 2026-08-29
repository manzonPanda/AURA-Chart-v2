/**
 * Type definitions mirroring the parts of the IG REST API we consume.
 * See https://labs.ig.com/rest-trading-api-guide
 */

export interface IgPriceLevel {
  bid?: number | null;
  ask?: number | null;
  midTraded?: number | null;
}

export interface IgPrice {
  openPrice?: IgPriceLevel | null;
  closePrice?: IgPriceLevel | null;
  highPrice?: IgPriceLevel | null;
  lowPrice?: IgPriceLevel | null;
  lastTradedVolume?: string | number | null;
  /** Bar close time in the server's local timezone (fallback only). */
  snapshotTime?: string | null;
  /** Bar close time in UTC (preferred source of truth). */
  snapshotTimeUTC?: string | null;
}

export interface IgHistoricalPricesResponse {
  instrumentType?: string;
  prices?: IgPrice[];
  allowance?: {
    remainingAllowance?: number;
    totalAllowance?: number;
    allowanceExpiry?: string;
  };
}

/**
 * The ONLY chart resolution — a single 3-minute timeframe.
 *   - `MINUTE_3` → backend-aggregated 3-minute candle built from IG MINUTE data
 *     (epoch-bucket floor(ts/180)*180). IG v3 /prices is capped at 500
 *     points/request and offers no reliable 3-minute page, so 3m is NEVER
 *     requested from IG directly — we pull a small 1-minute window and
 *     aggregate it into one-day-ish 3m candles.
 */
export const CHART_RESOLUTIONS = ["MINUTE_3"] as const;

export type ChartResolution = (typeof CHART_RESOLUTIONS)[number];

export const MAX_PAGE_SIZE = 500;