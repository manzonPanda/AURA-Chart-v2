/**
 * Historical prices via GET /api/v1/prices/{symbol}.
 *
 * ▸ RESOLUTION: `MINUTE` buckets (Capital's smallest); callers aggregate to
 *   3m with the SHARED, provider-agnostic aggregateToMinutes (relocated from
 *   ig/historical.ts — one aggregation, both providers).
 * ▸ MIDPOINT: AURA's OHLC basis is IG's mid. Capital returns bid AND ask
 *   OHLC; open/high/low/close = (bid + ask) / 2 rounded onto the instrument's
 *   quoting grid (GOLD 2dp) — the documented Phase 1 decision, NOT a basis
 *   change. Raw bid/ask remain in CapitalCandle for future bid-based views.
 * ▸ TIMESTAMPS: `snapshotTimeUTC` is authoritative (UTC ISO, epoch-ms via
 *   parseCapitalTimestampAsUtc — never the local snapshotTime).
 * ▸ PAGINATION: /prices is bounded server-side; historical retrieval pages
 *   forward through fetchPricePages using `from`/`to` windows + `max`, with
 *   retry/backoff and rate-limit awareness (Capital throttles bursts).
 */
import { CapitalApiError } from "./errors.js";
import { capitalRowTimestamp } from "./time.js";
import {
  CAPITAL_PAGE_SIZE,
  type CapitalBidAsk,
  type CapitalHistoricalPricesResponse,
  type CapitalPrice,
} from "./types.js";

/** One bounded pagination window (epoch-ms; toMs exclusive). */
export interface CapitalPriceWindow {
  fromMs: number;
  toMs: number;
}

/** Parsed midpoint OHLC row (+ the raw bid/ask it was derived from). */
export interface CapitalCandle {
  /** Bucket close time, UTC epoch-ms (authoritative snapshotTimeUTC). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  openBidAsk?: CapitalBidAsk;
  highBidAsk?: CapitalBidAsk;
  lowBidAsk?: CapitalBidAsk;
  closeBidAsk?: CapitalBidAsk;
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function midPair(bid: number | null, ask: number | null): number | null {
  if (bid === null && ask === null) return null;
  if (bid === null) return ask;
  if (ask === null) return bid;
  return (bid + ask) / 2;
}

/** Mid of one bid/ask pair (generic {bid, ask} shape), null when unusable. */
/**
 * Round onto the instrument's quoting grid (GOLD 2dp) — Math.round parity
 * with roundToInstrumentPrecision, kept inline so the capital module stays
 * isolated from ig-era code.
 */
export function roundToGrid(raw: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(raw * factor) / factor;
}

/** Mid of one bid/ask pair (generic {bid, ask} shape), null when unusable. */
function midBidAsk(ba: CapitalBidAsk | null | undefined): number | null {
  if (!ba) return null;
  return midPair(num(ba.bid), num(ba.ask));
}

/** Mid of one documented `<field>Bid/<field>Ask` level shape. */
function midField(
  ba: CapitalBidAsk | null | undefined,
  bidKey: string,
  askKey: string,
): number | null {
  if (!ba) return null;
  const rec = ba as unknown as Record<string, unknown>;
  return midPair(
    num(rec[bidKey] as number | string | null | undefined),
    num(rec[askKey] as number | string | null | undefined),
  );
}

/** Parse one CapitalPrice API row into a midpoint CapitalCandle. */
export function parseCapitalPrice(p: CapitalPrice, decimals: number): CapitalCandle | null {
  const ts = capitalRowTimestamp(p);
  if (!Number.isFinite(ts)) return null; // malformed row — skipped, never guessed
  const o = midField(p.openPrice, "openBid", "openAsk") ?? midBidAsk(p.openPrice);
  const h = midField(p.highPrice, "highBid", "highAsk") ?? midBidAsk(p.highPrice);
  const l = midField(p.lowPrice, "lowBid", "lowAsk") ?? midBidAsk(p.lowPrice);
  const c = midField(p.closePrice, "closeBid", "closeAsk") ?? midBidAsk(p.closePrice);
  if (o === null || h === null || l === null || c === null) return null;
  const vol = num(p.lastTradedVolume) ?? undefined;
  return {
    ts,
    open: roundToGrid(o, decimals),
    high: roundToGrid(h, decimals),
    low: roundToGrid(l, decimals),
    close: roundToGrid(c, decimals),
    ...(vol !== undefined ? { volume: vol } : {}),
    openBidAsk: p.openPrice ?? undefined,
    highBidAsk: p.highPrice ?? undefined,
    lowBidAsk: p.lowPrice ?? undefined,
    closeBidAsk: p.closePrice ?? undefined,
  };
}

/** Parse a full /prices response body (tolerant of a missing prices array). */
export function parseCapitalPrices(
  body: CapitalHistoricalPricesResponse,
  decimals: number,
): CapitalCandle[] {
  const rows = Array.isArray(body.prices) ? body.prices : [];
  const out: CapitalCandle[] = [];
  for (const row of rows) {
    const candle = parseCapitalPrice(row, decimals);
    if (candle) out.push(candle);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Injected authenticated request — retry/renewal logic lives in client.ts. */
export interface CapitalPricesFetcher {
  getPrices: (
    symbol: string,
    fromMs: number,
    toMs: number,
    max: number,
  ) => Promise<CapitalHistoricalPricesResponse>;
}

/**
 * One bounded window of 1-minute midpoint candles. The CLIENT injects the
 * authenticated request so retry/renewal logic lives in exactly one place
 * (capital/client.ts) — this module stays pure parsing + windowing.
 */
export async function fetchOneMinuteWindow(
  deps: CapitalPricesFetcher,
  symbol: string,
  window: CapitalPriceWindow,
  decimals: number,
  max = CAPITAL_PAGE_SIZE,
): Promise<CapitalCandle[]> {
  if (!(window.toMs > window.fromMs)) return [];
  const body = await deps.getPrices(
    symbol,
    window.fromMs,
    window.toMs,
    Math.min(max, CAPITAL_PAGE_SIZE),
  );
  const candles = parseCapitalPrices(body, decimals);
  // Window-bound the parse (the server may return the enclosing page boundary).
  return candles.filter((c) => c.ts >= window.fromMs && c.ts < window.toMs);
}

/**
 * Progressive forward pagination across an arbitrary range (the Phase 8
 * backfill engine consumes this). Yields bounded pages; the consumer upserts
 * each page BEFORE the next is requested, so a crash resumes from the last
 * persisted bucket with no duplicate rows (UNIQUE (instrument, timeframe,
 * bucket_time) dedups on re-run).
 */
export async function* fetchPricePages(
  deps: CapitalPricesFetcher,
  symbol: string,
  fromMs: number,
  toMs: number,
  windowMs: number,
  decimals: number,
  max = CAPITAL_PAGE_SIZE,
): AsyncGenerator<CapitalCandle[]> {
  if (!(toMs > fromMs)) return;
  if (!(windowMs > 0)) {
    throw new CapitalApiError("internal", 500, "Pagination window must be positive.");
  }
  let cursor = fromMs;
  while (cursor < toMs) {
    const winTo = Math.min(cursor + windowMs, toMs);
    yield await fetchOneMinuteWindow(deps, symbol, { fromMs: cursor, toMs: winTo }, decimals, max);
    cursor = winTo;
  }
}
