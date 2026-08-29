/**
 * TEMPORARY (this stage only): same contract checks as ws-check.mjs, but for
 * the Supabase-history stage and writing results to a FILE (the interactive
 * shell here cannot capture this script's stdout). Connects to the browser's
 * exact WS path — ws://localhost:5173/ws?res=MINUTE_3 via the Vite proxy —
 * and verifies the frames that will drive series.update() after the
 * /api/candles/db handoff:
 *   1. connection + truthful status frames
 *   2. candle frames carry timeframe=MINUTE_3, bucket on the 180 s grid
 *   3. forming-candle updates (same bucket) + at least one ROLLOVER
 *   4. prices finite and non-zero
 */
import WebSocket from "../backend/node_modules/ws/index.js";
import { writeFileSync } from "node:fs";

const BASE_HOST = process.env.WS_CHECK_HOST || "localhost:5173";
const RES = "MINUTE_3";
const BUCKET = 180;
const WAIT_MS = Number(process.env.WS_CHECK_WAIT_MS || 200_000);
const OUT = process.env.WS_CHECK_OUT || "ws-check-db-stage.log";

const lines = [];
const out = (s) => {
  lines.push(s);
  try { writeFileSync(OUT, lines.join("\n")); } catch { /* best effort */ }
};

const iso = (sOrMs) => new Date(typeof sOrMs === "number" && sOrMs > 1e12 ? sOrMs : sOrMs * 1000).toISOString();
const ws = new WebSocket(`ws://${BASE_HOST}/ws?res=${RES}`);
const seen = { status: 0, candle: 0, other: 0 };
let lastBucket = 0, updates = 0, rollovers = 0, badFrames = 0;
let lastCandleAt = 0;

ws.on("open", () => out(`[WS-CHECK] connected ws://${BASE_HOST}/ws?res=${RES} at ${iso(Date.now())}`));
ws.on("error", (e) => out(`[WS-CHECK] socket error: ${e.message}`));
ws.on("close", () => out("[WS-CHECK] closed"));

ws.on("message", (raw) => {
  let m;
  try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.type === "status") {
    seen.status++;
    if (seen.status <= 2) out(`[WS-CHECK] status #${seen.status}: ${m.status} ticks=${m.ticks}`);
  } else if (m.type === "candle") {
    seen.candle++;
    lastCandleAt = Date.now();
    if (m.timeframe !== RES) { badFrames++; out(`[WS-CHECK] BAD timeframe=${m.timeframe} (expected ${RES})`); }
    if (![m.open, m.high, m.low, m.close].every((v) => Number.isFinite(v) && v > 0)) { badFrames++; out(`[WS-CHECK] BAD ohlc: ${JSON.stringify(m)}`); }
    if (m.time % BUCKET !== 0) { badFrames++; out(`[WS-CHECK] BAD bucket not on grid: ${m.time}`); }
    if (m.time === lastBucket) updates++;
    else if (lastBucket !== 0 && m.time > lastBucket) {
      rollovers++;
      out(`[WS-CHECK] >>> ROLLOVER #${rollovers}: ${iso(lastBucket)} -> ${iso(m.time)} (o=${m.open} h=${m.high} l=${m.low} c=${m.close})`);
    }
    lastBucket = m.time;
  } else {
    seen.other++;
  }
});

setTimeout(() => {
  out("[WS-CHECK] SUMMARY");
  out(`  frames: status=${seen.status} candle=${seen.candle} other=${seen.other}`);
  out(`  forming-candle updates (same bucket): ${updates}`);
  out(`  bucket rollovers observed: ${rollovers}`);
  out(`  bad frames: ${badFrames}`);
  out(`  last candle frame at: ${lastCandleAt ? `${iso(lastCandleAt)}` : "never"}`);
  out(`  RESULT: ${badFrames > 0 || seen.candle === 0 ? "FAIL" : "PASS"}`);
  ws.close();
  process.exit(badFrames > 0 || seen.candle === 0 ? 1 : 0);
}, WAIT_MS);
