/**
 * Historical chart horizon — calendar-aware PAGE PLANNING for the INITIAL
 * history load (Option B from the investigation: chain the existing
 * before-cursor pagination until the selected horizon's trading time is
 * covered; "Load More History" keeps its own fixed page size on top). Pure
 * and framework-free (Node-testable) — App.tsx owns the fetch loop, exactly
 * like historyPagination.ts.
 *
 * Session awareness: the horizon NEVER means "days × 24 × 60 candles". The
 * target candle count is derived from the ACTIVE instrument's market calendar
 * (per-weekday trading windows + closed dates — served by GET /api/instruments
 * and the SAME calendar the future-horizon whitespace builder and the backend
 * gap detector trust), so DAX (≈ 1,010 min/session-day Mon–Fri) and Gold/Silver
 * (≈ 1,320 min/day + the Sunday open) each get approximately N WEEKS of THEIR
 * OWN trading time. The result is a page COUNT; each page stays at the fixed
 * HISTORY_LIMIT size, so every request remains far below the backend's
 * 10,000-row ceiling.
 *
 * No calendar (catalog still loading / unreachable): falls back to the
 * pre-horizon SINGLE-PAGE behavior — the next epic/timeframe/horizon-resolved
 * reload re-plans with the real calendar, so the fallback never over-fetches.
 */
import {
  historyHorizonDays,
  type HistoryHorizonKey,
} from "../config/chart.ts";
import { zoneParts } from "./marketCalendar.ts";

/** Safety ceiling for ONE horizon load (Silver 1m × 1 month ≈ 21 pages at the
 *  registry page size; the ceiling also guards exotic/edge calendars). */
export const MAX_HISTORY_PAGES = 24;

/** Structural calendar subset the planner reads (satisfied by the instrument
 *  registry's `calendar` and by marketCalendar.ts `HorizonCalendar`). */
export interface HistoryCalendar {
  timezone: string;
  windowsByWeekday: Readonly<Record<number, readonly { openMin: number; closeMin: number }[]>>;
  closedDates: readonly string[];
}

export interface HistoryPagePlan {
  /** Number of fixed-size pages to request (the newest page first). */
  requests: number;
  /** Expected TRADING minutes covered by the lookback window (0 when no
   *  calendar is available — the single-page fallback). */
  targetMinutes: number;
  /** Expected candles at the selected timeframe's bucket width (fractional —
   *  the page count is the rounded-up, clamped consumer of this). */
  targetCandles: number;
}

const DAY_MS = 86_400_000;

/** First instant (epoch ms) of the local day labeled `date` in `timezone` —
 *  DST-safe via a bounded binary search + minute-accurate back-off, memoized. */
const dayStartCache = new Map<string, number>();
function localDayStartMs(date: string, timezone: string): number {
  const key = `${timezone}|${date}`;
  const cached = dayStartCache.get(key);
  if (cached !== undefined) return cached;
  const naive = Date.parse(`${date}T00:00:00`); // UTC-midnight label — only a guess
  // Smallest instant within ±80 h whose zone date >= target (ISO date strings
  // compare lexicographically while the day is still rolling over).
  let lo = naive - 80 * 3_600_000;
  let hi = naive + 80 * 3_600_000;
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (zoneParts(mid, timezone).date >= date) hi = mid;
    else lo = mid;
  }
  let ms = hi;
  let guard = 0;
  while (guard++ < 1500 && zoneParts(ms - 60_000, timezone).date === date) ms -= 60_000;
  while (guard++ < 1500 && zoneParts(ms, timezone).date !== date) ms += 60_000;
  dayStartCache.set(key, ms);
  return ms;
}

/** Label of the FOLLOWING local day (UTC label arithmetic is fine — labels are
 *  only keys for localDayStartMs, which resolves the true DST-aware boundary). */
function nextLocalDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Expected TRADING minutes covered by [fromMs, toMs] under `cal`: per local
 * day only the portion of each trading window inside the clipped day slice
 * counts; full/partial closure dates contribute 0. O(days × windows) with a
 * memoized local-midnight finder — trivially cheap for ≤ 31 days.
 */
export function expectedTradingMinutes(
  cal: HistoryCalendar,
  fromMs: number,
  toMs: number,
): number {
  if (!cal || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  const timezone = cal.timezone;
  if (!timezone) return 0;
  let total = 0;
  let ms = localDayStartMs(zoneParts(fromMs, timezone).date, timezone);
  let guard = 0;
  while (ms <= toMs && guard++ < 64) {
    const parts = zoneParts(ms, timezone);
    const windows = cal.windowsByWeekday[parts.weekday] ?? [];
    const dayEndMs = localDayStartMs(nextLocalDate(parts.date), timezone);
    if (!cal.closedDates.includes(parts.date)) {
      const fromMin = Math.max(0, (fromMs - ms) / 60_000);
      const toMin = Math.min(24 * 60, (toMs - ms) / 60_000);
      for (const w of windows) {
        const s = Math.max(w.openMin, fromMin);
        const e = Math.min(w.closeMin, toMin);
        if (e > s) total += e - s;
      }
    }
    ms = dayEndMs > ms ? dayEndMs : ms + DAY_MS; // absolute walk guard
  }
  return total;
}

/**
 * Page plan for one horizon over the active instrument's calendar.
 * `nowMs` is explicit so tests are deterministic; App passes Date.now().
 */
export function historyHorizonPages(opts: {
  horizon: HistoryHorizonKey;
  /** Active instrument calendar — null → single-page (pre-horizon) behavior. */
  calendar: HistoryCalendar | null;
  /** Selected timeframe bucket width in seconds (1m → 60, 3m → 180). */
  bucketSec: number;
  /** Fixed page size — HISTORY_LIMIT for both the initial load and Load More. */
  pageSize: number;
  /** Anchor of the lookback window (epoch ms). */
  nowMs: number;
}): HistoryPagePlan {
  const days = historyHorizonDays(opts.horizon);
  if (!opts.calendar) {
    return { requests: 1, targetMinutes: 0, targetCandles: 0 };
  }
  const fromMs = opts.nowMs - days * DAY_MS;
  const targetMinutes = expectedTradingMinutes(opts.calendar, fromMs, opts.nowMs);
  const bucketMinutes = Math.max(1, opts.bucketSec > 0 ? opts.bucketSec / 60 : 60);
  const pageSize = Math.max(1, Math.round(opts.pageSize) || 1);
  const targetCandles = targetMinutes / bucketMinutes;
  const requests = Math.max(1, Math.min(MAX_HISTORY_PAGES, Math.ceil(targetCandles / pageSize)));
  return { requests, targetMinutes, targetCandles };
}