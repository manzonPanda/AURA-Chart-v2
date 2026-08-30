/**
 * WS protocol check: connects to the relay with res=MINUTE_1, prints every
 * frame received for 8 s, then exits. Verifies the `res` param is accepted
 * (no error frame) and status/candle frames parse. Market may be closed —
 * absence of candle frames is not a failure; an `error` frame is.
 *
 * Usage: node scripts/ws-check.mjs [res]  (default MINUTE_1)
 */
import WebSocket from "ws";

const res = process.argv[2] || "MINUTE_1";
const url = process.env.AURA_WS_URL || "ws://127.0.0.1:8787/ws";
const ws = new WebSocket(`${url}?res=${res}`);
let candleFrames = 0;
let statusFrames = 0;
let errorFrame = null;

ws.on("open", () => console.log(`WS OPEN url=${url} res=${res}`));
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "candle") candleFrames += 1;
  else if (msg.type === "status") {
    statusFrames += 1;
    console.log("STATUS", JSON.stringify(msg));
  } else if (msg.type === "error") errorFrame = JSON.stringify(msg);
  else console.log("FRAME", JSON.stringify(msg).slice(0, 160));
});
ws.on("error", (err) => {
  console.error("WS ERROR", err.message);
  process.exit(1);
});
ws.on("close", (code) => {
  console.log(
    `WS CLOSE code=${code} candleFrames=${candleFrames} statusFrames=${statusFrames}` +
      (errorFrame ? ` ERROR_FRAME=${errorFrame}` : ""),
  );
  process.exit(errorFrame ? 1 : 0);
});

setTimeout(() => ws.close(), 8000);
