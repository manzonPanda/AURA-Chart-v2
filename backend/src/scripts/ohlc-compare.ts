/**
 * `npm run ig:ohlc-compare`
 *
 * TEMPORARY diagnostic — WHY do our 3-minute MID OHLC numbers differ from the
 * IG website's candles for the same DAX 3-minute bucket?
 *
 * IG's /prices endpoint returns one candle per level (`bid`, `ask`,
 * `midTraded`). This script re-aggregates the SAME 1-minute server candles into
 * 3-minute buckets FOUR ways:
 *
 *   quoteMid  — (bid+ask)/2             ← what the live stream uses (rounded 1dp)
 *   midTraded — IG's traded mid         ← what historical.ts PREFERS for chart history
 *   bid       — bid only
 *   ask       — ask only
 *
 * Place the output next to the backend's `[IG TICK]` / `[3M CANDLE CLOSED]`
 * logs for the same wall-clock bucket and you can see at a glance which price
 * basis + open definition IG's website chart actually matches.
 *
 * Uses only the newest accessible window (≤500 one-minute rows) — one request,
 * no paging, no allowance burn.
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { IgClient } from "../ig/client.js";
import { fetchRawPrices } from "../ig/historical.js";
import { parseIgTimestampAsUtc } from "../ig/time.js";
import type { IgPrice, IgPriceLevel } from "../ig/types.js";

const BUCKET_MS = 3 * 60 * 1000;

/** "HH:MM:SS" (UTC) of bucket start. */
function hhmmss(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}
const fmt = (v: number | null | undefined): string =>
  typeof v === "number" ? String(Math.round(v * 10) / 10) : "-";

interface Ohlc {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}
const empty = (): Ohlc => ({ open: null, high: null, low: null, close: null });

function useFirst(...vs: (number | null | undefined)[]): number | null {
  for (const v of vs) if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
/** (bid+ask)/2 when both present, else bid → ask → midTraded (LTP-like). */
function quoteMid(level: IgPriceLevel | null | undefined): number | null {
  if (!level) return null;
  if (typeof level.bid === "number" && typeof level.ask === "number") return (level.bid + level.ask) / 2;
  return useFirst(level.bid, level.ask, level.midTraded);
}
/** Which price basis a level produces (fallback chain per basis). */
function pick(level: IgPriceLevel | null | undefined, basis: Basis): number | null {
  if (!level) return null;
  if (basis === "bid") return useFirst(level.bid);
  if (basis === "ask") return useFirst(level.ask);
  if (basis === "midTraded") return useFirst(level.midTraded) ?? quoteMid(level);
  return quoteMid(level);
}

const BASES = ["quoteMid", "midTraded", "bid", "ask"] as const;
type Basis = (typeof BASES)[number];

interface Bucket {
  ts: number;
  bars: number;
  ohlc: Record<Basis, Ohlc>;
  /** Snapshot labels (UTC) of the underlying 1m bars in this bucket. */
  labels: string[];
}

function pushLevel(
  b: Bucket,
  basis: Basis,
  field: "open" | "high" | "low" | "close",
  v: number | null,
): void {
  if (v === null) return;
  const o = b.ohlc[basis];
  if (field === "open" && o.open === null) o.open = v;
  if (field === "high" && (o.high === null || v > o.high)) o.high = v;
  if (field === "low" && (o.low === null || v < o.low)) o.low = v;
  if (field === "close") o.close = v;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const epic = config.ig.defaultEpic;
  if (!epic) {
    console.error("Set IG_DAX_EPIC in backend/.env first.");
    process.exit(1);
  }

  const ig = new IgClient({ ...config.ig });
  console.log(`epic=${epic} gateway=${new URL(config.ig.baseUrl).host}`);
  const prices = await fetchRawPrices(ig, epic, 500);
  console.log(`1m rows fetched: ${prices.length}`);
  if (prices.length === 0) {
    console.error("No 1-minute rows returned (allowance exhausted or market closed?).");
    process.exit(1);
  }

  // Show the newest 1m rows raw (levels intact) so they can be audited.
  console.log(`\n[IG SERVER 1M — newest ${Math.min(8, prices.length)} rows]`);
  for (const p of prices.slice(-8)) {
    const ts = parseIgTimestampAsUtc(p.snapshotTimeUTC ?? p.snapshotTime ?? "");
    const l = (v: IgPriceLevel | null | undefined) =>
      `${fmt(v?.bid)}/${fmt(v?.ask)}/${fmt(v?.midTraded)}`.padEnd(24);
    console.log(
      `time=${hhmmss(Number.isNaN(ts) ? 0 : ts)}  ` +
        `open[bid/ask/midT]=${l(p.openPrice)} high${l(p.highPrice)} ` +
        `low${l(p.lowPrice)} close${l(p.closePrice)}`,
    );
  }

  // Aggregate 1m rows into 3-minute buckets by the SAME epoch floor the chart
  // uses (floor(ts/180000)*180000), one OHLC set per price basis.
  const buckets = new Map<number, Bucket>();
  for (const p of prices) {
    const ts = parseIgTimestampAsUtc(p.snapshotTimeUTC ?? p.snapshotTime ?? "");
    if (Number.isNaN(ts)) continue;
    const bucketTs = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    let b = buckets.get(bucketTs);
    if (!b) {
      b = {
        ts: bucketTs,
        bars: 0,
        ohlc: { quoteMid: empty(), midTraded: empty(), bid: empty(), ask: empty() },
        labels: [],
      };
      buckets.set(bucketTs, b);
    }
    b.bars += 1;
    const label = hhmmss(ts);
    if (!b.labels.includes(label)) b.labels.push(label);
    for (const basis of BASES) {
      pushLevel(b, basis, "open", pick(p.openPrice, basis));
      pushLevel(b, basis, "high", pick(p.highPrice, basis));
      pushLevel(b, basis, "low", pick(p.lowPrice, basis));
      pushLevel(b, basis, "close", pick(p.closePrice, basis));
    }
  }

  const sorted = [...buckets.values()].sort((a, b) => a.ts - b.ts).slice(-6);
  console.log(`\n[IG SERVER 3M — newest ${sorted.length} buckets, floor(ts/180)*180 same as live]`);
  for (const b of sorted) {
    console.log(`\n[IG SERVER 3M] bucket=${hhmmss(b.ts)} 1mBars=${b.bars} labels=${b.labels.join(",")}`);
    for (const basis of BASES) {
      const o = b.ohlc[basis];
      console.log(
        `  ${basis.padEnd(9)} O=${fmt(o.open)} H=${fmt(o.high)} L=${fmt(o.low)} C=${fmt(o.close)}`,
      );
    }
  }
  const lastBucket = hhmmss(sorted[sorted.length - 1]?.ts ?? 0);
  console.log(
    `\nCompare the quoteMid row against the backend's [3M CANDLE CLOSED] for bucket ${lastBucket}.`,
  );
}

void main().catch((err) => {
  console.error("ohlc-compare failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});