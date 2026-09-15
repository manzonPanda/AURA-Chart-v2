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
  /**
   * The band's right AXIS ANCHOR (epoch ms): the first real candle at-or-after
   * the missing interval — always a REGISTERED time point (a real candle),
   * even when the outage abuts a calendar-closed stretch whose buckets are
   * neither candles nor whitespace slots. Exclusive w.r.t. the band: the
   * boundary candle stays outside the shaded region.
   */
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
 * Floor an epoch-ms timestamp to its timeframe bucket-start (epoch ms).
 * Used to bucket-match a candle against a gap interval's start.
 */
function floorToBucketMs(tsMs: number, bucketSec: number): number {
  const bucketMs = bucketSec > 0 ? bucketSec * 1000 : 1000;
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

/**
 * Revalidate gap state against the CURRENT authoritative candle dataset.
 *
 * The REST loader can retain stale gaps after a missing candle is subsequently
 * repaired (backfill/reconciliation): a gap that the previous page reported may
 * now be filled by candles loaded from a newer page. This function rebuilds the
 * gap list against the merged candles so repaired buckets disappear.
 *
 * Rules implemented (forensic §8):
 *  - Rule A/E: a bucket that has an authoritative candle MUST NOT be a DATA GAP.
 *  - Rule B: a gap is only meaningful if it is STRICTLY OLDER than the newest
 *    authoritative closed bucket (the current forming bucket and any unsettled
 *    recent buckets are never shaded).
 *  - Rule C: a backfill that inserts a previously-missing candle drops its gap
 *    (handled by the caller re-running this on every history update).
 *  - Rule D: this only inspects real candles — temporary quote/live state never
 *    generates a gap, so passing a stale live overlay cannot fabricate one.
 *
 * No candles are fabricated: a band is suppressed only, never created here.
 */
export function revalidateGaps(
  gaps: readonly CandleGap[],
  candles: readonly { ts: number }[],
  bucketSec: number,
): CandleGap[] {
  if (gaps.length === 0) return [];
  if (!Number.isFinite(bucketSec) || bucketSec <= 0) return [];

  // Rule A/E buckets: every authoritative candle's bucket-start.
  const presentBuckets = new Set<number>();
  let latestTs = 0;
  for (const c of candles) {
    if (!Number.isFinite(c.ts) || c.ts <= 0) continue;
    presentBuckets.add(floorToBucketMs(c.ts, bucketSec));
    if (c.ts > latestTs) latestTs = c.ts;
  }
  if (presentBuckets.size === 0) return [];

  // Rule B: keep a gap only if it is strictly older than the newest authoritative
  // closed bucket (its start must precede the latest candle's bucket). Gaps at
  // the frontier / forming bucket are suppressed.
  const frontierBucket = floorToBucketMs(latestTs, bucketSec);

  const kept: CandleGap[] = [];
  for (const g of gaps) {
    if (!Number.isFinite(g.startTime) || !Number.isFinite(g.endTime) || g.endTime <= g.startTime) {
      continue; // invalid interval — drop (mergeGapIntervals already filters this too)
    }
    const gapBucket = floorToBucketMs(g.startTime, bucketSec);
    if (presentBuckets.has(gapBucket)) continue; // Rule A: bucket now has a candle
    if (gapBucket >= frontierBucket) continue; // Rule B: at/after the closed frontier
    kept.push(g);
  }
  // Stable, ascending by startTime (matches mergeGapLists sort direction).
  return kept.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Resolve `CandleGap` records against the loaded candles into renderable
 * bands. A band needs real candles on BOTH sides to anchor between — gaps
 * touching the loaded window's edges predate collection (older pages) or
 * extend into the future, and are never shaded.
 *
 * The band's right edge is anchored on the FIRST REAL CANDLE at-or-after the
 * outage — never on the raw interval end. When a gap abuts a calendar-closed
 * stretch (e.g. the US gold daily break after 21:00 UTC), the interval end
 * has neither a candle nor a whitespace slot — it is not registered on the
 * chart's time scale and `timeToCoordinate` would return null for it,
 * silently dropping the band into the compaction fallback (misaligned by
 * half the outage on a whitespace axis). The axis step count from the first
 * missing slot to that candle still equals `spanIndices` (the closed stretch
 * compacts into exactly the one step the final missing bucket would have
 * occupied), so the primitive's `barW = (xe − xs) / spanIndices` stays
 * exactly one bar and both boundary candles stay OUTSIDE the band.
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
  // Rule E (defensive): never band a bucket that is present in the authoritative
  // candle set — a repaired/loaded candle must erase its gap even if the caller
  // did not revalidate beforehand. Build a bucket→present set once.
  const presentBuckets = new Set<number>();
  for (const ts of times) {
    if (Number.isFinite(ts)) presentBuckets.add(Math.floor(ts / bucketMs) * bucketMs);
  }

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
    // Rule E: a gap interval whose bucket now carries an authoritative candle
    // is not a gap — suppress it instead of rendering a misleading band.
    if (presentBuckets.has(Math.floor(g.startTime / bucketMs) * bucketMs)) continue;
    const iL = lastBefore(g.startTime);
    const iR = firstAtOrAfter(g.endTime);
    if (iL < 0 || iR < 0) continue;
    bands.push({
      startMs: g.startTime,
      // Right axis anchor = the FIRST REAL CANDLE at-or-after the outage (a
      // time point always registered on the chart scale). `g.endTime` itself
      // is unregistered when the gap abuts a calendar-closed stretch — see
      // the doc block above. When a candle sits exactly at the gap end (the
      // 9-minute case) this is byte-identical to the previous behavior.
      endMs: candles[iR]!.ts,
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