/**
 * New York cash-equity session gate (PURE, I/O-free, DST-safe).
 *
 * Mirrors the Intl-based wall-clock approach of ../market/calendar.ts (which
 * resolves Europe/London for the DAX gap detector) but for America/New_York:
 * instants are converted to NY wall-clock parts per evaluation, so daylight
 * saving is handled by the IANA database — never by a fixed UTC offset.
 *
 * Session rule (feature spec):
 *   - Weekdays only (NYSE cash equities do not trade on weekends).
 *   - A CLOSED 1-minute candle qualifies when its CLOSE instant falls inside
 *     (start, end] — i.e. the first qualifying close is 09:31 (the 09:30 bar)
 *     and the last is 16:00:00 (the 15:59 bar, the final cash-session bar).
 *     The 09:29 pre-market bar closes AT 09:30 and does not qualify.
 *
 * No holiday calendar is applied (out of scope for v1 — documented in the
 * README); the window alone decides alert eligibility.
 */

export const NY_SESSION_TIMEZONE = "America/New_York";

/** en-GB → zero-padded 24h clock, same convention as market/calendar.ts. */
const nyDateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: NY_SESSION_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const nyWeekdayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: NY_SESSION_TIMEZONE, weekday: "short" });

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface NyParts {
  /** 'YYYY-MM-DD' in America/New_York. */
  date: string;
  /** ISO weekday of the NY-local date: 1=Mon … 7=Sun. */
  weekday: number;
  /** Minutes since NY-local midnight. */
  minutes: number;
}

/** NY wall-clock parts for an epoch-ms instant (DST-safe by construction). */
export function newYorkParts(ms: number): NyParts {
  const parts = nyDateFmt.formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const wd = nyWeekdayFmt.format(new Date(ms)).slice(0, 3);
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAY_INDEX[wd] ?? 7,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** "HH:MM" → minutes since midnight (caller validated via isValidHHMM). */
export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * True when a closed candle's CLOSE instant falls inside the NY cash session:
 * Mon–Fri and start < closeMinutes <= end (NY wall clock, DST-safe).
 */
export function isClosedCandleInSession(closeMs: number, startHHMM: string, endHHMM: string): boolean {
  const p = newYorkParts(closeMs);
  if (p.weekday > 5) return false;
  const start = hhmmToMinutes(startHHMM);
  const end = hhmmToMinutes(endHHMM);
  return p.minutes > start && p.minutes <= end;
}

/**
 * Display helper: epoch-ms of an NY wall-clock time on a given NY date.
 * Two-pass UTC correction — a naive UTC parse is off by the zone's current
 * UTC offset; each pass measures how far the instant's NY wall clock is from
 * the target and shifts by that delta. 09:30/16:00 never touch the 02:00 DST
 * transition, so two passes always converge exactly.
 * Used by the UI to show the PH-time equivalent of the NY session window.
 */
export function nyWallClockToEpochMs(dateYYYYMMDD: string, hhmm: string): number {
  const base = Date.parse(`${dateYYYYMMDD}T00:00:00Z`);
  let t = base + hhmmToMinutes(hhmm) * 60_000;
  if (!Number.isFinite(base)) return NaN;
  for (let pass = 0; pass < 2; pass++) {
    const p = newYorkParts(t);
    const shownDayOffset = Math.round(
      (Date.parse(`${p.date}T00:00:00Z`) - base) / 86_400_000,
    );
    // Both instants expressed as "minutes since date-00:00 (NY)":
    const shownMin = shownDayOffset * 1440 + p.minutes;
    const targetMin = hhmmToMinutes(hhmm);
    t += (targetMin - shownMin) * 60_000;
  }
  return t;
}
