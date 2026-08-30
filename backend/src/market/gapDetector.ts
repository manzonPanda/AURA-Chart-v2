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
    if (!isBucketExpected(b, opts.calendar)) continue;
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
    if (r.time >= first && r.time < opts.toSec && isBucketExpected(r.time, opts.calendar)) continue;
    report.unexpected.push(r.time);
  }
  report.unexpected.sort((a, b) => a - b);
  return report;
}