/**
 * Timestamp parsing for Capital.com REST payloads.
 *
 * Capital.com documents:
 *   snapshotTimeUTC — "2024-01-02T00:00:00" → UTC wall clock, NO tz designator
 *   snapshotTime    — "2024/01/02 00:00:00" → account/display local wall clock
 *
 * ES `Date.parse` treats timezone-less ISO strings as LOCAL time, which in a
 * UTC+8 environment would shift every historical candle +8 h versus the live
 * stream (the exact bug class the verified IG tz fix guards against). The
 * canonical rule here is the SAME one: parse the wall-clock components of
 * tz-less strings as UTC. Strings WITH an explicit offset (Z / ±hh:mm) and
 * date-only strings ("2024-01-02", UTC per ES spec) go through Date.parse.
 *
 * snapshotTimeUTC is the AUTHORITATIVE timestamp (user decision 2026-09):
 *   Capital.com UTC timestamp → Supabase timestamptz → AURA Manila display.
 */
export function parseCapitalTimestampAsUtc(raw: string): number {
  const s = raw.trim();
  // Tz-less "YYYY-MM-DDTHH:MM[:SS[.mmm]]" or "YYYY/MM/DD HH:MM[:SS]" variants
  // (both `-` and `/` date separators; `T` or space time separator).
  const m = s.match(
    /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.:](\d{1,3}))?)?$/,
  );
  if (!m) return Date.parse(s);
  const [, y, mo, d, h, mi, sec = "0", frac = "0"] = m;
  return Date.UTC(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(sec), Number(frac.padEnd(3, "0")),
  );
}

/**
 * Format epoch-ms as a Capital.com UTC request parameter — the exact inverse
 * of parseCapitalTimestampAsUtc for tz-less strings:
 *   1704153600000 → "2024-01-02T00:00:00"
 * Used by GET /prices?from=&to= so the server always interprets the window as
 * UTC wall clock (never the display/account timezone).
 */
export function formatCapitalUtcIso(epochMs: number): string {
  const d = new Date(epochMs);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  );
}

/**
 * Tolerant extraction of the authoritative UTC timestamp from a Capital.com
 * price/quote row: prefers snapshotTimeUTC (tz-less → UTC), falls back to
 * snapshotTime with the same tz-less UTC rule. Returns NaN when unusable.
 */
export function capitalRowTimestamp(row: { snapshotTimeUTC?: string | null; snapshotTime?: string | null }): number {
  const utcIso = row.snapshotTimeUTC ?? row.snapshotTime;
  if (!utcIso) return NaN;
  return parseCapitalTimestampAsUtc(utcIso);
}
