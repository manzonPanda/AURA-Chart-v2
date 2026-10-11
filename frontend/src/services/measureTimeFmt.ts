/**
 * AURA's ONE presentation pass over CandleKit's measurement readout time token.
 *
 * Pure + framework-free (no React, no DOM) so it runs identically in the
 * browser and in Node tests — same doctrine as services/activeIndicators.ts.
 *
 * MeasurementOverlay exposes no formatter hook (className/style only) and its
 * native fmtTime() renders coarse units — "45s" | "90m" | "1.5h". AURA wants
 * each unit spelled out only when it has a value — "45m" | "1h 30m" | "2h" —
 * so MeasureTimeFmt rewrites ONLY the trailing time node inside
 * `.ck-measure-meta` — every VALUE still comes from the library's
 * MeasurementController (see the "AURA owns no ruler math" contract in
 * drawingToolbar.test.mjs).
 *
 * Fail-open by design: any text this module does not recognise (a future
 * library wording change) returns null and is left exactly as the library
 * rendered it — the readout can degrade to the native format, never to a
 * broken parse. Re-reading our OWN output also returns null ("1h 30m" has no
 * native single-token shape) or the identical string ("45m" | "2h" | "0m" —
 * round-trip stable), which is what terminates the MutationObserver write
 * loop; the property test in measureTimeFmt.test.mjs pins that guarantee.
 */

/** Native fmtTime() tokens: "45s" | "90m" | "1.5h" (seconds / minutes / hours). */
const NATIVE_TIME = /^(\d+(?:\.\d+)?)(s|m|h)$/;

/**
 * Convert a native time token to AURA's unit style, or null when the text is
 * not a native unit token (already formatted, malformed, unknown).
 *
 *   "90m" → "1h 30m"   both parts shown — each has a value
 *   "2h"  → "2h"       minutes are 0 → the empty part is omitted
 *   "5m"  → "5m"       hours are 0 → omitted (minutes are NOT zero-padded)
 *   "45s" → "0m"       sub-minute durations floor to minutes; both parts
 *                      empty → the "0m" fallback (never an empty tooltip)
 *
 * Hours are never wrapped or capped ("26h" stays "26h" — a multi-day
 * measurement stays a duration, not a date).
 */
export function timeTokenToHM(token: string): string | null {
  const m = NATIVE_TIME.exec(token.trim());
  if (!m) return null;
  const amount = parseFloat(m[1]);
  const seconds = m[2] === "s" ? amount : m[2] === "m" ? amount * 60 : amount * 3600;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "0m";
}
