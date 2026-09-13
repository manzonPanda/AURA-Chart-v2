import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClosedCandle, CandleStatus } from "../streaming/types.js";
import { instrumentMetaFor } from "../market/instruments.js";
import type { QueryResult, QueryResultRow } from "pg";

/**
 * Minimal query surface shared by `pg.Pool`, `pg.Client` and `PoolClient`.
 * Production passes the process-wide pool (getPgPool()); tests may pass a
 * dedicated transaction-scoped client so the whole suite runs inside ONE
 * transaction that is rolled back — the production table keeps 0 rows.
 */
export interface PgQueryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** Raw ohlc_candles row returned by the persistence backend. */
export interface CandleRow {
  bucket_time: string; // ISO-8601 timestamptz
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  tick_count: number | null;
  status: string | null;
}

/** Chart-ready candle — `time` is the bucket start in epoch SECONDS. */
export interface PersistedCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number | null;
  status?: CandleStatus;
}

/**
 * The persistence-backend abstraction. Both implementations share an identical
 * public contract so RealtimeService / routes / EMA can be storage-agnostic.
 *
  * `source` is threaded through the live write path so providers are recorded
 * correctly: "capital" for Capital.com ticks, "ig" / "ig_historical" for
 * legacy-archive rows (IG is retired — never written by active code).
 */
export interface CandleBackend {
  /**
   * Persist a single CLOSED candle (never per-tick).
   * `source` records the feed that produced this candle.
   */
  saveClosedCandle(
    instrument: string,
    timeframe: string,
    candle: ClosedCandle,
    source: CandleSource,
  ): Promise<void>;

  /** Newest `limit` candles (ascending), strictly older than `beforeSec` if given. */
  loadCandles(instrument: string, timeframe: string, limit: number, beforeSec?: number): Promise<PersistedCandle[]>;

  /** Earliest persisted bucket (epoch s) for an instrument/timeframe; null when empty. */
  oldestBucketSec(instrument: string, timeframe: string): Promise<number | null>;

  /** Rows whose bucket start lies within [fromSec, toSec] (inclusive), ascending. */
  loadCandlesRange(instrument: string, timeframe: string, fromSec: number, toSec: number): Promise<PersistedCandle[]>;

  /** Race-safe insert for a MISSING bucket; source defaults to "capital". */
  insertIfMissing(
    instrument: string,
    timeframe: string,
    candle: { time: number; open: number; high: number; low: number; close: number },
    source?: CandleSource,
  ): Promise<"inserted" | "already-present">;

  /** Race-safe repair for a PARTIAL bucket; source defaults to "capital". */
  repairIfPartial(
    instrument: string,
    timeframe: string,
    candle: { time: number; open: number; high: number; low: number; close: number },
    opts?: { includeBackfilled?: boolean; source?: CandleSource },
  ): Promise<"repaired" | "status-changed">;
}

/**
 * The `source` provenance written to ohlc_candles.source.
 *
 * Active production path: ONLY "capital" is written by live collection
 * (Capital.com stream) and historical backfill (Capital downloader).
 *
 * "ig" / "ig_historical" are RETAINED in the type purely for legacy-ARCHIVE
 * database compatibility (the Supabase ohlc_candles archive holds 27,338 rows
 * stamped with those values). They are NEVER produced by active production
 * code — the realtime service maps every CAPITAL instrument to "capital" via
 * toCandleSource(), and IG collection/backfill is fully retired. No database
 * constraint prevents legacy values; we just stop generating new ones.
 */
export type CandleSource = "ig" | "ig_historical" | "capital";

/**
 * Map an instrument identity to its candle `source` provenance.
 *
 * Accepts EITHER
 *   - a provider name ("capital" / "CAPITAL") — `InstrumentMeta.provider`, or
 *   - a raw instrument epic ("GOLD", "IX.D.DAX.IGM.IP", …) — resolved through
 *     the instrument registry.
 *
 * IG is RETIRED: an IG-provider epic or the literal "ig"/"ig_historical"
 * provider name resolves to "ig" ONLY as a legacy-archive label. The active
 * CAPITAL path always maps to "capital". No IG fallback exists — if Capit.
 * al is unavailable, the service stays DISCONNECTED, never "ig".
 */
export function toCandleSource(instrumentMeta: { provider: string } | string): CandleSource {
  if (typeof instrumentMeta === "string") {
    const s = instrumentMeta.toLowerCase();
    if (s === "capital") return "capital";
    if (s === "ig" || s === "ig_historical") return "ig";
    // Not a provider name — treat the string as an instrument epic.
    return toCandleSource(instrumentMetaFor(instrumentMeta));
  }
  return instrumentMeta.provider.toLowerCase() === "capital" ? "capital" : "ig";
}


/**
 * Stage 1 classification rule (TIME-based, per design — never tick_count, since
 * a quiet market can legitimately produce few ticks):
 *
 * A closed candle is `partial` when the FIRST tick aggregated into it arrived
 * more than {@link PARTIAL_ANCHOR_TOLERANCE_MS} after the bucket boundary —
 * i.e. the process restarted / the stream recovered after the bucket began.
 * Measured normal first-tick deltas are ~300–400 ms (e.g. 09:06:00.348 for the
 * 09:06 bucket), so 5 s is far above delivery jitter yet far below the 180 s
 * bucket: 09:06:00.348 → completed, 09:07:40.125 → partial.
 *
 * tick_count stays a purely diagnostic column.
 *
 * Caveat (accepted): with DISTINCT-mode streaming a bucket whose first quote
 * CHANGE genuinely happens >5 s in (very quiet market) is flagged partial.
 * That is the conservative direction — a false `partial` only makes the future
 * backfill double-check the bucket; a false `completed` would hide a defect.
 */
export const PARTIAL_ANCHOR_TOLERANCE_MS = 5_000;

/** Classify a closed candle for persistence (explicit override wins). */
export function classifyClosedCandle(candle: ClosedCandle): CandleStatus {
  if (candle.status) return candle.status;
  const first = candle.firstTickMs;
  if (!Number.isFinite(first) || first <= 0) return "completed"; // no anchor diagnostics — cannot prove partial
  return first - candle.time * 1000 > PARTIAL_ANCHOR_TOLERANCE_MS ? "partial" : "completed";
}

/**
 * Persistence for COMPLETED candles only (never per-tick).
 *
 * Every write is an UPSERT keyed on (instrument, timeframe, bucket_time) — the
 * table's UNIQUE constraint makes each save idempotent: a replayed close, a
 * Lightstreamer reconnect or a full backend restart can re-encounter the same
 * bucket and still end up with exactly one row.
 *
 * Failure policy: save failures are logged (`[DB CANDLE SAVE ERROR]`) and
 * swallowed — a Supabase outage must NEVER disturb the realtime IG stream or
 * the chart. Missed buckets are backfillable from IG historical later
 * (bootstrap source); `tick_count` marks restart-partial candles.
 */
export class SupabaseCandleStore implements CandleBackend {
  constructor(
    private readonly client: SupabaseClient,
    private readonly table: string,
  ) {}

  async saveClosedCandle(
    instrument: string,
    timeframe: string,
    candle: ClosedCandle,
    source: CandleSource,
  ): Promise<void> {
    const bucketTime = new Date(candle.time * 1000).toISOString();
    const status = classifyClosedCandle(candle);
    try {
      const { error } = await this.client
        .from(this.table)
        .upsert(
          {
            instrument,
            timeframe,
            bucket_time: bucketTime,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
                        tick_count: Number.isFinite(candle.tickCount) ? candle.tickCount : null,
            status,
            source,
          },
          { onConflict: "instrument,timeframe,bucket_time" },
        );

      if (error) {
        console.log(
          `[DB CANDLE SAVE ERROR]\nbucket=${bucketTime}\ncode=${error.code ?? "-"}\nerror=${error.message}`,
        );
        return;
      }

      console.log(
        `[DB CANDLE SAVED]\n` +
          `instrument=${instrument}\n` +
          `timeframe=${timeframe}\n` +
          `bucket=${bucketTime.slice(11, 19)}\n` +
          `O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}\n` +
                    `ticks=${candle.tickCount ?? "-"} status=${status} source=${source} (upsert — idempotent)`,
      );
    } catch (err) {
      console.log(
        `[DB CANDLE SAVE ERROR]\nbucket=${bucketTime}\nerror=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Newest `limit` candles for (instrument, timeframe), returned ASCENDING and
   * chart-ready (`time` = epoch seconds) — directly consumable by
   * `series.setData()`.
   *
   * `beforeSec` (optional) is a history-pagination CURSOR: only rows STRICTLY
   * OLDER than that bucket start are returned (used by the chart's
   * "Load More History" — the frontend sends its oldest loaded bucket).
   *
   * Supabase-hosted PostgREST silently CLAMPS every request to 1000 rows
   * (db-max-rows=1000): `.limit(2000)` returns only the newest 1000 — exactly
   * one 1m trading day. To serve genuine multi-day history we page through
   * `.range(from, to)` windows of ≤1000 rows (newest-first) until `capped`
   * rows are collected or the table is exhausted, then re-sort ascending.
   */
  async loadCandles(
    instrument: string,
    timeframe: string,
    limit: number,
    beforeSec?: number,
  ): Promise<PersistedCandle[]> {
    const capped = Math.max(1, Math.min(10000, Math.round(limit) || 500));
    const PAGE = 1000; // PostgREST per-request max — keep every window ≤ 1000
    const rows: CandleRow[] = [];
    for (let from = 0; from < capped; from += PAGE) {
      const to = Math.min(from + PAGE - 1, capped - 1);
      let q = this.client
        .from(this.table)
        .select("bucket_time,open,high,low,close,tick_count,status")
        .eq("instrument", instrument)
        .eq("timeframe", timeframe);
      if (beforeSec !== undefined && Number.isFinite(beforeSec) && beforeSec > 0) {
        q = q.lt("bucket_time", new Date(beforeSec * 1000).toISOString());
      }
      const { data, error } = await q
        .order("bucket_time", { ascending: false })
        .range(from, to);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as unknown as CandleRow[];
      rows.push(...page);
      if (page.length < to - from + 1) break; // table exhausted mid-window
    }

    return rows
      .map((r) => ({
        time: Math.floor(new Date(r.bucket_time).getTime() / 1000),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        tickCount: r.tick_count ?? null,
        ...(r.status ? { status: r.status as CandleStatus } : {}),
      }))
      .sort((a, b) => a.time - b.time);
  }

  /** Earliest persisted bucket (epoch s) for an instrument/timeframe — null when empty. */
  async oldestBucketSec(instrument: string, timeframe: string): Promise<number | null> {
    const { data, error } = await this.client
      .from(this.table)
      .select("bucket_time")
      .eq("instrument", instrument)
      .eq("timeframe", timeframe)
      .order("bucket_time", { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as { bucket_time: string }[];
    return rows.length > 0 ? Math.floor(new Date(rows[0].bucket_time).getTime() / 1000) : null;
  }

  /** Rows whose bucket START lies within [fromSec, toSec] (inclusive), ascending. */
  async loadCandlesRange(
    instrument: string,
    timeframe: string,
    fromSec: number,
    toSec: number,
  ): Promise<PersistedCandle[]> {
    const { data, error } = await this.client
      .from(this.table)
      .select("bucket_time,open,high,low,close,tick_count,status")
      .eq("instrument", instrument)
      .eq("timeframe", timeframe)
      .gte("bucket_time", new Date(fromSec * 1000).toISOString())
      .lte("bucket_time", new Date(toSec * 1000).toISOString())
      .order("bucket_time", { ascending: true });

    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as CandleRow[];
    return rows.map((r) => ({
      time: Math.floor(new Date(r.bucket_time).getTime() / 1000),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tick_count ?? null,
      ...(r.status ? { status: r.status as CandleStatus } : {}),
    }));
  }

  /**
   * Race-safe backfill insert for a MISSING bucket.
   *
   * Atomic in Postgres: with `ignoreDuplicates` + the unique constraint the
   * insert lands ONLY if the bucket is still absent at write time. If the
   * realtime collector closed that very bucket between the gap scan and this
   * write (bucket became `completed`), the insert is silently ignored and the
   * live candle is protected. Provenance: status='backfilled',
   * source=caller (Capital backfill passes 'capital'). tick_count is null (no realtime ticks involved).
   */
  async insertIfMissing(
    instrument: string,
    timeframe: string,
    candle: { time: number; open: number; high: number; low: number; close: number },
    source: CandleSource = "capital",
  ): Promise<"inserted" | "already-present"> {
    const { error, count } = await this.client
      .from(this.table)
      .upsert(
        {
          instrument,
          timeframe,
          bucket_time: new Date(candle.time * 1000).toISOString(),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          tick_count: null,
          status: "backfilled",
          source,
        },
        // upsert + ignoreDuplicates → INSERT … ON CONFLICT DO NOTHING: the row
        // lands ONLY if the bucket is still absent (count=0 ⇒ was not missing).
        { onConflict: "instrument,timeframe,bucket_time", ignoreDuplicates: true, count: "exact" },
      );
    if (error) throw new Error(error.message);
    return (count ?? 0) > 0 ? "inserted" : "already-present";
  }

  /**
   * Race-safe backfill repair for a PARTIAL bucket.
   *
   * Atomic conditional UPDATE: matches only while the row's status is still
   * `partial` (plus `backfilled` when `includeBackfilled`/--force). If the
   * bucket became `completed` after the gap scan, zero rows match and the
   * completed candle is untouched. OHLC is replaced wholesale with the
   * wholesale; status becomes 'backfilled', source=caller (Capital backfill passes 'capital').
   */
  async repairIfPartial(
    instrument: string,
    timeframe: string,
    candle: { time: number; open: number; high: number; low: number; close: number },
    opts: { includeBackfilled?: boolean; source?: CandleSource } = {},
  ): Promise<"repaired" | "status-changed"> {
    const { error, count } = await this.client
      .from(this.table)
      .update(
        {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          tick_count: null,
          status: "backfilled",
          source: opts.source ?? "capital",
        },
        { count: "exact" },
      )
      .eq("instrument", instrument)
      .eq("timeframe", timeframe)
      .eq("bucket_time", new Date(candle.time * 1000).toISOString())
      .in("status", opts.includeBackfilled ? ["partial", "backfilled"] : ["partial"]);
    if (error) throw new Error(error.message);
    return (count ?? 0) > 0 ? "repaired" : "status-changed";
  }

  /** Health probe: a single cheap select against the table. */
  async ping(): Promise<boolean> {
    const { error } = await this.client.from(this.table).select("id", { count: "exact", head: true }).limit(0);
    return !error;
  }
}

/**
 * @deprecated Legacy name retained so existing Supabase-targeted operational
 * scripts (db-candle-check, etc.) keep working unchanged. New runtime code
 * must use PgCandleStore (or CandleBackend for storage-agnostic wiring).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function
export const CandleStore = SupabaseCandleStore;
export type CandleStore = SupabaseCandleStore;

/**
 * PostgreSQL-backed CandleStore — replaces Supabase/PostgREST for live market
 * data persistence. Implements the SAME {@link CandleBackend} contract so all
 * callers are storage-agnostic. Uses a native `pg` connection POOL and explicit
 * `ON CONFLICT` SQL to preserve the exact idempotency and race-safe backfill
 * semantics of the Supabase layer.
 */
export class PgCandleStore implements CandleBackend {
  /**
   * @param pool A shared `pg.Pool` (process-wide singleton from `getPgPool()`)
   *   — or any {@link PgQueryable} (a transaction-scoped `pg.Client` in tests).
   * @param table The ohlc_candles table name (defaults to `ohlc_candles`).
   */
  constructor(
    private readonly pool: PgQueryable,
    private readonly table: string = "ohlc_candles",
  ) {}

  /** Upsert one CLOSED candle — idempotent via the unique constraint. */
  async saveClosedCandle(
    instrument: string,
    timeframe: string,
    candle: ClosedCandle,
    source: CandleSource,
  ): Promise<void> {
    const bucketTime = new Date(candle.time * 1000).toISOString();
    const status = classifyClosedCandle(candle);
    const sql = `
      INSERT INTO ${this.table}
        (instrument, timeframe, bucket_time, open, high, low, close, tick_count, status, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (instrument, timeframe, bucket_time) DO UPDATE SET
        open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
        close=EXCLUDED.close, tick_count=EXCLUDED.tick_count,
        status=EXCLUDED.status, source=EXCLUDED.source;
    `;
    try {
      await this.pool.query(sql, [
        instrument, timeframe, bucketTime,
        candle.open, candle.high, candle.low, candle.close,
        Number.isFinite(candle.tickCount) ? candle.tickCount : null, status, source,
      ]);
      console.log(
        `[DB CANDLE SAVED]\ninstrument=${instrument}\ntimeframe=${timeframe}\n` +
          `bucket=${bucketTime.slice(11, 19)}\n` +
          `O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}\n` +
          `ticks=${candle.tickCount ?? "-"} status=${status} source=${source} (upsert — idempotent)`,
      );
    } catch (err) {
      console.log(
        `[DB CANDLE SAVE ERROR]\nbucket=${bucketTime}\ninstrument=${instrument}\nerror=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Newest `limit` candles (ascending). Paginated in 1000-row windows. */
  async loadCandles(
    instrument: string, timeframe: string, limit: number, beforeSec?: number,
  ): Promise<PersistedCandle[]> {
    const capped = Math.max(1, Math.min(10000, Math.round(limit) || 500));
    const PAGE = 1000;
    const rows: CandleRow[] = [];
    const cols = "bucket_time,open,high,low,close,tick_count,status";

    for (let offset = 0; offset < capped; offset += PAGE) {
      const fetch = Math.min(PAGE, capped - offset);
      const sql = beforeSec
        ? `SELECT ${cols} FROM ${this.table} WHERE instrument=$1 AND timeframe=$2 AND bucket_time < $3 ORDER BY bucket_time DESC LIMIT $4 OFFSET $5`
        : `SELECT ${cols} FROM ${this.table} WHERE instrument=$1 AND timeframe=$2 ORDER BY bucket_time DESC LIMIT $3 OFFSET $4`;
      const params: unknown[] = beforeSec
        ? [instrument, timeframe, new Date(beforeSec * 1000).toISOString(), fetch, offset]
        : [instrument, timeframe, fetch, offset];
      const { rows: page } = await this.pool.query<CandleRow>(sql, params);
      rows.push(...page);
      if (page.length < fetch) break;
    }
    return rows
      .map((r) => ({
        time: Math.floor(new Date(r.bucket_time).getTime() / 1000),
        open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
        tickCount: r.tick_count ?? null,
        ...(r.status ? { status: r.status as CandleStatus } : {}),
      }))
      .sort((a, b) => a.time - b.time);
  }

  /** Earliest persisted bucket (epoch s) — null when empty. */
  async oldestBucketSec(instrument: string, timeframe: string): Promise<number | null> {
    const sql = `SELECT bucket_time FROM ${this.table} WHERE instrument=$1 AND timeframe=$2 ORDER BY bucket_time ASC LIMIT 1`;
    const { rows } = await this.pool.query<{ bucket_time: string }>(sql, [instrument, timeframe]);
    return rows.length > 0 ? Math.floor(new Date(rows[0].bucket_time).getTime() / 1000) : null;
  }

  /** Rows whose bucket START lies within [fromSec, toSec] (inclusive), ascending. */
  async loadCandlesRange(instrument: string, timeframe: string, fromSec: number, toSec: number): Promise<PersistedCandle[]> {
    const sql = `SELECT bucket_time,open,high,low,close,tick_count,status FROM ${this.table}
                 WHERE instrument=$1 AND timeframe=$2 AND bucket_time >= $3 AND bucket_time <= $4 ORDER BY bucket_time ASC`;
    const { rows } = await this.pool.query<CandleRow>(sql, [
      instrument, timeframe,
      new Date(fromSec * 1000).toISOString(), new Date(toSec * 1000).toISOString(),
    ]);
    return rows.map((r) => ({
      time: Math.floor(new Date(r.bucket_time).getTime() / 1000),
      open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      tickCount: r.tick_count ?? null,
      ...(r.status ? { status: r.status as CandleStatus } : {}),
    }));
  }

  /** Race-safe insert for a MISSING bucket (ON CONFLICT DO NOTHING). */
  async insertIfMissing(instrument: string, timeframe: string, candle: { time: number; open: number; high: number; low: number; close: number }, source: CandleSource = "capital"): Promise<"inserted" | "already-present"> {
    const sql = `INSERT INTO ${this.table} (instrument, timeframe, bucket_time, open, high, low, close, source, status, tick_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'backfilled',NULL)
      ON CONFLICT (instrument, timeframe, bucket_time) DO NOTHING RETURNING 1`;
    const { rows } = await this.pool.query<{ "1"?: number }>(sql, [
      instrument, timeframe, new Date(candle.time * 1000).toISOString(),
      candle.open, candle.high, candle.low, candle.close, source,
    ]);
    return rows.length > 0 ? "inserted" : "already-present";
  }

  /** Race-safe repair for a PARTIAL bucket (conditional UPDATE). */
  async repairIfPartial(instrument: string, timeframe: string, candle: { time: number; open: number; high: number; low: number; close: number }, opts: { includeBackfilled?: boolean; source?: CandleSource } = {}): Promise<"repaired" | "status-changed"> {
    // EXACT Supabase-layer semantics: `completed` candles are NEVER overwritten
    // by the backfill (the planner always protects them). `--force` extends the
    // repair to `backfilled` rows only — never to `completed`.
    const allowed = opts.includeBackfilled ? ["partial", "backfilled"] : ["partial"];
    const sql = `UPDATE ${this.table} SET open=$1,high=$2,low=$3,close=$4,tick_count=NULL,status='backfilled',source=$5
      WHERE instrument=$6 AND timeframe=$7 AND bucket_time=$8 AND status = ANY($9) RETURNING 1`;
    const { rows } = await this.pool.query<{ "1"?: number }>(sql, [
      candle.open, candle.high, candle.low, candle.close, opts.source ?? "capital",
      instrument, timeframe, new Date(candle.time * 1000).toISOString(), allowed,
    ]);
    return rows.length > 0 ? "repaired" : "status-changed";
  }

  /**
   * Bounded multi-row HISTORICAL insert — the Capital historical downloader's
   * write path (insertIfMissing's idempotency, batched):
   *
   *   INSERT … VALUES (…), (…), …
   *   ON CONFLICT (instrument, timeframe, bucket_time) DO NOTHING
   *   RETURNING bucket_time
   *
   * Every row carries status='backfilled' + the caller's `source` (the Capital
   * downloader passes 'capital'). DO NOTHING = first writer wins: existing
   * completed/partial/live rows and earlier backfill rows are NEVER
   * overwritten — the conservative historical-import preference. Conflicts
   * return nothing, so {inserted, skipped} is derived from RETURNING and a
   * re-run (or an interrupted run) is an exact no-op for present buckets.
   */
    async insertBackfilledBatch(
    instrument: string,
    timeframe: string,
    rows: ReadonlyArray<{ time: number; open: number; high: number; low: number; close: number }>,
    source: CandleSource = "capital",
  ): Promise<{ inserted: number; skipped: number }> {
    // 8 placeholders per row (7 columns + source) + shared literals — 1000 rows
    // ≈ 8 000 parameters, far under the 65 535 protocol limit, so each chunk is
    // ONE statement = one atomic batch (never one transaction per candle).
    const CHUNK = 1000;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((r, k) => {
        const b = k * 8;
        values.push(
          instrument, timeframe, new Date(r.time * 1000).toISOString(),
          r.open, r.high, r.low, r.close, source,
        );
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},'backfilled',NULL)`;
      });
      const sql = `
        INSERT INTO ${this.table}
          (instrument, timeframe, bucket_time, open, high, low, close, source, status, tick_count)
        VALUES ${tuples.join(",")}
        ON CONFLICT (instrument, timeframe, bucket_time) DO NOTHING
        RETURNING bucket_time;
      `;
      const { rows: returned } = await this.pool.query<{ bucket_time: string }>(sql, values);
      inserted += returned.length;
    }
    return { inserted, skipped: rows.length - inserted };
  }

  /** Health probe: SELECT 1 FROM table WHERE FALSE. */
  async ping(): Promise<boolean> {
    try { await this.pool.query(`SELECT 1 FROM ${this.table} WHERE FALSE`); return true; }
    catch { return false; }
  }
}