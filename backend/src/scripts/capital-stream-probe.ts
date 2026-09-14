/**
 * `npx tsx backend/src/scripts/capital-stream-probe.ts --seconds 60`
 *
 * TEMPORARY DIAGNOSTIC (not long-term). Measures, concurrently:
 *
 *   (A) CAPITAL RAW STREAM
 *     Opens a real Capital.com streaming session (fresh login — its own
 *     session, independent of the production stream) + a raw `wss` socket,
 *     subscribes to OHLC M1 for GOLD exactly like the production client, then
 *     classifies EVERY frame for `--seconds` (default 60) with ZERO assumptions.
 *     Reports destination census, payload-key census, ohlc.event bid/ask
 *     pairing, bid/ask-bearing frame rate, distinct mids, distinct mid changes,
 *     and inter-arrival gap statistics.
 *
 *   (B) PRODUCTION RELAY (backend -> frontend seat)
 *     Simultaneously opens `ws://127.0.0.1:8787/ws`?res=MINUTE_1&epic=GOLD and
 *     counts candle + status frames with the same gap stats — the rate the chart
 *     layer actually observes.
 *
 * READ-ONLY / NON-INVASIVE: only subscribes + counts. Does NOT forward to the
 * aggregator, does NOT write to the DB, and the relay client is a passive
 * browser stand-in. The only side effect is one extra session login; the
 * production stream self-heals via its verified 30s heartbeat + reconnect
 * (commit f9f0459). NO credentials/tokens printed — only frame SHAPES (keys)
 * and market-data PRICES (public, non-secret).
 */
import "dotenv/config";
import { WebSocket } from "ws";

import { loadConfig, isCapitalConfigured } from "../config.js";
import { CapitalClient } from "../capital/client.js";
import { CAPITAL_STREAMING_DEFAULT_URL } from "../capital/capitalStream.js";

interface Args {
  seconds: number;
  relayUrl: string;
  symbol: string;
  timeframe: string;
  /** Which subscription(s) to send: ohlc | quote | both (default ohlc). */
  dest: "ohlc" | "quote" | "both";
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    seconds: 60,
    relayUrl: process.env.AURA_PROBE_RELAY_URL || "ws://127.0.0.1:8787/ws",
    symbol: "GOLD",
    timeframe: "MINUTE_1",
    dest: "ohlc",
  };
  // Supports both `--seconds=65` and `--seconds 65`.
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    let val: string;
    if (key.startsWith("--")) {
      const eq = key.indexOf("=");
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(2, eq);
      } else {
        key = key.slice(2);
        val = argv[i + 1] ?? "";
        if (!argv[i + 1]?.startsWith("--") && i + 1 < argv.length) i++;
      }
      if (key === "seconds") a.seconds = Number(val) || 60;
      else if (key === "relay") a.relayUrl = val;
      else if (key === "symbol") a.symbol = val;
      else if (key === "timeframe") a.timeframe = val;
      else if (key === "dest" && ["ohlc", "quote", "both"].includes(val)) {
        a.dest = val as Args["dest"];
      }
    }
  }
  return a;
}

/** Strip any token-like keys before dumping frame shapes/samples. */
function redactedShape(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return String(obj);
  const o = obj as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    if (/cst|security\s*token|password|apikey|identifier/i.test(k)) {
      clean[k] = "<REDACTED>";
    } else if (typeof o[k] === "object" && o[k] !== null) {
      clean[k] = redactedShape(o[k]);
    } else {
      clean[k] = o[k];
    }
  }
  return JSON.stringify(clean);
}

interface GapStats {
  count: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
}

function summaryStats(deltasMs: number[]): GapStats {
  if (deltasMs.length === 0) return { count: 0, min: 0, p50: 0, p90: 0, max: 0 };
  const s = [...deltasMs].sort((x, y) => x - y);
  const at = (p: number): number => {
    const idx = Math.floor(p * (s.length - 1));
    return s[Math.min(s.length - 1, Math.max(0, idx))];
  };
  return { count: s.length, min: s[0], p50: at(0.5), p90: at(0.9), max: s[s.length - 1] };
}

/** Numeric helper tolerating Capital's string-or-number encoding. */
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function findNum(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const n = num(obj[k]);
    if (n !== undefined) return n;
  }
  return undefined;
}

interface RelayResult {
  candle: number;
  status: number;
  other: number;
  distinctCloses: Set<number>;
  gaps: number[];
  lastCandleAt: number;
  sampleCandle: string | null;
}
// ── CAPITAL RAW STREAM PROBE ──────────────────────────────────────────────────

interface CapitalProbeResult {
  frames: number;
  pingText: number;
  byDestination: Record<string, number>;
  /** `destination|sorted,payload,keys` → count */
  payloadKeyCensus: Record<string, number>;
  ohlcSides: { bid: number; ask: number };
  /** distinct `t` values seen on ohlc.event frames */
  distinctTs: Set<number>;
  /** paired bursts (bid+ask for same t) — what production WOULD emit. */
  bursts: number;
  burstTicks: number;
  /** every frame carrying both bid & ask (price-bearing) */
  priceFrames: number;
  priceGaps: number[];
  lastPriceAt: number;
  distinctMids: Set<number>;
  distinctMidChanges: number;
  lastMid: number | null;
  /** frames whose payload carries an errorCode (subscribe rejections etc.) */
  errorFrames: number;
  errorCodes: Record<string, number>;
  samples: string[];
}

function newCapitalResult(): CapitalProbeResult {
  return {
    frames: 0,
    pingText: 0,
    byDestination: {},
    payloadKeyCensus: {},
    ohlcSides: { bid: 0, ask: 0 },
    distinctTs: new Set(),
    bursts: 0,
    burstTicks: 0,
    priceFrames: 0,
    priceGaps: [],
    lastPriceAt: 0,
    distinctMids: new Set(),
    distinctMidChanges: 0,
    lastMid: null,
    errorFrames: 0,
    errorCodes: {},
    samples: [],
  };
}

/** Pairing buffer mirroring production's handleOhlcSide cache (bounded). */
const BID_ASK_CACHE: Record<number, { bid?: number; ask?: number; bidT?: number; askT?: number }> = {};

function handleCapitalFrame(res: CapitalProbeResult, raw: string, now: number): void {
  res.frames += 1;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    if (trimmed === "#ping") res.pingText += 1;
    return;
  }
  let env: unknown;
  try {
    env = JSON.parse(trimmed);
  } catch {
    res.payloadKeyCensus["parse-error"] = (res.payloadKeyCensus["parse-error"] ?? 0) + 1;
    return;
  }
  if (!env || typeof env !== "object") return;
  const e = env as { destination?: unknown; payload?: unknown };
  const dest = typeof e.destination === "string" ? e.destination : "";
  const key = dest || "(no-destination)";
  res.byDestination[key] = (res.byDestination[key] ?? 0) + 1;

  const payload =
    e.payload && typeof e.payload === "object" ? (e.payload as Record<string, unknown>) : {};
  const censusKey = `${key}|${Object.keys(payload).sort().join(",") || "(empty)"}`;
  res.payloadKeyCensus[censusKey] = (res.payloadKeyCensus[censusKey] ?? 0) + 1;
  if (res.samples.length < 4) res.samples.push(`[${dest}] ${redactedShape(payload).slice(0, 220)}`);

  // Error frames (subscribe rejections, session errors) — count + log live.
  if (typeof payload.errorCode === "string") {
    res.errorFrames += 1;
    const code = payload.errorCode;
    res.errorCodes[code] = (res.errorCodes[code] ?? 0) + 1;
    console.log(`[probe] CAPITAL error frame #${res.errorFrames}: ${code}`);
  }

  // ohlc.event pairing (production semantics: bid+ask for same epoch-ms t -> 4 mid ticks)
  if (dest === "ohlc.event" || dest.toLowerCase().includes("ohlc.event")) {
    const side = typeof payload.priceType === "string" ? payload.priceType.toLowerCase() : "";
    if (side === "bid" || side === "ask") {
      res.ohlcSides[side] += 1;
      const t = num(payload.t);
      if (t !== undefined) res.distinctTs.add(t);
      if (t !== undefined) {
        const slot = (BID_ASK_CACHE[t] = BID_ASK_CACHE[t] ?? {});
        // reset a stale (>30s) half-pair so old side can't pair with new
        if (now - (slot.bidT ?? 0) > 30_000 && now - (slot.askT ?? 0) > 30_000) {
          delete BID_ASK_CACHE[t];
        }
        const slot2 = (BID_ASK_CACHE[t] = BID_ASK_CACHE[t] ?? {});
        if (side === "bid") {
          slot2.bid = num(payload.c);
          slot2.bidT = now;
        } else {
          slot2.ask = num(payload.c);
          slot2.askT = now;
        }
        if (
          slot2.bid !== undefined &&
          slot2.ask !== undefined &&
          Math.abs((slot2.bidT ?? 0) - (slot2.askT ?? 0)) < 5_000
        ) {
          res.bursts += 1;
          res.burstTicks += 4; // production emits 4 mid ticks per paired burst
          delete BID_ASK_CACHE[t];
        }
      }
    }
  }

  // price-bearing frames: any payload exposing both bid & ask.
  const bid = findNum(payload, ["bid"]);
  const ask = findNum(payload, ["ask", "offer"]);
  if (bid !== undefined && ask !== undefined) {
    res.priceFrames += 1;
    const mid = Math.round(((bid + ask) / 2) * 100) / 100;
    if (res.lastPriceAt > 0) res.priceGaps.push(now - res.lastPriceAt);
    res.lastPriceAt = now;
    res.distinctMids.add(mid);
    if (res.lastMid === null) {
      res.lastMid = mid;
        } else if (mid !== res.lastMid) {
      res.lastMid = mid;
      res.distinctMidChanges += 1;
    }
  }
}

function newRelayResult(): RelayResult {
  return { candle: 0, status: 0, other: 0, distinctCloses: new Set(), gaps: [], lastCandleAt: 0, sampleCandle: null };
}

// ── CAPITAL RAW STREAM PROBE (run) ────────────────────────────────────────────

async function probeCapital(args: Args): Promise<CapitalProbeResult> {
  const cfg = loadConfig();
  if (!isCapitalConfigured(cfg)) {
    throw new Error("[probe] Capital.com is not configured in backend/.env — cannot probe the live stream.");
  }
  const client = new CapitalClient(cfg.capital);
  const session = await client.getStreamSession();
  const headers = client.streamingHeaders(session);
  const url = cfg.capital.streamingUrl || CAPITAL_STREAMING_DEFAULT_URL;

  const res = newCapitalResult();
  const deadline = Date.now() + args.seconds * 1000;
  const startedAt = Date.now();

  await new Promise<void>((resolve) => {
    let settled = false;
    const ws = new WebSocket(url, { headers });
    // Live progress: rate + destination mix, so a long run is observable.
    let lastFrames = 0;
    let lastProgressAt = startedAt;
    const progress = setInterval(() => {
      const dS = Math.max(0.001, (Date.now() - lastProgressAt) / 1000);
      console.log(
        `[probe] t+${Math.round((Date.now() - startedAt) / 1000)}s frames=${res.frames} ` +
          `(+${Math.round((res.frames - lastFrames) / dS)}/s) ` +
          `dest=${Object.entries(res.byDestination)
            .map(([d, n]) => `${d || "(none)"}:${n}`)
            .join(" ")}` +
          (res.errorFrames ? ` ERRORS=${JSON.stringify(res.errorCodes)}` : ""),
      );
      lastFrames = res.frames;
      lastProgressAt = Date.now();
    }, 10_000);
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearInterval(progress);
      try {
        ws.close();
      } catch {}
      resolve();
    };
    const timer = setInterval(() => {
      if (Date.now() > deadline) settle();
    }, 500);

        ws.on("open", () => {
      // Subscriptions are staggered 1.5s apart so two frames never land in the
      // same instant (a possible cause of error.too-many.requests).
      const sendSub = (destination: string, payload: Record<string, unknown>): void => {
        ws.send(
          JSON.stringify({
            destination,
            correlationId: destination === "OHLCMarketData.subscribe" ? "1" : "2",
            cst: session.cst,
            securityToken: session.xSecurityToken,
            payload,
          }),
        );
      };
      if (args.dest === "ohlc" || args.dest === "both") {
        // MINUTE OHLC — identical to production (parity baseline).
        sendSub("OHLCMarketData.subscribe", {
          epics: [args.symbol],
          resolutions: ["MINUTE"],
          type: "classic",
        });
      }
      if (args.dest === "quote") {
        // Quote-only run: isolate the high-frequency bid/offer feed.
        sendSub("marketData.subscribe", { epics: [args.symbol] });
      } else if (args.dest === "both") {
        setTimeout(() => {
          try {
            sendSub("marketData.subscribe", { epics: [args.symbol] });
          } catch (e) {
            console.error(`[probe] quote subscribe send failed: ${String(e)}`);
          }
        }, 1500);
      }
    });
    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
      if (raw) handleCapitalFrame(res, raw, Date.now());
    });
    ws.on("error", (e) => console.error(`[probe] CAPITAL socket error: ${e.message || e}`));
    ws.on("close", () => settle());
  });
  return res;
}

async function probeRelay(args: Args): Promise<RelayResult> {
  const res = newRelayResult();
  const url = `${args.relayUrl}?res=${args.timeframe}&epic=${args.symbol}`;
  const deadline = Date.now() + args.seconds * 1000;

  await new Promise<void>((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setInterval(() => {
      if (Date.now() > deadline && !settled) {
        settled = true;
        clearInterval(timer);
        try {
          ws.close();
        } catch {}
        resolve();
      }
    }, 500);

    ws.on("open", () => {});
    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const m = msg as { type?: string };
      if (m.type === "candle") {
        res.candle += 1;
        const c = msg as { close?: number };
        if (typeof c.close === "number") res.distinctCloses.add(c.close);
        if (res.sampleCandle === null) res.sampleCandle = redactedShape(msg).slice(0, 220);
        const now = Date.now();
        if (res.lastCandleAt > 0) res.gaps.push(now - res.lastCandleAt);
        res.lastCandleAt = now;
      } else if (m.type === "status") {
        res.status += 1;
      } else {
        res.other += 1;
      }
    });
    ws.on("error", (e) => console.error(`[probe] RELAY socket error: ${e.message || e}`));
    ws.on("close", () => {
      if (!settled) {
        settled = true;
        clearInterval(timer);
        resolve();
      }
    });
  });
  return res;
}

function printGap(label: string, deltas: number[]): void {
  if (deltas.length < 1) {
    console.log(`  ${label}: (none)`);
    return;
  }
  const s = summaryStats(deltas);
  const spanMs = deltas.reduce((a, b) => a + b, 0);
  console.log(
    `  ${label}: n=${s.count} frames/s≈${(s.count / Math.max(1, spanMs / 1000)).toFixed(1)} ` +
      `gap min=${s.min}ms p50=${s.p50}ms p90=${s.p90}ms max=${s.max}ms`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const windowS = args.seconds;
  console.log(`[probe] window=${windowS}s symbol=${args.symbol} timeframe=${args.timeframe} relay=${args.relayUrl}`);

  const [cap, relay] = await Promise.all([probeCapital(args), probeRelay(args)]);

  console.log("\n=== CAPITAL RAW STREAM (server -> client) ===");
  console.log(
    `  subscription mode=${args.dest} | frames total=${cap.frames}  frames/s=${(cap.frames / windowS).toFixed(1)}  #ping text=${cap.pingText}` +
      ` | errorFrames=${cap.errorFrames} ${JSON.stringify(cap.errorCodes)}`,
  );
  console.log("  by destination:");
  for (const [dest, n] of Object.entries(cap.byDestination).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${dest}: ${n} (${(n / windowS).toFixed(1)}/s)`);
  }
  console.log("  payload key census (destination|keys -> count), top 12:");
  for (const [k, n] of Object.entries(cap.payloadKeyCensus).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${k} -> ${n}`);
  }
  console.log(`  ohlc.event: bid=${cap.ohlcSides.bid} ask=${cap.ohlcSides.ask} distinct_t=${cap.distinctTs.size}`);
  console.log(`  paired bursts (bid+ask) = ${cap.bursts} -> production-equivalent price ticks = ${cap.burstTicks}`);
  console.log(`  price-bearing frames (bid+ask payload): count=${cap.priceFrames} (${(cap.priceFrames / windowS).toFixed(1)}/s)`);
  printGap("price-frame inter-arrival", cap.priceGaps);
  console.log(`  distinct mids=${cap.distinctMids.size} distinct mid changes=${cap.distinctMidChanges} lastMid=${cap.lastMid}`);
  if (cap.samples.length) console.log(`  samples:\n    ${cap.samples.join("\n    ")}`);

  console.log("\n=== RELAY: production backend -> frontend seat ===");
  console.log(
    `  candle frames=${relay.candle} (${(relay.candle / windowS).toFixed(2)}/s, ${Math.round((relay.candle / windowS) * 60)}/min)` +
      ` | status frames=${relay.status} | other=${relay.other}`,
  );
  console.log(`  distinct close prices=${relay.distinctCloses.size}`);
  printGap("candle inter-arrival", relay.gaps);
  if (relay.sampleCandle) console.log(`  sample candle frame: ${relay.sampleCandle}`);

  console.log(
    "\n=== DIAGNOSIS ===" +
      `\nCapital: total frames/s=${(cap.frames / windowS).toFixed(1)}` +
      ` | price-bearing frames/s=${(cap.priceFrames / windowS).toFixed(1)}` +
      ` | ohlc.event bursts/min=${Math.round((cap.bursts / windowS) * 60)}` +
      `\nRelay: candle frames/min=${Math.round((relay.candle / windowS) * 60)}` +
      ` | candle frames/s=${(relay.candle / windowS).toFixed(2)}` +
      `\nDistinct mid price changes/min=${Math.round((cap.distinctMidChanges / windowS) * 60)}`,
  );
  process.exit(0);
}

void main();

