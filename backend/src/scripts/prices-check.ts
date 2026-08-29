/**
 * TEMPORARY diagnostic: `npx tsx src/scripts/prices-check.ts`
 *
 * Probes IG /prices/{epic} parameter behaviour (safe output — timestamps,
 * counts and prices only; never credentials):
 *   1. max=500 alone                      → how many prices come back?
 *   2. max=500 + pageSize=500             → does pageSize unlock more?
 *   3. pageSize=500 alone                 → ?
 *   4. from/to window pagination          → can we page backwards?
 *   5. snapshotTimeUTC semantics          → bar START vs END label?
 *      (compares last returned bars against `now` and the bucket grid)
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { IgClient } from "../ig/client.js";
import type { IgHistoricalPricesResponse } from "../ig/types.js";
import { parseIgTimestampAsUtc } from "../ig/time.js";

const EPIC_OVERRIDE = (process.env.PRICES_CHECK_EPIC || "").trim();
const RES = (process.env.PRICES_CHECK_RESOLUTION || "MINUTE").toUpperCase();
const BUCKET_SEC: Record<string, number> = {
  MINUTE: 60, MINUTE_3: 180,
};
const bucketSec = BUCKET_SEC[RES] ?? 60;

const iso = (ms: number): string => new Date(ms).toISOString();

async function probe(
  ig: IgClient,
  epic: string,
  label: string,
  params: Record<string, string>,
): Promise<{ count: number; firstIso: string; lastIso: string } | null> {
  const q = new URLSearchParams(params);
  try {
    const data = await ig.request<IgHistoricalPricesResponse>(`/prices/${epic}`, { query: q, version: "3" });
    const prices = data?.prices ?? [];
    const allow = data?.allowance;
    const firstRaw = prices[0]?.snapshotTimeUTC ?? prices[0]?.snapshotTime ?? "?";
    const lastRaw = prices[prices.length - 1]?.snapshotTimeUTC ?? prices[prices.length - 1]?.snapshotTime ?? "?";
    console.log(`\n[${label}] params=${q.toString()}`);
    console.log(`  received=${prices.length} first="${firstRaw}" last="${lastRaw}"`);
    if (allow) {
      console.log(`  allowance: remaining=${allow.remainingAllowance} total=${allow.totalAllowance} expiry=${allow.allowanceExpiry ?? "?"}`);
    }
    // Show the last three raw rows (timestamp + close only — safe).
    for (const p of prices.slice(-3)) {
      const raw = p.snapshotTimeUTC ?? p.snapshotTime ?? "?";
      const ms = p.snapshotTimeUTC ? parseIgTimestampAsUtc(p.snapshotTimeUTC) : NaN;
      const close = p.closePrice;
      const closeVal = close
        ? typeof close.midTraded === "number" ? close.midTraded : close.bid ?? close.ask
        : "?";
      console.log(`  row: t="${raw}" -> ${Number.isNaN(ms) ? "?" : iso(ms)} close=${closeVal}`);
    }
    return { count: prices.length, firstIso: String(firstRaw), lastIso: String(lastRaw) };
  } catch (err) {
    console.log(`\n[${label}] params=${q.toString()} FAILED: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const epic = EPIC_OVERRIDE || config.ig.defaultEpic;
  console.log(`gateway=${new URL(config.ig.baseUrl).host} epic=${epic} resolution=${RES} bucket=${bucketSec}s`);
  console.log(`now = ${Date.now()} -> ${iso(Date.now())}`);
  const nowBucket = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec;
  console.log(`current bucket start = ${nowBucket} -> ${iso(nowBucket * 1000)}`);

  const ig = new IgClient({ ...config.ig });

  await probe(ig, epic, "A max-only", { resolution: RES, max: "500" });
  await probe(ig, epic, "B max+pageSize", { resolution: RES, max: "500", pageSize: "500" });
  await probe(ig, epic, "C pageSize-only", { resolution: RES, pageSize: "500" });
  await probe(ig, epic, "D max20-baseline", { resolution: RES, max: "20" });
  await probe(ig, epic, "G pagenumber2", { resolution: RES, max: "500", pageSize: "500", pagenumber: "2" });

  // E) from/to window: try pulling the PREVIOUS page backwards in time.
  const b = await probe(ig, epic, "E from/to-page2-prep(max100)", { resolution: RES, max: "100", pageSize: "100" });
  if (b && b.count === 100) {
    // Re-fetch with max=100 to get its oldest timestamp for the from-window test.
    const data = await ig.request<IgHistoricalPricesResponse>(`/prices/${epic}`, {
      query: new URLSearchParams({ resolution: RES, max: "100", pageSize: "100" }),
      version: "3",
    });
    const prices = data?.prices ?? [];
    const oldestRaw = prices[0]?.snapshotTimeUTC;
    if (oldestRaw) {
      const oldestMs = parseIgTimestampAsUtc(oldestRaw);
      // Ask for points ending just before the oldest one we already have.
      const to = new Date(oldestMs - 1000).toISOString().replace(/\.\d{3}Z$/, "");
      await probe(ig, epic, "F from/to-backwards", { resolution: RES, max: "100", pageSize: "100", to });
    }
  }

  console.log("\nDONE");
}

void main();
