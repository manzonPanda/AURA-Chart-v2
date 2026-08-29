/**
 * Market calendar + bucket-grid helpers for gap detection (Stage 2 — read-only).
 *
 * DELETING nothing from the pipeline: this module only ANSWERS the question
 * "was the market expected to trade during bucket B?" so that missing-candle
 * detection never mistakes legitimate closures for data loss. It is pure
 * (no I/O, no clock reads) and therefore fully unit-testable offline.
 *
 * Calendar: IG "Germany 40" CFD. Dealing hours per IG's public market
 * information are quoted in UK time: Mon–Fri 01:10–05:00 and 08:00–21:00
 * (daily break 05:00–08:00 UK), closed weekends and exchange holidays.
 * Windows are stored as London WALL-CLOCK minutes and evaluated per instant
 * through Intl with the Europe/London zone — DST-safe by construction
 * (August: 08:00 London = 07:00 UTC; December: 08:00 London = 08:00 UTC).
 *
 * Extensibility: to refine later, edit ONLY the data below (or add calendars)
 * — `windowsByWeekday` supports per-day rules and `closedDates` supports
 * per-date full closures. No detector code needs to change.
 */

/** Trading window in calendar-timezone wall clock, minutes since midnight. */
export interface MarketWindow {
  /** Inclusive opening minute (e.g. 01:10 → 70). */
  openMin: number;
  /** Exclusive closing minute (e.g. 05:00 → 300). */
  closeMin: number;
}

export interface MarketCalendar {
  id: string;
  label: string;
  /** IANA zone the dealing hours are quoted in. */
  timezone: string;
  /** ISO weekday (1=Mon … 7=Sun) → trading windows in `timezone` wall clock. */
  windowsByWeekday: Readonly<Record<number, readonly MarketWindow[]>>;
  /** Full closure dates ('YYYY-MM-DD' in `timezone`). Extensible seed list. */
  closedDates: readonly string[];
}

const DAX_SESSION_WINDOWS: readonly MarketWindow[] = [
  { openMin: 1 * 60 + 10, closeMin: 5 * 60 }, // 01:10–05:00 UK (overnight futures)
  { openMin: 8 * 60, closeMin: 21 * 60 }, //    08:00–21:00 UK (main session)
];

/**
 * Exchange holidays observed by DAX/IG (Xetra full closures). Seed covers
 * 2025–2026. Deliberately EXCLUDES half-days (Dec 24 / Dec 31): IG often still
 * quotes part of those days, so flagging a collector outage there is the
 * safer direction for a gap detector. Correct/extend as needed.
 */
const CLOSED_DATES_2025_2026: readonly string[] = [
  "2025-01-01", "2025-04-18", "2025-04-21", "2025-05-01", "2025-10-03", "2025-12-25", "2025-12-26",
  "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-01", "2026-10-03", "2026-12-25", "2026-12-26",
];

/** IG Germany 40 CFD calendar (single source for the gap detector). */
export const IG_GERMANY_40: MarketCalendar = {
  id: "ig-germany-40",
  label: "IG Germany 40 (DAX) CFD",
  timezone: "Europe/London",
  windowsByWeekday: { 1: DAX_SESSION_WINDOWS, 2: DAX_SESSION_WINDOWS, 3: DAX_SESSION_WINDOWS, 4: DAX_SESSION_WINDOWS, 5: DAX_SESSION_WINDOWS, 6: [], 7: [] },
  closedDates: CLOSED_DATES_2025_2026,
};

// ── Wall-clock conversion (Intl-based, DST-safe) ────────────────────────────

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const weekdayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" });
const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface LondonParts {
  /** 'YYYY-MM-DD' in Europe/London. */
  date: string;
  /** ISO weekday 1=Mon … 7=Sun. */
  weekday: number;
  /** Minutes since London midnight. */
  minutes: number;
}

/** London wall-clock parts for an epoch-ms instant. */
export function londonParts(ms: number): LondonParts {
  const parts = dateFmt.formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const wd = weekdayFmt.format(new Date(ms)).slice(0, 3);
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAY_INDEX[wd] ?? 7,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const inAnyWindow = (parts: LondonParts, cal: MarketCalendar): boolean => {
  if (cal.closedDates.includes(parts.date)) return false;
  return (cal.windowsByWeekday[parts.weekday] ?? []).some(
    (w) => parts.minutes >= w.openMin && parts.minutes < w.closeMin,
  );
};

/**
 * True when the 3-minute bucket starting at `bucketSec` overlaps any trading
 * window: a bucket is expected if its START or its LAST instant falls inside a
 * window of a non-closed trading day. This naturally admits the bucket that
 * contains a mid-grid session open (e.g. 01:10 London opens inside the
 * 01:09–01:12 bucket) and rejects everything inside the daily break, weekends
 * and holidays. All instants are UTC epoch; conversion is display-only.
 */
export function isBucketExpected(bucketSec: number, cal: MarketCalendar): boolean {
  const startMs = bucketSec * 1000;
  const start = londonParts(startMs);
  // Last instant of the bucket (start+180s−1ms) so window opens INSIDE the
  // bucket count as expected.
  const last = londonParts(startMs + 179_999);
  if (cal.closedDates.includes(start.date) || cal.closedDates.includes(last.date)) return false;
  return inAnyWindow(start, cal) || inAnyWindow(last, cal);
}