/**
 * `npm run ig:stream-check`
 *
 * Backend-only connectivity diagnostic that proves the IG Lightstreamer feed
 * actually delivers live ticks BEFORE the React chart is hooked up.
 *
 * Runs the SAME classes the server uses (IgClient -> IgStreamClient ->
 * CHART:<epic>:TICK) and reports a secret-free verdict:
 *
 *   gateway: api.ig.com
 *   authentication: PASS
 *   lightstreamer: CONNECTED
 *   subscription: CHART:IX.D.DAX.IGM.IP:TICK
 *   ticks received: 15
 *   latest price: 26325.8
 *   status: STREAMING
 *
 * Never prints IG credentials / CST / X-SECURITY-TOKEN / Lightstreamer session.
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { IgClient } from "../ig/client.js";
import { IgStreamClient } from "../streaming/igStream.js";
import type { IngTick, StreamState } from "../streaming/types.js";

const WAIT_MS = Number(process.env.IG_STREAM_CHECK_WAIT_MS || 20_000);
const EXIT_ON_TICKS = Number(process.env.IG_STREAM_CHECK_TICKS || 20);

function verdict(ok: boolean, exitCode = 1): never {
  console.log(`RESULT  : ${ok ? "SUCCESS" : "FAIL"}`);
  process.exit(ok ? 0 : exitCode);
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`gateway : ${new URL(config.ig.baseUrl).host}`);

  if (!config.ig.apiKey || !config.ig.username || !config.ig.password) {
    console.log("authentication: FAIL — set IG_API_KEY / IG_USERNAME / IG_PASSWORD in backend/.env");
    return verdict(false);
  }
  if (!config.ig.defaultEpic) {
    console.log("subscription: FAIL — set IG_DAX_EPIC in backend/.env");
    return verdict(false);
  }

  // 1) Authenticate (same REST login the server uses). Never logged.
  const ig = new IgClient({ ...config.ig });
  console.log("authentication: CONNECTING");
  let session;
  try {
    session = await ig.getStreamSession();
    console.log("authentication: PASS");
  } catch (err) {
    console.log(`authentication: FAIL — ${err instanceof Error ? err.message : "unknown error"}`);
    return verdict(false);
  }

  if (!session.endpoint) {
    console.log("lightstreamer: FAIL — /session did not return a lightstreamer endpoint");
    return verdict(false);
  }

  // 2) Connect to Lightstreamer + subscribe to CHART:<epic>:TICK.
  console.log("lightstreamer: CONNECTING");
  // Object holders avoid TS flow-narrowing pitfalls for closure-assigned vars.
  const acc = { ticks: 0, latest: null as IngTick | null   };
  const st = { value: "CONNECTING" as StreamState };

  const stream = new IgStreamClient(session, config.ig.defaultEpic, {
    onTick: (tick) => {
      acc.ticks += 1;
      acc.latest = tick;
    },
    onState: (state) => {
      st.value = state;
      console.log(`[STREAM] status: ${state}${acc.ticks ? ` (${acc.ticks} ticks so far)` : ""}`);
    },
  });

  try {
    stream.connect();
  } catch (err) {
    console.log(`lightstreamer: FAIL — ${err instanceof Error ? err.message : "could not connect"}`);
    return verdict(false);
  }

  // 3) Wait for enough ticks or a hard timeout, then report + exit.
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + WAIT_MS;
    const poll = setInterval(() => {
      if (acc.ticks >= EXIT_ON_TICKS || Date.now() >= deadline || st.value === "DISCONNECTED") {
        clearInterval(poll);
        resolve();
      }
    }, 500);
  });

  console.log(`subscription: CHART:${config.ig.defaultEpic}:TICK`);
  console.log(`ticks received: ${acc.ticks}`);
  if (acc.latest) {
    console.log(`latest price: ${acc.latest.price.toFixed(2)}`);
  } else {
    console.log("latest price: <none>");
  }

  const ok = acc.ticks > 0 && st.value === "LIVE";
  console.log(`status: ${ok ? "STREAMING" : st.value}`);

  stream.disconnect();
  if (ok) {
    console.log("[IG] Lightstreamer connected");
    console.log("[IG] DAX subscription active");
    console.log("[STREAM] tick received");
    return verdict(true);
  }
  console.log("[IG] No live ticks received — check epic/streaming permissions for this account.");
  return verdict(false);
}

void main();