/**
 * IG market discovery — search instruments by name and fetch market details,
 * through the authenticated client so the results reflect the account's actual
 * available market.
 */
import type { IgClient } from "./client.js";

/**
 * Live fields observed in the `/markets` search response. Typed loosely
 * (mirrors the raw payload) because IG is the source of truth here.
 */
export interface IgMarketSummary {
  epic?: string;
  instrumentName?: string;
  instrumentType?: string;
  marketStatus?: string;
  expiry?: string;
  lotSize?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface IgMarketsSearchResult {
  markets?: IgMarketSummary[];
}

export interface IgMarketDetails {
  market?: {
    marketName?: string;
    marketStatus?: string;
    instrumentType?: string;
    [key: string]: unknown;
  };
  instrument?: {
    epic?: string;
    name?: string;
    type?: string;
    currency?: string;
    symbol?: string;
    [key: string]: unknown;
  };
  snapshot?: {
    bid?: number;
    offer?: number;
    high?: number;
    low?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** GET /markets?searchTerm=... — search market instruments by keyword. */
export async function searchIGMarkets(ig: IgClient, searchTerm: string): Promise<IgMarketsSearchResult> {
  const query = new URLSearchParams();
  query.set("searchTerm", searchTerm);
  return ig.request<IgMarketsSearchResult>("/markets", { query });
}

/** GET /markets/{epic} — detailed market + instrument + snapshot for one epic. */
export async function getIGMarketDetails(ig: IgClient, epic: string): Promise<IgMarketDetails> {
  return ig.request<IgMarketDetails>(`/markets/${encodeURIComponent(epic)}`, {});
}