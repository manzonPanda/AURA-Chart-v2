-- 0002_candle_timestamps_manila.sql
--
-- Display convention for ohlc_candles timestamps:
--
--   bucket_time             -> ALWAYS the absolute UTC instant (chart
--                              alignment, 3-minute bucket math). Untouched.
--   created_at / updated_at -> remain `timestamptz` absolute instants in
--                              storage (NOT converted, no +8 hardcoded), but
--                              are DISPLAYED as Asia/Manila (UTC+8) via the
--                              read-only view `ohlc_candles_pht` below.
--
-- Why a view instead of `ALTER DATABASE ... SET timezone`:
--   timestamptz has no per-column timezone — its display follows the session
--   TimeZone. Changing the database/session default would also flip the
--   DISPLAY of bucket_time (and every other timestamptz) to +08, which is
--   explicitly not wanted. A per-column rendering via `at time zone
--   'Asia/Manila'` is the clean PostgreSQL idiom: it is evaluated at READ
--   time, so future rows are automatically correct, no application code adds
--   hours anywhere, and the named zone (not a fixed offset) stays correct even
--   if the timezone rules ever change.

drop view if exists public.ohlc_candles_pht;

create view public.ohlc_candles_pht
with (security_invoker = true) as
select
    id,
    instrument,
    timeframe,
    -- Absolute UTC instant — the chart bucket anchor. Do NOT localize.
    bucket_time,

    -- Manila wall-clock rendering of the two system timestamps
    -- (`timestamptz at time zone 'Asia/Manila'` -> timestamp without tz).
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
    source
from public.ohlc_candles;

comment on view public.ohlc_candles_pht is
    'ohlc_candles with created_at/updated_at ALSO rendered as Asia/Manila (UTC+8) wall-clock (created_at_pht / updated_at_pht). bucket_time remains the absolute UTC instant. Underlying storage is not modified.';

comment on column public.ohlc_candles.bucket_time is
    '3-minute market bucket START — absolute UTC instant (timestamptz). Used for chart alignment; never convert to local time.';

comment on column public.ohlc_candles.created_at is
    'Row creation instant (timestamptz, absolute). Display in PH time via view ohlc_candles_pht.created_at_pht.';

comment on column public.ohlc_candles.updated_at is
    'Row last-write instant (timestamptz, absolute, maintained by trigger ohlc_candles_touch). Display in PH time via view ohlc_candles_pht.updated_at_pht.';