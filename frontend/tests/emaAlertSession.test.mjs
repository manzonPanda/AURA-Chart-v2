/**
 * Unit tests for the NY-session display helper (services/sessionTimes.ts).
 * Runs with Node's type stripping: npm --prefix frontend run test.
 * Deterministic UTC instants; Intl with explicit timeZone makes results
 * independent of the machine's system clock.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { sessionDisplay } from "../src/services/sessionTimes.ts";

test("sessionDisplay: EST day — Manila mirrors are UTC+8 of NY wall clock", () => {
  // Wed 2025-01-15 15:00 UTC (EST, UTC-5): NY 09:30 = 14:30 UTC → PH 22:30;
  // NY 16:00 = 21:00 UTC → PH 05:00 (next calendar day in Manila).
  const d = sessionDisplay(Date.UTC(2025, 0, 15, 15, 0));
  assert.equal(d.nyStart, "09:30");
  assert.equal(d.nyEnd, "16:00");
  assert.equal(d.phStart, "22:30");
  assert.equal(d.phEnd, "05:00");
  assert.equal(d.openNow, true); // NY 10:00, Wednesday
});

test("sessionDisplay: EDT day — the same NY window shifts one hour earlier in UTC", () => {
  // Mon 2025-03-10 15:00 UTC (EDT, UTC-4): NY 09:30 = 13:30 UTC → PH 21:30;
  // NY 16:00 = 20:00 UTC → PH 04:00. No fixed offset — DST-safe by IANA.
  const d = sessionDisplay(Date.UTC(2025, 2, 10, 15, 0));
  assert.equal(d.phStart, "21:30");
  assert.equal(d.phEnd, "04:00");
  assert.equal(d.openNow, true);
});

test("sessionDisplay: closed outside the 09:30-16:00 window", () => {
  // Wed 2025-01-15 21:30 UTC → NY 16:30 → session closed.
  const closed = sessionDisplay(Date.UTC(2025, 0, 15, 21, 30));
  assert.equal(closed.openNow, false);
  // Wed 2025-01-15 14:00 UTC → NY 09:00 (pre-market) → closed.
  const preOpen = sessionDisplay(Date.UTC(2025, 0, 15, 14, 0));
  assert.equal(preOpen.openNow, false);
  // Sat 2025-03-08 15:00 UTC → NY weekend → closed regardless of clock time.
  const weekend = sessionDisplay(Date.UTC(2025, 2, 8, 15, 0));
  assert.equal(weekend.openNow, false);
});