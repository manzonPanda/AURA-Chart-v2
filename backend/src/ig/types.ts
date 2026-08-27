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

export const IG_RESOLUTIONS = [
  "SECOND",
  "MINUTE",
  "MINUTE_2",
  "MINUTE_3",
  "MINUTE_5",
  "MINUTE_10",
  "MINUTE_15",
  "MINUTE_30",
  "HOUR",
  "HOUR_2",
  "HOUR_3",
  "HOUR_4",
  "DAY",
  "WEEK",
  "MONTH",
] as const;

export type IgResolution = (typeof IG_RESOLUTIONS)[number];

export const MAX_PAGE_SIZE = 500;