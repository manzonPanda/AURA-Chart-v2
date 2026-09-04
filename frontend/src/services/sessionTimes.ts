/**
 * NY-session display helper (PURE) — shows the Philippine-time equivalent of
 * the America/New_York session window without ever hardcoding an offset.
 *
 * The session RULES live server-side; this module only renders the current
 * window's wall-clock labels for the UI:
 *   NY start/end are given ("09:30"/"16:00"); their PH equivalents shift by
 *   +12h in EDT and +13h in EST, computed via Intl per instant — never a
 *   fixed offset.
 */

const NY_TZ = "America/New_York";
const PH_TZ = "Asia/Manila";

const nyDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: NY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const nyPartsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: NY_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const phTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: PH_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface SessionDisplay {
  /** "09:30"–"16:00" New York wall clock (as configured). */
  nyStart: string;
  nyEnd: string;
  /** Today's PH-time equivalents, e.g. "21:30" / "04:00" (DST-dependent). */
  phStart: string;
  phEnd: string;
  /** Whether the NY session is open at the instant `nowMs` (Mon-Fri only). */
  openNow: boolean;
}

function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Epoch-ms of an NY wall-clock time today (two-pass UTC correction). */
function nyWallClockTodayToEpochMs(nowMs: number, hhmm: string): number {
  const date = nyDateFmt.format(nowMs); // today's NY date
  const base = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(base)) return NaN;
  let t = base + hhmmToMinutes(hhmm) * 60_000;
  for (let pass = 0; pass < 2; pass++) {
    const parts = nyPartsFmt.formatToParts(new Date(t));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    const shownDate = nyDateFmt.format(t);
    const dayOffset = Math.round((Date.parse(`${shownDate}T00:00:00Z`) - base) / 86_400_000);
    const shownMin = dayOffset * 1440 + (Number(get("hour")) * 60 + Number(get("minute")));
    t += (hhmmToMinutes(hhmm) - shownMin) * 60_000;
  }
  return t;
}

function weekdayOfNyDate(ms: number): number {
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: NY_TZ, weekday: "short" }).format(ms);
  const idx: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return idx[wd.slice(0, 3)] ?? 7;
}

/** Current NY-session window with its PH-time equivalents (display only). */
export function sessionDisplay(nowMs: number, start = "09:30", end = "16:00"): SessionDisplay {
  const startMs = nyWallClockTodayToEpochMs(nowMs, start);
  const endMs = nyWallClockTodayToEpochMs(nowMs, end);
  const startParts = nyPartsFmt.formatToParts(new Date(nowMs));
  const get = (type: string): string => startParts.find((p) => p.type === type)?.value ?? "";
  const minutesNow = Number(get("hour")) * 60 + Number(get("minute"));
  const weekday = weekdayOfNyDate(nowMs);
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  return {
    nyStart: start,
    nyEnd: end,
    phStart: phTimeFmt.format(startMs),
    phEnd: phTimeFmt.format(endMs),
    openNow: weekday <= 5 && minutesNow > s && minutesNow <= e,
  };
}
