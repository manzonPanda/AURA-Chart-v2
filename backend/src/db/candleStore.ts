import type { SupabaseClient } from "@supabase/supabase-js";
import type { CandleStatus, ClosedCandle } from "../streaming/types.js";

/** Raw ohlc_candles row (PostgREST returns `numeric` as string). */
interface CandleRow {
  bucket_time: string;
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
export class CandleStore {
  constructor(
    private readonly client: SupabaseClient,
    private readonly table: string,
  ) {}

  async saveClosedCandle(
    instrument: string,
    timeframe: string,
    candle: ClosedCandle,
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
            source: "ig",
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
          `ticks=${candle.tickCount ?? "-"} status=${status} (upsert — idempotent)`,
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
   */
  async loadCandles(
    instrument: string,
    timeframe: string,
    limit: number,
  ): Promise<PersistedCandle[]> {
        const capped = Math.max(1, Math.min(10000, Math.round(limit) || 500));
    const { data, error } = await this.client
      .from(this.table)
      .select("bucket_time,open,high,low,close,tick_count,status")
      .eq("instrument", instrument)
      .eq("timeframe", timeframe)
      .order("bucket_time", { ascending: false })
      .limit(capped);

    if (error) throw new Error(error.message);

    const rows = (data ?? []) as unknown as CandleRow[];
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
   * Stage 3 backfill — RACE-SAFE insert for a MISSING bucket.
   *
   * Atomic in Postgres: with `ignoreDuplicates` + the unique constraint the
   * insert lands ONLY if the bucket is still absent at write time. If the
   * realtime collector closed that very bucket between the gap scan and this
   * write (bucket became `completed`), the insert is silently ignored and the
   * live candle is protected. Provenance: status='backfilled',
   * source='ig_historical'. tick_count is null (no realtime ticks involved).
   */
  async insertIfMissing(
    instrument: string,
    timeframe: string,
    candle: { time: number; open: number; high: number; low: number; close: number },
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
          source: "ig_historical",
        },
        // upsert + ignoreDuplicates → INSERT … ON CONFLICT DO NOTHING: the row
        // lands ONLY if the bucket is still absent (count=0 ⇒ was not missing).
        { onConflict: "instrument,timeframe,bucket_time", ignoreDuplicates: true, count: "exact" },
      );
    if (error) throw new Error(error.message);
    return (count ?? 0) > 0 ? "inserted" : "already-present";
  }

  /**
   * Stage 3 backfill — RACE-SAFE repair for a PARTIAL bucket.
   *
   * Atomic conditional UPDATE: matches only while the row's status is still
   * `partial` (plus `backfilled` when `includeBackfilled`/--force). If the
   * bucket became `completed` after the gap scan, zero rows match and the
   * completed candle is untouched. OHLC is replaced wholesale with the
   * IG-derived candle; status/source become backfilled/ig_historical.
   */
  async repairIfPartial(
    instrument: string,
    timeframe: string,
    candle: { time: number; open: number; high: number; low: number; close: number },
    opts: { includeBackfilled?: boolean } = {},
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
          source: "ig_historical",
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
}