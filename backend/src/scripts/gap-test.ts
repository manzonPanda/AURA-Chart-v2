/**
 * `npm run gap:test` — OFFLINE unit tests for Stage 2 gap detection
 * (src/market/calendar.ts + src/market/gapDetector.ts). No DB, no IG, no clock:
 * every scenario pins explicit UTC instants so results are deterministic.
 *
 * Covers: continuous history, single/multiple missing buckets, partial vs
 * missing separation, completed reporting, weekend closure, the daily DAX
 * session break, holidays, and DST correctness (August BST vs December GMT).
 */
import { IG_GERMANY_40, isBucketExpected } from "../market/calendar.js";
import { detectGaps, type GapRow } from "../market/gapDetector.js";

let failed = false;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

/** Wed 2026-08-26, London BST (UTC+1): 09:00 UK = 08:00 UTC. On the 180s grid. */
const DAY = Date.UTC(2026, 7, 26) / 1000;
const U = (daySec: number, h: number, m: number): number => daySec + h * 3600 + m * 60;

/** Contiguous rows 08:00–09:00 UTC (20 buckets) all completed. */
function fullDayRows(): GapRow[] {
  const rows: GapRow[] = [];
  for (let t = U(DAY, 8, 0); t < U(DAY, 9, 0); t += 180) rows.push({ time: t, status: "completed" });
  return rows;
}

function main(): void {
  // ── 1. Continuous candles → no missing gaps ──────────────────────────────
  const r1 = detectGaps(fullDayRows(), { fromSec: U(DAY, 8, 0), toSec: U(DAY, 9, 0), calendar: IG_GERMANY_40 });
  check("1. continuous rows → zero missing", r1.missing.length === 0 && r1.completed.length === 20,
    `missing=${r1.missing.length} completed=${r1.completed.length}`);

  // ── 2. One missing bucket → exactly that bucket ─────────────────────────
  const rows2 = fullDayRows().filter((r) => r.time !== U(DAY, 8, 9));
  const r2 = detectGaps(rows2, { fromSec: U(DAY, 8, 0), toSec: U(DAY, 9, 0), calendar: IG_GERMANY_40 });
  check("2. one missing bucket detected exactly", r2.missing.length === 1 && r2.missing[0] === U(DAY, 8, 9),
    `missing=${r2.missing.map((s) => new Date(s * 1000).toISOString()).join(",")}`);

  // ── 3. Multiple missing buckets → all detected ───────────────────────────
  const gone = [U(DAY, 8, 9), U(DAY, 8, 30), U(DAY, 8, 51)];
  const rows3 = fullDayRows().filter((r) => !gone.includes(r.time));
  const r3 = detectGaps(rows3, { fromSec: U(DAY, 8, 0), toSec: U(DAY, 9, 0), calendar: IG_GERMANY_40 });
  check("3. multiple missing buckets all detected", r3.missing.length === 3 && gone.every((g) => r3.missing.includes(g)),
    `missing=${r3.missing.length}`);

  // ── 4. Partial bucket → partial, NOT missing ─────────────────────────────
  const rows4 = fullDayRows().map((r) => (r.time === U(DAY, 8, 15) ? { ...r, status: "partial" as const } : r));
  const r4 = detectGaps(rows4, { fromSec: U(DAY, 8, 0), toSec: U(DAY, 9, 0), calendar: IG_GERMANY_40 });
  check("4. partial bucket reported as partial only",
    r4.partial.length === 1 && r4.partial[0] === U(DAY, 8, 15) && r4.missing.length === 0,
    `partial=${r4.partial.length} missing=${r4.missing.length}`);

  // ── 5. Completed buckets → reported ──────────────────────────────────────
  check("5. completed buckets reported", r4.completed.length === 19, `completed=${r4.completed.length}`);

  // ── 6. Weekend → NOT reported as missing ─────────────────────────────────
  // Scan the last Friday main-session bucket (19:57 UTC = 20:57 UK) through
  // Saturday midnight UTC: Friday evening (post 21:00 UK close) + all Saturday
  // must yield ZERO expected buckets. NOTE: the scan MUST NOT run into Sunday
  // 00:10 UTC — that is Monday 01:10 UK, where the real overnight session
  // opens (scenario 6b).
  const FRI = Date.UTC(2026, 7, 21) / 1000;
  const SAT = Date.UTC(2026, 7, 22) / 1000;
  const SUN = Date.UTC(2026, 7, 23) / 1000;
  const MON = Date.UTC(2026, 7, 24) / 1000;
  const r6 = detectGaps(
    [{ time: U(FRI, 19, 57), status: "completed" }, { time: U(SAT, 12, 0), status: "completed" }],
    { fromSec: U(FRI, 19, 57), toSec: U(SUN, 0, 0), calendar: IG_GERMANY_40 },
  );
  check("6. weekend closure invisible to detector",
    r6.expectedBuckets === 1 && r6.missing.length === 0 && r6.completed.length === 1,
    `expectedBuckets=${r6.expectedBuckets} missing=${r6.missing.length}`);
  check("6a. Saturday row outside expected grid → informational 'unexpected', NOT missing",
    r6.unexpected.includes(U(SAT, 12, 0)) && !r6.missing.includes(U(SAT, 12, 0)),
    `unexpected=${r6.unexpected.length}`);

  // ── 6b. Overnight session (01:10–05:00 UK) is REAL market time ───────────
  // Monday 00:09–03:57 UTC (01:09–04:59 UK) holds 77 expected 3-minute buckets.
  // With rows for all of them → zero missing; without rows → 77 missing (an
  // outage during the overnight session IS detectable data loss).
  const overnightStart = U(MON, 0, 9);
  const overnightRows: GapRow[] = [];
  for (let t = overnightStart; t < U(MON, 4, 0); t += 180) {
    overnightRows.push({ time: t, status: "completed" });
  }
  const r6bWith = detectGaps(overnightRows, { fromSec: U(MON, 0, 0), toSec: U(MON, 7, 0), calendar: IG_GERMANY_40 });
  const r6bWithout = detectGaps([], { fromSec: U(MON, 0, 0), toSec: U(MON, 7, 0), calendar: IG_GERMANY_40 });
  check("6b. overnight session buckets expected & satisfied when rows exist",
    r6bWith.expectedBuckets === 77 && r6bWith.missing.length === 0,
    `expected=${r6bWith.expectedBuckets} missing=${r6bWith.missing.length}`);
  check("6b. outage during overnight session detected as missing",
    r6bWithout.missing.length === 77,
    `missing=${r6bWithout.missing.length}`);

  // ── 7. Daily session break (05:00–08:00 UK) → NOT missing ────────────────
  // Wed 03:57 UTC (04:57 UK, in overnight window) → 07:03 UTC (08:03 UK).
  // The 04:00–06:57 UTC break buckets must not be expected.
  const r7 = detectGaps(
    [U(DAY, 3, 57), U(DAY, 7, 0), U(DAY, 7, 3)].map((time) => ({ time, status: "completed" as const })),
    { fromSec: U(DAY, 3, 57), toSec: U(DAY, 7, 6), calendar: IG_GERMANY_40 },
  );
  check("7. daily session break invisible to detector",
    r7.expectedBuckets === 3 && r7.missing.length === 0,
    `expectedBuckets=${r7.expectedBuckets} missing=${r7.missing.length}`);

  // ── 7b. Holiday closure → NOT missing ────────────────────────────────────
  const XMAS = Date.UTC(2025, 11, 25) / 1000; // Thursday 2025-12-25, seeded closure
  const r7b = detectGaps([], { fromSec: XMAS, toSec: XMAS + 86400, calendar: IG_GERMANY_40 });
  check("7b. holiday (2025-12-25) invisible to detector", r7b.expectedBuckets === 0,
    `expectedBuckets=${r7b.expectedBuckets}`);

  // ── DST correctness (August BST vs December GMT) ─────────────────────────
  // August: 08:00 UK = 07:00 UTC → 07:00 UTC expected, 06:57 UTC (break) not.
  check("DST August: 07:00 UTC (=08:00 UK) expected", isBucketExpected(U(DAY, 7, 0), IG_GERMANY_40));
  check("DST August: 06:57 UTC (=07:57 UK, break) NOT expected", !isBucketExpected(U(DAY, 6, 57), IG_GERMANY_40));
  // December: 08:00 UK = 08:00 UTC → 08:00 UTC expected, 07:57 UTC (break) not.
  const DEC = Date.UTC(2025, 11, 2) / 1000; // Tuesday
  check("DST December: 08:00 UTC (=08:00 UK) expected", isBucketExpected(U(DEC, 8, 0), IG_GERMANY_40));
  check("DST December: 07:57 UTC (=07:57 UK, break) NOT expected", !isBucketExpected(U(DEC, 7, 57), IG_GERMANY_40));

  // ── Mid-grid session open (01:10 UK) ─────────────────────────────────────
  // 01:10 UK opens INSIDE the 01:09–01:12 bucket → that 3m bucket is expected.
  // (Explicit 180 s width — isBucketExpected now takes the grid width; the
  // 60 s default would correctly reject 01:09 on the 1m grid, which does not
  // touch the 01:10 open.)
  check("mid-grid open: 00:09 UTC (01:09 UK) expected", isBucketExpected(U(DAY, 0, 9), IG_GERMANY_40, 180));
  check("mid-grid open: 00:06 UTC (01:06 UK) NOT expected", !isBucketExpected(U(DAY, 0, 6), IG_GERMANY_40, 180));

  // ── toSec is exclusive (forming bucket excluded by the caller) ───────────
  const r8 = detectGaps(fullDayRows(), { fromSec: U(DAY, 8, 0), toSec: U(DAY, 8, 6), calendar: IG_GERMANY_40 });
  check("toSec is exclusive (forming bucket excluded by caller)",
    r8.expectedBuckets === 2 && r8.completed.length === 2,
    `expectedBuckets=${r8.expectedBuckets}`);

  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(failed ? 1 : 0);
}

main();