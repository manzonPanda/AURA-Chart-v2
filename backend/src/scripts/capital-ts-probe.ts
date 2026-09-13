/**
 * `npm run capital:ts-probe` — READ-ONLY verification of Capital.com historical
 * bar-timestamp semantics (never a database touch, never a backend restart).
 *
 * WHY: the historical import must store each candle at its BUCKET START so the
 * historical rows join the live stream timestamp-equal (live rows are bucket
 * starts on the 60 s epoch grid, empirically verified by the realtime
 * partial/completed classification: first ticks land ~300–400 ms AFTER the
 * bucket boundary — impossible under close-stamped frames). Capital documents
 * `from`/`to` filtration "based on snapshotTimeUTC" but never states whether a
 * MINUTE bar's snapshotTimeUTC is its OPEN or CLOSE instant.
 *
 * The probe settles it empirically with two read-only /prices fetches:
 *   fetch 1 at minute M (a few seconds in): bar stamped M is FORMING under
 *     OPEN stamping (partial coverage [M, now)) and COMPLETE under CLOSE
 *     stamping (coverage [M−60s, M)).
 *   fetch 2 ~130 s later: bar stamped M is final under BOTH conventions.
 *     OHLC CHANGED between fetches → OPEN-stamped (bucket start = stamp —
 *     the downloader's assumed convention). IDENTICAL → CLOSE-stamped
 *     (bucket start = stamp − 60 s — the downloader must shift by one minute).
 *
 * Output: a per-bar table (stamp, OHLC@1, OHLC@2, changed?) + the conclusion
 * + the resulting bucket rule. NO credentials, tokens, or headers are printed.
 */
import "dotenv/config";

import { CapitalClient } from "../capital/client.js";
import { isCapitalConfigured, loadConfig } from "../config.js";
import { parseCapitalPrice, type CapitalPricesFetcher } from "../capital/historical.js";
import { capitalRowTimestamp } from "../capital/time.js";
import { CAPITAL_PAGE_SIZE, type CapitalHistoricalPricesResponse, type CapitalPrice } from "../capital/types.js";
import { MINUTE_MS } from "../backfill/capitalDownloader.js";

function die(msg: string): never {
  console.error(`capital:ts-probe: ${msg}`);
  process.exit(1);
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
const stampIso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

interface Ohlc { open: number; high: number; low: number; close: number; }
const sameOhlc = (a: Ohlc | null, b: Ohlc | null): boolean =>
  a !== null && b !== null && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

/** Extract the OHLC of the bar stamped exactly `stampMs` (null when absent). */
function ohlcAt(body: CapitalHistoricalPricesResponse, decimals: number, stampMs: number): Ohlc | null {
  const rows = (Array.isArray(body.prices) ? body.prices : []) as CapitalPrice[];
  for (const row of rows) {
    if (capitalRowTimestamp(row) === stampMs) {
      const c = parseCapitalPrice(row, decimals);
      return c ? { open: c.open, high: c.high, low: c.low, close: c.close } : null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  let waitMs = 130_000;
  let lookbackMinutes = 5;
  let symbol = "GOLD";
  for (const rawArg of process.argv.slice(2)) {
    const [key, ...rest] = rawArg.replace(/^--/, "").split("=");
    const val = rest.join("=");
    if (key === "wait-ms") waitMs = Number(val);
    else if (key === "lookback-minutes") lookbackMinutes = Number(val);
    else if (key === "symbol") symbol = val;
    else die(`unknown argument "--${key}"`);
  }

  const cfg = loadConfig();
  if (!isCapitalConfigured(cfg)) die("Capital.com is not configured (CAPITAL_* env) — nothing to probe.");
  const client = new CapitalClient(cfg.capital);
  const fetcher: CapitalPricesFetcher = client;

  const now1 = Date.now();
  const m = Math.floor(now1 / MINUTE_MS) * MINUTE_MS; // minute containing now1
  const from = m - lookbackMinutes * MINUTE_MS;
  // `to` is INCLUSIVE (verified live 2026-09-13: [20:40,20:46] → 7 stamps) and
  // must NEVER be in the future — Capital rejects a future `to` with
  // 400 {"errorCode":"error.invalid.daterange"} (the original probe failure).
  // The forming bucket START is the latest valid non-future boundary and, being
  // inclusive, still catches bar M under BOTH stamping conventions.
  const to = m;

  console.log(`[capital:ts-probe] symbol=${symbol} fetch1 at ${iso(now1)} window=${iso(from)}…${iso(to)} (read-only)`);
  const body1 = await fetcher.getPrices(symbol, from, to, CAPITAL_PAGE_SIZE);
  const rows1 = Array.isArray(body1.prices) ? body1.prices : [];
  const stamps1 = rows1.map((r) => capitalRowTimestamp(r)).filter(Number.isFinite);
  const first = stamps1.length ? Math.min(...stamps1) : NaN;
  const last = stamps1.length ? Math.max(...stamps1) : NaN;
  const ohlc1 = ohlcAt(body1, 2, m);
  console.log(
    `[capital:ts-probe] fetch1: bars=${rows1.length} stampRange=${Number.isFinite(first) ? iso(first) : "—"}…${Number.isFinite(last) ? iso(last) : "—"} ` +
      `bar@${stampIso(m)}=${ohlc1 ? `O${ohlc1.open}/H${ohlc1.high}/L${ohlc1.low}/C${ohlc1.close}` : "ABSENT"}`,
  );
  if (!ohlc1) {
    // Bar M absent at fetch 1: under CLOSE stamping it would be complete and
    // present. Absence → OPEN stamping (forming bar not yet exposed).
    console.log(
      `[capital:ts-probe] fetch2 in ${waitMs}ms… (read-only; bar@${stampIso(m)} absent at fetch1 — ` +
        `a complete bar would be impossible under CLOSE stamping)`,
    );
  } else {
    console.log(`[capital:ts-probe] fetch2 in ${waitMs}ms… (read-only; comparing bar@${stampIso(m)} OHLC stability)`);
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(2_000, waitMs)));

  const now2 = Date.now();
  const body2 = await fetcher.getPrices(symbol, from, to, CAPITAL_PAGE_SIZE);
  const rows2 = Array.isArray(body2.prices) ? body2.prices : [];
  const ohlc2 = ohlcAt(body2, 2, m);
  console.log(
    `[capital:ts-probe] fetch2 at ${iso(now2)}: bars=${rows2.length} ` +
      `bar@${stampIso(m)}=${ohlc2 ? `O${ohlc2.open}/H${ohlc2.high}/L${ohlc2.low}/C${ohlc2.close}` : "ABSENT"}`,
  );

  console.log(`[capital:ts-probe] per-bar comparison (stamp → OHLC@fetch1 vs OHLC@fetch2):`);
  for (const row of rows2.slice(0, 16)) {
    const s = capitalRowTimestamp(row);
    if (!Number.isFinite(s)) continue;
    const a = ohlcAt(body1, 2, s);
    const b = ohlcAt(body2, 2, s);
    const changed = sameOhlc(a, b) ? "final   " : "CHANGED ";
    const fmt = (o: Ohlc | null): string => (o ? `O${o.open}/H${o.high}/L${o.low}/C${o.close}` : "(absent@1)");
    console.log(`  ${stampIso(s)}Z  ${changed} ${fmt(a)}  vs  ${fmt(b)}`);
  }

  if (!ohlc1 && ohlc2) {
    console.log(
      `[capital:ts-probe] CONCLUSION: OPEN-stamped (bar M absent while forming, present when complete)\n` +
        `[capital:ts-probe] bucket rule: bucketStart = snapshotTimeUTC — the downloader's assumed convention holds.`,
    );
  } else if (ohlc1 && !sameOhlc(ohlc1, ohlc2)) {
    console.log(
      `[capital:ts-probe] CONCLUSION: OPEN-stamped (bar M was FORMING at fetch1 — its OHLC changed by fetch2)\n` +
        `[capital:ts-probe] bucket rule: bucketStart = snapshotTimeUTC — the downloader's assumed convention holds.`,
    );
  } else if (ohlc1 && sameOhlc(ohlc1, ohlc2)) {
    console.log(
      `[capital:ts-probe] CONCLUSION: CLOSE-stamped (bar M was COMPLETE at fetch1 — OHLC unchanged; its coverage is [stamp−60s, stamp))\n` +
        `[capital:ts-probe] bucket rule: bucketStart = snapshotTimeUTC − 60s — historicalWindowEndMs MUST move one minute; the downloader must be adjusted before importing.`,
    );
    process.exit(2);
  } else {
    die(`unexpected probe result — bar@${stampIso(m)} absent at BOTH fetches (bad symbol or empty market?).`);
  }
}

void main();
