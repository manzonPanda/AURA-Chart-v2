/**
 * Crosshair hover timestamp — weekday prefix (Asia/Manila).
 *
 * Contract:
 *   `formatManilaDateTimeFull` renders "Weekday Mon-DD-YYYY HH:mm PH"
 *   (e.g. "Tuesday Oct-13-2026 17:36 PH") from a UTC epoch-ms instant.
 *   The weekday is derived in Asia/Manila from the SAME instant as the
 *   displayed date — never the browser's local zone — so weekday and date
 *   always agree, including near-midnight boundaries.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatManilaDateTimeFull } from "../src/services/timefmt.ts";

/** Build a UTC epoch-ms instant that displays as the given Manila wall-clock. */
const manilaWall = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm, 0);

const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("hover label shows Monday for a Monday candle", () => {
  assert.equal(formatManilaDateTimeFull(manilaWall(2026, 10, 12, 9, 30)), "Monday Oct-12-2026 09:30 PH");
});

test("hover label shows Tuesday for a Tuesday candle", () => {
  assert.equal(formatManilaDateTimeFull(manilaWall(2026, 10, 13, 17, 36)), "Tuesday Oct-13-2026 17:36 PH");
});

test("hover label shows Friday for a Friday candle", () => {
  assert.equal(formatManilaDateTimeFull(manilaWall(2026, 10, 16, 14, 5)), "Friday Oct-16-2026 14:05 PH");
});

test("midnight boundary uses Manila date+weekday (no double conversion)", () => {
  // 2026-10-12 23:59 PH (Monday) and one minute later 2026-10-13 00:00 PH (Tuesday).
  assert.equal(formatManilaDateTimeFull(manilaWall(2026, 10, 12, 23, 59)), "Monday Oct-12-2026 23:59 PH");
  assert.equal(formatManilaDateTimeFull(manilaWall(2026, 10, 13, 0, 0)), "Tuesday Oct-13-2026 00:00 PH");
  // 2026-10-12 00:30 PH is still Oct 11 (Sunday) in UTC — the label must follow
  // Manila (Monday 2026-10-12), proving exactly one PH conversion is applied.
  const early = manilaWall(2026, 10, 12, 0, 30);
  assert.equal(new Date(early).toISOString().slice(0, 10), "2026-10-11"); // Sunday in UTC
  assert.equal(formatManilaDateTimeFull(early), "Monday Oct-12-2026 00:30 PH");
});

test("weekday and displayed date always agree (full week sweep)", () => {
  const expected = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (let i = 0; i < 7; i++) {
    const got = formatManilaDateTimeFull(manilaWall(2026, 10, 12 + i, 12, 0));
    assert.match(got, new RegExp(`^${expected[i]} Oct-${String(12 + i).padStart(2, "0")}-2026 12:00 PH$`));
  }
});

test("date, 24h time, and PH suffix stay intact", () => {
  const got = formatManilaDateTimeFull(manilaWall(2026, 10, 13, 17, 36));
  assert.match(got, /^\w+ [A-Za-z]{3}-\d{2}-\d{4} \d{2}:\d{2} PH$/);
  assert.ok(got.endsWith(" PH"));
});

test("wiring: crosshair timeFormatter is the hover path (axis ticks untouched)", () => {
  const chart = readSrc("../src/components/TradingChart/TradingChart.tsx");
  assert.match(
    chart,
    /localization:\s*\{[^}]*timeFormatter:\s*\(\(time: unknown\)\s*=>\s*\n?\s*formatManilaDateTimeFull\(/,
    "crosshair time label renders via formatManilaDateTimeFull",
  );
  const timefmt = readSrc("../src/services/timefmt.ts");
  assert.match(timefmt, /timeZone:\s*MANILA_TZ,[\s\S]*weekday:\s*"long"/, "weekday computed in Asia/Manila");
});
