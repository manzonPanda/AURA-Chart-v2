/**
 * The single source of truth for AURA chart timeframes.
 *
 *   timeframe → bucket width in SECONDS (pure epoch grid: floor(ts/bucketSec)*bucketSec)
 *
 * PERSISTENCE RULE (the new architecture):
 *   Supabase `ohlc_candles` stores ONLY completed MINUTE_1 candles
 *   (`CANONICAL_TIMEFRAME`) — nothing else is ever written for the live DAX/IG
 *   stream. Every larger timeframe (MINUTE_3 today; 5m/15m/30m/1H for CandleKit
 *   replay later) is either:
 *     1. derived ON READ from persisted 1m rows via {@link aggregateCompleteToMinutes}
 *        (GET /api/candles/db history), and/or
 *     2. aggregated IN MEMORY from the same live tick fan-out (the WebSocket
 *        forming-candle overlay — never persisted, never a stored series).
 *
 * Adding a future timeframe = add one row here + (optionally) a “load N*k 1m
 * rows and aggregateCompleteToMinutes” branch in routes/candlesDb.ts — nothing
 * in the streaming layer, the schema, or the store needs to change.
 */
import { aggregateToMinutes } from "../ig/historical.js";
import type { Candle } from "../types/candle.js";

/** timeframe → bucket start width in seconds. THE registry. */
export const TIMEFRAME_BUCKET_SEC: Readonly<Record<string, number>> = {
  /**
   * The only PERSISTED timeframe — canonical historical data for the live
   * DAX/IG stream. Backend aggregates ticks into a 60 s bucket and upserts
   * the COMPLETED candle to Supabase.
   */
  MINUTE_1: 60,
  /**
   * Live in-memory overlay + history derived from persisted 1m candles. Never
   * persisted, never requested from IG separately, never stored as a series.
   */
  MINUTE_3: 180,
};

/** The canonical persisted timeframe — the ONLY one written to ohlc_candles. */
export const CANONICAL_TIMEFRAME: string = "MINUTE_1";

/** All live-streamed timeframes (registry keys, stable order). */
export const STREAM_TIME_FRAMES: readonly string[] = Object.keys(TIMEFRAME_BUCKET_SEC);

/** Whole-minute width of a timeframe (3 → “3 minute”), undefined otherwise. */
export function minutesFor(timeframe: string): number | undefined {
  const sec = TIMEFRAME_BUCKET_SEC[timeframe];
  return typeof sec === "number" && sec % 60 === 0 ? sec / 60 : undefined;
}

/** The timeframe key for a whole-minute width (MINUTE_1/MINUTE_3/… generic). */
export function timeframeForMinutes(minutes: number): string {
  if (minutes === 1) return "MINUTE_1";
  if (minutes === 3) return "MINUTE_3";
  return `MINUTE_${minutes}`;
}

/** True only for the canonical persisted timeframe. */
export function isPersistedTimeframe(timeframe: string): boolean {
  return timeframe === CANONICAL_TIMEFRAME;
}

/** Epoch bucket START (seconds) for an epoch-ms instant on a frame’s grid. */
export function bucketOf(epochMs: number, bucketSec: number): number {
  return Math.floor(epochMs / 1000 / bucketSec) * bucketSec;
}

/** Human UI label: “1m” / “3m”. */
export function timeframeLabel(timeframe: string): string {
  const minutes = minutesFor(timeframe);
  return typeof minutes === "number" ? `${minutes}m` : timeframe;
}

/**
 * Aggregate COMPLETED 1m candles into a larger whole-minute timeframe, reusing
 * the EXACT grid + OHLC rules of aggregateToMinutes (the tested live/history
 * aggregation — open=first open, high=max high, low=min low, close=last
 * close, volume=∑):
 *
 *   09:00 1m + 09:01 1m + 09:02 1m  →  09:00 3m
 *   09:03 + 09:04 + 09:05           →  09:03 3m
 *
 * Only buckets with a FULL set of underlying 1m rows are returned. A trailing
 * bucket with < `minutes` rows is still forming (the live WS overlay owns it);
 * incomplete head/gapped buckets are omitted too, so a partially-covered
 * window never masquerades as a complete larger candle. `oneMin` must be
 * ascending epoch-ms candles (Candle.ts convention).
 */
export function aggregateCompleteToMinutes(oneMin: readonly Candle[], minutes: number): Candle[] {
  const bucketMs = minutes * 60 * 1000;
  const counts = new Map<number, number>();
  for (const c of oneMin) {
    const b = Math.floor(c.ts / bucketMs) * bucketMs;
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return aggregateToMinutes(oneMin, minutes).filter((c) => (counts.get(c.ts) ?? 0) === minutes);
}