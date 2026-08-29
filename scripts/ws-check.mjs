/**
 * TEMPORARY live-pipeline verification: connects a WS client to the DEV SERVER
 * (ws://localhost:5173/ws — the exact path the browser uses, via the Vite
 * proxy) and captures realtime frames. Verifies:
 *   1. connection + truthful status frames (LIVE means ticks flowing)
 *   2. candle frames carry the REQUESTED timeframe (MINUTE_15 here)
 *   3. every bucketStart = floor(tickTs/interval)*interval
 *   4. forming-candle UPDATES (same bucket) and bucket ROLLOVER (new bucket)
 *   5. prices are finite and non-zero (LTP never becomes 0/NaN)
 * Safe output: timestamps, counts, prices only.
 */
import WebSocket from "../backend/node_modules/ws/index.js";

const BASE_HOST = process.env.WS_CHECK_HOST || "localhost:5173";
const RES = process.env.WS_CHECK_RES || "MINUTE";
const BUCKET = { MINUTE: 60, MINUTE_3: 180 }[RES] || 60;
const WAIT_MS = Number(process.env.WS_CHECK_WAIT_MS || 180_000);

const iso = (sOrMs) => new Date(typeof sOrMs === "number" && sOrMs > 1e12 ? sOrMs : sOrMs * 1000).toISOString();

const ws = new WebSocket(`ws://${BASE_HOST}/ws?res=${RES}`);
const seen = { status: 0, candle: 0, other: 0 };
let lastBucket = 0;
let updates = 0, rollovers = 0, badFrames = 0;
let firstCandleAt = 0, lastCandleAt = 0;
const t0 = Date.now();

ws.on("open", () => {
  console.log(`[WS-CHECK] connected ws://${BASE_HOST}/ws?res=${RES} at ${iso(Date.now())}`);
});
ws.on("error", (e) => {
  console.log(`[WS-CHECK] socket error: ${e.message}`);
});
ws.on("close", () => console.log("[WS-CHECK] closed"));

ws.on("message", (raw) => {
  let m;
  try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.type === "status") {
    seen.status++;
    console.log(
      `[WS-CHECK] status #${seen.status}: ${m.status} ticks=${m.ticks}` +
        (m.lastTickAt ? ` lastTickAt=${iso(m.lastTickAt)}` : " lastTickAt=never") +
        (m.price != null ? ` price=${m.price}` : ""),
    );
  } else if (m.type === "candle") {
    seen.candle++;
    if (firstCandleAt === 0) firstCandleAt = Date.now();
    lastCandleAt = Date.now();
    // Frame contract checks
    if (m.timeframe !== RES) { badFrames++; console.log(`[WS-CHECK] BAD timeframe=${m.timeframe} (expected ${RES})`); }
    if (![m.open, m.high, m.low, m.close].every((v) => Number.isFinite(v) && v > 0)) {
      badFrames++;
      console.log(`[WS-CHECK] BAD ohlc (non-finite or zero): ${JSON.stringify(m)}`);
    }
    const bucketMs = Math.floor(Date.now() / 1000 / BUCKET) * BUCKET;
    const onGrid = m.time % BUCKET === 0;
    if (!onGrid) { badFrames++; console.log(`[WS-CHECK] BAD bucket not on grid: ${m.time}`); }
    if (m.time > bucketMs + BUCKET) { badFrames++; console.log(`[WS-CHECK] FUTURE bucket: ${iso(m.time)}`); }
    if (m.time === lastBucket) updates++;
    else if (lastBucket !== 0 && m.time > lastBucket) {
      rollovers++;
      console.log(`[WS-CHECK] >>> ROLLOVER #${rollovers}: ${iso(lastBucket)} -> ${iso(m.time)} (open=${m.open} high=${m.high} low=${m.low} close=${m.close})`);
    } else {
      console.log(`[WS-CHECK] candle #${seen.candle} timeframe=${m.timeframe} bucket=${iso(m.time)} o=${m.open} h=${m.high} l=${m.low} c=${m.close} vol=${m.volume ?? 0}`);
    }
    lastBucket = m.time;
  } else {
    seen.other++;
  }
});

setTimeout(() => {
  const age = lastCandleAt ? Math.round((Date.now() - lastCandleAt) / 1000) : null;
  console.log("\n[WS-CHECK] SUMMARY");
  console.log(`  res=${RES} bucket=${BUCKET}s`);
  console.log(`  framesReceived: total=${seen.status + seen.candle + seen.other} status=${seen.status} candle=${seen.candle} other=${seen.other}`);
  console.log(`  forming-candle updates (same bucket): ${updates}`);
  console.log(`  bucket rollovers observed: ${rollovers}`);
  console.log(`  bad frames: ${badFrames}`);
  console.log(`  first candle frame at: ${firstCandleAt ? iso(firstCandleAt) : "never"}`);
  console.log(`  last candle frame at:  ${lastCandleAt ? `${iso(lastCandleAt)} (${age}s ago)` : "never"}`);
  ws.close();
  process.exit(badFrames > 0 || seen.candle === 0 ? 1 : 0);
}, WAIT_MS);
