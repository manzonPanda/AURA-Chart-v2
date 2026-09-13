/**
 * `npm run backfill:capital` — MANUAL Capital.com historical import (Phase 8).
 *
 * NEVER automatic: not on startup, not on reconnect, not scheduled, not from
 * the frontend. The production backend is untouched by this script — it is a
 * separate explicit process that reuses the repo's own config/auth/store seams:
 *
 *   config.ts (env)          → the ONE Capital credential source (never logged)
 *   capital/client.ts        → the ONE session/auth/renewal implementation
 *   db/pgPool.ts + PgCandleStore → the ONE PostgreSQL connection layer
 *   market/instruments.ts    → the ONE instrument registry (registered symbols only)
 *
 * Usage:
 *   npm run backfill:capital                          # default 6 completed months, GOLD (every registered CAPITAL instrument)
 *   npm run backfill:capital -- --months=6
 *   npm run backfill:capital -- --from="2026-03-13T00:00Z" --to="2026-09-12T00:00Z"
 *   npm run backfill:capital -- --days=3
 *   npm run backfill:capital -- --hours=6
 *   npm run backfill:capital -- --symbol=GOLD --dry-run
 *   npm run backfill:capital -- --keep-going          # reject malformed rows and continue (default aborts)
 *   npm run backfill:capital -- --pause-ms=250 --max-retries=5
 *
 * Range semantics (UTC, minute grid): the ceiling is ALWAYS the last COMPLETED
 * minute — the forming bucket is never requested as historical data (and once
 * the live stream cuts over, ON CONFLICT DO NOTHING keeps every live row).
 *
 * Writes: status='backfilled', source='capital', timeframe=MINUTE_1 only.
 * MINUTE_3 rows are never written — 3m stays derived from canonical 1m rows.
 * Missing Capital candles stay missing (no placeholders, no gap manufacturing).
 *
 * Secrets: credentials, CST, X-SECURITY-TOKEN, authenticated headers, the
 * database password and AURA_DB_URL are NEVER printed — the crash path logs
 * through SecretRedactor over CapitalClient.redactables() + pgSecrets().
 */
import "dotenv/config";

import {
  CapitalValidationError,
  defaultCapitalBackfillRange,
  downloadCapitalHistory,
  historicalWindowEndMs,
  isMinuteAligned,
  lastCompletedBucketStartMs,
  minuteAlignDown,
  parseUtcMinuteInput,
  resolveCapitalInstruments,
  CAPITAL_BACKFILL_WINDOW_MS,
  type CapitalDownloadResult,
} from "../backfill/capitalDownloader.js";
import { CapitalClient } from "../capital/client.js";
import { isCapitalConfigured, loadConfig } from "../config.js";
import { PgCandleStore } from "../db/candleStore.js";
import { getPgPool, pgSecrets } from "../db/pgPool.js";
import { SecretRedactor } from "../lib/redact.js";

function die(msg: string): never {
  console.error(`backfill:capital: ${msg}`);
  process.exit(1);
}

interface Args {
  fromMs?: number;
  toMs?: number;
  months: number;
  days?: number;
  hours?: number;
  symbols: string[];
  dryRun: boolean;
  pauseMs: number;
  maxRetries: number;
  keepGoing: boolean;
  windowMinutes?: number;
}

function parseArgs(): Args {
  const args: Args = { months: 6, symbols: [], dryRun: false, pauseMs: 250, maxRetries: 5, keepGoing: false };
  for (const rawArg of process.argv.slice(2)) {
    const [key, ...rest] = rawArg.replace(/^--/, "").split("=");
    const val = rest.join("=");
    switch (key) {
      case "from": args.fromMs = parseUtcMinuteInput(val); break;
      case "to": args.toMs = parseUtcMinuteInput(val); break;
      case "months": args.months = Number(val); break;
      case "days": args.days = Number(val); break;
      case "hours": args.hours = Number(val); break;
      case "symbol": if (val) args.symbols.push(val); break;
      case "dry-run": args.dryRun = true; break;
      case "pause-ms": args.pauseMs = Number(val); break;
      case "max-retries": args.maxRetries = Number(val); break;
      case "keep-going": args.keepGoing = true; break;
      case "window-minutes": args.windowMinutes = Number(val); break;
      case "help":
        console.log(
          "backfill:capital — Capital.com historical 1m import\n" +
            "  --from=UTC --to=UTC        explicit completed-minute range (exclusive --to)\n" +
            "  --months=6 | --days=N | --hours=N   relative shorthands (default months=6)\n" +
            "  --symbol=GOLD              select registered CAPITAL instruments (default: all)\n" +
            "  --dry-run                  fetch + validate + report, write NOTHING\n" +
            "  --pause-ms=250             sequential pacing between requests\n" +
            "  --max-retries=5            bounded retries for 429/network/upstream\n" +
            "  --keep-going               reject malformed rows instead of aborting\n" +
            "  --window-minutes=1000      REST window (≤ documented max=1000 bars/page)",
        );
        process.exit(0);
      default: die(`unknown argument "--${key}" (see --help)`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = loadConfig();
  if (!isCapitalConfigured(cfg)) {
    die("Capital.com is not configured — set CAPITAL_API_KEY / CAPITAL_API_PASSWORD / CAPITAL_IDENTIFIER in backend/.env.");
  }

  const instruments = resolveCapitalInstruments(cfg, args.symbols.length ? args.symbols : undefined);
  const capitalClient = new CapitalClient(cfg.capital);

  // Store: canonical PostgreSQL ONLY (never a second connection). Dry-run skips
  // the store entirely so the PG layer is not even opened.
  let store: PgCandleStore | null = null;
  let pool = null as ReturnType<typeof getPgPool>;
  if (!args.dryRun) {
    pool = getPgPool();
    if (!pool) die("PostgreSQL is not configured (AURA_DB_URL / /etc/aura/postgres.env) — refusing to import without a store.");
    store = new PgCandleStore(pool);
    if (!(await store.ping())) {
      die("PostgreSQL store unreachable or ohlc_candles missing — npm run db:migrate first / verify AURA_DB_URL.");
    }
  }

  // Crash path: fatal logs pass through the redactor (Capital tokens + PG
  // password/AURA_DB_URL values masked) — same policy as the production server.
  const redactor = new SecretRedactor(() => [...capitalClient.redactables(), ...pgSecrets()]);
  for (const evt of ["uncaughtException", "unhandledRejection"] as const) {
    process.on(evt, (err: unknown) => {
      console.error(`[capital-backfill FATAL ${evt}]\n${redactor.describe(err)}`);
      process.exit(1);
    });
  }

  const nowMs = Date.now();
  const ceiling = historicalWindowEndMs(nowMs);

  // Range: explicit --from wins; else --hours/--days shorthand; else --months.
  const effectiveCeiling = args.toMs !== undefined ? Math.min(args.toMs, ceiling) : ceiling;
  if (args.toMs !== undefined && !isMinuteAligned(args.toMs)) die("--to must be minute-aligned.");
  let fromMs: number;
  if (args.fromMs !== undefined) {
    if (Number.isNaN(args.fromMs)) die("--from could not be parsed (use UTC YYYY-MM-DD or ISO).");
    fromMs = args.fromMs;
  } else if (args.hours !== undefined) {
    fromMs = effectiveCeiling - args.hours * 3_600_000;
  } else if (args.days !== undefined) {
    fromMs = effectiveCeiling - args.days * 86_400_000;
  } else {
    fromMs = defaultCapitalBackfillRange(nowMs, args.months).fromMs;
  }
  fromMs = minuteAlignDown(fromMs);
  if (!isMinuteAligned(effectiveCeiling)) die("range ceiling must be minute-aligned (internal bug).");
  if (!(effectiveCeiling > fromMs)) {
    die(`empty range — requested ceiling ${new Date(effectiveCeiling).toISOString()} is at/before --from ${new Date(fromMs).toISOString()}.`);
  }
  if (args.toMs !== undefined && args.toMs > ceiling) {
    console.log(
      `[capital-backfill] requested --to ${new Date(args.toMs).toISOString()} exceeds the completed-minute ceiling — ` +
        `clamped to ${new Date(ceiling).toISOString()} (the forming minute is NEVER imported as historical data).`,
    );
  }
  if (fromMs > lastCompletedBucketStartMs(nowMs)) {
    die("--from lies inside the current forming minute — nothing completed to import.");
  }

  const windowMs = args.windowMinutes !== undefined
    ? Math.min(args.windowMinutes, 1000) * 60_000
    : CAPITAL_BACKFILL_WINDOW_MS;

  console.log(
    `[capital-backfill] instruments: ${instruments.map((m) => m.epic).join(", ")}` +
      `${args.dryRun ? " — DRY-RUN (fetch + validate + report only, no database writes)" : ""}\n` +
      `[capital-backfill] range: ${new Date(fromMs).toISOString()} … ${new Date(effectiveCeiling).toISOString()} (exclusive ceiling) ` +
      `(exclusive — all COMPLETED minutes; forming bucket excluded)\n` +
      `[capital-backfill] pacing: pauseMs=${args.pauseMs} maxRetries=${args.maxRetries} windowMs=${windowMs} onInvalid=${args.keepGoing ? "reject" : "abort"}` +
      (pool ? " db=configured (PgCandleStore, ON CONFLICT DO NOTHING)" : " db=(none — dry-run)"),
  );

  const all: CapitalDownloadResult[] = [];
  let failed = 0;
  for (const instrument of instruments) {
    try {
      const result = await downloadCapitalHistory({
        symbol: instrument.epic,
        decimals: instrument.decimals,
        fromMs,
        toMs: effectiveCeiling,
        fetcher: capitalClient,
        store: args.dryRun ? null : (store as PgCandleStore),
        windowMs,
        pauseMs: args.pauseMs,
        maxRetries: args.maxRetries,
        onInvalid: args.keepGoing ? "reject" : "abort",
        logger: (line): void => console.log(line),
      });
      all.push(result);
    } catch (err) {
      failed += 1;
      if (err instanceof CapitalValidationError) {
        console.error(redactor.describe(err));
      } else {
        console.error(
          `[capital-backfill] ${instrument.epic}: ABORTED — NO database changes from the failed page; ` +
            `already-persisted pages remain (re-run resumes at no extra cost).\n${redactor.describe(err)}`,
        );
      }
      // One instrument's failure must not cascade into silently skipping the
      // others' reporting — but the run exits non-zero regardless.
    }
  }

  const totals = all.reduce(
    (acc, r) => ({
      requests: acc.requests + r.requests,
      received: acc.received + r.received,
      inserted: acc.inserted + r.inserted,
      dbSkipped: acc.dbSkipped + r.dbSkipped,
      inBatchDuplicates: acc.inBatchDuplicates + r.inBatchDuplicates,
      invalid: acc.invalid + r.invalid,
    }),
    { requests: 0, received: 0, inserted: 0, dbSkipped: 0, inBatchDuplicates: 0, invalid: 0 },
  );
  console.log(
    `\n[capital-backfill] TOTAL instruments=${all.length} requests=${totals.requests} received=${totals.received} ` +
      `inserted=${totals.inserted} skipped-present=${totals.dbSkipped} inBatchDupes=${totals.inBatchDuplicates} invalid=${totals.invalid}` +
      `${args.dryRun ? " (dry-run — NOTHING was written)" : ""}` +
      (failed ? `\nRESULT: FAIL (${failed} instrument(s) aborted — inspect above; re-run resumes)` : "\nRESULT: OK"),
  );
  if (failed) process.exit(1);
}

void main();
