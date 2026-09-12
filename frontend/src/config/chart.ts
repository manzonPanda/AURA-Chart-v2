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
 * HISTORY HORIZON — how much TRADING history the chart loads on initial load
 * / history synchronization. Deliberately NOT a raw candle count and NOT a
 * naive "days × 24 × 60": services/historyHorizon.ts converts the selected
 * horizon into a number of fixed-size OLDER pages (page size = HISTORY_LIMIT)
 * using the ACTIVE instrument's market calendar (DAX ≈ 1,010 min/session-day
 * Mon–Fri; Gold/Silver ≈ 1,320 min/day + the Sunday open), so each market gets
 * approximately N WEEKS of ITS OWN sessions.
 *
 * Default: 2w — enough historical candles for killzone/DOL PineScripts to see
 * the previous sessions' high/low without pressing Load More. 3w and 1m are
 * opt-in. "Load More History" is UNAFFECTED: it keeps fetching the next
 * fixed-size older page via before=<oldestLoadedTs>.
 */
export const HISTORY_HORIZONS = [
  // key | label                | calendar days spanned
  { key: "1w", label: "1 Week", days: 7 },
  { key: "2w", label: "2 Weeks", days: 14 },
  { key: "3w", label: "3 Weeks", days: 21 },
  { key: "1m", label: "1 Month", days: 30 },
] as const;

export type HistoryHorizonKey = (typeof HISTORY_HORIZONS)[number]["key"];

/** Default history horizon — two weeks of the market's trading time. */
export const DEFAULT_HISTORY_HORIZON: HistoryHorizonKey = "2w";

/** Corrupted/unknown stored horizons fall back to the default (sanitize-safe). */
export function sanitizeHistoryHorizon(raw: unknown): HistoryHorizonKey {
  return typeof raw === "string" && HISTORY_HORIZONS.some((h) => h.key === raw)
    ? (raw as HistoryHorizonKey)
    : DEFAULT_HISTORY_HORIZON;
}

/** Calendar days a horizon key spans (7 / 14 / 21 / 30). */
export function historyHorizonDays(key: HistoryHorizonKey): number {
  for (const h of HISTORY_HORIZONS) {
    if (h.key === key) return h.days;
  }
  return 14; // unreachable for valid keys — DEFAULT_HISTORY_HORIZON = 2w
}

/**
 * PAGE SIZE for the persisted-candle history endpoint (GET /api/candles/db):
 * every request — the initial horizon load AND each "Load More History" click
 * — fetches at most this many candles of the SELECTED timeframe. Deliberately
 * NOT the amount loaded on page load: the HISTORY_HORIZON above decides that,
 * as a count of these fixed-size pages (so every request stays comfortably
 * below the backend's 10,000-row ceiling; 2,000 × 1m ≈ 1.5 trading days).
 */
export const HISTORY_LIMIT = 2000;

export const INSTRUMENT_LABEL = "DAX / IG";

/**
 * Gold EPIC constant — the canonical Spot Gold (SGD1 Contract) EPIC.
 * Reuses the SAME epic string as the backend registry
 * (backend/src/market/instruments.ts GOLD_INSTRUMENT.epic) so there is
 * exactly one definition; the frontend only carries it so a fresh browser
 * can start on Gold before the instrument catalog arrives.
 */
export const GOLD_INSTRUMENT_EPIC = "CS.D.CFIGOLD.CFI.IP";

/**
 * Instruments the UI dropdown offers to users. DAX remains fully supported
 * by the backend/API/database (historical rows stay queryable), but it is
 * hidden from the selector to prevent accidental selection. This is a
 * UI-level exclusion only — no backend, schema, or data changes.
 */
export const HIDDEN_INSTRUMENT_EPICS = new Set<string>(["IX.D.DAX.IGM.IP"]);