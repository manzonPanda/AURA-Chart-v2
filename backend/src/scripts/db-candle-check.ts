/**
 * `npm run db:candle-check`
 *
 * End-to-end contract test for the Supabase candle persistence, using a
 * synthetic TEST instrument (real market data is never touched):
 *
 *   1. upsert inserts a candle for a synthetic bucket
 *   2. read-back matches what was written
 *   3. upserting the SAME bucket again keeps exactly ONE row (no duplicates)
 *   4. the re-upsert updates OHLC in place (last write wins)
 *   5. tick_count survives the round-trip
 *   6. test rows are cleaned up
 *
 * Expects SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in backend/.env and the
 * ohlc_candles table to exist (npm run db:migrate first).
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { createSupabaseAdmin } from "../db/supabaseClient.js";
import { CandleStore, classifyClosedCandle } from "../db/candleStore.js";
import type { ClosedCandle } from "../streaming/types.js";

const INSTRUMENT = "TEST_INSTRUMENT";
const TIMEFRAME = "MINUTE_3";
/** Synthetic buckets far in the past: 2020-01-01 09:06 / 09:09 / 09:12 UTC. */
const BUCKET_SEC = Math.floor(Date.UTC(2020, 0, 1, 9, 6, 0) / 1000);
const PARTIAL_BUCKET_SEC = BUCKET_SEC + 180;
const BACKFILLED_BUCKET_SEC = BUCKET_SEC + 360;

function mkCandle(
  o: number,
  h: number,
  l: number,
  c: number,
  opts: {
    bucketSec?: number;
    /** First-tick delay after the bucket start (ms). Default: anchored at 348ms. */
    firstTickDelayMs?: number;
    status?: ClosedCandle["status"];
    tickCount?: number;
  } = {},
): ClosedCandle {
  const bucketSec = opts.bucketSec ?? BUCKET_SEC;
  const firstTickDelayMs = opts.firstTickDelayMs ?? 348;
  return {
    time: bucketSec,
    open: o,
    high: h,
    low: l,
    close: c,
    tickCount: opts.tickCount ?? 42,
    firstTickMs: bucketSec * 1000 + firstTickDelayMs,
    lastTickMs: (bucketSec + 179) * 1000,
    ...(opts.status ? { status: opts.status } : {}),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const admin = createSupabaseAdmin(config.supabase);
  if (!admin) {
    console.error("Supabase is not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in backend/.env");
    process.exit(1);
  }
  const store = new CandleStore(admin, config.supabase.table);

  let failed = false;
  const check = (name: string, ok: boolean, detail = ""): void => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failed = true;
  };

  // ── Pure classification unit checks (no DB) ──────────────────────────────
  check(
    "classify: anchored first tick (+348ms) -> completed",
    classifyClosedCandle(mkCandle(1, 2, 0.5, 1.5)) === "completed",
  );
  check(
    "classify: restart mid-bucket (+100.125s) -> partial",
    classifyClosedCandle(mkCandle(1, 2, 0.5, 1.5, { firstTickDelayMs: 100_125 })) === "partial",
  );
  check(
    "classify: quiet-market low tick_count does NOT make partial",
    classifyClosedCandle(mkCandle(1, 2, 0.5, 1.5, { tickCount: 3 })) === "completed",
  );
  check(
    "classify: explicit backfilled override wins",
    classifyClosedCandle(mkCandle(1, 2, 0.5, 1.5, { status: "backfilled" })) === "backfilled",
  );

  // ── DB round-trip: unique/upsert + status persistence ───────────────────
  try {
    await store.saveClosedCandle(INSTRUMENT, TIMEFRAME, mkCandle(100, 110, 90, 105));
    let rows = await store.loadCandles(INSTRUMENT, TIMEFRAME, 10);
    check(
      "initial upsert saved one row",
      rows.length === 1 && rows[0].open === 100 && rows[0].close === 105,
      `rows=${rows.length}`,
    );
    check("anchored candle persisted as completed", rows.length === 1 && rows[0].status === "completed");

    // Same (instrument, timeframe, bucket_time) — MUST NOT create a duplicate.
    await store.saveClosedCandle(INSTRUMENT, TIMEFRAME, mkCandle(100, 120, 90, 115));
    rows = await store.loadCandles(INSTRUMENT, TIMEFRAME, 10);
    check("re-upsert same bucket keeps exactly one row", rows.length === 1, `rows=${rows.length}`);
    check(
      "re-upsert updated OHLC in place (last write wins)",
      rows.length === 1 && rows[0].high === 120 && rows[0].close === 115,
      rows.length === 1 ? `H=${rows[0].high} C=${rows[0].close}` : "",
    );
    check(
      "tick_count persisted through upsert",
      rows.length === 1 && rows[0].tickCount === 42,
      rows.length === 1 ? `ticks=${rows[0].tickCount}` : "",
    );

    // Restart-mid-bucket candle → classified partial by the time rule.
    await store.saveClosedCandle(
      INSTRUMENT,
      TIMEFRAME,
      mkCandle(105, 118, 98, 116, { bucketSec: PARTIAL_BUCKET_SEC, firstTickDelayMs: 100_125, tickCount: 12 }),
    );
    // Future backfill job writes explicit 'backfilled' rows.
    await store.saveClosedCandle(
      INSTRUMENT,
      TIMEFRAME,
      mkCandle(99, 104, 96, 102, { bucketSec: BACKFILLED_BUCKET_SEC, status: "backfilled" }),
    );
    rows = await store.loadCandles(INSTRUMENT, TIMEFRAME, 10);
    const byBucket = new Map(rows.map((r) => [r.time, r.status]));
    check("partial candle stored with status=partial", byBucket.get(PARTIAL_BUCKET_SEC) === "partial");
    check("backfilled status accepted by CHECK constraint", byBucket.get(BACKFILLED_BUCKET_SEC) === "backfilled");
    check("exactly one row per bucket (no duplicates)", rows.length === 3, `rows=${rows.length}`);
  } finally {
    const { error } = await admin.from(config.supabase.table).delete().eq("instrument", INSTRUMENT);
    check("cleanup removed test rows", !error, error?.message ?? "");
  }

  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(failed ? 1 : 0);
}

void main().catch((err) => {
  console.error("db-candle-check failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});