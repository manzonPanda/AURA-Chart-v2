import { Hono, type Context } from "hono";
import type { CandleStore, PersistedCandle } from "../db/candleStore.js";
import { instrumentMetaFor, type InstrumentMeta } from "../market/instruments.js";
import { detectGaps } from "../market/gapDetector.js";
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
 * GET /api/candles/db?epic=<EPIC>&timeframe=MINUTE_1|MINUTE_3&limit=<1..5000>
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

/** Load chart-history candles for a timeframe WITHOUT touching IG historical
 *  REST (see the header above). Never reads a stored 3m series. */
async function loadTimeframeCandles(
  store: CandleStore,
  epic: string,
  timeframe: string,
  limit: number,
): Promise<PersistedCandle[]> {
  const minutes = minutesFor(timeframe);

  // Not a whole-minute frame (or 1m itself) → the stored rows are the result.
  if (typeof minutes !== "number" || minutes <= 1) {
    return store.loadCandles(epic, timeframe, limit);
  }

  // N complete macro candles require N*minutes closed 1m rows; fetch a little
  // head-room so the newest (still-forming) macro bucket can be dropped — it
  // belongs to the live WS overlay, not to history.
  const raw = await store.loadCandles(epic, CANONICAL_TIMEFRAME, limit * minutes + minutes + 1);
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

  return aggregateCompleteToMinutes(oneMin, minutes).map((c) => ({
    time: Math.floor(c.ts / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    tickCount: tickSums.get(c.ts) ?? null,
    ...(statuses.get(c.ts) ? { status: statuses.get(c.ts) } : {}),
  }));
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
  store: CandleStore | null,
  instruments: readonly InstrumentMeta[],
  defaultEpic: string = instruments[0]?.epic ?? "",
): Hono {
  const app = new Hono();

  app.get("/candles/db", async (c) => {
    if (!store) {
      return c.json(
        {
          error:
            "Candle persistence is not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in backend/.env.",
          code: "DB_NOT_CONFIGURED",
        },
        503,
      );
    }

    const requested = (c.req.query("epic") ?? "").trim();
    const epic = requested || defaultEpic.trim();
    if (!epic) {
      return c.json(
        { error: "No instrument EPIC configured — set IG_DAX_EPIC or pass `epic`.", code: "EPIC_MISSING" },
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
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 500;

    try {
      const candles = await loadTimeframeCandles(store, epic, timeframe, limit);
      return c.json({ epic, timeframe, count: candles.length, candles });
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
        { error: "No instrument EPIC configured — set IG_DAX_EPIC or pass `epic`.", code: "EPIC_MISSING" },
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
      const iso = (secs: number[]): string[] =>
        secs.slice(0, 500).map((s) => new Date(s * 1000).toISOString());

      return c.json({
        epic,
        timeframe,
        bucketSec,
        range: {
          from: new Date(fromSec * 1000).toISOString(),
          to: new Date(formingBucket * 1000).toISOString(),
          hours,
          formingBucketExcluded: new Date(formingBucket * 1000).toISOString(),
        },
        market: {
          calendar: calendar.id,
          label: calendar.label,
          timezone: calendar.timezone,
          closedDatesCount: calendar.closedDates.length,
        },
        summary: {
          expectedBuckets: report.expectedBuckets,
          missing: report.missing.length,
          partial: report.partial.length,
          completed: report.completed.length,
          backfilled: report.backfilled.length,
          unexpectedRows: report.unexpected.length,
          truncated: report.missing.length > 500 || report.partial.length > 500,
        },
        missing: iso(report.missing),
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