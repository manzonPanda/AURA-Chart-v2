/**
 * Market-data gap bands — the pure geometry layer between derived `CandleGap`
 * intervals and the chart's gap-shading primitive (GapRegionsPrimitive.ts).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Positioning contract (the LWC compaction problem):
 *
 * Lightweight Charts compacts missing bars: when 09:30–09:38 are absent from
 * the data, the 09:29 and 09:39 candles become ADJACENT logical indices and
 * NO axis space is reserved for the outage. A band spanning the missing
 * minutes therefore cannot be placed at [iL + 0.5, iR − 0.5] — that is zero
 * pixels wide.
 *
 * Instead each band is ANCHORED at the boundary between the surrounding real
 * candles (logical index `iL + (iR − iL) / 2`) and SIZED by the real missing
 * duration in bar-units (`(endMs − startMs) / bucketMs`). The primitive
 * converts bar-units to pixels with the live bar spacing, so a band always
 * shows the outage's true extent relative to normal candles — compressed by
 * the axis compaction, never widening the axis or creating fake bars.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure + framework-free (Node-testable, no LWC/DOM imports). Gaps are
 * presentation-only metadata: they never enter the candle arrays that feed
 * Pine, the Trading Behavior Engine or persistence.
 */
import type { CandleGap } from "../types/candle.ts";

/** One renderable DATA GAP band in compacted logical-index space. */
export interface GapBand {
  /** Real missing interval start (epoch ms) — kept for labels/debug. */
  startMs: number;
  /** Real missing interval end, exclusive (epoch ms). */
  endMs: number;
  /** Logical index the band is centered on (the 09:29|09:39 boundary). */
  anchorIndex: number;
  /** Band width in bar-units = (endMs − startMs) / bucketMs. */
  spanIndices: number;
}

/**
 * Merge overlapping/touching gap intervals into maximal ascending spans.
 * The backend reports one interval per missing bucket (a 9-minute outage =
 * nine 1-minute intervals); the renderer wants ONE band per outage. Invalid
 * entries (non-finite / inverted) are dropped.
 */
export function mergeGapIntervals(
  gaps: readonly { startTime: number; endTime: number }[],
): { startTime: number; endTime: number }[] {
  const clean = gaps
    .filter((g) => Number.isFinite(g.startTime) && Number.isFinite(g.endTime) && g.endTime > g.startTime)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  const out: { startTime: number; endTime: number }[] = [];
  for (const g of clean) {
    const last = out[out.length - 1];
    // Touching spans (next.startTime <= last.endTime) belong to one outage.
    if (last && g.startTime <= last.endTime) {
      last.endTime = Math.max(last.endTime, g.endTime);
    } else {
      out.push({ startTime: g.startTime, endTime: g.endTime });
    }
  }
  return out;
}

/**
 * Resolve `CandleGap` records against the loaded candles into renderable
 * bands. A band needs real candles on BOTH sides to anchor between — gaps
 * touching the loaded window's edges predate collection (older pages) or
 * extend into the future, and are never shaded.
 *
 * @param candles   ascending candles (only `ts` is read — epoch ms).
 * @param gaps      derived gap intervals (epoch ms).
 * @param bucketSec the chart's bucket width (60 = 1m, 180 = 3m).
 */
export function resolveGapBands(
  candles: readonly { ts: number }[],
  gaps: readonly CandleGap[],
  bucketSec: number,
): GapBand[] {
  if (!Number.isFinite(bucketSec) || bucketSec <= 0 || candles.length === 0) return [];
  const bucketMs = bucketSec * 1000;
  const merged = mergeGapIntervals(gaps);
  if (merged.length === 0) return [];
  const times = candles.map((c) => c.ts);

  // Rightmost index with ts < t (-1 when none).
  const lastBefore = (t: number): number => {
    let lo = 0;
    let hi = times.length - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  };
  // Leftmost index with ts >= t (-1 when none).
  const firstAtOrAfter = (t: number): number => {
    let lo = 0;
    let hi = times.length - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] >= t) {
        res = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return res;
  };

  const bands: GapBand[] = [];
  for (const g of merged) {
    const iL = lastBefore(g.startTime);
    const iR = firstAtOrAfter(g.endTime);
    if (iL < 0 || iR < 0) continue;
    bands.push({
      startMs: g.startTime,
      endMs: g.endTime,
      anchorIndex: iL + (iR - iL) / 2,
      spanIndices: (g.endTime - g.startTime) / bucketMs,
    });
  }
  return bands;
}

/**
 * Merge two gap lists (e.g. the live window's gaps + a freshly loaded older
 * page's gaps) into one deduplicated, ascending list. Two records are the
 * same gap when their exact interval matches.
 */
export function mergeGapLists(a: readonly CandleGap[], b: readonly CandleGap[]): CandleGap[] {
  const seen = new Set<string>();
  const out: CandleGap[] = [];
  for (const g of [...a, ...b]) {
    if (!Number.isFinite(g.startTime) || !Number.isFinite(g.endTime)) continue;
    const key = `${g.startTime}:${g.endTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out.sort((x, y) => x.startTime - y.startTime);
}