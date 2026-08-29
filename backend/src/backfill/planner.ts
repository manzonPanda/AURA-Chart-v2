/**
 * Stage 3 — backfill PLANNER (pure, no I/O, fully unit-testable).
 *
 * For every 3-minute bucket in [fromSec..toSec] (forming/live bucket always
 * excluded) it decides what — if anything — may be written from IG historical
 * 1-minute data:
 *
 *   missing bucket     → INSERT candidate  (status=backfilled, source=ig_historical)
 *   partial bucket     → REPAIR candidate  (status=backfilled, source=ig_historical)
 *   completed bucket   → PROTECTED — never planned, never overwritten
 *   backfilled bucket  → PROTECTED unless allowBackfilledRepair (--force)
 *   IG data insufficient → UNCOVERED — bucket left EXACTLY as it is
 *
 * Coverage rule (conservative, per design): a bucket is coverable only when IG
 * returned a 1-minute row for ALL THREE of its minutes (b, b+60, b+120). A
 * partial candle is never replaced with an incomplete historical result.
 *
 * Price basis (recorded here, written to `source`): IG historical 1m candles
 * via midPrice() — midTraded preferred, else (bid+ask)/2, else single side —
 * aggregated on the exact floor(ts/180)*180 grid by aggregateToMinutes(), then
 * rounded to 1 decimal to match the live chart's MID convention. Deterministic:
 * identical IG rows → byte-identical plan. The LIVE MID calculation is not
 * involved anywhere in this module.
 */
import { aggregateToMinutes } from "../ig/historical.js";
import { isBucketExpected, type MarketCalendar } from "../market/calendar.js";
import type { PersistedCandle } from "../db/candleStore.js";
import type { Candle } from "../types/candle.js";
import type { CandleStatus } from "../streaming/types.js";

export const BACKFILL_BUCKET_SEC = 180;
export const BACKFILL_SOURCE = "ig_historical";

export interface BackfillPlanInput {
  /** Inclusive bucket-start ceiling of the scan (epoch s, will be grid-aligned). */
  fromSec: number;
  /** Inclusive bucket-start end of the scan (epoch s, grid-aligned). */
  toSec: number;
  /** The currently forming bucket (epoch s) — always excluded, live is sacred. */
  formingBucketSec: number;
  /** IG historical 1-minute candles covering the range (ascending). */
  oneMin: readonly Candle[];
  /** Persisted rows for the same range (any subset — missing buckets simply absent). */
  rows: readonly PersistedCandle[];
  /** --force: also plan repairs of `backfilled` rows (never of `completed`). */
  allowBackfilledRepair?: boolean;
  /** Market calendar — non-trading buckets (weekend/break/holiday) are never
   *  planned, mirroring the Stage-2 gap detector (legitimate closures are not
   *  gaps and must never be backfilled). */
  calendar?: MarketCalendar;
}

export interface PlannedInsert {
  bucketSec: number;
  candle: Candle;
}
export interface PlannedRepair {
  bucketSec: number;
  candle: Candle;
  previousStatus: CandleStatus;
}
export interface BackfillPlan {
  inserts: PlannedInsert[];
  repairs: PlannedRepair[];
  uncovered: { bucketSec: number; reason: "missing" | "partial" }[];
  skippedCompleted: number[];
  skippedBackfilled: number[];
  stats: { oneMinRows: number; expectedBuckets: number };
}

/** Round to 1 decimal — the live chart's MID convention, applied to backfill too. */
const round1 = (v: number): number => Math.round(v * 10) / 10;

function roundCandle(c: Candle): Candle {
  return {
    ts: c.ts,
    open: round1(c.open),
    high: round1(c.high),
    low: round1(c.low),
    close: round1(c.close),
    ...(c.volume !== undefined ? { volume: c.volume } : {}),
  };
}

export function planBackfill(input: BackfillPlanInput): BackfillPlan {
  const plan: BackfillPlan = {
    inserts: [],
    repairs: [],
    uncovered: [],
    skippedCompleted: [],
    skippedBackfilled: [],
    stats: { oneMinRows: input.oneMin.length, expectedBuckets: 0 },
  };

  const bucketSec = BACKFILL_BUCKET_SEC;
  const fromSec = Math.floor(input.fromSec / bucketSec) * bucketSec;
  const toSec = Math.floor(input.toSec / bucketSec) * bucketSec;

  const byBucket = new Map<number, Candle>();
  for (const c of aggregateToMinutes(input.oneMin, 3)) byBucket.set(c.ts, c);
  const oneMinTs = new Set<number>(input.oneMin.map((c) => c.ts));
  const rowsByBucket = new Map<number, PersistedCandle>(input.rows.map((r) => [r.time, r]));

  for (let b = fromSec; b <= toSec; b += bucketSec) {
    if (b >= input.formingBucketSec) break; // never touch the forming/live bucket
    if (input.calendar && !isBucketExpected(b, input.calendar)) continue; // market closed — not a gap
    plan.stats.expectedBuckets += 1;

    // byBucket/oneMinTs are keyed in epoch MS (Candle.ts is ms-based); b is epoch SECONDS.
    const ig = byBucket.get(b * 1000);
    // Full coverage = a 1m row for ALL THREE minutes of the bucket.
    const covered =
      ig !== undefined && [0, 60, 120].every((off) => oneMinTs.has((b + off) * 1000));

    const row = rowsByBucket.get(b);
    const status: CandleStatus = row?.status ?? "completed";

    if (!row) {
      if (covered && ig) plan.inserts.push({ bucketSec: b, candle: roundCandle(ig) });
      else plan.uncovered.push({ bucketSec: b, reason: "missing" });
      continue;
    }
    if (status === "partial") {
      if (covered && ig) {
        plan.repairs.push({ bucketSec: b, candle: roundCandle(ig), previousStatus: status });
      } else {
        plan.uncovered.push({ bucketSec: b, reason: "partial" }); // leave untouched
      }
      continue;
    }
    if (status === "completed") {
      plan.skippedCompleted.push(b); // protected — always
      continue;
    }
    // status === "backfilled": protected unless explicitly forced.
    if (input.allowBackfilledRepair && covered && ig) {
      plan.repairs.push({ bucketSec: b, candle: roundCandle(ig), previousStatus: status });
    } else {
      plan.skippedBackfilled.push(b);
    }
  }
  return plan;
}