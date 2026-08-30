/**
 * Stage 3 — MANUAL IG historical backfill (never automatic: not on startup,
 * not on reconnect, not scheduled, not from the frontend).
 *
 *   npm run backfill -- --from="2026-08-28T12:00:00Z" --to="2026-08-28T15:00:00Z" [--dry-run] [--force] [--epic=EPIC] [--minutes=1|3|k]
 *   (--hours=N is a shorthand for --from = to − N hours; default window = 6h)
 *
 * `--minutes` selects the target candle width (default 3 for the legacy
 * MINUTE_3 view; pass 1 to backfill the canonical MINUTE_1 frames — the grid
 * the new 1m-only architecture persists).
 *
 * Policy — enforced at plan time AND re-enforced atomically per write:
 *   missing     → INSERT   (status=backfilled, source=ig_historical)
 *   partial     → full repair from the IG-derived 3m candle (status=backfilled)
 *   completed   → PROTECTED — never overwritten
 *   backfilled  → PROTECTED unless --force
 *   uncovered   → IG returned insufficient data — bucket left EXACTLY as is
 *   forming/live bucket → always excluded
 * --dry-run performs scan + IG fetch + planning + full report but writes NOTHING.
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { createSupabaseAdmin } from "../db/supabaseClient.js";
import { CandleStore } from "../db/candleStore.js";
import { IgClient } from "../ig/client.js";
import { fetchOneMinuteRange } from "../ig/historical.js";
import { IgApiError } from "../ig/errors.js";
import { planBackfill, type BackfillPlan } from "../backfill/planner.js";
import { IG_GERMANY_40 } from "../market/calendar.js";
import { detectGaps } from "../market/gapDetector.js";
import { timeframeForMinutes } from "../streaming/timeframes.js";

function die(msg: string): never {
  console.error(`backfill: ${msg}`);
  process.exit(1);
}

const fmtBucket = (sec: number): string => new Date(sec * 1000).toISOString().slice(11, 16);
const fmtDayBucket = (sec: number): string =>
  `${new Date(sec * 1000).toISOString().slice(0, 10)} ${fmtBucket(sec)}`;
const fmtOhlc = (c: { open: number; high: number; low: number; close: number }): string =>
  `O=${c.open} H=${c.high} L=${c.low} C=${c.close}`;

/** Any IG failure aborts with a clean message and ZERO database changes. */
function abortOnIgFailure(err: unknown): never {
  if (err instanceof IgApiError) {
    console.error(
      `[BACKFILL ABORTED] IG historical REST failed (kind=${err.kind}) — NO database changes were made.` +
        (err.kind === "rate_limit"
          ? "\nThe historical-data allowance is exhausted/rate-limited; retry when it resets."
          : "") +
        `\ndetail: ${err.message}`,
    );
  } else {
    console.error("[BACKFILL ABORTED] unexpected failure — NO database changes were made.\n", err);
  }
  process.exit(1);
}

interface Args {
  fromMs: number;
  toMs: number;
  dryRun: boolean;
  force: boolean;
  epic?: string;
  /** Target candle width in whole minutes (1 = canonical MINUTE_1, 3 = legacy MINUTE_3). */
  minutes: number;
}

function parseArgs(): Args {
  let fromMs: number | undefined;
  let toMs: number | undefined;
  let hours = 6;
  let dryRun = false;
  let force = false;
  let epic: string | undefined;
  let minutes = 3;
  for (const raw of process.argv.slice(2)) {
    const [key, ...rest] = raw.replace(/^--/, "").split("=");
    const val = rest.join("=");
    if (key === "dry-run") dryRun = true;
    else if (key === "force") force = true;
    else if (key === "hours") hours = Number(val);
    else if (key === "minutes") minutes = Number(val);
    else if (key === "epic") epic = val.trim();
    else if (key === "from") {
      const t = Date.parse(val);
      if (Number.isNaN(t)) die(`invalid --from "${val}"`);
      fromMs = t;
    } else if (key === "to") {
      const t = Date.parse(val);
      if (Number.isNaN(t)) die(`invalid --to "${val}"`);
      toMs = t;
    } else die(`unknown argument --${key}`);
  }
  if (toMs === undefined) toMs = Date.now();
  if (fromMs === undefined) fromMs = toMs - hours * 3_600_000;
  if (fromMs > toMs) [fromMs, toMs] = [toMs, fromMs];
  if (!Number.isInteger(minutes) || minutes < 1) die(`invalid --minutes=${minutes} (must be a positive whole number of minutes)`);
  return { fromMs, toMs, dryRun, force, epic, minutes };
}

async function main(): Promise<void> {
  const args = parseArgs();
  // Target candle width drives the timeframe key + bucket grid (1 → canonical
  // MINUTE_1, 3 → legacy MINUTE_3, k → generic whole-minute frame).
  const minutes = args.minutes;
  const TF = timeframeForMinutes(minutes);
  const BUCKET_SEC = minutes * 60;
  const config = loadConfig();
  const admin = createSupabaseAdmin(config.supabase);
  if (!admin) die("Supabase is not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in backend/.env");
  const store = new CandleStore(admin, config.supabase.table);
  const epic = (args.epic ?? config.ig.defaultEpic).trim();
  if (!epic) die("No instrument EPIC — set IG_DAX_EPIC or pass --epic=EPIC");

  // epoch-ms → grid-aligned epoch-seconds (ms/1000, then floor to the 180 s grid).
  const fromSec = Math.floor(args.fromMs / 1000 / BUCKET_SEC) * BUCKET_SEC;
  const toSec = Math.floor(args.toMs / 1000 / BUCKET_SEC) * BUCKET_SEC;
  // The currently forming bucket is sacred — never scanned, never written.
  const formingBucketSec = Math.floor(Date.now() / 1000 / BUCKET_SEC) * BUCKET_SEC;

  console.log(
    `BACKFILL ${args.dryRun ? "DRY RUN" : "REAL RUN"}\n` +
      `instrument=${epic} timeframe=${TF}\n` +
      `range=${new Date(fromSec * 1000).toISOString()} .. ${new Date(toSec * 1000).toISOString()}\n` +
      `forming bucket (excluded)=${fmtDayBucket(formingBucketSec)}Z`,
  );

  // 1. Scan persisted rows for the range (DB failure → abort before any IG call).
  let rows;
  try {
    rows = await store.loadCandlesRange(epic, TF, fromSec, toSec);
  } catch (err) {
    die(`DB scan failed: ${err instanceof Error ? err.message : err}`);
  }

  // 2. Gap report (pure — DB rows + market calendar, NO IG call yet).
  //    Printed BEFORE the IG fetch so an allowance outage can never hide the
  //    gap scan, and a no-gap run never burns allowance at all.
  const gaps = detectGaps(rows, {
    fromSec,
    toSec: Math.min(toSec, formingBucketSec), // exclusive bound — forming bucket never scanned
    calendar: IG_GERMANY_40,
    bucketSec: BUCKET_SEC,
  });
  const list = (arr: number[]): string =>
    arr.length ? arr.map((b) => `  ${fmtDayBucket(b)}Z`).join("\n") : "  (none)";
  console.log(
    `\nMissing (${gaps.missing.length}):\n${list(gaps.missing)}` +
      `\n\nPartial (${gaps.partial.length}):\n${list(gaps.partial)}` +
      `\n\nCompleted+backfilled (protected): ${gaps.completed.length + gaps.backfilled.length}` +
      ` of ${gaps.expectedBuckets} expected market buckets`,
  );
  if (gaps.unexpected.length)
    console.log(`\nUnexpected rows (outside market sessions — informational):\n${list(gaps.unexpected)}`);
  if (gaps.missing.length === 0 && gaps.partial.length === 0) {
    console.log("\nNothing to backfill — IG historical REST was NOT contacted.");
    return;
  }

  // 3. IG historical 1-minute fetch — ANY failure aborts with ZERO DB changes.
  const ig = new IgClient({ ...config.ig });
  let oneMin;
  try {
    oneMin = await fetchOneMinuteRange(ig, epic, args.fromMs, args.toMs);
  } catch (err) {
    abortOnIgFailure(err);
  }

  // 4. Plan (pure) — market calendar applied; completed always protected.
  const plan = planBackfill({
    fromSec,
    toSec,
    formingBucketSec,
    oneMin,
    rows,
    minutes,
    allowBackfilledRepair: args.force,
    calendar: IG_GERMANY_40,
  });

  // 5. Full plan report.
  console.log(
    `\nMissing (${plan.inserts.length}):\n${list(plan.inserts.map((i) => i.bucketSec))}` +
      `\n\nPartial (${plan.repairs.filter((r) => r.previousStatus === "partial").length}):\n` +
      list(plan.repairs.filter((r) => r.previousStatus === "partial").map((r) => r.bucketSec)) +
      (args.force
        ? `\n\nBackfilled repairs (--force) (${plan.repairs.filter((r) => r.previousStatus === "backfilled").length}):\n` +
          list(plan.repairs.filter((r) => r.previousStatus === "backfilled").map((r) => r.bucketSec))
        : "") +
      `\n\nIG data:\n  1m rows received: ${plan.stats.oneMinRows}\n  expected 3m buckets: ${plan.stats.expectedBuckets}`,
  );
  if (plan.inserts.length)
    console.log(
      `\nWould insert:\n` +
        plan.inserts.map((i) => `  ${fmtDayBucket(i.bucketSec)}Z → backfilled  ${fmtOhlc(i.candle)}`).join("\n"),
    );
  if (plan.repairs.length)
    console.log(
      `\nWould repair:\n` +
        plan.repairs
          .map((r) => `  ${fmtDayBucket(r.bucketSec)}Z ${r.previousStatus} → backfilled  ${fmtOhlc(r.candle)}`)
          .join("\n"),
    );
  console.log(
    `\nCompleted candles protected: ${plan.skippedCompleted.length}` +
      `\nBackfilled candles protected${args.force ? "" : " (use --force to repair)"}: ${plan.skippedBackfilled.length}` +
      `\nUncovered (IG data insufficient — left EXACTLY as is): ${plan.uncovered.length}` +
      (plan.uncovered.length ? `\n${list(plan.uncovered.map((u) => u.bucketSec))}` : ""),
  );

  if (args.dryRun) {
    console.log("\nDatabase changes:\n  NONE (dry-run)");
    return;
  }

  // 5. REAL mode — race-safe writes; the DB re-checks each bucket's status at
  //    write time (missing→insert / partial→repair / completed→skip / backfilled→skip).
  let inserted = 0;
  let repaired = 0;
  let racedProtected = 0;
  let failed = 0;
  for (const ins of plan.inserts) {
    try {
      const outcome = await store.insertIfMissing(epic, TF, {
        time: ins.bucketSec,
        open: ins.candle.open,
        high: ins.candle.high,
        low: ins.candle.low,
        close: ins.candle.close,
      });
      if (outcome === "inserted") {
        inserted += 1;
        console.log(`[BACKFILL INSERTED] bucket=${fmtDayBucket(ins.bucketSec)}Z ${fmtOhlc(ins.candle)}`);
      } else {
        racedProtected += 1;
        console.log(`[BACKFILL SKIPPED-RACED] bucket=${fmtDayBucket(ins.bucketSec)}Z no longer missing — protected`);
      }
    } catch (err) {
      failed += 1;
      console.error(`[BACKFILL WRITE ERROR] bucket=${fmtDayBucket(ins.bucketSec)}Z ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const rep of plan.repairs) {
    try {
      const outcome = await store.repairIfPartial(
        epic,
        TF,
        {
          time: rep.bucketSec,
          open: rep.candle.open,
          high: rep.candle.high,
          low: rep.candle.low,
          close: rep.candle.close,
        },
        {
          includeBackfilled: rep.previousStatus === "backfilled",
        },
      );
      if (outcome === "repaired") {
        repaired += 1;
        console.log(`[BACKFILL REPAIRED] bucket=${fmtDayBucket(rep.bucketSec)}Z ${rep.previousStatus}→backfilled ${fmtOhlc(rep.candle)}`);
      } else {
        racedProtected += 1;
        console.log(`[BACKFILL SKIPPED-RACED] bucket=${fmtDayBucket(rep.bucketSec)}Z no longer ${rep.previousStatus} — protected`);
      }
    } catch (err) {
      failed += 1;
      console.error(`[BACKFILL WRITE ERROR] bucket=${fmtDayBucket(rep.bucketSec)}Z ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(
    `\nDatabase changes:\n` +
      `  inserted=${inserted} repaired=${repaired} raced-protected=${racedProtected} failed=${failed}` +
      (failed ? "\nRESULT: FAIL (some writes errored — inspect above)" : "\nRESULT: OK"),
  );
  if (failed) process.exit(1);
}

void main();