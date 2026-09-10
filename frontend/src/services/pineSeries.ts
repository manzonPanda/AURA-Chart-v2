/**
 * Authoritative Pine candle series — the SINGLE conversion of AURA's chart truth
 * (closed bars + forming WS candle) into the full-OHLCV series the Pine engine
 * consumes. Pure + framework-free (worker-safe, Node-testable; no engine /
 * DOM imports).
 *
 * The close stream reuses `effectiveCloseSeries` so any indicator fed to Pine
 * sees byte-for-byte the same closes as AURA's ema.ts oracle. Open/high/low/
 * volume ride along so OHLC-dependent scripts (atr, …) get real data; when a
 * bar is missing from the by-ts map (replay / history gaps) its own close fills
 * open/high/low so Pine's history math never sees holes.
 */
import { effectiveCloseSeries, type EmaSourceBar } from "./ema.ts";

/** Full-OHLCV candle Pine engines consume — bucket start in epoch ms. */
export interface PineCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/** Minimal closed-bar shape the builder consumes (structural subset of `Bar`). */
export interface PineSeriesBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Forming WS candle (bucket start in epoch SECONDS, AURA realtime shape). */
export interface PineSeriesLiveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * Merge historical candles + closed-live-bucket ledger + forming candle into the
 * single authoritative bar series the indicator bridges feed to Pine/EMA/SMA.
 *
 * WHY THIS EXISTS:
 *   App's `candles` history state is only refreshed on history load / timeframe
 *   switch / refresh. Live rollovers, however, are painted by LiveBarBridge
 *   directly into the CandleKit controller — they NEVER flow back into the React
 *   `candles` array. Without this merge, bridges receive
 *     [historical bars] + [single forming candle]
 *   and every live bucket that closed AFTER the last history load silently
 *   vanishes from the Pine input, so EMA/EMA/SMA diverge from TradingView and
 *   appear stale. This function reconstructs the complete series.
 *
 *   - `historical` = App's loaded candles (already bucket-aligned, epoch ms ts).
 *   - `closedLive` = ledger of live buckets that have closed since the last
 *     history load (captured by TradingChart on each rollover).
 *   - `forming`  = latest forming WS candle (bucket start, epoch s) | null.
 *
 * Merge rules (same semantics as effectiveCloseSeries in ema.ts):
 *   - same bucket ts → real/latest candle wins (server truth replaces)
 *   - strictly ascending ts
 *   - no duplicate timestamps
 *   - forming candle is appended LAST
 *
 * Pure + framework-free (no React/DOM/engine imports) — unit-testable.
 */
export function mergeBridgeBars(
  historical: readonly PineSeriesBar[],
  closedLive: readonly PineSeriesBar[],
  forming: PineSeriesLiveCandle | null,
  bucketSec: number,
): PineSeriesBar[] {
  const bucketMs = bucketSec > 0 ? bucketSec * 1000 : 1000;
  const out: PineSeriesBar[] = [];
  const seen = new Set<number>();

  // Historical first — preserves original order, these are already sorted.
  for (const b of historical) {
    if (!seen.has(b.ts)) {
      seen.add(b.ts);
      out.push(b);
    }
  }
  // Then closed-live ledger — newer than history by construction.
  for (const b of closedLive) {
    if (!seen.has(b.ts)) {
      seen.add(b.ts);
      out.push(b);
    }
  }
  // Then the forming candle — replaced in place if its bucket ts already exists
  // (it shouldn't in live mode, but the guard keeps this race-free), else appended.
  if (forming && Number.isFinite(forming.time)) {
    const liveBucketTs = Math.floor((forming.time * 1000) / bucketMs) * bucketMs;
    const idx = out.findIndex((b) => b.ts === liveBucketTs);
    if (idx >= 0) {
      out[idx] = { ts: liveBucketTs, open: forming.open, high: forming.high, low: forming.low, close: forming.close, volume: forming.volume };
    } else {
      out.push({ ts: liveBucketTs, open: forming.open, high: forming.high, low: forming.low, close: forming.close, volume: forming.volume });
    }
  }
  return out;
}

/**
 * Build the authoritative, full-OHLCV candle series for the Pine engine from the
 * chart's closed bars + the forming WS candle, REUSING `effectiveCloseSeries`
 * so the close stream feeding indicators is identical to ema.ts.
 */
export function buildAuthoritativeSeries(
  bars: readonly PineSeriesBar[],
  live: PineSeriesLiveCandle | null,
  bucketSec: number,
): PineCandle[] {
  const bucketMs = bucketSec * 1000;
  const closes = effectiveCloseSeries(
    bars as readonly EmaSourceBar[],
    live ? { time: live.time, close: live.close } : null,
    bucketSec,
  );
  const byTs = new Map<number, PineSeriesBar>();
  for (const b of bars) byTs.set(b.ts, b);
  const liveBucketTs = live ? Math.floor((live.time * 1000) / bucketMs) * bucketMs : null;

  const out: PineCandle[] = [];
  for (const m of closes) {
    const bar = byTs.get(m.ts);
    if (live && liveBucketTs === m.ts) {
      out.push({
        openTime: m.ts,
        open: live.open,
        high: live.high,
        low: live.low,
        close: m.close,
        volume: live.volume ?? 0,
        closeTime: m.ts + bucketMs,
      });
    } else if (bar) {
      out.push({
        openTime: bar.ts,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: m.close,
        volume: bar.volume ?? 0,
        closeTime: bar.ts + bucketMs,
      });
    } else {
      out.push({
        openTime: m.ts,
        open: m.close,
        high: m.close,
        low: m.close,
        close: m.close,
        volume: 0,
        closeTime: m.ts + bucketMs,
      });
    }
  }
  return out;
}

/**
 * Compact, exact fingerprint of the authoritative close stream. A cache hit
 * whenever the series is unchanged — so the engines never re-run for a
 * stale/rAF frame that didn't move the authoritative close.
 *
 * FNV-1a over the precise `"ts,close"` text of every candle (no float
 * truncation) plus length and end-points, so a collision is practically
 * impossible.
 */
export function dataSignature(series: readonly PineCandle[]): string {
  let h = 2166111748;
  for (let i = 0; i < series.length; i++) {
    const c = series[i];
    const s = `${c.openTime},${c.close}`;
    for (let j = 0; j < s.length; j++) {
      h = Math.imul(h ^ s.charCodeAt(j), 16777619);
    }
  }
  const first = series[0];
  const last = series[series.length - 1];
  return (
    `${series.length}|` +
    `f=${first?.openTime ?? 0}:${first?.close ?? 0}|` +
    `l=${last?.openTime ?? 0}:${last?.close ?? 0}|` +
    `h=${(h >>> 0).toString(36)}`
  );
}

/** FNV-1a fingerprint of a source string — distinguishes edited scripts in caches. */
export function sourceSignature(source: string): string {
  let h = 2166111748;
  for (let i = 0; i < source.length; i++) {
    h = Math.imul(h ^ source.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(36) + ":" + source.length.toString(36);
}