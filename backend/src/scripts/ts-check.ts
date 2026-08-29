/**
 * `npm run ig:ts-check` — backend timestamp-pipeline diagnostic.
 *
 * Traces SAFE diagnostic values through every stage of the timestamp pipeline
 * and compares the latest REST historical candle against the live tick stream:
 *
 *   1. IG REST snapshotTime / snapshotTimeUTC  (raw strings, as received)
 *   2. Normalized historical candle timestamp  (epoch ms -> s, UTC ISO)
 *   3. IG Lightstreamer UTM                    (raw value, as received)
 *   4. Parsed realtime tick timestamp          (epoch ms, UTC ISO)
 *   5. Realtime candle bucket                  (epoch s, UTC ISO)
 *   6. (frontend is a pure pass-through of 5 — see services/realtime.ts)
 *   7. CandleKit/LWC input                     (Bar.ts = same absolute instant)
 *
 * Prints ONLY timestamps, prices, and ISO strings — never credentials, CST,
 * X-SECURITY-TOKEN, API key, username, password, or session identifiers.
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { IgClient } from "../ig/client.js";
import { fetchHistoricalCandles } from "../ig/historical.js";
import { IgStreamClient } from "../streaming/igStream.js";
import type { IngTick, StreamState } from "../streaming/types.js";

const RESOLUTION = (process.env.TS_CHECK_RESOLUTION || "MINUTE").toUpperCase();
const BUCKET_SEC: Record<string, number> = {
  MINUTE: 60, MINUTE_3: 180,
};
const bucketSec = BUCKET_SEC[RESOLUTION] ?? 60;
const WAIT_MS = Number(process.env.TS_CHECK_WAIT_MS || 20_000);
const MAX_TICKS = Number(process.env.TS_CHECK_TICKS || 3);

const msIso = (ms: number): string => new Date(ms).toISOString();
const secIso = (s: number): string => new Date(s * 1000).toISOString();

/** The timezone-sensitive parse the historical pipeline used before the fix. */
const legacyParse = (s: string): number => Date.parse(s);

/**
 * Correct parse for IG timestamps that carry NO timezone designator
 * (documented as UTC): interpret the wall-clock components as UTC.
 * Strings WITH an explicit offset (Z / ±hh:mm) parse per ES spec.
 */
export function parseIgTimestampAsUtc(s: string): number {
  const m = s.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.:](\d{1,3}))?)?$/,
  );
  if (!m) return Date.parse(s); // explicit offset or unknown -> per spec
  const [, y, mo, d, h, mi, sec = "0", frac = "0"] = m;
  const ms = Number(frac.padEnd(3, "0"));
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), ms);
}

function verdict(ok: boolean): never {
  console.log(`RESULT  : ${ok ? "SUCCESS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

interface RawPrice {
  snapshotTime?: string | null;
  snapshotTimeUTC?: string | null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.ig.apiKey || !config.ig.username || !config.ig.password || !config.ig.defaultEpic) {
    console.log("ts-check: FAIL — set IG_API_KEY / IG_USERNAME / IG_PASSWORD / IG_DAX_EPIC in backend/.env");
    return verdict(false);
  }
  console.log(`gateway        : ${new URL(config.ig.baseUrl).host}`);
  console.log(`epic           : ${config.ig.defaultEpic}`);
  console.log(`resolution     : ${RESOLUTION} (bucket ${bucketSec}s)`);
  console.log(`now (machine)  : ${Date.now()} -> ${msIso(Date.now())}`);

  const ig = new IgClient({ ...config.ig });

  // ── 1) RAW IG historical payload ──────────────────────────────────────────
  let raw: { prices?: RawPrice[] };
  try {
    const q = new URLSearchParams({ resolution: RESOLUTION, max: "3" });
    raw = await ig.request<{ prices?: RawPrice[] }>(`/prices/${config.ig.defaultEpic}`, {
      query: q, version: "3",
    });
    console.log("authentication : PASS");
  } catch (err) {
    console.log(`authentication : FAIL — ${err instanceof Error ? err.message : "unknown"}`);
    return verdict(false);
  }

  const prices = raw.prices ?? [];
  console.log(`[REST] raw prices received: ${prices.length}`);
  for (const p of prices) {
    const sUtc = String(p.snapshotTimeUTC ?? "<absent>");
    const sLoc = String(p.snapshotTime ?? "<absent>");
    const legacyMs = legacyParse(sUtc);
    const fixedMs = parseIgTimestampAsUtc(sUtc);
    console.log(`[REST] snapshotTime    = "${sLoc}"  (exchange-local, IG-documented)`);
    console.log(`[REST] snapshotTimeUTC = "${sUtc}"  (as received — note: no tz designator)`);
    console.log(`[REST]   legacy Date.parse   -> ${legacyMs} -> ${Number.isNaN(legacyMs) ? "NaN" : msIso(legacyMs)}`);
    console.log(`[REST]   UTC-component parse -> ${fixedMs} -> ${msIso(fixedMs)}`);
  }

  // ── 2) Normalized candles through the REAL pipeline (historical.ts) ──────
  const candles = await fetchHistoricalCandles(ig, {
    epic: config.ig.defaultEpic, resolution: RESOLUTION, limit: 3,
  });
  const last = candles[candles.length - 1];
  if (!last) {
    console.log("[REST] normalization produced no candles");
    return verdict(false);
  }
  console.log(`[REST] normalized last candle ts = ${last.ts} ms = ${Math.floor(last.ts / 1000)} s -> ${msIso(last.ts)} (close ${last.close})`);

  // ── 3/4/5) Live stream: raw UTM -> parsed tick -> bucket ─────────────────
  const acc = { ticks: 0, first: null as IngTick | null, last: null as IngTick | null };
  const st = { value: "CONNECTING" as StreamState };
  let stream: IgStreamClient | null = null;
  try {
    const session = await ig.getStreamSession();
    stream = new IgStreamClient(session, config.ig.defaultEpic, {
      onTick: (t) => {
        acc.ticks += 1;
        if (!acc.first) acc.first = t;
        acc.last = t;
      },
      onState: (s) => { st.value = s; },
    });
    stream.connect();
  } catch (err) {
    console.log(`[STREAM] FAIL — ${err instanceof Error ? err.message : "could not connect"}`);
    return verdict(false);
  }

  await new Promise<void>((resolve) => {
    const deadline = Date.now() + WAIT_MS;
    const poll = setInterval(() => {
      if (acc.ticks >= MAX_TICKS || Date.now() >= deadline || st.value === "DISCONNECTED") {
        clearInterval(poll);
        resolve();
      }
    }, 250);
  });

  if (!acc.last || !acc.first) {
    console.log(`[STREAM] no ticks received (status=${st.value}) — cannot compare`);
    stream?.disconnect();
    return verdict(false);
  }

  const tick = acc.last;
  console.log(`[STREAM] status=${st.value} ticks=${acc.ticks}`);
  console.log(`[STREAM] first tick -> tsMs ${acc.first.tsMs} -> ${msIso(acc.first.tsMs)} (price ${acc.first.price})`);
  console.log(`[STREAM] last  tick -> tsMs ${tick.tsMs} -> ${msIso(tick.tsMs)} (price ${tick.price})`);

  const tickBucketSec = Math.floor(tick.tsMs / 1000 / bucketSec) * bucketSec;
  console.log(`[STREAM] bucket(${bucketSec}s) = ${tickBucketSec} s -> ${secIso(tickBucketSec)}`);

  // ── 6/7) Verdict: normalized history vs live bucket ──────────────────────
  const restSec = Math.floor(last.ts / 1000);
  const deltaSec = Math.abs(tickBucketSec - restSec);
  console.log(`[COMPARE] REST last   = ${restSec} s -> ${secIso(restSec)}`);
  console.log(`[COMPARE] tick bucket = ${tickBucketSec} s -> ${secIso(tickBucketSec)}`);
  console.log(`[COMPARE] delta = ${deltaSec} s (${(deltaSec / bucketSec).toFixed(1)} buckets of ${bucketSec}s)`);

  stream?.disconnect();

  // Adjacent is fine: last closed bar and the forming bar are ≤ 2 buckets apart.
  // Anything ≥ 3 buckets (e.g. exactly 28800 s = 8 h) means a normalization bug.
  const ok = deltaSec <= bucketSec * 2;
  console.log(ok
    ? "[COMPARE] PASS — historical and realtime share the same UTC time base"
    : `[COMPARE] FAIL — timestamps are ${(deltaSec / 3600).toFixed(2)} h apart; normalization is broken`);
  return verdict(ok);
}

void main();

