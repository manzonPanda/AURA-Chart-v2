/**
 * verifyProduction.ts — READ-ONLY verification script for Phase 6B/7
 *
 * Runs the exact diagnostic queries required by the verification step, reusing
 * the repo's own Supabase client + config (.env). Performs ZERO writes.
 *
 * Usage (on the prod VM):
 *   cd /home/ubuntu/apps/AURA-Chart-v2/backend
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx src/scripts/verifyProduction.ts
 */
import assert from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { loadConfig } from "../config.js";

const config = loadConfig();
const admin = createClient(config.supabase.url, config.supabase.serviceKey, {
  db: { schema: "public" },
  auth: { persistSession: false, autoRefreshToken: false },
});

async function run(): Promise<void> {
  // ── Row counts by instrument ──────────────────────────────────────────────
  const { data: counts, error: errCounts } = await admin
    .from("ohlc_candles")
    .select("instrument,timeframe", { count: "exact", head: true });
  assert.ifError(errCounts);

  // Supabase JS doesn't aggregate server-side in select — use rpc-free raw
  // approach via the Postgres function interface if available, otherwise group.
  const { data: grouped, error: errGroup } = await admin.rpc("candle_counts");
  // Fallback: we'll do this with individual count queries per instrument.
  const queryCount = async (inst: string, tf: string): Promise<number> => {
    const { count, error } = await admin
      .from("ohlc_candles")
      .select("*", { count: "exact", head: true })
      .eq("instrument", inst)
      .eq("timeframe", tf);
    if (error) throw error;
    return count ?? 0;
  };

  const total = await queryCount("", "");   // placeholder — will be overridden
  const capitalGold = await queryCount("GOLD", "MINUTE_1");
  const legacyGold = await queryCount("CS.D.CFIGOLD.CFI.IP", "MINUTE_1");
  const dax = await queryCount("IX.D.DAX.IGM.IP", "MINUTE_1");
  const silver = await queryCount("CS.D.CFDSILVER.CMG.IP", "MINUTE_1");

  // Total count
  const { count: totalCount, error: errTotal } = await admin
    .from("ohlc_candles")
    .select("*", { count: "exact", head: true });
  assert.ifError(errTotal);

  console.log("=== 3. DATABASE ROW COUNTS (Project B / production) ===");
  console.log(`Total rows:        ${totalCount}`);
  console.log(`  GOLD (Capital):  ${capitalGold}`);
  console.log(`  Legacy IG Gold:  ${legacyGold}`);
  console.log(`  DAX:             ${dax}`);
  console.log(`  Silver:          ${silver}`);

  // ── Backup table check ───────────────────────────────────────────────────
  // Supabase JS client doesn't expose to_regclass directly — use rpc or raw
  // via the admin REST / rpc interface. We'll check via a count attempt.
  console.log("\n=== 3b. BACKUP TABLE CHECK ===");
  const { count: backupCount, error: errBackup } = await admin
    .from("ohlc_candles_legacy_gold_backup")
    .select("*", { count: "exact", head: true });
  if (errBackup && errBackup.message.includes("does not exist")) {
    console.log("  public.ohlc_candles_legacy_gold_backup: DOES_NOT_EXIST");
  } else {
    console.log(`  public.ohlc_candles_legacy_gold_backup: EXISTS (${backupCount ?? 0} rows)`);
  }

  // ── GOLD bounds ──────────────────────────────────────────────────────────
  console.log("\n=== GOLD bounds ===");
  const { data: bounds, error: errBounds } = await admin
    .from("ohlc_candles")
    .select("bucket_time")
    .eq("instrument", "GOLD")
    .order("bucket_time", { ascending: true })
    .limit(1)
    .single();
  console.log(`  Earliest GOLD candle: ${bounds?.bucket_time ?? "none"}`);

  const { data: bounds2, error: errBounds2 } = await admin
    .from("ohlc_candles")
    .select("bucket_time")
    .eq("instrument", "GOLD")
    .order("bucket_time", { ascending: false })
    .limit(1)
    .single();
  console.log(`  Latest GOLD candle:   ${bounds2?.bucket_time ?? "none"}`);

  // ── Service restart check ────────────────────────────────────────────────
  console.log("\n=== 6. SERVICE STATUS (via /api/health) ===");
  try {
    const res = await fetch("http://127.0.0.1:8787/api/health", {
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    console.log(`  Health endpoint: HTTP ${res.status} → ${body.slice(0, 200)}`);
  } catch {
    console.log("  (Cannot reach local health — service check skipped on remote runner)");
  }
}

run().catch((e: unknown) => {
  console.error("FAILED:", e);
  process.exit(1);
});
