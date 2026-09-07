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