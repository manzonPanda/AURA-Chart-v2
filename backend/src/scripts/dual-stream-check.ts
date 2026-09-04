/**
 * `npm run ig:dual-stream-check` — Phase 1 multi-instrument LIVE verification.
 *
 * Runs the EXACT production data path for BOTH instruments concurrently:
 *   shared IgClient session → TWO IgStreamClient connections (DAX 1dp, Gold
 *   2dp) → per-EPIC routing via processInstrumentTick → independent
 *   InstrumentUnit aggregation → closed 1m candles persisted under each
 *   instrument's own EPIC (CandleStore prints [DB CANDLE SAVED]).
 *
 * Read-only on IG; the only writes are REAL closed 1m candles to the existing
 * ohlc_candles table (same as the live server). Ends with a per-instrument
 * verdict + a query of the latest persisted rows for BOTH EPICs.
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { CandleStore } from "../db/candleStore.js";
import { createSupabaseAdmin } from "../db/supabaseClient.js";
import { IgClient } from "../ig/client.js";
import { instrumentMetaFor, type InstrumentMeta } from "../market/instruments.js";
import { IgStreamClient } from "../streaming/igStream.js";
import {
  createInstrumentUnit,
  persistenceInstrumentFor,
  processInstrumentTick,
  type InstrumentUnit,
} from "../streaming/instrumentPipeline.js";
import type { StreamState } from "../streaming/types.js";

const WAIT_MS = Number(process.env.IG_DUAL_CHECK_WAIT_MS || 150_000);
const PROGRESS_MS = 15_000;

function verdict(ok: boolean, exitCode = 1): never {
  console.log(`RESULT  : ${ok ? "SUCCESS" : "FAIL"}`);
  process.exit(ok ? 0 : exitCode);
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`gateway : ${new URL(config.ig.baseUrl).host}`);
  console.log(`started : ${new Date().toISOString()} (window=${WAIT_MS / 1000}s)`);

  const metas: InstrumentMeta[] = [];
  if (!config.ig.defaultEpic) {
    console.log("FAIL — set IG_DAX_EPIC in backend/.env");
    return verdict(false);
  }
  metas.push(instrumentMetaFor(config.ig.defaultEpic));
  if (config.ig.goldEpic) metas.push(instrumentMetaFor(config.ig.goldEpic));
  if (metas.length < 2) {
    console.log("FAIL — set IG_GOLD_EPIC in backend/.env to verify the dual-stream path");
    return verdict(false);
  }
  console.log(`instruments: ${metas.map((m) => `${m.label} (${m.epic}, ${m.decimals}dp)`).join(" + ")}`);

  // ONE authentication — both streams share this session (production parity).
  const ig = new IgClient({ ...config.ig });
  console.log("authentication: CONNECTING");
  let session;
  try {
    session = await ig.getStreamSession();
    console.log("authentication: PASS (shared by both streams)");
  } catch (err) {
    console.log(`authentication: FAIL — ${err instanceof Error ? err.message : "unknown"}`);
    return verdict(false);
  }
  if (!session.endpoint) {
    console.log("lightstreamer: FAIL — no endpoint in session");
    return verdict(false);
  }

  const supabaseAdmin = createSupabaseAdmin(config.supabase);
  const candleStore = supabaseAdmin ? new CandleStore(supabaseAdmin, config.supabase.table) : null;
  console.log(`persistence: ${candleStore ? "ENABLED (real closed 1m candles)" : "disabled (no Supabase env)"}`);

  // Per-EPIC units — the same isolation the server uses.
  const units = new Map<string, InstrumentUnit>();
  for (const meta of metas) units.set(meta.epic, createInstrumentUnit(meta.epic, meta.label, meta.decimals));
  const states = new Map<string, StreamState>();
  /** True once the stream reached LIVE (verdict must survive the final disconnect). */
  const everLive = new Map<string, boolean>();

  const streams = metas.map((meta) => {
    const unit = units.get(meta.epic)!;
    return new IgStreamClient(
      session,
      meta.epic,
      {
        onTick: (tick) => {
          const results = processInstrumentTick(unit, tick);
          for (const r of results) {
            if (r.closed && r.timeframe === "MINUTE_1" && candleStore) {
              const instrument = persistenceInstrumentFor(r.timeframe, unit)!;
              void candleStore.saveClosedCandle(instrument, r.timeframe, r.closed);
            }
          }
        },
        onState: (state) => {
          states.set(meta.epic, state);
          if (state === "LIVE") everLive.set(meta.epic, true);
          console.log(`[DUAL] ${meta.label} state -> ${state}`);
        },
      },
      meta.decimals, // per-instrument quoting precision (DAX 1 / Gold 2)
    );
  });

  console.log("lightstreamer: CONNECTING both streams…");
  for (const stream of streams) stream.connect();

  // Live window with progress lines.
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PROGRESS_MS));
    const lines = metas
      .map((m) => {
        const u = units.get(m.epic)!;
        return `${m.label}: ticks=${u.ticksReceived} last=${u.lastPrice !== null ? u.lastPrice.toFixed(m.decimals) : "-"}`;
      })
      .join("  |  ");
    console.log(`[DUAL progress] ${lines}`);
  }

  for (const stream of streams) stream.disconnect();

  // ── Verdict per instrument (state BEFORE the deliberate teardown disconnect) ─
  let allLive = true;
  for (const meta of metas) {
    const u = units.get(meta.epic)!;
    const wasLive = everLive.get(meta.epic) === true;
    const ok = u.ticksReceived > 0 && wasLive;
    if (!ok) allLive = false;
    console.log(
      `${meta.label} (${meta.epic}): wasLive=${wasLive} ticks=${u.ticksReceived} ` +
        `lastPrice=${u.lastPrice !== null ? u.lastPrice.toFixed(meta.decimals) : "-"} decimals=${meta.decimals} → ${ok ? "STREAMING" : "NOT STREAMING"}`,
    );
  }

  // ── Persisted rows: latest per instrument ────────────────────────────────
  if (candleStore && supabaseAdmin) {
    await new Promise((r) => setTimeout(r, 2_000)); // let upserts settle
    const { data, error } = await supabaseAdmin
      .from(config.supabase.table)
      .select("instrument,timeframe,bucket_time,open,high,low,close,status")
      .in("instrument", metas.map((m) => m.epic))
      .order("bucket_time", { ascending: false })
      .limit(12);
    if (error) {
      console.log(`[DUAL] DB query error: ${error.message}`);
    } else {
      console.log("[DUAL] latest ohlc_candles rows (both instruments):");
      for (const row of data ?? []) {
        console.log(
          `  instrument=${row.instrument} tf=${row.timeframe} bucket=${row.bucket_time} ` +
            `O=${row.open} H=${row.high} L=${row.low} C=${row.close} status=${row.status}`,
        );
      }
    }
  }

  return verdict(allLive);
}

void main();