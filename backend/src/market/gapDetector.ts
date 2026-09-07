import type { CandleStatus } from "../streaming/types.js";
import { isBucketExpected, type MarketCalendar } from "./calendar.js";

/**
 * Pure gap detection over an epoch bucket grid (Stage 2 — read-only).
 *
 * Consumes persisted candle rows (bucket start epoch-seconds + status) for ONE
 * (instrument, timeframe) and classifies every EXPECTED market bucket in
 * [fromSec, toSec) as:
 *
 *   missing    — expected bucket, no row
 *   partial    — expected bucket, row with status 'partial' (Stage 1 anchor rule)
 *   completed  — expected bucket, row with status 'completed' or 'backfilled'
 *                (backfilled rows satisfy the requirement; source tracked separately)
 *
 * Rows OUTSIDE expected buckets/outside the range are `unexpected`
 * (informational only — never treated as errors). The forming bucket is
 * excluded by the caller via `toSec`. Weekend/break/holiday buckets are simply
 * never expected (see calendar.ts) — legitimate closures are invisible.
 *
 * `bucketSec` is now explicit (the caller passes the timeframe grid: 60 for the
 * canonical MINUTE_1 rows, 180 for the MINUTE_3 view). The 180 default is kept
 * only as a legacy fallback for existing offline tests.
 */
export interface GapRow {
  time: number;
  status?: CandleStatus | string;
}

export interface GapOptions {
  fromSec: number;
  /** Exclusive upper bound — pass the forming bucket start to exclude it. */
  toSec: number;
  calendar: MarketCalendar;
  bucketSec?: number;
}

export interface GapReport {
  missing: number[];
  partial: number[];
  completed: number[];
  backfilled: number[];
  unexpected: number[];
  /** Expected (market-open) buckets scanned — missing+partial+completed+backfilled. */
  expectedBuckets: number;
}

export function detectGaps(rows: readonly GapRow[], opts: GapOptions): GapReport {
  const bucketSec = opts.bucketSec ?? 180;
  const byTime = new Map<number, GapRow>();
  for (const r of rows) byTime.set(r.time, r);

  const report: GapReport = {
    missing: [], partial: [], completed: [], backfilled: [], unexpected: [], expectedBuckets: 0,
  };

  const first = Math.ceil(opts.fromSec / bucketSec) * bucketSec;
  for (let b = first; b < opts.toSec; b += bucketSec) {
    if (!isBucketExpected(b, opts.calendar, bucketSec)) continue;
    report.expectedBuckets += 1;
    const row = byTime.get(b);
    if (!row) {
      report.missing.push(b);
      continue;
    }
    if (row.status === "partial") report.partial.push(b);
    else if (row.status === "backfilled") report.backfilled.push(b);
    else report.completed.push(b); // 'completed' or unknown → treat as filled
  }

  // Rows outside the expected grid or outside the scanned range: informational.
  for (const r of rows) {
    if (r.time >= first && r.time < opts.toSec && isBucketExpected(r.time, opts.calendar, bucketSec)) continue;
    report.unexpected.push(r.time);
  }
  report.unexpected.sort((a, b) => a - b);
  return report;
}

/** One renderable market-data gap: [startMs, endMs) on the candle bucket grid. */
export interface GapInterval {
  /** Missing bucket START in epoch-MILLISECONDS (matches the frontend Candle.ts base). */
  startMs: number;
  /** Exclusive end = startMs + bucketSec * 1000. */
  endMs: number;
}

/**
 * Derive chart-renderable gap INTERVALS from candle times + a market calendar.
 *
 * Companion to {@link detectGaps}: where detectGaps classifies every expected
 * bucket for REPORTING, this walks the loaded candle window and returns only
 * the MISSING expected buckets as `[startMs, endMs)` intervals — the exact
 * shape the chart needs to shade a "DATA GAP" region. No synthetic candles are
 * created; the intervals are derived, read-only metadata.
 *
 * Scan bounds:
 *   - from the OLDEST loaded candle (buckets older than the loaded window
 *     predate collection — pagination territory, never reported here);
 *   - to `min(newestLoadedBucket, formingBucketExclusive)` so the still-forming
 *     live bucket is never shaded (it belongs to the realtime WS overlay).
 *     `opts.toSec` overrides the forming-bucket bound (tests / replay).
 *
 * Weekend/break/holiday buckets are simply never expected (calendar decides),
 * so legitimate market closures produce NO intervals — only genuine broker/feed
 * outages during expected trading time are reported.
 *
 * Pure (calendar injected — no epic/store coupling) and framework-free, so it
 * is directly unit-testable without Hono or Supabase.
 */
export function deriveGapIntervals(
  candleTimesSec: readonly number[],
  calendar: MarketCalendar,
  bucketSec: number,
  opts?: { toSec?: number },
): GapInterval[] {
  if (bucketSec <= 0 || candleTimesSec.length === 0) return [];

  const present = new Set<number>();
  for (const t of candleTimesSec) {
    if (!Number.isFinite(t) || t <= 0) continue;
    present.add(Math.floor(t / bucketSec) * bucketSec);
  }
  if (present.size === 0) return [];
  const times = [...present].sort((a, b) => a - b);

  const formingBucket = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec;
  const toSec = opts?.toSec ?? formingBucket;
  const last = Math.min(times[times.length - 1], toSec - bucketSec);

  const gaps: GapInterval[] = [];
  for (let b = times[0]; b <= last; b += bucketSec) {
    if (present.has(b)) continue;
    if (!isBucketExpected(b, calendar, bucketSec)) continue;
    gaps.push({ startMs: b * 1000, endMs: (b + bucketSec) * 1000 });
  }
  return gaps;
}