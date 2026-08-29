/**
 * Stage 3 — OFFLINE backfill contract test. Uses ONLY synthetic TEST_INSTRUMENT
 * rows (real market data is never touched) against the real Supabase table so
 * the unique constraint + conditional-write semantics are exercised for real.
 *
 * Covered scenarios (mapping to the Stage-3 test list):
 *   1  missing bucket → inserted as backfilled/ig_historical
 *   2  partial bucket → repaired to backfilled
 *   3  completed bucket → insert ignored + repair refused, OHLC unchanged
 *   4  backfilled bucket → protected by default, repaired only with --force flag
 *   5  IG returns no data → partial remains untouched (planner: uncovered)
 *   6  IG unavailable → planner receives no rows → nothing planned (CLI maps
 *      allowance errors to a clean abort; verified live separately)
 *   7  duplicate backfill → still exactly one row
 *   8  multiple missing → all planned/inserted
 *   9  exact 3-minute grid alignment (ts % 180 === 0)
 *   10 forming/live bucket excluded from every plan
 *   11 deterministic OHLC (same IG rows → identical plans)
 *   12 planned-but-not-applied ranges create NO rows (dry-run safety)
 *   13 status='backfilled' + source='ig_historical' persisted and readable
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { createSupabaseAdmin } from "../db/supabaseClient.js";
import { CandleStore } from "../db/candleStore.js";
import { planBackfill } from "../backfill/planner.js";
import { IG_GERMANY_40 } from "../market/calendar.js";
import type { ClosedCandle } from "../streaming/types.js";
import type { Candle } from "../types/candle.js";

const INSTRUMENT = "TEST_INSTRUMENT";
const TF = "MINUTE_3";
/** Wednesday 2026-08-26 09:00 UTC — inside the DAX main session (08:00–21:00 UK). */
const BASE = Math.floor(Date.UTC(2026, 7, 26, 9, 0, 0) / 1000);
/** n-th 3-minute bucket after BASE. */
const B = (n: number): number => BASE + n * 180;

/** Deterministic synthetic IG 1-minute candles covering the given 3m buckets. */
function igOneMin(buckets: number[]): Candle[] {
  const rows: Candle[] = [];
  for (const b of buckets) {
    for (let m = 0; m < 3; m++) {
      const ts = (b + m * 60) * 1000;
      const v = 1000 + ((ts / 60_000) % 500);
      rows.push({ ts, open: v, high: v + 0.5, low: v - 0.5, close: v + 0.25 });
    }
  }
  return rows.sort((x, y) => x.ts - y.ts);
}

/** Realtime-style closed candle; partial when the first tick arrived 100 s in. */
function closed(bucket: number, partial = false): ClosedCandle {
  return {
    time: bucket,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    tickCount: partial ? 40 : 300,
    firstTickMs: bucket * 1000 + (partial ? 100_000 : 350),
    lastTickMs: bucket * 1000 + 179_000,
  };
}

let failed = false;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const admin = createSupabaseAdmin(config.supabase);
  if (!admin) {
    console.error("Supabase not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in backend/.env");
    process.exit(1);
  }
  const store = new CandleStore(admin, config.supabase.table);

  try {
    // ── Scenario 1 + 8 + 9 + 13: multiple missing buckets → planned & inserted ──
    const oneMin0to2 = igOneMin([B(0), B(1), B(2)]);
    const plan1 = planBackfill({
      fromSec: B(0),
      toSec: B(2),
      formingBucketSec: B(9),
      oneMin: oneMin0to2,
      rows: await store.loadCandlesRange(INSTRUMENT, TF, B(0), B(2)),
      calendar: IG_GERMANY_40,
    });
    check(
      "S1/8 plan: 3 missing buckets → 3 inserts, none uncovered",
      plan1.inserts.length === 3 && plan1.uncovered.length === 0 && plan1.stats.expectedBuckets === 3,
    );
    check("S9 grid alignment: every planned ts % 180 === 0", plan1.inserts.every((p) => p.bucketSec % 180 === 0));
    for (const p of plan1.inserts) {
      const r = await store.insertIfMissing(INSTRUMENT, TF, {
        time: p.bucketSec,
        open: p.candle.open,
        high: p.candle.high,
        low: p.candle.low,
        close: p.candle.close,
      });
      if (r !== "inserted") check(`S1 insert ${p.bucketSec}`, false, r);
    }
    const after1 = await store.loadCandlesRange(INSTRUMENT, TF, B(0), B(2));
    const s13 =
      after1.length === 3 &&
      after1.every((r, i) => r.status === "backfilled" && r.time === plan1.inserts[i].bucketSec &&
        r.open === plan1.inserts[i].candle.open && r.close === plan1.inserts[i].candle.close);
    check("S1/13 inserted rows: status=backfilled, OHLC = plan, exact buckets", s13, `rows=${after1.length}`);

    // ── Scenario 11: determinism ──
    const plan1b = planBackfill({
      fromSec: B(0), toSec: B(2), formingBucketSec: B(9), oneMin: oneMin0to2,
      rows: after1.filter(() => false), calendar: IG_GERMANY_40,
    });
    check("S11 deterministic: identical IG rows → identical plan", JSON.stringify(plan1) === JSON.stringify(plan1b));

    // ── Scenario 7: duplicate backfill attempt ──
    const dup = await store.insertIfMissing(INSTRUMENT, TF, {
      time: B(0), open: 999, high: 999, low: 999, close: 999,
    });
    const afterDup = await store.loadCandlesRange(INSTRUMENT, TF, B(0), B(0));
    check(
      "S7 duplicate insert → already-present, one row, OHLC unchanged",
      dup === "already-present" && afterDup.length === 1 && afterDup[0].close === plan1.inserts[0].candle.close,
    );

    // ── Scenario 12: planned-but-never-applied range must not phantom-write ──
    const still3 = await store.loadCandlesRange(INSTRUMENT, TF, B(0), B(2));
    check("S12 planned-but-not-applied → still exactly 3 rows (no phantom writes)", still3.length === 3, `rows=${still3.length}`);

    // ── Scenarios 2/3/4/5 in one plan: partial B(4), completed B(6),
    //    covered-missing B(3), uncovered partial B(5), uncovered missing B(7) ──
    await store.saveClosedCandle(INSTRUMENT, TF, closed(B(4), true)); // partial (first tick 100 s in)
    await store.saveClosedCandle(INSTRUMENT, TF, closed(B(6), false)); // completed (first tick 350 ms)
    await store.saveClosedCandle(INSTRUMENT, TF, closed(B(5), true)); // partial WITHOUT IG coverage
    const rowsMid = await store.loadCandlesRange(INSTRUMENT, TF, B(0), B(7));
    const plan2 = planBackfill({
      fromSec: B(0),
      toSec: B(7),
      formingBucketSec: B(9),
      oneMin: igOneMin([B(0), B(1), B(2), B(3), B(4), B(6)]),
      rows: rowsMid,
      calendar: IG_GERMANY_40,
    });
    const rep4 = plan2.repairs.find((r) => r.bucketSec === B(4));
    check(
      "S2 plan: partial B(4) → repair candidate (previousStatus=partial)",
      rep4 !== undefined && rep4.previousStatus === "partial",
    );
    check(
      "S3 plan: completed B(6) protected — skipped, never planned",
      plan2.skippedCompleted.includes(B(6)) &&
        !plan2.inserts.some((p) => p.bucketSec === B(6)) &&
        !plan2.repairs.some((r) => r.bucketSec === B(6)),
      `protected=${plan2.skippedCompleted.length}`,
    );
    check(
      "S4 plan: backfilled B(0) protected by default",
      plan2.skippedBackfilled.includes(B(0)) && !plan2.repairs.some((r) => r.bucketSec === B(0)),
    );
    check(
      "S5 plan: partial B(5) & missing B(7) lack IG coverage → uncovered, untouched",
      plan2.uncovered.some((u) => u.bucketSec === B(5) && u.reason === "partial") &&
        plan2.uncovered.some((u) => u.bucketSec === B(7) && u.reason === "missing"),
    );

    // Apply plan2 exactly like the real CLI: inserts then conditional repairs.
    const ohlc = (c: Candle) => ({ open: c.open, high: c.high, low: c.low, close: c.close });
    let inserted = 0;
    let alreadyPresent = 0;
    let repaired = 0;
    let statusChanged = 0;
    for (const p of plan2.inserts) {
      const r = await store.insertIfMissing(INSTRUMENT, TF, { time: p.bucketSec, ...ohlc(p.candle) });
      if (r === "inserted") inserted += 1;
      else alreadyPresent += 1;
    }
    for (const r of plan2.repairs) {
      const res = await store.repairIfPartial(INSTRUMENT, TF, { time: r.bucketSec, ...ohlc(r.candle) });
      if (res === "repaired") repaired += 1;
      else statusChanged += 1;
    }
    const after2 = await store.loadCandlesRange(INSTRUMENT, TF, B(0), B(7));
    const byB = new Map(after2.map((r) => [r.time, r]));
    const b4 = byB.get(B(4));
    check(
      "S2 write: B(4) repaired → status=backfilled, IG-derived OHLC, tick_count cleared",
      repaired === 1 && b4?.status === "backfilled" && rep4 !== undefined &&
        b4?.close === rep4.candle.close && b4?.tickCount === null,
    );
    check(
      "S3 write: completed B(6) OHLC + status unchanged after full apply",
      byB.get(B(6))?.status === "completed" && byB.get(B(6))?.open === 1 && byB.get(B(6))?.close === 1.5,
    );
    check(
      "S5 write: B(5) partial untouched, B(7) still absent",
      byB.get(B(5))?.status === "partial" && byB.get(B(5))?.open === 1 && !byB.has(B(7)),
    );
    check(
      "S8 write: covered missing bucket inserted; DB holds 5 backfilled rows total",
      inserted === 1 && alreadyPresent === 0 && after2.filter((r) => r.status === "backfilled").length === 5,
      `inserted=${inserted}`,
    );

    // ── Scenario 4 write-level: backfilled protection + explicit --force path ──
    const refused = await store.repairIfPartial(INSTRUMENT, TF, { time: B(0), open: 42, high: 42, low: 42, close: 42 });
    const forced = await store.repairIfPartial(
      INSTRUMENT, TF, { time: B(0), open: 10, high: 11, low: 9, close: 10.5 }, { includeBackfilled: true },
    );
    const b0 = (await store.loadCandlesRange(INSTRUMENT, TF, B(0), B(0)))[0];
    check(
      "S4 write: backfilled refused without force, repaired with force",
      refused === "status-changed" && forced === "repaired" && b0?.open === 10 && b0?.status === "backfilled",
    );

    // ── Scenario 10: forming/live bucket never planned ──
    const plan10 = planBackfill({
      fromSec: B(8),
      toSec: B(9),
      formingBucketSec: B(8),
      oneMin: igOneMin([B(8)]),
      rows: [],
      calendar: IG_GERMANY_40,
    });
    check(
      "S10 forming/live bucket excluded from every plan",
      plan10.inserts.length === 0 && plan10.repairs.length === 0 && plan10.stats.expectedBuckets === 0,
    );

  } finally {
    const { error } = await admin.from(config.supabase.table).delete().eq("instrument", INSTRUMENT);
    check("cleanup removed TEST_INSTRUMENT rows", !error, error?.message ?? "");
  }

  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
  process.exit(failed ? 1 : 0);
}

void main().catch((err) => {
  console.error("backfill-test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
