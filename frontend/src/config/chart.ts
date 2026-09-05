/**
 * AURA Chart timeframes — the frontend selector (1m | 3m).
 *
 * 1m  → history from Supabase persisted MINUTE_1 rows; live stream from the
 *       backend 1m aggregator (the canonical persisted frame).
 * 3m  → history DERIVED on read from persisted 1m rows (backend aggregates);
 *       live forming candle from the backend in-memory 3m overlay (never
 *       persisted, never a separate stored series).
 *
 * The key here MUST mirror the backend registry (backend/src/streaming/
 * timeframes.ts — server is the single source of truth); this table only
 * drives the UI selector and the WS `res=` parameter.
 */
export const TIMEFRAMES = [
  { key: "MINUTE_1", label: "1m", bucketSec: 60 },
  { key: "MINUTE_3", label: "3m", bucketSec: 180 },
] as const;

export type TimeFrameKey = (typeof TIMEFRAMES)[number]["key"];

/** Default selection preserves the historic 3m-first chart experience. */
export const DEFAULT_TIME_FRAME: TimeFrameKey = "MINUTE_3";

/**
  * How many candles (of the SELECTED timeframe) to load from Supabase on page
 * load (GET /api/candles/db). 2,000 × 1m ≈ 1.5 trading days (covers
 * yesterday + today for DAX); 2,000 × 3m ≈ 3 trading days. The window is
 * bounded so refreshes don't load the entire table. IG historical REST
 * (max 500 points/request) is no longer the page-history source; it may serve
 * as a future bootstrap/backfill source only.
 */
export const HISTORY_LIMIT = 2000;

export const INSTRUMENT_LABEL = "DAX / IG";