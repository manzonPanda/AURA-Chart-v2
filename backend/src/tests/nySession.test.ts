/**
 * NY cash-equity session gate — unit tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *
 * All instants are concrete UTC epochs on known NY dates, so every assertion
 * is deterministic and DST transitions are exercised for real:
 *   2025-03-09  spring forward (EST→EDT)   2025-11-02  fall back (EDT→EST)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isClosedCandleInSession,
  hhmmToMinutes,
  newYorkParts,
  nyWallClockToEpochMs,
} from "../emaAlert/nySession.js";

const UTC = (y: number, m: number, d: number, h = 0, min = 0): number => Date.UTC(y, m - 1, d, h, min);
const S = "09:30";
const E = "16:00";

test("hhmmToMinutes parses 24h wall clock", () => {
  assert.equal(hhmmToMinutes("09:30"), 570);
  assert.equal(hhmmToMinutes("16:00"), 960);
  assert.equal(hhmmToMinutes("00:00"), 0);
});

test("newYorkParts resolves NY wall clock per instant (EST vs EDT)", () => {
  // 2025-01-15 14:31 UTC → 09:31 EST (UTC-5)
  const est = newYorkParts(UTC(2025, 1, 15, 14, 31));
  assert.equal(est.date, "2025-01-15");
  assert.equal(est.weekday, 3); // Wednesday
  assert.equal(est.minutes, 9 * 60 + 31);
  // 2025-03-10 13:31 UTC → 09:31 EDT (UTC-4, after spring forward)
  const edt = newYorkParts(UTC(2025, 3, 10, 13, 31));
  assert.equal(edt.date, "2025-03-10");
  assert.equal(edt.minutes, 9 * 60 + 31);
});

test("session start is respected: close at 09:30 NY is OUT, 09:31 is IN", () => {
  // EST day: close 09:30 NY = 14:30 UTC (the 09:29 pre-market bar) → out.
  assert.equal(isClosedCandleInSession(UTC(2025, 1, 15, 14, 30), S, E), false);
  // close 09:31 NY = 14:31 UTC (the 09:30 session bar) → in.
  assert.equal(isClosedCandleInSession(UTC(2025, 1, 15, 14, 31), S, E), true);
});

test("session end is respected: close at 16:00 NY is IN, 16:01 is OUT", () => {
  // close 16:00:00 NY = 21:00 UTC (the 15:59 bar, last cash bar) → in.
  assert.equal(isClosedCandleInSession(UTC(2025, 1, 15, 21, 0), S, E), true);
  // close 16:01 NY = 21:01 UTC → out.
  assert.equal(isClosedCandleInSession(UTC(2025, 1, 15, 21, 1), S, E), false);
});

test("weekends never qualify (NY cash equities Mon-Fri)", () => {
  // 2025-03-08 is a Saturday: 09:31 NY = 13:31 UTC → out despite the clock time.
  assert.equal(isClosedCandleInSession(UTC(2025, 3, 8, 13, 31), S, E), false);
  // 2025-01-18 is a Saturday, 16:00 NY = 21:00 UTC → out.
  assert.equal(isClosedCandleInSession(UTC(2025, 1, 18, 21, 0), S, E), false);
});

test("DST spring forward: the same NY wall clock shifts its UTC instant by one hour", () => {
  // Friday 2025-03-07 (EST): 09:31 close = 14:31 UTC → in.
  assert.equal(isClosedCandleInSession(UTC(2025, 3, 7, 14, 31), S, E), true);
  // Monday 2025-03-10 (EDT): the SAME 14:31 UTC is now 10:31 NY (still in),
  // and 09:31 NY now lives at 13:31 UTC.
  assert.equal(isClosedCandleInSession(UTC(2025, 3, 10, 13, 31), S, E), true);
  assert.equal(isClosedCandleInSession(UTC(2025, 3, 10, 14, 31), S, E), true);
});

test("DST fall back: 08:31 NY (EST) is out while 09:31 NY is in", () => {
  // Friday 2025-10-31 (EDT): 13:31 UTC = 09:31 NY → in.
  assert.equal(isClosedCandleInSession(UTC(2025, 10, 31, 13, 31), S, E), true);
  // Monday 2025-11-03 (EST): 13:31 UTC = 08:31 NY → out (pre-market).
  assert.equal(isClosedCandleInSession(UTC(2025, 11, 3, 13, 31), S, E), false);
  // 14:31 UTC = 09:31 NY (EST) → in. The wall-clock rule held across the
  // transition without any fixed-offset math.
  assert.equal(isClosedCandleInSession(UTC(2025, 11, 3, 14, 31), S, E), true);
});

test("nyWallClockToEpochMs maps NY wall clock to the correct UTC instant", () => {
  assert.equal(nyWallClockToEpochMs("2025-01-15", "09:30"), UTC(2025, 1, 15, 14, 30)); // EST +5
  assert.equal(nyWallClockToEpochMs("2025-03-10", "09:30"), UTC(2025, 3, 10, 13, 30)); // EDT +4
  assert.equal(nyWallClockToEpochMs("2025-11-03", "09:30"), UTC(2025, 11, 3, 14, 30)); // EST +5
  assert.equal(nyWallClockToEpochMs("2025-11-03", "16:00"), UTC(2025, 11, 3, 21, 0)); // EST +5
  assert.equal(nyWallClockToEpochMs("2025-03-10", "16:00"), UTC(2025, 3, 10, 20, 0)); // EDT +4
});
