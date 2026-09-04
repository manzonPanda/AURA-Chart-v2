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

// ── Gold (Spot) ──────────────────────────────────────────────────────────────
// IG "Spot Gold (SGD1 Contract)" — CS.D.CFIGOLD.CFI.IP. IG's gold CFD follows
// the CME Globex precious-metals schedule quoted in UK wall-clock time:
// Sunday open 23:00, Friday close 22:00, with a DAILY 1-hour break
// 22:00–23:00. US and UK DST shift together, so these wall-clock windows hold
// year-round (no dead-zone months).
//
// VERIFICATION STATUS (Phase 0, 2026-09-04):
//   - EPIC + name + currency + precision confirmed against the LIVE account
//     via GET /markets/{epic} (npm run ig:market-check): "Spot Gold (SGD1
//     Contract)", SGD, 2-decimal quoting (bid 4467.47 / offer 4467.97).
//   - IG's REST served openingHours=null on this gateway (v1 and v3) and the
//     public market pages render client-side, so the WINDOW DATA below is the
//     Globex-aligned IG schedule, cross-checked empirically: the market was
//     live-quoting during a London window this seed marks OPEN.
//   - The gap detector's failure mode for an unmodelled closure is a flagged
//     "missing" bucket (conservative noise, never data corruption), and this
//     seed is pure DATA — refine it here (no detector changes) as IG's hours
//     are confirmed across weekends/breaks.
const GOLD_DAY_WINDOWS: readonly MarketWindow[] = [
  { openMin: 0, closeMin: 22 * 60 }, // 00:00–22:00 UK (until the daily break)
];
const GOLD_SUNDAY_WINDOWS: readonly MarketWindow[] = [
  { openMin: 23 * 60, closeMin: 24 * 60 }, // 23:00–24:00 UK (Globex week open)
];

/**
 * Full closures for Gold (CME Globex precious metals — NO trading). Unlike the
 * DAX list, German-only holidays (May 1 / Oct 3) are NOT gold closures, and
 * Easter Monday is a normal Globex day. Deliberately EXCLUDES shortened
 * sessions (Christmas Eve, Boxing Day, US Thanksgiving): Globex still trades
 * part of those days, so flagging a collector outage there is the safer
 * direction — mirrors the DAX half-day policy. Seed covers 2025–2027.
 */
const GOLD_CLOSED_DATES_2025_2027: readonly string[] = [
  "2025-01-01", "2025-04-18", "2025-12-25",
  "2026-01-01", "2026-04-03", "2026-12-25",
  "2027-01-01", "2027-03-26",
];

/** IG Spot Gold CFD calendar (gap detector for CS.D.CFIGOLD.CFI.IP). */
export const IG_SPOT_GOLD: MarketCalendar = {
  id: "ig-spot-gold",
  label: "IG Spot Gold (SGD) CFD",
  timezone: "Europe/London",
  windowsByWeekday: {
    1: GOLD_DAY_WINDOWS,
    2: GOLD_DAY_WINDOWS,
    3: GOLD_DAY_WINDOWS,
    4: GOLD_DAY_WINDOWS,
    5: GOLD_DAY_WINDOWS,
    6: [],
    7: GOLD_SUNDAY_WINDOWS,
  },
  closedDates: GOLD_CLOSED_DATES_2025_2027,
};

// ── Wall-clock conversion (Intl-based, DST-safe, per-timezone) ───────────────

export interface ZoneParts {
  /** 'YYYY-MM-DD' in `timezone`. */
  date: string;
  /** ISO weekday 1=Mon … 7=Sun. */
  weekday: number;
  /** Minutes since `timezone` midnight. */
  minutes: number;
}

/** Historic name kept for BC — London is simply the DAX calendar's zone. */
export type LondonParts = ZoneParts;

/** Cached per-zone formatters — isBucketExpected is hot on gap scans. */
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

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Wall-clock parts of an epoch-ms instant in the given IANA zone (DST-safe
 *  by construction: the IANA database resolves every conversion per instant). */
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

/** London wall-clock parts for an epoch-ms instant (BC — DAX calendar zone). */
export function londonParts(ms: number): LondonParts {
  return zoneParts(ms, "Europe/London");
}

const inAnyWindow = (parts: ZoneParts, cal: MarketCalendar): boolean => {
  if (cal.closedDates.includes(parts.date)) return false;
  return (cal.windowsByWeekday[parts.weekday] ?? []).some(
    (w) => parts.minutes >= w.openMin && parts.minutes < w.closeMin,
  );
};

/**
 * True when the timeframe bucket starting at `bucketStartSec` with width
 * `bucketWidthSec` overlaps any trading window of `cal`'s OWN timezone: a
 * bucket is expected if its START or its LAST instant falls inside a window of
 * a non-closed trading day. This naturally admits the bucket that contains a
 * mid-grid session open (e.g. DAX 01:10 London opens inside the 01:09–01:12
 * 3m bucket) and rejects everything inside daily breaks, weekends and
 * holidays. All instants are UTC epoch; conversion is per-calendar-zone
 * (instrument-aware — DAX and Gold calendars can quote in different zones)
 * and display-only.
 *
 * WIDTH IS EXPLICIT (Phase 0 bug fix): the previous signature used its single
 * parameter as BOTH the bucket start AND the width, so the "last instant"
 * computed to start + start — an epoch doubling that checked a phantom bucket
 * decades in the future (e.g. Saturday 07:00 UTC evaluated "Monday 14:00",
 * inside a DAX window) and could classify weekend/break buckets as expected.
 * Callers on a grid (`detectGaps`, the backfill planner) pass their grid
 * width; the 60 s default matches the canonical persisted 1m frame.
 */
export function isBucketExpected(
  bucketStartSec: number,
  cal: MarketCalendar,
  bucketWidthSec: number = 60,
): boolean {
  const startMs = bucketStartSec * 1000;
  const start = zoneParts(startMs, cal.timezone);
  // Last instant of the bucket (start + width − 1 ms) so a window opening
  // INSIDE the bucket still counts as expected.
  const last = zoneParts(startMs + Math.max(1, Math.round(bucketWidthSec)) * 1000 - 1, cal.timezone);
  if (cal.closedDates.includes(start.date) || cal.closedDates.includes(last.date)) return false;
  return inAnyWindow(start, cal) || inAnyWindow(last, cal);
}