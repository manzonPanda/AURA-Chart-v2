/**
 * Type definitions mirroring the parts of the Capital.com REST API we consume.
 * See https://open-api.capital.com/ (REST) + the streaming WebSocket docs.
 *
 * OHLC basis (USER-CONFIRMED decision 2026-09 — do not change silently):
 *   open  = (openBid  + openAsk)  / 2
 *   high  = (highBid  + highAsk)  / 2
 *   low   = (lowBid   + lowAsk)   / 2
 *   close = (closeBid + closeAsk) / 2
 * then rounded onto the instrument's quoting grid (Gold = 2 decimals).
 */

/** A Capital.com bid/ask level. Documented shape uses `<field>Bid/<field>Ask`;
 *  a generic {bid, ask} shape is accepted too (parsing is tolerant). */
export interface CapitalBidAsk {
  bid?: number | string | null;
  ask?: number | string | null;
  openBid?: number | string | null;
  openAsk?: number | string | null;
  highBid?: number | string | null;
  highAsk?: number | string | null;
  lowBid?: number | string | null;
  lowAsk?: number | string | null;
  closeBid?: number | string | null;
  closeAsk?: number | string | null;
}

/** One Capital.com historical price bar (1-minute `resolution=MINUTE` page). */
export interface CapitalPrice {
  /** Bar close time in the display timezone (fallback only — NEVER authoritative). */
  snapshotTime?: string | null;
  /** Bar close time in UTC, NO timezone designator — the AUTHORITATIVE source. */
  snapshotTimeUTC?: string | null;
  openPrice?: CapitalBidAsk | null;
  highPrice?: CapitalBidAsk | null;
  lowPrice?: CapitalBidAsk | null;
  closePrice?: CapitalBidAsk | null;
  lastTradedVolume?: number | string | null;
}

export interface CapitalHistoricalPricesResponse {
  prices?: CapitalPrice[];
  /** Capital.com error payload (when the request fails, not a 200). */
  errorCode?: string;
}

/** Metadata for one Capital.com market (GET /markets/{symbol}). */
export interface CapitalMarketDetails {
  instrument?: { symbol?: string; name?: string; type?: string } | null;
  snapshot?: {
    bid?: number | null;
    offer?: number | null;
    decimalPlacesFactor?: number | null;
    snapshotTimeUTC?: string | null;
  } | null;
  dealingRules?: Record<string, unknown> | null;
  errorCode?: string;
}

/**
 * The ONLY historical resolution AURA requests from Capital.com — 1-minute
 * bars. 3m is backend-aggregated from 1m (epoch bucketing), exactly like the
 * IG pipeline. There is no native 3-minute page request in AURA.
 */
export const CAPITAL_RESOLUTION = "MINUTE";

/**
 * Bounded page size for /prices pagination (points per HTTP request). This is
 * deliberately CONSERVATIVE (well below any documented server cap) — the
 * pagination loop always advances by client-side timestamps, so the exact
 * server maximum never matters, only bounded request sizes do.
 */
export const CAPITAL_PAGE_SIZE = 1000;

/** AURA's Capital.com Gold market symbol (verified via /markets?searchTerm=Gold).
 *  NOT GOLDUS / GOLDAU / GCZ2026 — spot Gold CFD only. */
export const CAPITAL_GOLD_SYMBOL = "GOLD";
