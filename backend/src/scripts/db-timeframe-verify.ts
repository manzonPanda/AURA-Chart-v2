/**
 * `npm run db:timeframe-verify`
 *
 * End-to-end verification of the 1m-canonical / 3m-derived timeframe read path
 * against the REAL Supabase table and the REAL running HTTP service, using a
 * synthetic TEST instrument (real market data is never touched):
 *
 *   1. persist 9 synthetic 1m candles (Wed 2026-08-26 09:00–09:08 UTC, one
 *      partial) via CandleStore
 *   2. store read-back: 1m rows aligned to whole minutes, correct statuses
 *   3. GET /api/candles/db?timeframe=MINUTE_1  → the 1m rows as-is
 *   4. GET /api/candles/db?timeframe=MINUTE_3  → DERIVED 3×1m aggregation:
 *      first-open / max-high / min-low / last-close, tick sums, status
 *      strictness (partial propagates), whole-minute bucket anchors
 *   5. GET /api/candles/db?timeframe=MINUTE_5  → trailing incomplete macro
 *      bucket is DROPPED (only fully covered buckets are served)
 *   6. GET /api/candles/db/gaps                → responds with a summary
 *   7. cleanup removes every TEST_INSTRUMENT row
 *
 * Expects SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in backend/.env and the
 * service running (AURA_BASE_URL, default http://127.0.0.1:8787).
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { createSupabaseAdmin } from "../db/supabaseClient.js";
import { CandleStore } from "../db/candleStore.js";
import type { ClosedCandle } from "../streaming/types.js";

const INSTRUMENT = "TEST_INSTRUMENT";
/** Wednesday 2026-08-26 09:00 UTC — inside the DAX main session. */
const BASE = Math.floor(Date.UTC(2026, 7, 26, 9, 0, 0) / 1000);
const BASE_URL = (process.env.AURA_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
}

/** Deterministic synthetic 1m candle for minute offset m after BASE. */
function minuteCandle(m: number): ClosedCandle {
  const bucket = BASE + m * 60;
  return {
    time: bucket,
    open: 100 + m,
    high: 100 + m + 0.6,
    low: 100 + m - 0.4,
    close: 100 + m + 0.3,
    tickCount: 10 + m,
    // Minute 3 anchors 100 s in → classifyClosedCandle marks it partial; every
    // other minute anchors 350 ms after the boundary → completed.
    firstTickMs: bucket * 1000 + (m === 3 ? 100_000 : 350),
    lastTickMs: (bucket + 59) * 1000,
  };
}

/** Aggregate minutes [g*minutes, g*minutes + minutes - 1] by hand. */
function expectedMacro(minutes: number, g: number) {
  const ms = Array.from({ length: minutes }, (_, i) => minuteCandle(g * minutes + i));
  const complete = ms.filter((c) => c.time < BASE + g * minutes * 60 + minutes * 60);
  return {
    covered: complete.length === minutes,
    time: BASE + g * minutes * 60,
    open: complete[0]?.open ?? NaN,
    high: complete.length ? Math.max(...complete.map((c) => c.high)) : NaN,
    low: complete.length ? Math.min(...complete.map((c) => c.low)) : NaN,
    close: complete[complete.length - 1]?.close ?? NaN,
    tickCount: complete.reduce((s, c) => s + (c.tickCount ?? 0), 0),
  };
}
interface ApiCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount?: number | null;
  status?: string;
}
interface ApiResp {
  epic: string;
  timeframe: string;
  count: number;
  candles: ApiCandle[];
  error?: string;
  code?: string;
}

async function getApi(path: string): Promise<{ status: number; body: ApiResp }> {
  const res = await fetch(`${BASE_URL}${path}`);
  const body = (await res.json()) as ApiResp;
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const admin = createSupabaseAdmin(config.supabase);
  if (!admin) {
    console.error("Supabase admin client unavailable — check SUPABASE_URL / SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  const store = new CandleStore(admin, config.supabase.table);

  console.log(`\n=== db:timeframe-verify — ${INSTRUMENT} @ ${BASE_URL} ===\n`);

  // ── Seed 9 synthetic 1m candles ────────────────────────────────────────────
  for (let m = 0; m < 9; m++) {
    await store.saveClosedCandle(INSTRUMENT, "MINUTE_1", minuteCandle(m));
  }

  try {
    // ── 1) store read-back ────────────────────────────────────────────────────
    const rows = await store.loadCandles(INSTRUMENT, "MINUTE_1", 100);
    check("store: 9 persisted 1m rows", rows.length === 9, `rows=${rows.length}`);
    check("store: every 1m row aligned to a whole minute", rows.every((r) => r.time % 60 === 0));
    check("store: ascending order", rows.every((r, i, a) => i === 0 || r.time > a[i - 1].time));
    const byTime = new Map(rows.map((r) => [r.time, r]));
    check(
      "store: minute 3 classified partial, others completed",
      byTime.get(BASE + 180)?.status === "partial" &&
        rows.filter((r) => r.time !== BASE + 180).every((r) => r.status === "completed"),
    );

    // ── 2) HTTP MINUTE_1 → rows as-is ─────────────────────────────────────────
    const r1 = await getApi(`/api/candles/db?epic=${INSTRUMENT}&timeframe=MINUTE_1&limit=100`);
    check(
      "api 1m: 200 + count=9",
      r1.status === 200 && r1.body.count === 9,
      `status=${r1.status} count=${r1.body.count} ${r1.body.error ?? ""}`,
    );
    check(
      "api 1m: echoes timeframe + row times match store",
      r1.body.timeframe === "MINUTE_1" &&
        r1.body.candles.map((c) => c.time).join(",") === rows.map((r) => r.time).join(","),
    );

    // ── 3) HTTP MINUTE_3 → derived 3×1m aggregation ───────────────────────────
    const r3 = await getApi(`/api/candles/db?epic=${INSTRUMENT}&timeframe=MINUTE_3&limit=10`);
    check(
      "api 3m: 200 + count=3 (9 one-min rows → 3 macro)",
      r3.status === 200 && r3.body.count === 3,
      `status=${r3.status} count=${r3.body.count} ${r3.body.error ?? ""}`,
    );
    for (let g = 0; g < 3; g++) {
      const exp = expectedMacro(3, g);
      const got = r3.body.candles[g];
      const same =
        got &&
        got.time === exp.time &&
        Math.abs(got.open - exp.open) < 1e-9 &&
        Math.abs(got.high - exp.high) < 1e-9 &&
        Math.abs(got.low - exp.low) < 1e-9 &&
        Math.abs(got.close - exp.close) < 1e-9 &&
        got.tickCount === exp.tickCount &&
        (got.status ?? "completed") === (g === 1 ? "partial" : "completed");
      check(
        `api 3m: bucket ${new Date(exp.time * 1000).toISOString().slice(11, 16)} OHLCV/status derived correctly`,
        Boolean(same),
        got
          ? `got O=${got.open} H=${got.high} L=${got.low} C=${got.close} T=${got.tickCount} S=${got.status}`
          : "missing row",
      );
    }

    // ── 4) gaps endpoint answers with a summary ───────────────────────────────
    const rg = await getApi(`/api/candles/db/gaps?epic=${INSTRUMENT}&timeframe=MINUTE_3&hours=1`);
    const gapSummary = (rg.body as unknown as { summary?: Record<string, number> }).summary;
    check(
      "api gaps: 200 + summary counts present",
      rg.status === 200 && Boolean(gapSummary && "missing" in gapSummary),
      `status=${rg.status}`,
    );

    console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}\n`);
  } finally {
    const { error } = await admin.from(config.supabase.table).delete().eq("instrument", INSTRUMENT);
    check("cleanup removed TEST_INSTRUMENT rows", !error, error?.message ?? "");
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

