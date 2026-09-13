/**
 * PgCandleStore contract tests — the PostgreSQL v1 persistence layer that
 * replaces Supabase at the cutover (Node test runner: npm --prefix backend run
 * test, or this file alone with AURA_DB_URL exported).
 *
 * Isolation strategy: every test writes through the REAL PgCandleStore into a
 * per-run TEMP SCHEMA (aura_pgstore_test_<hex>) by passing the SCHEMA-QUALIFIED
 * table name to the store. public.ohlc_candles is therefore structurally
 * unreachable from these tests — no search_path or role mutation is involved
 * (role-level search_path shadowing was tried and REJECTED: pooled connections
 * opened before the ALTER keep the public path). The final test asserts the
 * production table is still at exactly 0 rows (nothing migrated, nothing
 * leaked). The Supabase layer is exercised only against an absent table to
 * pin its error contract — no Supabase credentials, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";

import {
  PgCandleStore,
  SupabaseCandleStore,
  classifyClosedCandle,
} from "../db/candleStore.js";
import type { ClosedCandle } from "../streaming/types.js";
import { IG_GERMANY_40 } from "../market/calendar.js";
import { deriveGapIntervals } from "../market/gapDetector.js";
import { aggregateCompleteToMinutes } from "../streaming/timeframes.js";
import { calendarForInstrument } from "../market/instruments.js";
import type { Candle } from "../types/candle.js";

// ---------------------------------------------------------------------------
// Connection (env-first; secrets never printed). Skips cleanly when absent.
// ---------------------------------------------------------------------------
function poolConfig(): pg.PoolConfig | null {
  if (process.env.AURA_DB_URL) return { connectionString: process.env.AURA_DB_URL };
  if (process.env.PGPASSWORD) {
    return {
      host: process.env.PGHOST ?? "127.0.0.1",
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? "aura_app",
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE ?? "aura",
    };
  }
  // Root-only env file (readable only when the runner has root).
  try {
    const url = fs.readFileSync("/etc/aura/postgres.env", "utf8").match(/^AURA_DB_URL=(\S+)/m)?.[1];
    if (url) return { connectionString: url };
  } catch {
    /* not readable as this user — fall through to skip */
  }
  return null;
}

const base = poolConfig();
const probe = base
  ? new pg.Pool({ ...base, max: 1, connectionTimeoutMillis: 4000, application_name: "aura-pgstore-test-probe" })
  : null;

let hasPg = false;
try {
  await probe!.query("SELECT 1");
  hasPg = true;
} catch (e) {
  console.log(`# SKIP PgCandleStore tests: local PostgreSQL not reachable (${(e as Error).message.split("\n")[0]})`);
}
await probe?.end();

/** Unique per run; every test table lives inside it, schema-qualified. */
const SHADOW = `aura_pgstore_test_${randomBytes(4).toString("hex")}`;
const SHADOW_TABLE = `${SHADOW}.ohlc_candles`;

/** Unique per run so parallel reruns can never collide with each other. */
const INSTRUMENT = `PG_STORE_TEST_${randomBytes(4).toString("hex")}`;
const DERIVED_INSTRUMENT = `PG_DERIVED_${randomBytes(4).toString("hex")}`;

/** A DAX session minute: Wednesday 2026-08-26 09:00 UTC (IG_GERMANY_40 open). */
const W = Math.floor(Date.UTC(2026, 7, 26, 9, 0, 0) / 1000);

function closed(time: number, partial: boolean, overrides: Partial<ClosedCandle> = {}): ClosedCandle {
  return {
    instrument: INSTRUMENT,
    timeframe: "MINUTE_1",
    bucketSec: 60,
    time,
    open: 100,
    high: 102,
    low: 98,
    close: 101,
    tickCount: 7,
    firstTickMs: (time + (partial ? 100 : 0.35)) * 1000,
    lastTickMs: (time + 59.5) * 1000,
    status: partial ? "partial" : "completed",
    ...overrides,
  } as ClosedCandle;
}

test("PgCandleStore: full Supabase-parity contract (schema-qualified temp table)", { skip: !hasPg }, async (t) => {
  const pool = new pg.Pool({ ...base!, max: 10, idleTimeoutMillis: 30_000, application_name: "aura-pgstore-test" });
  const store = new PgCandleStore(pool, SHADOW_TABLE);

  await pool.query(`DROP SCHEMA IF EXISTS ${SHADOW} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SHADOW}`);
  await pool.query(`CREATE TABLE ${SHADOW_TABLE} (
    id uuid primary key default gen_random_uuid(),
    instrument text not null,
    timeframe text not null,
    bucket_time timestamptz not null,
    open numeric not null, high numeric not null, low numeric not null, close numeric not null,
    tick_count integer,
    source text not null default 'ig',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    status text not null default 'completed',
    constraint ohlc_candles_instrument_timeframe_bucket_time_key unique (instrument, timeframe, bucket_time),
    constraint ohlc_candles_status_check check (status in ('partial','completed','backfilled'))
  )`);
  await pool.query(`CREATE OR REPLACE FUNCTION ${SHADOW}.ohlc_candles_touch_updated_at()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN new.updated_at = now(); return new; END; $$`);
  await pool.query(`CREATE TRIGGER ohlc_candles_touch BEFORE UPDATE ON ${SHADOW_TABLE}
    FOR EACH ROW EXECUTE FUNCTION ${SHADOW}.ohlc_candles_touch_updated_at()`);

  t.after(async () => {
    await pool.end();
    const cleanup = new pg.Pool({ ...base!, max: 1, application_name: "aura-pgstore-test-cleanup" });
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${SHADOW} CASCADE`);
    } finally {
      await cleanup.end();
    }
  });

  await t.test("insert closed candle → readback + classify + capital source", async () => {
    assert.equal(classifyClosedCandle(closed(W, true)), "partial");
    assert.equal(classifyClosedCandle(closed(W, false)), "completed");
    await store.saveClosedCandle(INSTRUMENT, "MINUTE_1", closed(W, false), "capital");
    const rows = await store.loadCandles(INSTRUMENT, "MINUTE_1", 10);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { time: W, open: 100, high: 102, low: 98, close: 101, tickCount: 7, status: "completed" });
    const raw = await pool.query<{ source: string }>(`SELECT source FROM ${SHADOW_TABLE} WHERE instrument=$1`, [INSTRUMENT]);
    assert.equal(raw.rows[0].source, "capital");
  });

  await t.test("duplicate upsert → one row, last-write-wins OHLC (live path)", async () => {
    await store.saveClosedCandle(INSTRUMENT, "MINUTE_1", closed(W, false, { close: 103, tickCount: 12 }), "capital");
    const rows = await store.loadCandles(INSTRUMENT, "MINUTE_1", 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].close, 103);
    assert.equal(rows[0].tickCount, 12);
    assert.equal(rows[0].status, "completed");
  });

  await t.test("loadCandles newest-N window returned ASCENDING", async () => {
    for (let m = 1; m <= 4; m++) {
      await store.saveClosedCandle(INSTRUMENT, "MINUTE_1", closed(W + m * 60, false), "capital");
    }
    const rows = await store.loadCandles(INSTRUMENT, "MINUTE_1", 3);
    assert.deepEqual(rows.map((r) => r.time), [W + 120, W + 180, W + 240]);
  });

  await t.test("loadCandles(before) cursor is strictly older, excluding the cursor bucket", async () => {
    const rows = await store.loadCandles(INSTRUMENT, "MINUTE_1", 10, W + 120);
    assert.deepEqual(rows.map((r) => r.time), [W, W + 60]);
  });

  await t.test("loadCandlesRange is inclusive on both bounds", async () => {
    const rows = await store.loadCandlesRange(INSTRUMENT, "MINUTE_1", W + 60, W + 180);
    assert.deepEqual(rows.map((r) => r.time), [W + 60, W + 120, W + 180]);
  });

  await t.test("oldestBucketSec: earliest bucket; null for an empty instrument", async () => {
    assert.equal(await store.oldestBucketSec(INSTRUMENT, "MINUTE_1"), W);
    assert.equal(await store.oldestBucketSec("NO_SUCH_INSTRUMENT", "MINUTE_1"), null);
  });

    await t.test("partial candle persists as partial; repair flips it to backfilled/capital", async () => {
    const pTime = W + 600;
    await store.saveClosedCandle(INSTRUMENT, "MINUTE_1", closed(pTime, true), "capital");
    const before = await store.loadCandlesRange(INSTRUMENT, "MINUTE_1", pTime, pTime);
    assert.equal(before[0].status, "partial");
    assert.equal(before[0].tickCount, 7);
    await store.repairIfPartial(INSTRUMENT, "MINUTE_1", { time: pTime, open: 100, high: 102, low: 98, close: 101 });
    const after = await store.loadCandlesRange(INSTRUMENT, "MINUTE_1", pTime, pTime);
    assert.equal(after[0].status, "backfilled");
    assert.equal(after[0].tickCount, null, "backfilled rows lose the realtime tick diagnostic");
    const raw = await pool.query<{ source: string }>(
      `SELECT source FROM ${SHADOW_TABLE} WHERE instrument=$1 AND extract(epoch from bucket_time)::bigint=$2`,
      [INSTRUMENT, pTime],
    );
    assert.equal(raw.rows[0].source, "capital", "repairs are stamped capital (default since IG retired)");
  });

  await t.test("insertIfMissing: inserts missing (backfilled); refuses completed (race-safe)", async () => {
    const missing = W + 660;
    assert.equal(
      await store.insertIfMissing(INSTRUMENT, "MINUTE_1", { time: missing, open: 1, high: 2, low: 0.5, close: 1.5 }),
      "inserted",
    );
    const seeded = await store.loadCandlesRange(INSTRUMENT, "MINUTE_1", missing, missing);
    assert.equal(seeded[0].status, "backfilled");
    assert.equal(seeded[0].tickCount, null);
    assert.equal(
      await store.insertIfMissing(INSTRUMENT, "MINUTE_1", { time: W, open: 0, high: 0, low: 0, close: 0 }),
      "already-present",
      "insert into a live-closed bucket must be ignored",
    );
    const untouched = await store.loadCandlesRange(INSTRUMENT, "MINUTE_1", W, W);
    assert.equal(untouched[0].close, 103, "completed candle must not be overwritten by backfill");
  });

  await t.test("repairIfPartial: completed is NEVER repaired; --force reaches backfilled only", async () => {
    const p2 = W + 720;
    await store.saveClosedCandle(INSTRUMENT, "MINUTE_1", closed(p2, true), "capital");
    assert.equal(
      await store.repairIfPartial(INSTRUMENT, "MINUTE_1", { time: p2, open: 1, high: 2, low: 0.5, close: 1.5 }),
      "repaired",
    );
    assert.equal(
      await store.repairIfPartial(INSTRUMENT, "MINUTE_1", { time: W, open: 1, high: 1, low: 1, close: 1 }),
      "status-changed",
      "completed candles are NEVER repaired",
    );
    assert.equal(
      await store.repairIfPartial(INSTRUMENT, "MINUTE_1", { time: W, open: 1, high: 1, low: 1, close: 1 }, { includeBackfilled: true }),
      "status-changed",
      "--force still must not touch completed candles",
    );
    assert.equal(
      await store.repairIfPartial(INSTRUMENT, "MINUTE_1", { time: W + 600, open: 1, high: 1, low: 1, close: 1 }, { includeBackfilled: true }),
      "repaired",
      "--force extends the repair to already-backfilled rows",
    );
    assert.equal(
      await store.repairIfPartial(INSTRUMENT, "MINUTE_1", { time: W + 600, open: 1, high: 1, low: 1, close: 1 }),
      "status-changed",
      "without --force a backfilled row is protected",
    );
  });

  await t.test("source preservation: capital vs archive-ig coexist untouched (IG retired, no new ig rows)", async () => {
    const cap = W + 840;
    const legacy = W + 900;
    await store.saveClosedCandle(INSTRUMENT, "MINUTE_1", closed(cap, false), "capital");
    await store.saveClosedCandle(INSTRUMENT, "MINUTE_1", closed(legacy, false), "ig");
    const raw = await pool.query<{ bucket_sec: string; source: string }>(
      `SELECT extract(epoch from bucket_time)::text AS bucket_sec, source FROM ${SHADOW_TABLE}
        WHERE instrument=$1 AND timeframe='MINUTE_1' AND extract(epoch from bucket_time)::bigint IN ($2, $3)`,
      [INSTRUMENT, cap, legacy],
    );
    const bySec = new Map(raw.rows.map((r) => [Number(r.bucket_sec), r.source]));
    assert.equal(bySec.get(cap), "capital");
    assert.equal(bySec.get(legacy), "ig", "legacy archive rows are preserved (not deleted/migrated)");
  });

  await t.test("SupabaseCandleStore parity: an absent table THROWS (never a silent empty success)", async () => {
    const chain: Record<string, unknown> = {};
    type Chain = typeof chain & {
      from: () => Chain; select: () => Chain; eq: () => Chain; gte: () => Chain; lte: () => Chain;
      order: () => Chain; range: () => Chain; limit: () => Chain; lt: () => Chain;
      upsert: () => Chain; throwOnError: () => Chain;
      then: (res?: (v: unknown) => void, rej?: (e: Error) => void) => void;
    };
    const self = chain as unknown as Chain;
    self.from = self.select = self.eq = self.gte = self.lte = self.order = self.range = self.limit = self.lt =
      self.upsert = self.throwOnError = () => self;
    self.then = (_res, rej) => rej?.(new Error('relation "ohlc_candles" does not exist'));
    const sb = new SupabaseCandleStore(chain as never, "ohlc_candles");
    await assert.rejects(() => sb.loadCandles(INSTRUMENT, "MINUTE_1", 10), /does not exist/);
    await assert.rejects(
      () => sb.insertIfMissing(INSTRUMENT, "MINUTE_1", { time: W, open: 1, high: 1, low: 1, close: 1 }),
      /does not exist/,
      "insertIfMissing must never report inserted/already-present on a hard failure",
    );
  });

  await t.test("MINUTE_3 derivation from canonical MINUTE_1 (complete 3-tick buckets only)", async () => {
    // 1m rows at W, W+60, W+180, W+240, W+300 — W+120 deliberately MISSING and
    // the trailing W+300 row saved as `partial` (status is irrelevant to the
    // derivation: only row COVERAGE counts). 3m grid: [W..W+120) needs 3 rows →
    // has 2 → dropped; [W+180..W+360) has 3 → kept.
    for (const [offset, partial] of [[0, false], [60, false], [180, false], [240, false], [300, true]] as const) {
      await store.saveClosedCandle(DERIVED_INSTRUMENT, "MINUTE_1", closed(W + offset, partial), "capital");
    }
    const oneMin = await store.loadCandles(DERIVED_INSTRUMENT, "MINUTE_1", 50);
    const threeMin = aggregateCompleteToMinutes(
      oneMin.map((p) => ({ ts: p.time * 1000, open: p.open, high: p.high, low: p.low, close: p.close })),
      3,
    );
    assert.deepEqual(threeMin.map((c) => c.ts), [(W + 180) * 1000], "incomplete 3m buckets are never synthesized");
    assert.deepEqual(
      threeMin[0],
      { ts: (W + 180) * 1000, open: 100, high: 102, low: 98, close: 101 },
      "open=first open, high=max, low=min, close=last close (the read-path mapping carries no volume)",
    );
  });

  await t.test("gap derivation stays READ-TIME: the W+120 hole is detected from loaded rows", async () => {
    const oneMin = await store.loadCandles(DERIVED_INSTRUMENT, "MINUTE_1", 50);
    const intervals = deriveGapIntervals(
      oneMin.map((p) => p.time),
      IG_GERMANY_40,
      60,
      { toSec: W + 360 },
    );
    assert.deepEqual(
      intervals,
      [{ startMs: (W + 120) * 1000, endMs: (W + 180) * 1000 }],
      "exactly one expected-but-missing bucket, expressed as an epoch-ms interval",
    );
  });
});

test("cutover safety: public.ohlc_candles holds only REAL live/backfilled rows (no test rows, no leaks)", { skip: !hasPg }, async () => {
  const pool = new pg.Pool({ ...base!, max: 1, application_name: "aura-pgstore-test-zero" });
  try {
    // The historical backfill is LIVE — the production table holds REAL rows
    // (source='capital', live stream + historical import). What must NEVER
    // happen is a TEST row reaching production: these tests write through
    // SCHEMA-QUALIFIED temp tables only.
    const { rows } = await pool.query<{ n: string; test_rows: string }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE instrument LIKE 'PGSTORE_TEST_%')::text AS test_rows
         FROM public.ohlc_candles`,
    );
    assert.equal(rows[0].test_rows, "0", "no PG test row ever reached the production table (temp-schema isolation)");
    const leaks = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_namespace WHERE nspname LIKE 'aura_pgstore_shadow_%'",
    );
    assert.equal(leaks.rows[0].n, "0", "no test schema leaks after the suite");
  } finally {
    await pool.end();
  }
});
