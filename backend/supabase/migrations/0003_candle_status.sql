-- 0003_candle_status.sql
--
-- Stage 1: candle status classification.
--
--   status = 'partial'     collector joined AFTER the bucket began (restart /
--                          reconnect mid-bucket) — first tick anchored late;
--                          eligible for future IG backfill repair.
--   status = 'completed'   collector had coverage from the bucket boundary
--                          (normal live close, or rows predating this system).
--   status = 'backfilled'  reserved for the future IG historical backfill job
--                          (not implemented yet — schema-ready).
--
-- LIVE is deliberately NOT a stored state: the forming candle lives only in
-- memory (CandleAggregator) and enters the DB only at rollover.
--
-- Classification is TIME-based (firstTickMs - bucketStart), never tick_count —
-- a quiet market can legitimately produce few ticks. The rule itself lives in
-- backend/src/db/candleStore.ts (classifyClosedCandle, 5s tolerance).

alter table public.ohlc_candles
    add column if not exists status text not null default 'completed';

-- CHECK constraint, added idempotently (safe to re-run).
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'ohlc_candles_status_check' and conrelid = 'public.ohlc_candles'::regclass
    ) then
        alter table public.ohlc_candles
            add constraint ohlc_candles_status_check
            check (status in ('partial', 'completed', 'backfilled'));
    end if;
end;
$$;

-- Existing rows predate the status system — they all read as 'completed'
-- (the NOT NULL DEFAULT backfills them automatically on ADD COLUMN).
comment on column public.ohlc_candles.status is
    'partial | completed | backfilled. partial = first tick anchored >5s after the bucket boundary (restart/reconnect mid-bucket). completed = full coverage from the boundary. backfilled = repaired/inserted from IG historical (future stage).';

-- Future gap-detection / backfill queries filter by (instrument, timeframe, status).
create index if not exists ohlc_candles_status_idx
    on public.ohlc_candles (instrument, timeframe, status);

-- Refresh the Manila display view with status appended (column order of the
-- existing columns is unchanged).
drop view if exists public.ohlc_candles_pht;

create view public.ohlc_candles_pht
with (security_invoker = true) as
select
    id,
    instrument,
    timeframe,
    -- Absolute UTC instant — the chart bucket anchor. Do NOT localize.
    bucket_time,

    -- Manila wall-clock rendering of the two system timestamps.
    (created_at at time zone 'Asia/Manila') as created_at_pht,
    (updated_at at time zone 'Asia/Manila') as updated_at_pht,

    -- The untouched absolute instants, for side-by-side comparison.
    created_at,
    updated_at,

    open,
    high,
    low,
    close,
    tick_count,
    source,
    status
from public.ohlc_candles;

comment on view public.ohlc_candles_pht is
    'ohlc_candles with created_at/updated_at ALSO rendered as Asia/Manila (UTC+8) wall-clock (created_at_pht / updated_at_pht). bucket_time remains the absolute UTC instant. Includes candle status (partial/completed/backfilled). Underlying storage is not modified.';