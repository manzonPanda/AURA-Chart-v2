import { Hono, type Context } from "hono";
import type { CandleBackend, PersistedCandle } from "../db/candleStore.js";
import { instrumentMetaFor, type InstrumentMeta } from "../market/instruments.js";
import { detectGaps, deriveGapIntervals } from "../market/gapDetector.js";
import { RECONCILE_GRACE_FALLBACK_SEC } from "../backfill/reconcile.js";
import { calendarForInstrument } from "../market/instruments.js";
import type { CandleStatus } from "../streaming/types.js";
import {
  CANONICAL_TIMEFRAME,
  TIMEFRAME_BUCKET_SEC,
  aggregateCompleteToMinutes,
  bucketOf,
  minutesFor,
} from "../streaming/timeframes.js";
import type { Candle } from "../types/candle.js";

/**
   * GET /api/candles/db?epic=<EPIC>&timeframe=MINUTE_1|MINUTE_3&limit=<1..10000>&before=<epoch-sec>
 *
 * Serves chart history from OUR Supabase persistence — the frontend's normal
 * history source. IG REST stays a bootstrap/backfill source only and its
 * allowance errors can never affect this endpoint.
 *
 * Timeframe sourcing under the 1m-only architecture:
 *   - MINUTE_1 → the persisted rows as-is (Supabase stores ONLY completed 1m).
 *   - MINUTE_3 → DERIVED ON READ from persisted 1m candles via
 *     aggregateCompleteToMinutes() — the exact same grid + OHLC rules the
 *     live in-memory overlay uses, so history↔live handoff stays
 *     timestamp-equal. No stored 3m series is consulted or expected.
 *
 * Response shape matches the realtime websocket candle frames (`time` = bucket
 * start, epoch SECONDS, ascending) so it feeds `series.setData()` directly and
 * hands off seamlessly to the live `series.update()` stream.
 */

/** Calendar-aware gap intervals over the loaded candle window (epoch-ms).
 *  Wire shape `{ start, end }` (epoch-MILLISECONDS) — what the frontend's
 *  `fetchCandlesDb()` maps into `CandleGap` records. [] when the instrument
 *  has no registered calendar (never guessed).
 *
 *  SETTLED-BOUNDARY SEMANTICS (2026-09-16 forensic fix): a missing bucket is a
 *  DATA GAP only once the reconciler has had a SUCCESSFUL opportunity to scan
 *  it — i.e. its bucket start is strictly below `settledToSec` (the last
 *  error-free run's EXCLUSIVE scan end). Buckets at/after the boundary are
 *  PENDING reconciliation (Capital DISTINCT OHLC delivery can leave them
 *  absent from PostgreSQL for up to ~18m) and are dropped here, never shaded. */
function gapsForEpic(
  epic: string,
  timesSec: readonly number[],
  bucketSec: number,
  settledToSec: number,
): { start: number; end: number }[] {
  const calendar = calendarForInstrument(epic);
  if (!calendar) return [];
  return filterSettledGaps(
    deriveGapIntervals(timesSec, calendar, bucketSec).map((g) => ({ start: g.startMs, end: g.endMs })),
    settledToSec,
  );
}

/** Source of the reconciler's settled frontier — epoch SECONDS of the last
 *  successful run's EXCLUSIVE scan end, or null when unavailable (reconciler
 *  disabled / no successful run yet). Structurally satisfied by
 *  `CapitalReconciler.settledScanToSec` without a hard dependency. */
export type SettledBoundarySecSource = () => number | null;

/** Resolve the effective settled boundary (epoch SECONDS) for one request:
 *  the reconciler's frontier when available, else the documented 20-minute
 *  reconciliation grace behind the wall clock (RECONCILE_GRACE_FALLBACK_SEC
 *  = safetyLag 3m + interval 15m + 2m slack with default settings). */
export function resolveSettledToSec(
  source: SettledBoundarySecSource | undefined,
  nowMs: number = Date.now(),
): number {
  const fromReconciler = source?.();
  if (typeof fromReconciler === "number" && Number.isFinite(fromReconciler) && fromReconciler > 0) {
    return Math.floor(fromReconciler);
  }
  return Math.floor(nowMs / 1000) - RECONCILE_GRACE_FALLBACK_SEC;
}

/** Keep only gap intervals whose bucket start is STRICTLY below the settled
 *  boundary (`bucket >= settledToSec` ⇒ pending reconciliation ⇒ not a DATA
 *  GAP). Bucket starts and the boundary are minute-aligned, so the strict
 *  comparison is exact: the boundary itself was NOT scanned (detectGaps scans
 *  buckets strictly below its `toSec`). */
export function filterSettledGaps<T extends { start: number }>(gaps: readonly T[], settledToSec: number): T[] {
  return gaps.filter((g) => Number.isFinite(g.start) && Math.floor(g.start / 1000) < settledToSec);
}

/** Load chart-history candles for a timeframe WITHOUT touching IG historical
 *  REST (see the header above). Never reads a stored 3m series.
 *
 *  `beforeSec` (optional) is the history-pagination cursor: only rows strictly
 *  older than it are considered. `hasMore` reports whether the RAW database
 *  page came back full — a full page means older rows may still exist (the
 *  frontend's "Load More History" keeps going while hasMore is true).
 *
 *  Also returns derived gaps — market-data intervals that should have had
 *  candles but don't (broker outages), excluding market closures per calendar. */
async function loadTimeframeCandles(
  store: CandleBackend,
  epic: string,
  timeframe: string,
  limit: number,
  beforeSec?: number,
  settledToSec: number = Math.floor(Date.now() / 1000) - RECONCILE_GRACE_FALLBACK_SEC,
): Promise<{ candles: PersistedCandle[]; hasMore: boolean; gaps: { start: number; end: number }[] }> {
  const minutes = minutesFor(timeframe);

  // Not a whole-minute frame (or 1m itself) → the stored rows are the result.
  if (typeof minutes !== "number" || minutes <= 1) {
        const raw = await store.loadCandles(epic, timeframe, limit, beforeSec);
    const bucketSec = TIMEFRAME_BUCKET_SEC[timeframe] ?? 60;
    const gaps = gapsForEpic(
      epic,
      raw.map((r) => r.time),
      bucketSec,
      settledToSec,
    );
    return { candles: raw, hasMore: raw.length >= limit, gaps };
  }

  // N complete macro candles require N*minutes closed 1m rows; fetch a little
  // head-room so the newest (still-forming) macro bucket can be dropped — it
  // belongs to the live WS overlay, not to history.
  const requested1m = limit * minutes + minutes + 1;
  const raw = await store.loadCandles(epic, CANONICAL_TIMEFRAME, requested1m, beforeSec);
  const oneMin: Candle[] = raw.map((r) => ({
    ts: r.time * 1000,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
  }));

  // Per-bucket aggregates carried alongside OHLC: tickCount = ∑1m tick counts,
  // status = strictest constituent (partial > backfilled > completed).
  const bucketMs = minutes * 60 * 1000;
  const tickSums = new Map<number, number>();
  const statuses = new Map<number, CandleStatus>();
  for (const r of raw) {
    const b = Math.floor((r.time * 1000) / bucketMs) * bucketMs;
    tickSums.set(b, (tickSums.get(b) ?? 0) + (r.tickCount ?? 0));
    const curStatus = r.status ?? "completed";
    const prev = statuses.get(b);
    if (!prev) statuses.set(b, curStatus);
    else if (curStatus === "partial") statuses.set(b, "partial");
    else if (curStatus === "backfilled" && prev === "completed") statuses.set(b, "backfilled");
  }

  const candles = aggregateCompleteToMinutes(oneMin, minutes).map((c) => ({
    time: Math.floor(c.ts / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    tickCount: tickSums.get(c.ts) ?? null,
    ...(statuses.get(c.ts) ? { status: statuses.get(c.ts) } : {}),
  }));
  // Full 1m page ⇒ the table still has older rows (the derived macro count can
  // legitimately be < limit — the last macro bucket may be incomplete).
    const bucketSec = minutes * 60;
  const gaps = gapsForEpic(
    epic,
    candles.map((c) => c.time),
    bucketSec,
    settledToSec,
  );
  return { candles, hasMore: raw.length >= requested1m, gaps };
}

/** Squash groups of stored 1m GapRows into one effective row per macro bucket:
 *  partial if ANY constituent 1m is partial, else backfilled if any is
 *  backfilled, else completed. Buckets with no rows stay absent → reported as
 *  missing by detectGaps. */
function deriveGapRows(
  oneMin: readonly { time: number; status?: CandleStatus }[],
  bucketSec: number,
): { time: number; status?: CandleStatus }[] {
  const out = new Map<number, { time: number; status?: CandleStatus }>();
  for (const r of oneMin) {
    const b = Math.floor(r.time / bucketSec) * bucketSec;
    const cur = out.get(b) ?? { time: b, status: undefined };
    if (r.status === "partial") cur.status = "partial";
    else if (r.status === "backfilled" && cur.status !== "partial") cur.status = "backfilled";
    else if (!cur.status) cur.status = "completed";
    out.set(b, cur);
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}
/** 400 for an EPIC outside the CONFIGURED instrument set — a request with an
 *  arbitrary string must be REJECTED, never silently answered with an empty
 *  dataset (Phase 2). */
function unsupportedEpic(c: Context, epic: string, instruments: readonly InstrumentMeta[]) {
  return c.json(
    {
      error: `Unsupported instrument EPIC "${epic}". Configured instruments: ${instruments.map((i) => i.epic).join(", ")}.`,
      code: "UNSUPPORTED_EPIC",
    },
    400,
  );
}

/**
 * EPIC resolution shared by every /candles/db endpoint: omitted → the
 * configured default (DAX — the historic behavior); explicit → must be a
 * CONFIGURED instrument (else 400). The resolved epic is also the
 * ohlc_candles `instrument` identity every store call is keyed by, so a
 * query can never accidentally read another instrument's candles.
 */
export function createCandlesDbRouter(
  store: CandleBackend | null,
  instruments: readonly InstrumentMeta[],
  defaultEpic: string = instruments[0]?.epic ?? "",
  /** The Capital reconciler's settled frontier — `CapitalReconciler.settledScanToSec`.
   *  Omitted/null ⇒ the 20-minute reconciliation grace fallback is used. */
  settledBoundarySec?: SettledBoundarySecSource,
): Hono {
  const app = new Hono();

  app.get("/candles/db", async (c) => {
    if (!store) {
      return c.json(
        {
          error:
            "Candle persistence is not configured — set AURA_DB_URL (via /etc/aura/postgres.env on the VM) to enable PostgreSQL persistence.",
          code: "DB_NOT_CONFIGURED",
        },
        503,
      );
    }

    const requested = (c.req.query("epic") ?? "").trim();
    const epic = requested || defaultEpic.trim();
    if (!epic) {
      return c.json(
        { error: "No instrument EPIC configured — pass `epic` as a query parameter.", code: "EPIC_MISSING" },
        400,
      );
    }
    if (!instruments.some((i) => i.epic === epic)) {
      return unsupportedEpic(c, epic, instruments);
    }

    const timeframe = (c.req.query("timeframe") ?? CANONICAL_TIMEFRAME).trim().toUpperCase();
    if (!(timeframe in TIMEFRAME_BUCKET_SEC)) {
      return c.json(
        {
          error: `Invalid timeframe "${timeframe}". Supported: ${Object.keys(TIMEFRAME_BUCKET_SEC).join(", ")}`,
          code: "INVALID_TIMEFRAME",
        },
        400,
      );
    }

    const parsedLimit = Number(c.req.query("limit"));
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 2000;

    // History-pagination cursor (epoch SECONDS): only candles STRICTLY older
    // than this bucket start are returned. Omitted → the newest `limit`.
    const parsedBefore = Number(c.req.query("before"));
    const beforeSec =
      Number.isFinite(parsedBefore) && parsedBefore > 0 ? Math.floor(parsedBefore) : undefined;

    try {
      const settledToSec = resolveSettledToSec(settledBoundarySec);
      const { candles, hasMore, gaps } = await loadTimeframeCandles(store, epic, timeframe, limit, beforeSec, settledToSec);
      return c.json({ epic, timeframe, count: candles.length, hasMore, candles, gaps, settledToSec });
    } catch (err) {
      return c.json(
        {
          error: `Failed to load persisted candles: ${err instanceof Error ? err.message : String(err)}`,
          code: "DB_LOAD_FAILED",
        },
        500,
      );
    }
  });

  /**
   * GET /api/candles/db/gaps?epic=<EPIC>&timeframe=MINUTE_1|MINUTE_3&hours=<1..240>
   *
   * Stage 2 (read-only): classifies expected market buckets for the requested
   * timeframe as missing / partial / completed. The scan always runs over the
   * CANONICAL persisted 1m rows:
   *   - MINUTE_1 → the 60 s grid directly (the persisted truth);
   *   - MINUTE_3 → the 180 s grid via deriveGapRows() (one effective row per
   *     3m bucket from its constituent 1m rows — partial if any sub-1m is
   *     partial, else backfilled, else completed; absent buckets are missing).
   * Market closures (weekends, breaks, holidays) are never reported as
   * missing — the REQUESTED instrument's OWN calendar decides "expected"
   * (DAX → IG_GERMANY_40, Spot Gold → IG_SPOT_GOLD). No rows are created;
   * bucket times are UTC ISO (the chart displays Asia/Manila separately).
   * The still-forming bucket is always excluded.
   */
  app.get("/candles/db/gaps", async (c) => {
    if (!store) {
      return c.json({ error: "Candle persistence is not configured.", code: "DB_NOT_CONFIGURED" }, 503);
    }
    const requested = (c.req.query("epic") ?? "").trim();
    const epic = requested || defaultEpic.trim();
    if (!epic) {
      return c.json(
        { error: "No instrument EPIC configured — pass `epic` as a query parameter.", code: "EPIC_MISSING" },
        400,
      );
    }
    if (!instruments.some((i) => i.epic === epic)) {
      return unsupportedEpic(c, epic, instruments);
    }
    const timeframe = (c.req.query("timeframe") ?? "MINUTE_1").trim().toUpperCase();
    if (!(timeframe in TIMEFRAME_BUCKET_SEC)) {
      return c.json(
        {
          error: `Invalid timeframe "${timeframe}". Supported: ${Object.keys(TIMEFRAME_BUCKET_SEC).join(", ")}`,
          code: "INVALID_TIMEFRAME",
        },
        400,
      );
    }

    const parsedHours = Number(c.req.query("hours"));
    const hours = Number.isFinite(parsedHours) ? Math.min(240, Math.max(1, parsedHours)) : 6;

    try {
      const bucketSec = TIMEFRAME_BUCKET_SEC[timeframe];
      // Gap detection always reads the canonical persisted 1m rows; the macro
      // view squashes them per bucket below.
      const rows = await store.loadCandles(epic, CANONICAL_TIMEFRAME, 5000);
      const effectiveRows = timeframe === CANONICAL_TIMEFRAME ? rows : deriveGapRows(rows, bucketSec);

      const nowSec = Math.floor(Date.now() / 1000);
      const formingBucket = bucketOf(nowSec * 1000, bucketSec);
      // Scan from the newer of (lookback window start, oldest persisted row) —
      // buckets older than our earliest row predate collection and are not
      // "missing"; they are simply uncollected (future backfill territory).
      const oldestRow = effectiveRows.length > 0 ? effectiveRows[0].time : formingBucket;
      const fromSec = Math.max(Math.ceil((nowSec - hours * 3600) / bucketSec) * bucketSec, oldestRow);

      // The REQUESTED instrument's OWN calendar decides "expected" — DAX uses
      // IG_GERMANY_40, Spot Gold uses IG_SPOT_GOLD. Never another market's
      // hours: a calendar-less EPIC is refused rather than guessed.
      const calendar = instrumentMetaFor(epic).calendar;
      if (!calendar) {
        return c.json(
          {
            error: `No market calendar is registered for "${epic}" — gap detection needs dealing hours and must not guess another market's.`,
            code: "NO_MARKET_CALENDAR",
          },
          400,
        );
      }
      const report = detectGaps(effectiveRows, {
        fromSec,
        toSec: formingBucket,
        calendar,
        bucketSec,
      });
      // Settled-boundary protection (same semantics as /candles/db): buckets at
      // or after the reconciler's last successful scan end are PENDING
      // reconciliation — Capital DISTINCT delivery may simply not have reached
      // PostgreSQL yet — so they are never reported as missing DATA GAPs here.
      const settledToSec = resolveSettledToSec(settledBoundarySec);
      const settledMissing = report.missing.filter((b) => b < settledToSec);
      const iso = (secs: number[]): string[] =>
        secs.slice(0, 500).map((s) => new Date(s * 1000).toISOString());

      return c.json({
        epic,
        timeframe,
        bucketSec,
        settledToSec,
        range: {
          from: new Date(fromSec * 1000).toISOString(),
          to: new Date(formingBucket * 1000).toISOString(),
          hours,
          formingBucketExcluded: new Date(formingBucket * 1000).toISOString(),
          settledToExcluded: new Date(settledToSec * 1000).toISOString(),
        },
        market: {
          calendar: calendar.id,
          label: calendar.label,
          timezone: calendar.timezone,
          closedDatesCount: calendar.closedDates.length,
        },
        summary: {
          expectedBuckets: report.expectedBuckets,
          missing: settledMissing.length,
          pendingReconciliation: report.missing.length - settledMissing.length,
          partial: report.partial.length,
          completed: report.completed.length,
          backfilled: report.backfilled.length,
          unexpectedRows: report.unexpected.length,
          truncated: settledMissing.length > 500 || report.partial.length > 500,
        },
        missing: iso(settledMissing),
        partial: iso(report.partial),
        unexpected: iso(report.unexpected),
      });
    } catch (err) {
      return c.json(
        { error: `Gap detection failed: ${err instanceof Error ? err.message : String(err)}`, code: "DB_LOAD_FAILED" },
        500,
      );
    }
  });

  return app;
}