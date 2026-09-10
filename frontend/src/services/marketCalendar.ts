/**
 * Frontend mirror of the backend market calendar primitives
 * (backend/src/market/calendar.ts) — single-source-of-truth contract:
 * the calendar DATA is served by GET /api/instruments (backend truth, never
 * hardcoded client-side); this module only re-implements the pure evaluation
 * logic (zoneParts / isBucketExpected) plus the session-aware future-horizon
 * builder for the trailing whitespace axis.
 *
 * DST-safe by construction: wall-clock windows are evaluated per instant
 * through Intl with the calendar's own IANA zone (August 08:00 London = 07:00
 * UTC, December = 08:00 UTC — both handled).
 */

/** Mirror of backend MarketWindow (services/instruments.ts shape). */
export interface HorizonWindow {
  openMin: number;
  closeMin: number;
}

/** Minimal structural calendar — satisfied by InstrumentCalendarInfo. */
export interface HorizonCalendar {
  timezone: string;
  windowsByWeekday: Readonly<Record<number, readonly HorizonWindow[]>>;
  closedDates: readonly string[];
}

export interface ZoneParts {
  /** 'YYYY-MM-DD' in the calendar zone. */
  date: string;
  /** ISO weekday 1=Mon … 7=Sun. */
  weekday: number;
  /** Minutes since zone midnight. */
  minutes: number;
}

/** ~24h of future TRADING time registered on the axis. */
export const FUTURE_HORIZON_MS = 86_400_000;
/** Weekend/holiday tail: always keep at least this many future slots. */
export const MIN_TAIL_SLOTS = 8;
/** Tail rule hard cap (days scanned beyond the horizon). */
export const MAX_TAIL_DAYS = 7;
/** Absolute slot ceiling — never an unbounded future dataset. */
export const MAX_FUTURE_SLOTS = 6000;

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const zoneFmtCache = new Map<string, { date: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat }>();

function zoneFormatters(timezone: string): { date: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat } {
  let fmts = zoneFmtCache.get(timezone);
  if (!fmts) {
    fmts = {
      date: new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }),
      weekday: new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short" }),
    };
    zoneFmtCache.set(timezone, fmts);
  }
  return fmts;
}

/** Wall-clock parts of an epoch-ms instant in the given IANA zone (byte-equal
 *  to the backend primitive of the same name). */
export function zoneParts(ms: number, timezone: string): ZoneParts {
  const { date: dateFmt, weekday: weekdayFmt } = zoneFormatters(timezone);
  const parts = dateFmt.formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const wd = weekdayFmt.format(new Date(ms)).slice(0, 3);
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAY_INDEX[wd] ?? 7,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const inAnyWindow = (parts: ZoneParts, cal: HorizonCalendar): boolean => {
  if (cal.closedDates.includes(parts.date)) return false;
  return (cal.windowsByWeekday[parts.weekday] ?? []).some(
    (w) => parts.minutes >= w.openMin && parts.minutes < w.closeMin,
  );
};

/** True when the bucket starting at `bucketStartSec` (width `bucketWidthSec`)
 *  overlaps any trading window — byte-equal to the backend primitive: a bucket
 *  is expected if its START or its LAST instant falls inside a window of a
 *  non-closed day (admits a mid-grid session open; rejects breaks/weekends/
 *  holidays). */
export function isBucketExpected(
  bucketStartSec: number,
  cal: HorizonCalendar,
  bucketWidthSec: number = 60,
): boolean {
  const startMs = bucketStartSec * 1000;
  const start = zoneParts(startMs, cal.timezone);
  const last = zoneParts(startMs + Math.max(1, Math.round(bucketWidthSec)) * 1000 - 1, cal.timezone);
  if (cal.closedDates.includes(start.date) || cal.closedDates.includes(last.date)) return false;
  return inAnyWindow(start, cal) || inAnyWindow(last, cal);
}

/**
 * Session-aware future horizon: the bucket-aligned, expected-only timestamps
 * for the next ~24h of TRADING time after `lastTsMs`, excluding daily breaks,
 * weekends and holidays (labels there would be fiction — same calendar the
 * gap detector trusts). Weekend/holiday anchors: the tail rule extends
 * day-by-day until ≥ MIN_TAIL_SLOTS expected slots exist, capped at
 * MAX_TAIL_DAYS days and MAX_FUTURE_SLOTS slots — deterministic, bounded.
 */
export function buildFutureHorizon(
  cal: HorizonCalendar,
  lastTsMs: number,
  bucketSec: number,
): number[] {
  if (!cal || !Number.isFinite(bucketSec) || bucketSec <= 0 || !Number.isFinite(lastTsMs)) return [];
  const bucketMs = bucketSec * 1000;
  const anchor = Math.floor(lastTsMs / bucketMs) * bucketMs;
  const slots: number[] = [];
  const collect = (fromMs: number, toMs: number): boolean => {
    for (let t = fromMs; t <= toMs; t += bucketMs) {
      if (slots.length >= MAX_FUTURE_SLOTS) return false;
      if (isBucketExpected(Math.floor(t / 1000), cal, bucketSec)) slots.push(t);
    }
    return true;
  };
  if (!collect(anchor + bucketMs, anchor + FUTURE_HORIZON_MS)) return slots;
  // Tail rule (weekend/holiday anchors): extend until ≥ MIN_TAIL_SLOTS.
  for (let day = 2; day <= MAX_TAIL_DAYS && slots.length < MIN_TAIL_SLOTS; day++) {
    if (!collect(anchor + (day - 1) * FUTURE_HORIZON_MS + bucketMs, anchor + day * FUTURE_HORIZON_MS)) break;
  }
  return slots;
}
