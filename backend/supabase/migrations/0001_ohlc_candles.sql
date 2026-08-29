-- 0001_ohlc_candles.sql — AURA-Chart completed-candle persistence.
--
-- One row per COMPLETED candle, keyed by (instrument, timeframe, bucket_time).
-- The UNIQUE constraint + backend UPSERT make every write idempotent:
-- replays, reconnects and post-restart re-closes can never create duplicates.
--
-- Apply via: Supabase SQL editor (paste) or `npm --prefix backend run db:migrate`
-- with SUPABASE_DB_URL set. Safe to run repeatedly (all statements are guarded).
--
-- Access model: the backend writes with the service-role key (RLS is bypassed).
-- If you later want the browser to read this table directly, add SELECT
-- policies — deliberately NOT added here (the backend proxies history today).

create table if not exists public.ohlc_candles (
    id uuid primary key default gen_random_uuid(),

    instrument text not null,
    timeframe text not null,

    -- Bucket START in UTC (epoch seconds / 1000 ISO). E.g. 09:06:00Z covers
    -- 09:06:00–09:08:59.999 — matches the live aggregator's floor(ts/180).
    bucket_time timestamptz not null,

    open numeric not null,
    high numeric not null,
    low numeric not null,
    close numeric not null,

    -- Diagnostics: ticks aggregated into this candle. A post-restart candle
    -- that resumed mid-bucket has a low count — identifiable and backfillable.
    tick_count integer,

    source text not null default 'ig',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    unique (instrument, timeframe, bucket_time)
);

-- History loads always filter by (instrument, timeframe) and order by
-- bucket_time; the unique constraint already serves ascending lookups, this
-- covers the descending newest-N query.
create index if not exists ohlc_candles_newest_idx
    on public.ohlc_candles (instrument, timeframe, bucket_time desc);

-- Keep updated_at fresh on every upsert (INSERT..ON CONFLICT DO UPDATE fires
-- the UPDATE trigger).
create or replace function public.ohlc_candles_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists ohlc_candles_touch on public.ohlc_candles;
create trigger ohlc_candles_touch
    before update on public.ohlc_candles
    for each row
    execute function public.ohlc_candles_touch_updated_at();