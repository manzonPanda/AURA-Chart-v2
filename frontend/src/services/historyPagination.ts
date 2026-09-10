/**
 * Incremental history pagination — PURE helpers (no React, no fetch).
 *
 * Split out so the merge/cursor/viewport/visibility decisions are unit-testable
 * without a chart or DOM, exactly like services/ema.ts and services/replay.ts.
 * The React wiring lives in App.tsx (fetch + state) and TradingChart.tsx
 * (viewport capture/restore + the subtle edge control).
 */
import type { Candle } from "../types/candle";

// ── Merge ────────────────────────────────────────────────────────────────────

export interface MergeOlderResult {
  /** New dataset: strictly-older fetched candles prepended, ascending. */
  merged: Candle[];
  /** How many fetched candles actually extended the dataset. */
  added: number;
}

/**
 * Prepend an older page to the loaded dataset.
 *
 * Guarantees:
 *  - the fetched page is filtered to candles STRICTLY OLDER than
 *    `existingOldestTs` (the cursor the request was made with) — nothing at or
 *    newer than the cursor can sneak in, so the live candle and every newer
 *    bucket are untouched;
 *  - no duplicates (ts-keyed against the existing set AND within the page);
 *  - the result is strictly ascending (Lightweight Charts requirement);
 *  - existing candles are never mutated — a new array is returned.
 */
export function mergeOlderCandles(
  existing: readonly Candle[],
  fetched: readonly Candle[],
  existingOldestTs: number,
): MergeOlderResult {
  const existingTs = new Set(existing.map((c) => c.ts));
  const seen = new Set<number>();
  const older: Candle[] = [];
  for (const c of fetched) {
    if (c.ts >= existingOldestTs) continue; // cursor boundary — already loaded
    if (existingTs.has(c.ts) || seen.has(c.ts)) continue; // duplicate
    seen.add(c.ts);
    older.push(c);
  }
  older.sort((a, b) => a.ts - b.ts);
  return { merged: [...older, ...existing], added: older.length };
}

/** The pagination cursor: the oldest currently-loaded bucket start (epoch ms). */
export function cursorFrom(candles: readonly Candle[]): number | null {
  return candles.length > 0 ? candles[0].ts : null;
}

// ── Request gating ───────────────────────────────────────────────────────────

export interface HistoryStatus {
  loading: boolean;
  exhausted: boolean;
  error: string | null;
}

export const INITIAL_HISTORY_STATUS: HistoryStatus = {
  loading: false,
  exhausted: false,
  error: null,
};

/**
 * Whether a "Load More History" request may start. The loading guard is what
 * makes double-clicks / rapid re-clicks harmless — exactly one in-flight
 * request can ever exist.
 */
export function canLoadMore(status: HistoryStatus, hasCandles: boolean): boolean {
  return hasCandles && !status.loading && !status.exhausted;
}

/** Exhaustion semantics: the backend said there is nothing older, OR the page
 *  contributed zero new candles (idempotent re-click safety). */
export function isExhausted(hasMore: boolean, added: number): boolean {
  return !hasMore || added === 0;
}

// ── Edge-proximity reveal ────────────────────────────────────────────────────

/**
 * True when the visible range's LEFT edge is within `thresholdBars` buckets of
 * the oldest loaded candle — the moment the "Load More History" control should
 * appear. `rangeFromSec` is LWC's visible-range `from` (epoch seconds).
 */
export function isNearHistoryEdge(
  rangeFromSec: number,
  oldestLoadedSec: number,
  bucketSec: number,
  thresholdBars = 40,
): boolean {
  if (!Number.isFinite(rangeFromSec) || !Number.isFinite(oldestLoadedSec) || oldestLoadedSec <= 0) {
    return false;
  }
  return rangeFromSec <= oldestLoadedSec + thresholdBars * bucketSec;
}

/** Control visibility: never during Replay, never without data, and only near
 *  the historical edge (exhausted shows its terminal state at the edge too). */
export function shouldShowLoadMore(opts: {
  replayActive: boolean;
  exhausted: boolean;
  nearEdge: boolean;
  hasData: boolean;
}): boolean {
  return !opts.replayActive && opts.hasData && opts.nearEdge;
}

// ── Latest-edge detection ─────────────────────────────────────────────────────

/**
 * True when the visible time range is anchored AT the real-time edge (i.e. the
 * user is looking at the most recent candle). `latestSec` MUST be the epoch
 * second of the latest REAL candle (NOT a whitespace slot) so the result is
 * invariant to data gaps/closures — the comparison is against the last candle's
 * bucket start, not the rightmost pixel or a slot count.
 *
 * Mirrors the follow-edge check in TradingChart.tsx's ViewportBridge.onPan so
 * the "Scroll to latest" button and the follow behaviour can never disagree.
 * `range.to` is LWC's visible-range right edge (epoch seconds). `bucketSec` is
 * the active timeframe granularity. We tolerate being up to one bucket short
 * of the latest candle (its own forming bucket hasn't fully closed yet).
 */
export function isAtLatestEdge(
  range: { from: number; to: number } | null,
  latestSec: number,
  bucketSec: number,
): boolean {
  if (!range || !latestSec || !Number.isFinite(latestSec)) return true; // no range / no latest → treat as at edge
  return range.to >= latestSec - bucketSec;
}

/** Control visibility for the "Scroll to latest" button. */
export function shouldShowScrollToLatest(opts: {
  atEdge: boolean;
  replayActive: boolean;
  hasCandles: boolean;
}): boolean {
  return !!opts.hasCandles && !opts.replayActive && !opts.atEdge;
}
