/**
 * Historical price fetching + normalization from the IG `/prices/{epic}`
 * endpoint into the internal `Candle` type.
 *
 * Only two chart timeframes are served:
 *  - `MINUTE`   → IG's native 1-minute resolution, fetched as-is.
 *  - `MINUTE_3` → backend-aggregated 3-minute candles built from IG MINUTE
 *    candles via epoch bucketing (floor(ts/180)*180). IG v3 /prices has NO
 *    native 3-minute page and is capped at 500 points/request, so 3m is never
 *    requested from IG directly — we aggregate 1-minute candles.
 */
import type { Candle } from "../types/candle.js";
import type { IgClient } from "./client.js";
import { IgApiError } from "./errors.js";
import { parseIgTimestampAsUtc } from "./time.js";
import type { IgHistoricalPricesResponse, IgPrice, IgPriceLevel } from "./types.js";
import { MAX_PAGE_SIZE } from "./types.js";

export interface HistoricalOptions {
  epic: string;
  /** Internal chart resolution: "MINUTE" or "MINUTE_3". */
  resolution: string;
  /** Desired number of chart candles (1m → up to 500; 3m → up to 500). */
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
  // IG's snapshotTimeUTC carries NO timezone designator; parse its components
  // as UTC (the existing, verified timezone fix — unchanged, no ±8 h).
  const ts = utcIso ? parseIgTimestampAsUtc(utcIso) : NaN;
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
 * Fetch the most recent `limit` raw 1-minute candles for an epic and return
 * them normalized, ascending + deduplicated.
 *
 * IG `/prices/{epic}` v3 facts (verified empirically 2026-08):
 *  - `max` ALONE is NOT honoured for page size — IG returns a 20-point page
 *    from the OLDEST end (the stale "Bars: 20" bug). Sending `pageSize`
 *    alongside `max` returns the NEWEST `limit`-capped window.
 *  - `pagenumber` and `to` are IGNORED by v3, so only the newest
 *    {@link MAX_PAGE_SIZE} points per (epic, resolution) are reachable. There
 *    is no legal backward-paging loop, so we request only the MINIMUM needed
 *    (one request) and never poll continuously.
 */
async function fetchRawCandles(ig: IgClient, epic: string, limit: number): Promise<Candle[]> {
  const prices = await fetchRawPrices(ig, epic, limit);

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

/**
 * DIAGNOSTIC EXPORT: raw IG 1-minute price rows (un-normalised, all levels
 * intact) so the `ohlc-compare` script can re-aggregate the SAME 3-minute
 * bucket using bid-only / ask-only / quote-mid / midTraded and compare against
 * the live `[3M CANDLE CLOSED]` logs. NOT used by the chart itself.
 */
export async function fetchRawPrices(ig: IgClient, epic: string, limit: number): Promise<IgPrice[]> {
  const pageSize = Math.min(Math.max(1, Math.round(limit) || MAX_PAGE_SIZE), MAX_PAGE_SIZE);

  const query = new URLSearchParams();
  query.set("resolution", "MINUTE"); // raw source for BOTH 1m and 3m
  query.set("max", String(pageSize));
  query.set("pageSize", String(pageSize));

  const data = await ig.request<IgHistoricalPricesResponse>(`/prices/${epic}`, {
    query,
    version: "3",
  });

  const prices = data?.prices;
  if (!Array.isArray(prices)) {
    throw new IgApiError("malformed", 502, "IG returned a malformed historical-price response.");
  }
  return prices;
}
/**
 * Stage 3 — fetch 1-minute candles covering the epoch-ms range [fromMs, toMs]
 * (inclusive) for backfill.
 *
 * IG version reality (probed directly 2026-08-28 on the LIVE gateway):
 *  - v2 /prices is RETIRED — every v2 request answers 404 `invalid_epic` even
 *    for an EPIC that streams fine. A v2 fallback therefore converts every
 *    real v3 error (allowance 403, auth, malformed) into a misleading
 *    `invalid_epic`; it was removed for that reason. Errors now propagate
 *    honestly (e.g. IG_ALLOWANCE_EXHAUSTED → kind=rate_limit).
 *  - v3 IGNORES range params (`from`/`to`/`pagenumber` — verified empirically
 *    in this repo): it answers with the newest `pageSize` points regardless.
 *    We still SEND the range (harmless, honoured if IG ever enables it) but do
 *    NOT rely on it: the response is filtered client-side to [fromMs, toMs]
 *    and the window is always requested at full reach (MAX_PAGE_SIZE) so
 *    older gaps have the best chance of being reachable at all.
 *
 * Coverage policy: partial/no coverage is a SUCCESS with fewer rows — the
 * backfill planner classifies each requested bucket as covered or uncovered
 * and never invents data for uncovered ones.
 */
export async function fetchOneMinuteRange(
  ig: IgClient,
  epic: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const query = new URLSearchParams();
  query.set("resolution", "MINUTE");
  query.set("max", String(MAX_PAGE_SIZE));
  query.set("pageSize", String(MAX_PAGE_SIZE));
  query.set("from", new Date(fromMs).toISOString());
  query.set("to", new Date(toMs).toISOString());

  const res = await ig.request<IgHistoricalPricesResponse>(`/prices/${epic}`, {
    query,
    version: "3",
  });

  // Client-side range filter — the only trustworthy guard (v3 may ignore from/to).
  return pricesToCandles(res.prices ?? []).filter((c) => c.ts >= fromMs && c.ts <= toMs);
}

/** Normalize raw IG price rows → ascending, deduplicated 1-minute candles. */
function pricesToCandles(prices: IgPrice[]): Candle[] {
  const seen = new Set<number>();
  const candles: Candle[] = [];
  for (const p of prices) {
    const c = toCandle(p);
    if (c && !seen.has(c.ts)) {
      seen.add(c.ts);
      candles.push(c);
    }
  }
  return candles.sort((a, b) => a.ts - b.ts);
}

/**
 * Aggregate ascending 1-minute candles into N-minute candles using pure epoch
 * bucketing (NO local timezone): bucketStart = floor(ts / (minutes*60)) * … .
 * open = first underlying open, high = max high, low = min low,
 * close = last underlying close, volume = sum of underlying volumes.
 */
export function aggregateToMinutes(oneMin: readonly Candle[], minutes: number): Candle[] {
  const bucketMs = minutes * 60 * 1000;
  const out: Candle[] = [];
  let cur: Candle | null = null;

  for (const c of oneMin) {
    const bucket = Math.floor(c.ts / bucketMs) * bucketMs;
    if (!cur || cur.ts !== bucket) {
      cur = {
        ts: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        ...(c.volume !== undefined ? { volume: c.volume } : {}),
      };
      out.push(cur);
      continue;
    }
    if (c.high > cur.high) cur.high = c.high;
    if (c.low < cur.low) cur.low = c.low;
    cur.close = c.close;
    if (c.volume !== undefined) cur.volume = (cur.volume ?? 0) + c.volume;
  }
  return out;
}

/**
 * Entry point for GET /api/candles. `resolution` is a CHART resolution
 * ("MINUTE" / "MINUTE_3" — never a raw IG enum):
 *  - MINUTE   : up to `limit` (≤500) native 1-minute candles.
 *  - MINUTE_3 : fetches the allowed 1-minute candles (one request, the
 *    minimum IG exposes) and aggregates them into 3-minute candles. IG only
 *    exposes the newest 500 points per (epic, resolution), so 500 1m → ~166
 *    3m; the realtime stream then extends the series forward.
 */
export async function fetchHistoricalCandles(
  ig: IgClient,
  opts: HistoricalOptions,
): Promise<Candle[]> {
  const requested = Math.max(1, Math.round(opts.limit) || MAX_PAGE_SIZE);
  const limit = Math.min(requested, MAX_PAGE_SIZE);

  const raw = await fetchRawCandles(ig, opts.epic, limit);
  // The ONLY resolution served is 3m, always aggregated from 1m underlying.
  const candles = aggregateToMinutes(raw, 3);

  // TEMPORARY safe diagnostics — timestamps + counts only, never secrets.
  const first = candles[0];
  const last = candles[candles.length - 1];
  const iso = (ts?: number) => (typeof ts === "number" ? new Date(ts).toISOString() : "—");
  console.log(
    `[HISTORY] timeframe=${opts.resolution} requested=${requested}` +
      ` raw1m=${raw.length} bars=${candles.length}` +
      ` first=${iso(first?.ts)} last=${iso(last?.ts)}`,
  );

  return candles;
}