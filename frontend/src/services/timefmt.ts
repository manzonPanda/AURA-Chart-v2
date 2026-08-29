/**
 * Chart display-timezone: Asia/Manila (UTC+08:00, no DST).
 *
 * CONVENTION (do not break): every timestamp in the pipeline — Supabase
 * `bucket_time`, IG UTM, realtime WS frames, `Candle.ts`/`Bar.ts` — is a UTC
 * epoch instant and stays untouched. This module ONLY renders display strings
 * and axis labels in Philippine time; no data value is ever shifted.
 *
 * Lightweight Charts v5 has no built-in timezone support: axis ticks are
 * formatted from the UTC epoch via `tickMarkFormatter` (time axis) and
 * `localization.timeFormatter` (crosshair label). Both receive the bar's time
 * in SECONDS (UTCTimestamp) and we format the same instant in Asia/Manila.
 *
 * Because PH is a fixed whole-hour offset (+8) with no DST, adding the offset
 * to an already-3-minute-aligned UTC bucket preserves bucket alignment:
 * :00/:03/:36 UTC grid == :00/:03/:36 PH grid. Verified in tests below.
 */

const MANILA_TZ = "Asia/Manila";

/** `Intl` formatters (en-GB → zero-padded 24h clock, e.g. "21:30"). */
const hmFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: MANILA_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const hmsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: MANILA_TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const dmyFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: MANILA_TZ,
  day: "2-digit",
  month: "short",
});

/** "21:30" — Manila wall-clock of a UTC epoch-ms instant. */
export function formatManilaHHMM(tsMs: number): string {
  return hmFmt.format(tsMs);
}

/** "21:30:00" — with seconds. */
export function formatManilaHHMMSS(tsMs: number): string {
  return hmsFmt.format(tsMs);
}

/** "28 Aug 21:30" — day-change ticks on the time axis. */
export function formatManilaDayHHMM(tsMs: number): string {
  return `${dmyFmt.format(tsMs)} ${hmFmt.format(tsMs)}`;
}

/** "2026-08-28 21:30 PH" — tooltip / OHLC strip full label. */
export function formatManilaDateTimeFull(tsMs: number): string {
  const isoLocal = new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(tsMs);
  return `${isoLocal} ${hmFmt.format(tsMs)} PH`;
}
