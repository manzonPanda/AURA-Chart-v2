import { Hono } from "hono";
import { RESOLUTION_BUCKET_SEC } from "../realtime.js";
import type { CandleStore } from "../db/candleStore.js";
import { IG_GERMANY_40 } from "../market/calendar.js";
import { detectGaps } from "../market/gapDetector.js";

/**
 * GET /api/candles/db?epic=<EPIC>&timeframe=MINUTE_3&limit=<1..5000>
 *
 * Serves chart history from OUR Supabase persistence — the frontend's normal
 * history source. IG REST stays a bootstrap/backfill source only and its
 * allowance errors can never affect this endpoint. Response shape matches the
 * realtime websocket candle frames (`time` = bucket start, epoch SECONDS,
 * ascending) so it feeds `series.setData()` directly and hands off seamlessly
 * to the live `series.update()` stream.
 */
export function createCandlesDbRouter(store: CandleStore | null, defaultEpic: string): Hono {
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

    const epic = (c.req.query("epic") ?? "").trim() || defaultEpic.trim();
    if (!epic) {
      return c.json(
        { error: "No instrument EPIC configured — set IG_DAX_EPIC or pass `epic`.", code: "EPIC_MISSING" },
        400,
      );
    }

    const timeframe = (c.req.query("timeframe") ?? "MINUTE_3").trim().toUpperCase();
    if (!(timeframe in RESOLUTION_BUCKET_SEC)) {
      return c.json(
        {
          error: `Invalid timeframe "${timeframe}". Supported: ${Object.keys(RESOLUTION_BUCKET_SEC).join(", ")}`,
          code: "INVALID_TIMEFRAME",
        },
        400,
      );
    }

    const parsedLimit = Number(c.req.query("limit"));
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 500;

    try {
      const candles = await store.loadCandles(epic, timeframe, limit);
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
   * GET /api/candles/db/gaps?epic=<EPIC>&hours=<1..240>
   *
   * Stage 2 (read-only): classifies expected 3-minute market buckets as
   * missing / partial / completed. Market closures (weekends, the daily
   * 05:00–08:00 UK break, holidays) are never reported as missing — the
   * IG Germany 40 calendar in src/market/calendar.ts decides "expected".
   * No rows are created; bucket times are UTC ISO (the chart displays
   * Asia/Manila separately). The still-forming bucket is always excluded.
   */
  app.get("/candles/db/gaps", async (c) => {
    if (!store) {
      return c.json({ error: "Candle persistence is not configured.", code: "DB_NOT_CONFIGURED" }, 503);
    }
    const epic = (c.req.query("epic") ?? "").trim() || defaultEpic.trim();
    const timeframe = (c.req.query("timeframe") ?? "MINUTE_3").trim().toUpperCase();
    if (timeframe !== "MINUTE_3") {
      return c.json(
        { error: `Gap detection currently supports MINUTE_3 only (got "${timeframe}").`, code: "INVALID_TIMEFRAME" },
        400,
      );
    }

    const parsedHours = Number(c.req.query("hours"));
    const hours = Number.isFinite(parsedHours) ? Math.min(240, Math.max(1, parsedHours)) : 6;

    try {
      const rows = await store.loadCandles(epic, timeframe, 5000);
      const nowSec = Math.floor(Date.now() / 1000);
      const formingBucket = Math.floor(nowSec / 180) * 180;
      // Scan from the newer of (lookback window start, oldest persisted row) —
      // buckets older than our earliest row predate collection and are not
      // "missing"; they are simply uncollected (future backfill territory).
      const oldestRow = rows.length > 0 ? rows[0].time : formingBucket;
      const fromSec = Math.max(Math.ceil((nowSec - hours * 3600) / 180) * 180, oldestRow);

      const report = detectGaps(rows, { fromSec, toSec: formingBucket, calendar: IG_GERMANY_40 });
      const iso = (secs: number[]): string[] =>
        secs.slice(0, 500).map((s) => new Date(s * 1000).toISOString());

      return c.json({
        epic,
        timeframe,
        range: {
          from: new Date(fromSec * 1000).toISOString(),
          to: new Date(formingBucket * 1000).toISOString(),
          hours,
          formingBucketExcluded: new Date(formingBucket * 1000).toISOString(),
        },
        market: {
          calendar: IG_GERMANY_40.id,
          label: IG_GERMANY_40.label,
          timezone: IG_GERMANY_40.timezone,
          closedDatesCount: IG_GERMANY_40.closedDates.length,
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