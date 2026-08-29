/**
 * AURA Chart is a single 3-minute timeframe (aggressive simplification).
 * No timeframe selector; no other resolutions.
 */
export const CHART_RESOLUTION = "MINUTE_3";
export const BUCKET_SEC = 180; // 3 minutes
/**
 * How many persisted 3-minute candles to load from Supabase on page load
 * (GET /api/candles/db). 500 × 3 min ≈ 25 hours of history. History is
 * optional — realtime never depends on it. IG historical REST (max 500
 * points/request) is no longer the page-history source; it may serve as a
 * future bootstrap/backfill source only.
 */
export const HISTORY_LIMIT = 500;

export const INSTRUMENT_LABEL = "DAX / IG";