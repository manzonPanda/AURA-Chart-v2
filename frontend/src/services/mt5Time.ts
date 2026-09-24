/**
 * MT5 server-time → AURA candle-time conversion (P3-B).
 *
 * P3-A established (mt5_p3a_diagnose.py + P3A_VERIFICATION_REPORT.md) that MT5
 * trade timestamps are NAIVE broker/server wall-clock strings (e.g.
 * "2026-07-31 19:42:21") — never UTC-labelled and never to be parsed as UTC.
 *
 * The authoritative timezone model is the repo's own `mt5-time.service.ts`
 * (MyTradingDashboard2): `Europe/Helsinki` (EET winter = UTC+2, EEST summer =
 * UTC+3), resolved PER TIMESTAMP through the platform IANA database via
 * `Intl` — the offset is NEVER hard-coded, and DST transitions are handled by
 * the tz database itself, not by arithmetic.
 *
 * Conversion flow (P3-B spec):
 *   MT5 server wall-clock string
 *     → parse naive parts
 *     → interpret as Europe/Helsinki wall clock (per-timestamp DST offset)
 *     → true UTC epoch-ms
 *     → floor to the candle bucket (60s for 1m, 180s for 3m — AURA's
 *       authoritative buckets, services/realtime.ts BUCKET_SECONDS; the 3m
 *       grid is a pure multiple of the 1m grid so one conversion serves both)
 *
 * Fixed-point refinement (same technique as mt5-time.service.ts): the tz
 * offset used is the one in force at the RESOLVED instant, iterated once, so
 * timestamps landing inside a DST-transition hour resolve on the correct side.
 *
 * Framework-free by design (frontend/tests run it with plain node --test).
 */

/** The verified MT5 broker timezone (P3-A + mt5-time.service.ts authority). */
export const MT5_SERVER_TIME_ZONE = "Europe/Helsinki";

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

export interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Parse a naive MT5/DB wall-clock string ("YYYY-MM-DD HH:MM:SS", "T"
 * separator tolerated, fractional seconds tolerated) into numeric parts.
 * Returns null for anything unparsable — callers MUST treat null as
 * "unmappable", never as "now" or 0.
 */
export function parseMt5WallClock(value: string | null | undefined): WallClockParts | null {
  if (!value) return null;
  const match = WALL_CLOCK_RE.exec(String(value).trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0"] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
  if (parts.year < 1970 || parts.year > 2100) return null;
  return parts;
}

/** Wall-clock parts for `instantMs` expressed in `zone` (IANA, via Intl). */
export function wallClockInZone(zone: string, instantMs: number): WallClockParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(instantMs));
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  let hour = read("hour");
  if (hour === 24) hour = 0; // a few engines emit "24:00:00" for midnight
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour,
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * UTC offset (ms) of `zone` at `instantMs`: (wall clock in zone) − (UTC
 * instant). Fully DST-aware — this is the ONLY offset source; nothing here
 * assumes UTC+2 or UTC+3.
 */
export function zoneOffsetMs(zone: string, instantMs: number): number {
  const wall = wallClockInZone(zone, instantMs);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return wallAsUtc - instantMs;
}

/**
 * MT5 server wall-clock string → true UTC epoch-ms.
 *
 * The naive string is read AS-IF it were UTC, then shifted by the
 * Europe/Helsinki offset in force at that instant (two-pass fixed point).
 * Returns null when the input is unparsable.
 */
export function mt5ServerWallToUtcMs(value: string | null | undefined): number | null {
  const parts = parseMt5WallClock(value);
  if (!parts) return null;
  const naiveAsUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
  );
  let instant = naiveAsUtc - zoneOffsetMs(MT5_SERVER_TIME_ZONE, naiveAsUtc);
  // Fixed-point refinement: re-verify with the corrected instant so the
  // offset used is the one actually in force at the real UTC instant (DST
  // boundary safety), exactly like mt5-time.service.ts.
  const corrected = naiveAsUtc - zoneOffsetMs(MT5_SERVER_TIME_ZONE, instant);
  if (corrected !== instant) instant = corrected;
  return instant;
}

/**
 * MT5 server wall-clock string → AURA candle bucket start (epoch-ms UTC).
 * `bucketSec` is the authoritative AURA bucket (60 = 1m, 180 = 3m from
 * services/realtime.ts BUCKET_SECONDS) — the caller passes it; this module
 * never invents an aggregation.
 */
export function mt5ServerWallToBucketMs(
  value: string | null | undefined,
  bucketSec: number,
): number | null {
  const utcMs = mt5ServerWallToUtcMs(value);
  if (utcMs === null || !(bucketSec > 0)) return null;
  const bucketMs = bucketSec * 1000;
  return Math.floor(utcMs / bucketMs) * bucketMs;
}
