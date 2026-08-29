/**
 * Timestamp parsing for IG REST payloads.
 *
 * IG's /prices response documents:
 *   snapshotTimeUTC — "2026-08-27T16:45:00"  → UTC wall clock, NO tz designator
 *   snapshotTime    — "2026/08/28 00:45:00"  → account/exchange local wall clock
 *
 * ES `Date.parse` treats timezone-less ISO strings as LOCAL time, which in a
 * UTC+8 environment shifted every historical candle −8 h versus the live
 * stream. The canonical rule here: parse the wall-clock components of
 * tz-less strings as UTC. Strings WITH an explicit offset (Z / ±hh:mm) and
 * date-only strings ("2026-08-27", UTC per ES spec) go through Date.parse.
 */
export function parseIgTimestampAsUtc(raw: string): number {
  const s = raw.trim();
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.:](\d{1,3}))?)?$/,
  );
  if (!m) return Date.parse(s);
  const [, y, mo, d, h, mi, sec = "0", frac = "0"] = m;
  return Date.UTC(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(sec), Number(frac.padEnd(3, "0")),
  );
}
