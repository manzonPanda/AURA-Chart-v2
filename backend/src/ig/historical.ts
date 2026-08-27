/**
 * Historical price fetching + normalization from the IG `/prices/{epic}`
 * endpoint into the internal `Candle` type.
 */
import type { Candle } from "../types/candle.js";
import type { IgClient } from "./client.js";
import { IgApiError } from "./errors.js";
import type { IgHistoricalPricesResponse, IgPrice, IgPriceLevel } from "./types.js";

export interface HistoricalOptions {
  epic: string;
  resolution: string;
  limit: number;
}

/** Best-effort single price from IG's { bid | ask | midTraded } level. */
function midPrice(level: IgPriceLevel | null | undefined): number | undefined {
  if (!level) return undefined;
  if (typeof level.midTraded === "number") return level.midTraded;
  if (typeof level.bid === "number" && typeof level.ask === "number") return (level.bid + level.ask) / 2;
  if (typeof level.bid === "number") return level.bid;
  if (typeof level.ask === "number") return level.ask;
  return undefined;
}

function toCandle(price: IgPrice): Candle | null {
  const open = midPrice(price.openPrice);
  const high = midPrice(price.highPrice);
  const low = midPrice(price.lowPrice);
  const close = midPrice(price.closePrice);

  if ([open, high, low, close].some((v) => typeof v !== "number" || Number.isNaN(v))) {
    return null;
  }

  const utcIso = price.snapshotTimeUTC ?? price.snapshotTime;
  const ts = utcIso ? Date.parse(utcIso) : NaN;
  if (Number.isNaN(ts)) return null;

  const volumeRaw = price.lastTradedVolume;
  const volume = volumeRaw == null || volumeRaw === "" ? undefined : Number(volumeRaw);

  return {
    ts,
    open: open as number,
    high: high as number,
    low: low as number,
    close: close as number,
    ...(typeof volume === "number" && Number.isFinite(volume) ? { volume } : {}),
  };
}

/**
 * Fetch the most recent `limit` candles (1..500, IG's pageSize cap) for an epic
 * at a given resolution and return them normalized, ascending, deduplicated.
 */
export async function fetchHistoricalCandles(
  ig: IgClient,
  opts: HistoricalOptions,
): Promise<Candle[]> {
  const limit = Math.max(1, Math.min(500, Math.round(opts.limit) || 500));

  const query = new URLSearchParams();
  query.set("resolution", opts.resolution);
  // `max` = "most recent N points" (documented v2 usage, no date params needed).
  // IG pagination is backwards: the returned window is newest-first.
  query.set("max", String(limit));

  const data = await ig.request<IgHistoricalPricesResponse>(`/prices/${opts.epic}`, {
    query,
    // IG serves /prices/{epic} at Version 3 only in 2026 — v1/v2 return bare
    // Tomcat 404 HTML (route retired). v3 keeps the bid/ask level shape.
    version: "3",
  });

  const prices = data?.prices;
  if (prices === undefined) {
    throw new IgApiError("malformed", 502, "IG returned a malformed historical-price response.");
  }
  if (!Array.isArray(prices)) {
    throw new IgApiError("malformed", 502, "IG returned a malformed historical-price response.");
  }

  const seen = new Set<number>();
  const candles: Candle[] = [];
  for (const p of prices) {
    const c = toCandle(p);
    if (!c || seen.has(c.ts)) continue;
    seen.add(c.ts);
    candles.push(c);
  }
  candles.sort((a, b) => a.ts - b.ts);
  return candles;
}