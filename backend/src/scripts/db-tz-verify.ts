/**
 * `npm run db:tz-verify`
 *
 * Verifies the Asia/Manila display convention for ohlc_candles timestamps:
 *
 *   1. prints the newest real candle row with created_at/updated_at shown in
 *      BOTH UTC and Asia/Manila wall-clock (same instant, +8 hours)
 *   2. asserts PH == UTC + 8h for the named zone (read-time evaluation — no
 *      hardcoded offset in storage)
 *   3. asserts bucket_time is still the untouched UTC instant
 *   4. reads the `ohlc_candles_pht` view and confirms the *_pht columns exist
 *      and match
 *
 * Read-only: performs no writes. Requires SUPABASE_DB_URL in backend/.env.
 */
import "dotenv/config";
import { Client } from "pg";

/** All timestamps are formatted INSIDE SQL with explicit zones — node-pg would
 *  otherwise render timestamptz Date objects in the local machine timezone. */
const ROW_SQL = `
    select
        instrument,
        timeframe,
        to_char(bucket_time at time zone 'UTC',        'YYYY-MM-DD HH24:MI:SS') as bucket_time_utc,
        to_char(created_at  at time zone 'UTC',        'YYYY-MM-DD HH24:MI:SS') as created_at_utc,
        to_char(created_at  at time zone 'Asia/Manila','YYYY-MM-DD HH24:MI:SS') as created_at_manila,
        to_char(updated_at  at time zone 'Asia/Manila','YYYY-MM-DD HH24:MI:SS') as updated_at_manila,
        -- Same-instant proof: the named zone renders exactly UTC+8 (PH has no DST).
        (created_at at time zone 'Asia/Manila')
            = (created_at at time zone 'UTC' + interval '8 hours')          as ph_is_utc_plus_8,
        (bucket_time at time zone 'Asia/Manila')
            = (bucket_time at time zone 'UTC' + interval '8 hours')         as bucket_math_consistent
    from public.ohlc_candles
    where instrument <> 'TEST_INSTRUMENT'
    order by bucket_time desc
    limit 1;
`;

const VIEW_SQL = `
    select
        instrument,
        to_char(bucket_time  at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as bucket_time_utc,
        to_char(created_at_pht, 'YYYY-MM-DD HH24:MI:SS')                  as created_at_pht,
        to_char(updated_at_pht, 'YYYY-MM-DD HH24:MI:SS')                  as updated_at_pht
    from public.ohlc_candles_pht
    where instrument <> 'TEST_INSTRUMENT'
    order by bucket_time desc
    limit 1;
`;

async function main(): Promise<void> {
  const connectionString = (process.env.SUPABASE_DB_URL || "").trim();
  if (!connectionString) {
    console.error("SUPABASE_DB_URL is not set — add it to backend/.env first.");
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const row = (await client.query(ROW_SQL)).rows[0];
    if (!row) {
      console.log("No real candle rows yet — wait for the next 3-minute close.");
      return;
    }

    console.log(`newest row  instrument=${row.instrument}  timeframe=${row.timeframe}`);
    console.log("");
    console.log("1) UTC representation");
    console.log(`   bucket_time = ${row.bucket_time_utc}+00`);
    console.log(`   created_at  = ${row.created_at_utc}+00`);
    console.log("");
    console.log("2) Asia/Manila representation (UTC+8 — same instants)");
    console.log(`   created_at  = ${row.created_at_manila}+08`);
    console.log(`   updated_at  = ${row.updated_at_manila}+08`);
    console.log(`   bucket_time = ${row.bucket_time_utc}+00  (kept UTC, display untouched)`);

    let failed = false;
    const check = (name: string, ok: boolean): void => {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
      if (!ok) failed = true;
    };

    check("created_at in Manila == UTC + 8h (same instant)", row.ph_is_utc_plus_8 === true);
    check("bucket_time math consistent (named zone == UTC + 8h)", row.bucket_math_consistent === true);

    const view = (await client.query(VIEW_SQL)).rows[0];
    check("view ohlc_candles_pht exposes *_pht columns", view !== undefined);
    if (view) {
      console.log("");
      console.log(`view ohlc_candles_pht  bucket_time=${view.bucket_time_utc}+00  ` +
        `created_at_pht=${view.created_at_pht}  updated_at_pht=${view.updated_at_pht}`);
      check(
        "view created_at_pht matches direct at-time-zone rendering",
        view.created_at_pht === row.created_at_manila,
      );
      check(
        "view updated_at_pht matches direct at-time-zone rendering",
        view.updated_at_pht === row.updated_at_manila,
      );
      check(
        "view bucket_time still renders the UTC instant",
        view.bucket_time_utc === row.bucket_time_utc,
      );
    }

    console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
    process.exit(failed ? 1 : 0);
  } finally {
    await client.end();
  }
}

void main().catch((err) => {
  console.error("db-tz-verify failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});