/**
 * TIME-SCALE WHITESPACE — IG-style empty horizontal time for detected
 * market-data gaps.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Purpose & boundary (the REAL/WHITESPACE separation):
 *
 * Lightweight Charts compacts missing bars: when 21:30–21:38 PH are absent
 * from the data, the 21:29 and 21:39 candles become ADJACENT logical indices
 * and NO axis space is reserved for the outage. `WhitespaceData` rows
 * registered through a dedicated INVISIBLE series establish the missing
 * timestamps as real time-scale slots — empty horizontal time with no OHLC —
 * so the axis, grid lines, crosshair and time-anchored drawings behave like
 * the IG platform.
 *
 * This module is PURE presentation metadata:
 *   - never mutates the real candle array (inputs are only read);
 *   - emits NO OHLC anywhere (slots are time-only; the invisible series is
 *     never rendered, so its anchor closes cannot affect any visual);
 *   - derives slots ONLY from backend-confirmed `CandleGap` intervals (the
 *     market calendar) — weekends / closed sessions are never invented here;
 *   - is consumed ONLY by the chart layer (WhitespaceBridge → an invisible
 *     LWC series, GapRegionsPrimitive geometry, Pine drawing remapping).
 *     Pine, EMA/SMA, the Trading Behavior Engine, replay and persistence
 *     keep seeing REAL candles only.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { CandleGap } from "../types/candle.ts";
import { mergeGapIntervals } from "./gapRegions.ts";

/** One real candle bounding a gap — anchor row for the invisible series. */
export interface WhitespaceAnchor {
  /** Real candle open time (epoch ms). */
  time: number;
  /** The real candle's close — series payload only (series is invisible). */
  value: number;
}

/** Pure whitespace plan for one chart dataset (immutable by contract). */
export interface WhitespacePlan {
  /** Ascending, deduped, OHLC-FREE bucket-start timestamps (epoch ms). */
  slots: readonly number[];
  /** Ascending real-candle anchors bounding the gaps (deduped by time). */
  anchors: readonly WhitespaceAnchor[];
}

/** Rightmost index with ts < t, or -1 when none. */
function lastBefore(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

/** Leftmost index with ts >= t, or -1 when none. */
function firstAtOrAfter(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! >= t) {
      res = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return res;
}

/** Whether a REAL candle exists exactly at bucket-start `t`. */
function hasCandleAt(times: readonly number[], t: number): boolean {
  const i = firstAtOrAfter(times, t);
  return i >= 0 && times[i] === t;
}

/** Count whitespace slots strictly before time `t` (slots ascending). */
function countSlotsBefore(slots: readonly number[], t: number): number {
  let lo = 0;
  let hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Build the whitespace plan for the loaded candles + derived gaps.
 *
 * For every merged gap interval the plan adds one OHLC-free slot per expected
 * bucket strictly between the bounding REAL candles (a gap touching the
 * loaded window's edge has no bounding candle on one side and contributes
 * nothing — same both-sides rule as `resolveGapBands`). Real candles always
 * win: a slot whose timestamp already has a real candle is never emitted, so
 * the plan can never duplicate a time point.
 *
 * @param candles   ascending real candles (ts + close are read; never mutated)
 * @param gaps      backend-derived gap intervals (epoch ms, may be unsorted)
 * @param bucketSec the chart's bucket width (60 = 1m, 180 = 3m)
 */
export function buildWhitespacePlan(
  candles: readonly { ts: number; close: number }[],
  gaps: readonly CandleGap[],
  bucketSec: number,
): WhitespacePlan {
  if (!Number.isFinite(bucketSec) || bucketSec <= 0 || candles.length === 0) {
    return { slots: [], anchors: [] };
  }
  const bucketMs = bucketSec * 1000;
  const merged = mergeGapIntervals(gaps);
  if (merged.length === 0) return { slots: [], anchors: [] };
  const times = candles.map((c) => c.ts);

  const slotSet = new Set<number>();
  const anchors = new Map<number, WhitespaceAnchor>();
  for (const g of merged) {
    const iL = lastBefore(times, g.startTime);
    const iR = firstAtOrAfter(times, g.endTime);
    if (iL < 0 || iR < 0) continue; // needs real candles on BOTH sides
    const left = candles[iL]!;
    const right = candles[iR]!;
    // Expected buckets strictly inside the outage, snapped to the bucket grid
    // and never reaching past the right bounding candle. For the canonical
    // outage 21:29 | 21:30…21:38 missing | 21:39 this emits 21:30–21:38 —
    // never 21:29 or 21:39 (both are real candles).
    const firstSlot = Math.ceil(g.startTime / bucketMs) * bucketMs;
    const lastSlotExclusive = Math.min(g.endTime, right.ts);
    const before = slotSet.size;
    for (let t = firstSlot; t < lastSlotExclusive; t += bucketMs) {
      if (!Number.isFinite(t) || t <= left.ts) break; // defensive / past left edge
      if (hasCandleAt(times, t)) continue; // real candle wins — never duplicated
      slotSet.add(t);
    }
    // Anchor the invisible series only for gaps that actually produced
    // whitespace — a gap interval whose buckets are all real candles needs
    // no time-scale repair, so its bounding candles stay untouched.
    if (slotSet.size > before) {
      anchors.set(left.ts, { time: left.ts, value: left.close });
      anchors.set(right.ts, { time: right.ts, value: right.close });
    }
  }
  return {
    slots: [...slotSet].sort((a, b) => a - b),
    anchors: [...anchors.values()].sort((a, b) => a.time - b.time),
  };
}

/**
 * Map a Piner ENGINE logical index (real-candle space — holes compacted) to
 * the CHART logical index (whitespace slots inserted) for drawing anchors.
 *
 * With whitespace the chart's logical of the first candle after a 9-slot gap
 * is engine index + 9; without whitespace (or for indexes before the first
 * real candle, where no whitespace can exist) the mapping is identity.
 * Fractional logicals (the 14335fa in-gap interpolation) distribute linearly
 * across the hole's slots — matching LWC's uniform bar spacing.
 *
 * @param logical     engine-space logical (integer for xloc.bar_index, the
 *                    14335fa fractional value for xloc.bar_time)
 * @param candleTimes ascending real-candle open times (epoch ms) — the SAME
 *                    series the engine ran on
 * @param slots       the plan's whitespace slots (ascending)
 */
export function remapLogicalToChart(
  logical: number,
  candleTimes: readonly number[],
  slots: readonly number[],
): number {
  const n = candleTimes.length;
  if (n === 0 || slots.length === 0 || !Number.isFinite(logical)) return logical;
  if (logical < 0) return logical; // before the first real candle: no whitespace exists there
  if (logical >= n) return logical + slots.length; // future extension past the last bar
  const i = Math.floor(logical);
  const frac = logical - i;
  const left = i + countSlotsBefore(slots, candleTimes[i]!);
  if (i + 1 >= n) return left + frac;
  const right = i + 1 + countSlotsBefore(slots, candleTimes[i + 1]!);
  return left + frac * (right - left);
}

