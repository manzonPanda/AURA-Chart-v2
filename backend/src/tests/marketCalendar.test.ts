/**
 * Market calendars — unit tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *
 * Phase 0 multi-instrument: the wall-clock conversion is now parameterized by
 * each calendar's OWN timezone (was hardcoded Europe/London), and the new
 * IG Spot Gold calendar must express the Globex-aligned gold schedule:
 * Sunday open 23:00 London, Friday close 22:00 London, daily break
 * 22:00–23:00. Deterministic UTC epochs on known dates; DST is exercised for
 * real (September = BST, December = GMT). DAX assertions double as a
 * behavior-preservation regression for the timezone refactor.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { IG_GERMANY_40, IG_SPOT_GOLD, IG_SPOT_SILVER, isBucketExpected } from "../market/calendar.js";

/** Epoch seconds of a UTC wall-clock instant, aligned to the 60 s grid. */
const B = (y: number, m: number, d: number, h = 0, min = 0): number =>
  Math.floor(Date.UTC(y, m - 1, d, h, min) / 1000 / 60) * 60;

// ── Gold: BST week (September 2026; London = UTC+1) ──────────────────────────

test("gold: Sunday open 23:00 BST (22:00 UTC) — exact open bucket is expected", () => {
  assert.equal(isBucketExpected(B(2026, 9, 6, 22, 0), IG_SPOT_GOLD), true);
});

test("gold: Sunday pre-open buckets are NOT expected", () => {
  assert.equal(isBucketExpected(B(2026, 9, 6, 21, 59), IG_SPOT_GOLD), false); // 22:59 BST
  assert.equal(isBucketExpected(B(2026, 9, 6, 21, 0), IG_SPOT_GOLD), false); // 22:00 BST (break)
});

test("gold: weekday 00:00–22:00 BST window (overnight + day session)", () => {
  assert.equal(isBucketExpected(B(2026, 9, 7, 0, 0), IG_SPOT_GOLD), true); // Mon 01:00 BST
  assert.equal(isBucketExpected(B(2026, 9, 7, 20, 59), IG_SPOT_GOLD), true); // Mon 21:59 BST
});

test("gold: daily break 22:00–23:00 BST is never expected", () => {
  assert.equal(isBucketExpected(B(2026, 9, 7, 21, 0), IG_SPOT_GOLD), false); // Mon 22:00 BST
  assert.equal(isBucketExpected(B(2026, 9, 7, 21, 30), IG_SPOT_GOLD), false); // Mon 22:30 BST
});

test("gold: Friday close 22:00 BST — last session minute in, close bucket out", () => {
  assert.equal(isBucketExpected(B(2026, 9, 11, 20, 59), IG_SPOT_GOLD), true); // 21:59 BST
  assert.equal(isBucketExpected(B(2026, 9, 11, 21, 0), IG_SPOT_GOLD), false); // 22:00 BST
});

test("gold: Saturday is fully closed", () => {
  assert.equal(isBucketExpected(B(2026, 9, 12, 12, 0), IG_SPOT_GOLD), false);
});

// ── Gold: CORRECTED weekday evening window (2026-09-15 forensic fix) ─────────
// London 23:00–24:00 is a REAL trading hour (the post-break Globex session).
// Before this fix the weekday rule carried only 00:00–22:00 London, so every
// one of those buckets was classified CLOSED and genuine holes there were never
// shaded as DATA GAPS. September 2026 = BST (London = UTC+1), so the window
// lands on UTC 22:00–23:00 — one hour BEFORE the UTC date change.

test("gold: weekday evening window — Mon 2026-09-14 BST (the exact forensic case)", () => {
  // 21:30 UTC = 22:30 BST → inside the daily break → CLOSED.
  assert.equal(isBucketExpected(B(2026, 9, 14, 21, 30), IG_SPOT_GOLD), false);
  assert.equal(isBucketExpected(B(2026, 9, 14, 21, 0), IG_SPOT_GOLD), false); // break opens
  assert.equal(isBucketExpected(B(2026, 9, 14, 21, 59), IG_SPOT_GOLD), false);
  // 22:00 UTC = 23:00 BST → break ends, post-break session OPEN (was CLOSED).
  assert.equal(isBucketExpected(B(2026, 9, 14, 22, 0), IG_SPOT_GOLD), true);
  // 22:30 UTC = 23:30 BST → OPEN (the buckets the forensic scan found in Postgres).
  assert.equal(isBucketExpected(B(2026, 9, 14, 22, 30), IG_SPOT_GOLD), true);
  assert.equal(isBucketExpected(B(2026, 9, 14, 22, 59), IG_SPOT_GOLD), true);
  // 23:30 UTC = Tue 00:30 BST → the next London day's main window → OPEN.
  assert.equal(isBucketExpected(B(2026, 9, 14, 23, 30), IG_SPOT_GOLD), true);
});

test("gold: the 22:00–23:00 Europe/London break stays CLOSED in BST and in GMT", () => {
  // BST (September): break = 21:00–21:59 UTC.
  for (let m = 0; m < 60; m++) {
    assert.equal(isBucketExpected(B(2026, 9, 15, 21, 0) + m * 60, IG_SPOT_GOLD), false, `BST break 21:${m} UTC`);
  }
  // GMT (December): break = 22:00–22:59 UTC — same wall clock, later UTC hour.
  for (let m = 0; m < 60; m++) {
    assert.equal(isBucketExpected(B(2026, 12, 7, 22, 0) + m * 60, IG_SPOT_GOLD), false, `GMT break 22:${m} UTC`);
  }
});

test("gold: evening window is DST-correct (GMT week shifts to 23:00–24:00 UTC)", () => {
  // December 2026 = GMT (London = UTC+0).
  assert.equal(isBucketExpected(B(2026, 12, 7, 21, 30), IG_SPOT_GOLD), true); // 21:30 GMT main window
  assert.equal(isBucketExpected(B(2026, 12, 7, 22, 30), IG_SPOT_GOLD), false); // 22:30 GMT BREAK
  assert.equal(isBucketExpected(B(2026, 12, 7, 23, 0), IG_SPOT_GOLD), true); // 23:00 GMT post-break OPEN
  assert.equal(isBucketExpected(B(2026, 12, 7, 23, 30), IG_SPOT_GOLD), true);
  assert.equal(isBucketExpected(B(2026, 12, 8, 0, 30), IG_SPOT_GOLD), true); // next London day
});

test("gold: day-boundary behavior — the evening window rolls over the UTC date", () => {
  // BST: Mon 23:00–24:00 London = Mon 22:00…22:59 UTC; the next UTC minute is
  // already Tue 00:00 London, where the main window continues.
  assert.equal(isBucketExpected(B(2026, 9, 14, 22, 59), IG_SPOT_GOLD), true);
  assert.equal(isBucketExpected(B(2026, 9, 14, 23, 0), IG_SPOT_GOLD), true);
  assert.equal(isBucketExpected(B(2026, 9, 14, 23, 59), IG_SPOT_GOLD), true);
  // GMT: the window IS UTC 23:00–23:59 and still rolls into the next London day.
  assert.equal(isBucketExpected(B(2026, 12, 7, 23, 59), IG_SPOT_GOLD), true);
  assert.equal(isBucketExpected(B(2026, 12, 8, 0, 0), IG_SPOT_GOLD), true);
});

// ── Other calendars MUST be untouched by the Gold correction ────────────────

test("DAX regression: the Gold correction did not move IG_GERMANY_40", () => {
  assert.equal(isBucketExpected(B(2026, 9, 14, 12, 0), IG_GERMANY_40), true); // Mon midday session
  assert.equal(isBucketExpected(B(2026, 9, 14, 21, 30), IG_GERMANY_40), false); // after the 21:00 UK close
  assert.equal(isBucketExpected(B(2026, 9, 14, 22, 30), IG_GERMANY_40), false); // evening — never a DAX window
  assert.equal(isBucketExpected(B(2026, 9, 12, 12, 0), IG_GERMANY_40), false); // Saturday
});

test("Silver regression: unchanged by the Gold correction (retired archive instrument)", () => {
  assert.equal(isBucketExpected(B(2026, 9, 14, 12, 0), IG_SPOT_SILVER), true);
  assert.equal(isBucketExpected(B(2026, 9, 14, 21, 30), IG_SPOT_SILVER), false);
  assert.equal(
    isBucketExpected(B(2026, 9, 14, 22, 30), IG_SPOT_SILVER),
    false,
    "Silver keeps its pre-fix weekday windows — the post-break hour was NOT added here",
  );
});

test("gold: Monday 2026-09-14 — exactly the break hour is closed, all else open", () => {
  let open = 0;
  let closed = 0;
  for (let m = 0; m < 24 * 60; m++) {
    if (isBucketExpected(B(2026, 9, 14, 0, 0) + m * 60, IG_SPOT_GOLD)) open += 1;
    else closed += 1;
  }
  assert.equal(closed, 60, "exactly one closed hour: the 21:00–21:59 UTC (= 22:00–22:59 BST) break");
  assert.equal(open, 24 * 60 - 60);
});

test("gold: FRIDAY evening has NO post-break window (the week closes 22:00 London)", () => {
  // Friday 2026-09-11 BST: 21:30 UTC = 22:30 BST (break) and 22:30 UTC =
  // 23:30 BST is the WEEKEND — no evening session on Fridays.
  assert.equal(isBucketExpected(B(2026, 9, 11, 21, 30), IG_SPOT_GOLD), false);
  assert.equal(isBucketExpected(B(2026, 9, 11, 22, 30), IG_SPOT_GOLD), false);
  assert.equal(isBucketExpected(B(2026, 9, 11, 23, 30), IG_SPOT_GOLD), false);
  // Friday 2026-12-11 GMT: same wall-clock rule, an hour later on the UTC grid.
  assert.equal(isBucketExpected(B(2026, 12, 11, 22, 30), IG_SPOT_GOLD), false);
  assert.equal(isBucketExpected(B(2026, 12, 11, 23, 30), IG_SPOT_GOLD), false);
});

test("gold: Saturday evening closed, Sunday opens at 23:00 London and runs into Monday", () => {
  assert.equal(isBucketExpected(B(2026, 9, 12, 22, 30), IG_SPOT_GOLD), false); // Sat 23:30 BST
  assert.equal(isBucketExpected(B(2026, 9, 12, 23, 30), IG_SPOT_GOLD), false); // Sun 00:30 BST
  assert.equal(isBucketExpected(B(2026, 9, 13, 21, 59), IG_SPOT_GOLD), false); // Sun 22:59 BST — pre-open
  assert.equal(isBucketExpected(B(2026, 9, 13, 22, 0), IG_SPOT_GOLD), true); // Sun 23:00 BST — week open
  assert.equal(isBucketExpected(B(2026, 9, 13, 23, 0), IG_SPOT_GOLD), true); // Mon 00:00 BST
});

// ── Gold: GMT week (December 2026; London = UTC+0) — DST correctness ─────────

test("gold: December Sunday open 23:00 GMT holds the same wall-clock schedule", () => {
  assert.equal(isBucketExpected(B(2026, 12, 6, 23, 0), IG_SPOT_GOLD), true);
  assert.equal(isBucketExpected(B(2026, 12, 6, 22, 0), IG_SPOT_GOLD), false);
  assert.equal(isBucketExpected(B(2026, 12, 7, 0, 0), IG_SPOT_GOLD), true); // Mon 00:00 GMT
});

// ── Gold: holiday closures (Globex precious metals) ──────────────────────────

test("gold: New Year's Day and Christmas Day are full closures", () => {
  assert.equal(isBucketExpected(B(2026, 1, 1, 12, 0), IG_SPOT_GOLD), false);
  assert.equal(isBucketExpected(B(2026, 12, 25, 12, 0), IG_SPOT_GOLD), false);
  assert.equal(isBucketExpected(B(2027, 3, 26, 12, 0), IG_SPOT_GOLD), false); // Good Friday 2027
});

// ── Instrument-aware calendars: the two markets MUST diverge ─────────────────

test("calendars diverge: German holidays close the DAX but NOT Gold", () => {
  // 2026-05-01 (Friday, Labour Day — Xetra closed) 06:30 BST = DAX daily break
  const bucket = B(2026, 5, 1, 5, 30); // 05:30 UTC = 06:30 BST
  assert.equal(isBucketExpected(bucket, IG_GERMANY_40), false, "DAX: break AND German holiday");
  assert.equal(isBucketExpected(bucket, IG_SPOT_GOLD), true, "Gold: normal Globex trading");
});

test("calendars agree where both are closed (Christmas Day)", () => {
  const bucket = B(2026, 12, 25, 12, 0);
  assert.equal(isBucketExpected(bucket, IG_GERMANY_40), false);
  assert.equal(isBucketExpected(bucket, IG_SPOT_GOLD), false);
});

// ── DAX regression: the timezone refactor must not move IG_GERMANY_40 ────────

test("DAX regression: BST summer windows unchanged (08:00 UK open)", () => {
  assert.equal(isBucketExpected(B(2025, 8, 5, 7, 0), IG_GERMANY_40), true); // 08:00 BST
  assert.equal(isBucketExpected(B(2025, 8, 5, 6, 57), IG_GERMANY_40), false); // 07:57 BST (break)
  assert.equal(isBucketExpected(B(2025, 8, 9, 7, 0), IG_GERMANY_40), false); // Saturday
});

test("DAX regression: GMT winter windows unchanged (08:00 UK = 08:00 UTC)", () => {
  assert.equal(isBucketExpected(B(2025, 12, 2, 8, 0), IG_GERMANY_40), true);
  assert.equal(isBucketExpected(B(2025, 12, 2, 7, 57), IG_GERMANY_40), false);
});

test("DAX regression: mid-grid open (01:10 UK) admits the touching bucket per grid width", () => {
  // 3m grid: the 01:09–01:12 bucket touches the 01:10 open → expected.
  assert.equal(isBucketExpected(B(2025, 8, 5, 0, 9), IG_GERMANY_40, 180), true);
  assert.equal(isBucketExpected(B(2025, 8, 5, 0, 6), IG_GERMANY_40, 180), false); // 01:06–01:09
  // 1m grid (canonical persisted frame): 01:09 does NOT touch 01:10.
  assert.equal(isBucketExpected(B(2025, 8, 5, 0, 9), IG_GERMANY_40), false);
  assert.equal(isBucketExpected(B(2025, 8, 5, 0, 10), IG_GERMANY_40), true);
});
// ── The Gold correction MUST NOT move any other instrument ──────────────────

test("DAX/Silver regression: the Gold weekday correction changed nothing else", () => {
  // DAX: the post-break hour is still NOT a DAX window (the correction only
  // touched IG_SPOT_GOLD's weekday entries).
  assert.equal(isBucketExpected(B(2026, 9, 14, 12, 0), IG_GERMANY_40), true); // Mon lunchtime session
  assert.equal(isBucketExpected(B(2026, 9, 14, 21, 30), IG_GERMANY_40), false); // past the UK close
  assert.equal(isBucketExpected(B(2026, 9, 14, 22, 30), IG_GERMANY_40), false);
  assert.equal(isBucketExpected(B(2026, 9, 12, 12, 0), IG_GERMANY_40), false); // Saturday
  // Silver (retired IG archive instrument): weekday windows unchanged — the
  // evening hour was deliberately NOT added there.
  assert.equal(isBucketExpected(B(2026, 9, 14, 12, 0), IG_SPOT_SILVER), true);
  assert.equal(isBucketExpected(B(2026, 9, 14, 21, 30), IG_SPOT_SILVER), false);
  assert.equal(isBucketExpected(B(2026, 9, 14, 22, 30), IG_SPOT_SILVER), false);
});
