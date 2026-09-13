/**
 * Provider-NEUTRAL candle aggregation. NO IG/Capital knowledge lives here.
 *
 * `aggregateToMinutes` was historically hosted inside the IG module; it is a
 * pure function on the shared `Candle` shape and is consumed by the ACTIVE
 * runtime (timeframes.ts → /api/candles/db derivation). It therefore lives in
 * its own module under streaming/ so the IG provider module could be removed
 * without disturbing the derivation pipeline.
 */
import type { Candle } from "../types/candle.js";

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
