/**
 * Automatic Capital.com reconciliation for GENUINE missing Gold candles.
 *
 * WHY THIS EXISTS (2026-09-15 forensic finding, read-only investigation):
 * Capital's MINUTE OHLC WebSocket stream uses DISTINCT delivery — a minute in
 * which the OHLC never changed can legitimately produce ZERO frames while the
 * high-frequency `marketData` quote stream keeps flowing. The live aggregator
 * therefore has nothing to close for such a minute and PostgreSQL keeps no row
 * for it (journal `ROLLOVER skip` ↔ absent row, 1:1 verified). Result: ~1–2
 * singleton holes per hour, which the chart correctly renders as DATA GAPs.
 *
 * This module REPAIRS those holes from the AUTHORITATIVE source only —
 * Capital's REST historical prices endpoint — reusing the EXISTING backfill
 * engine wholesale:
 *
 *   detectGaps (calendar-aware, market/gapDetector.ts)     ← which buckets?
 *        ↓
 *   downloadCapitalHistory (backfill/capitalDownloader.ts) ← fetch that range
 *        ↓
 *   PgCandleStore.insertBackfilledBatch                    ← INSERT … DO NOTHING
 *
 * ── HARD DATA-SAFETY CONTRACT (never relaxed here) ──────────────────────────
 *   • INSERT-only. The write path is `ON CONFLICT (instrument, timeframe,
 *     bucket_time) DO NOTHING` (insertBackfilledBatch) — an existing
 *     completed/partial/live/backfilled row is NEVER overwritten, its OHLC is
 *     never modified, and no DELETE/UPDATE exists anywhere in this module.
 *   • `source='capital'`, `status='backfilled'`, `tick_count=NULL` — exactly the
 *     existing backfill provenance. No new `source` value, no status changes.
 *   • NO synthetic candles. Quotes NEVER reach PostgreSQL: a minute with no
 *     Capital REST bar stays missing (a real gap), never fabricated. The quote
 *     stream stays a display-only concern.
 *   • Only MARKET-CALENDAR-OPEN buckets are considered — `detectGaps` consults
 *     the corrected Gold calendar, so breaks/weekends/holidays can never be
 *     "repaired".
 *   • The forming candle is never requested (the window ends before it) and the
 *     newest `safetyLagMinutes` completed buckets are deliberately skipped so
 *     late-arriving Capital data settles first.
 *   • If the live collector does close a bucket after a backfilled row landed,
 *     the live path's own `ON CONFLICT DO UPDATE` replaces it with the
 *     authoritative streamed OHLC — correct, and unchanged by this module.
 *
 * ─ LIVENESS CONTRACT ───────────────────────────────────────────────────────
 *   • Runs are sequential, non-overlapping, and FULLY error-contained: every
 *     failure is caught and reported, never rethrown (an escaped rejection
 *     would trip the process-level `unhandledRejection` guard and restart the
 *     backend — unacceptable for a repair job).
 *   • Zero REST requests when nothing is missing (the common case) — no noise,
 *     no rate-limit pressure on the live Capital session.
 *   • Nothing here touches the Capital WebSocket, heartbeat, quote stream,
 *     aggregator, live-candle persistence, the API, or the frontend.
 */
import type { CapitalPricesFetcher } from "../capital/historical.js";
import type { CapitalBackfillStore } from "./capitalDownloader.js";
import {
  CAPITAL_BACKFILL_WINDOW_MS,
  MINUTE_MS,
  downloadCapitalHistory,
} from "./capitalDownloader.js";
import type { MarketCalendar } from "../market/calendar.js";
import { detectGaps, type GapRow } from "../market/gapDetector.js";
import { CANONICAL_TIMEFRAME } from "../streaming/timeframes.js";

/** Canonical persisted bucket width — MINUTE_1 only (3m is derived on read). */
export const RECONCILE_BUCKET_SEC = 60;

/**
 * The minimal store surface reconciliation needs. Satisfied by `PgCandleStore`
 * (PostgreSQL — the production store). The Supabase shim has no
 * `insertBackfilledBatch`, so it can never satisfy this and reconciliation
 * simply stays disabled — no second persistence implementation is ever created.
 */
export interface ReconcileStore extends CapitalBackfillStore {
  loadCandlesRange(
    instrument: string,
    timeframe: string,
    fromSec: number,
    toSec: number,
  ): Promise<ReadonlyArray<{ time: number; status?: string }>>;
}

/** Structural type guard — TRUE only for stores owning the backfill write path. */
export function supportsReconciliation(store: unknown): store is ReconcileStore {
  const s = store as Partial<ReconcileStore> | null | undefined;
  return Boolean(
    s &&
      typeof s.loadCandlesRange === "function" &&
      typeof s.insertBackfilledBatch === "function",
  );
}
// ─ Settings (clamped — an invalid env value can never weaken the guards) ────

export interface ReconcileSettings {
  /** Minutes between automatic runs. */
  intervalMinutes: number;
  /** How far back each run scans (≤999 keeps one run to a single REST page). */
  lookbackMinutes: number;
  /** Newest COMPLETED buckets deliberately skipped (Capital REST settlement). */
  safetyLagMinutes: number;
}

export const RECONCILE_DEFAULTS: ReconcileSettings = {
  intervalMinutes: 15,
  lookbackMinutes: 180,
  safetyLagMinutes: 3,
};

const clampInt = (value: number, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * Clamp operator-supplied settings into the safe envelope. The safety lag can
 * never drop below 1: the newest COMPLETED bucket is always left to the live
 * pipeline, so this module can never race the stream on a just-closed candle.
 */
export function resolveReconcileSettings(partial: Partial<ReconcileSettings> = {}): ReconcileSettings {
  return {
    intervalMinutes: clampInt(
      partial.intervalMinutes ?? RECONCILE_DEFAULTS.intervalMinutes,
      1, 1440, RECONCILE_DEFAULTS.intervalMinutes,
    ),
    lookbackMinutes: clampInt(
      partial.lookbackMinutes ?? RECONCILE_DEFAULTS.lookbackMinutes,
      1, 999, RECONCILE_DEFAULTS.lookbackMinutes,
    ),
    safetyLagMinutes: clampInt(
      partial.safetyLagMinutes ?? RECONCILE_DEFAULTS.safetyLagMinutes,
      1, 60, RECONCILE_DEFAULTS.safetyLagMinutes,
    ),
  };
}

// ── Pure window + detection math (unit-tested without any I/O) ───────────────

export interface ReconcileWindow {
  /** Inclusive scan start (epoch seconds, minute-aligned). */
  fromSec: number;
  /** EXCLUSIVE scan end — excludes the forming bucket AND the safety lag. */
  toSec: number;
  /** Start of the bucket containing `nowMs` (never scanned). */
  formingStartSec: number;
}

/**
 * The scan window: `lookbackMinutes` wide, ending `safetyLagMinutes` before the
 * forming bucket. With the defaults (180/3) the newest scanned bucket is the
 * 4th-most-recent completed minute — comfortably after Capital REST settles.
 */
export function reconcileScanWindow(
  nowMs: number,
  settings: ReconcileSettings = RECONCILE_DEFAULTS,
): ReconcileWindow {
  const { lookbackMinutes, safetyLagMinutes } = resolveReconcileSettings(settings);
  const formingStartSec = Math.floor(nowMs / 1000 / RECONCILE_BUCKET_SEC) * RECONCILE_BUCKET_SEC;
  const toSec = formingStartSec - safetyLagMinutes * RECONCILE_BUCKET_SEC;
  return { fromSec: toSec - lookbackMinutes * RECONCILE_BUCKET_SEC, toSec, formingStartSec };
}

export interface MissingScan {
  missing: number[];
  expectedBuckets: number;
}

/**
 * Which market-open buckets in the window have NO persisted row?
 * Delegates to the shared, calendar-aware `detectGaps` — no second detector.
 */
export function findMissingBuckets(
  rows: readonly GapRow[],
  calendar: MarketCalendar,
  window: Pick<ReconcileWindow, "fromSec" | "toSec">,
): MissingScan {
  const report = detectGaps(rows, {
    fromSec: window.fromSec,
    toSec: window.toSec,
    calendar,
    bucketSec: RECONCILE_BUCKET_SEC,
  });
  return { missing: report.missing, expectedBuckets: report.expectedBuckets };
}

export interface MissingRequestRange {
  fromMs: number;
  /** EXCLUSIVE ceiling — exactly one minute past the newest missing bucket. */
  toMs: number;
}

/** Tightest Capital REST window covering every missing bucket (null when none). */
export function missingRequestRange(missing: readonly number[]): MissingRequestRange | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const sec of missing) {
    if (!Number.isFinite(sec)) continue;
    if (sec < lo) lo = sec;
    if (sec > hi) hi = sec;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return { fromMs: lo * 1000, toMs: hi * 1000 + MINUTE_MS };
}
// ── Result + observability ───────────────────────────────────────────────────

export interface ReconcileResult {
  symbol: string;
  /** Scan window actually used (epoch ms). */
  fromMs: number;
  toMs: number;
  safetyLagMinutes: number;
  /** Market-open buckets examined / found missing. */
  expectedBuckets: number;
  missingBuckets: number;
  /** First few missing bucket starts (epoch seconds) — never the whole list. */
  missingSample: number[];
  /** Capital REST range requested (null when nothing was missing). */
  requestedFromMs: number | null;
  requestedToMs: number | null;
  requests: number;
  /** Rows Capital returned for the requested range. */
  capitalRows: number;
  /** Rows actually inserted (genuinely missing). */
  inserted: number;
  /** Rows Capital returned that were ALREADY present (never overwritten). */
  skippedExisting: number;
  /** Malformed Capital rows rejected (never inserted). */
  invalid: number;
  errors: string[];
  durationMs: number;
}

const SAMPLE_LIMIT = 8;

const isoMinute = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;

/**
 * ONE concise line per target per run — deliberately not per candle, so normal
 * (missing = 0) operation adds a single quiet line. Mirrors the existing
 * `[capital-backfill]` / `[DB CANDLE SAVED]` diagnostic style.
 */
export function summarizeReconcile(result: ReconcileResult): string {
  const head =
    `[capital-reconcile] ${result.symbol}: window ${isoMinute(result.fromMs)}…${isoMinute(result.toMs)} ` +
    `(lag ${result.safetyLagMinutes}m) checked=${result.expectedBuckets} missing=${result.missingBuckets}`;
  if (result.missingBuckets === 0) {
    return `${head} — nothing to repair (${result.durationMs}ms)`;
  }
  const sample = result.missingSample
    .map((s) => new Date(s * 1000).toISOString().slice(11, 16))
    .join(",");
  return (
    `${head} [${sample}${result.missingBuckets > result.missingSample.length ? ",…" : ""}] ` +
    `requested=${isoMinute(result.requestedFromMs ?? 0)}…${isoMinute(result.requestedToMs ?? 0)} ` +
    `requests=${result.requests} capitalRows=${result.capitalRows} inserted=${result.inserted} ` +
    `skippedExisting=${result.skippedExisting} invalid=${result.invalid} ` +
    `errors=${result.errors.length} (${result.durationMs}ms)`
  );
}

// ── One target: detect → fetch → INSERT-missing (never throws) ───────────────

export interface ReconcileTarget {
  /** Registered CAPITAL instrument symbol (e.g. "GOLD"). */
  symbol: string;
  /** Quoting decimals (GOLD 2) — the midpoint OHLC grid. */
  decimals: number;
  /** The instrument's market calendar (Gold's corrected Globex schedule). */
  calendar: MarketCalendar;
}

export interface ReconcileEngineOptions {
  store: ReconcileStore;
  fetcher: CapitalPricesFetcher;
  targets: readonly ReconcileTarget[];
  settings?: Partial<ReconcileSettings>;
  logger?: (line: string) => void;
  /** Malformed Capital row policy. Default "reject" — report, never insert. */
  onInvalid?: "abort" | "reject";
  maxRetries?: number;
  backoffMs?: number;
  pauseMs?: number;
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/**
 * Scan every target for genuine missing completed buckets and repair them via
 * the existing Capital REST backfill engine. NEVER throws: all failures land in
 * `result.errors` and the summary log.
 */
export async function reconcileTargets(
  opts: ReconcileEngineOptions,
  nowMs: number = Date.now(),
): Promise<ReconcileResult[]> {
  const log = opts.logger ?? ((line: string): void => console.log(line));
  const settings = resolveReconcileSettings(opts.settings ?? {});
  const window = reconcileScanWindow(nowMs, settings);
  const results: ReconcileResult[] = [];

  for (const target of opts.targets) {
    const startedAt = Date.now();
    const result: ReconcileResult = {
      symbol: target.symbol,
      fromMs: window.fromSec * 1000,
      toMs: window.toSec * 1000,
      safetyLagMinutes: settings.safetyLagMinutes,
      expectedBuckets: 0,
      missingBuckets: 0,
      missingSample: [],
      requestedFromMs: null,
      requestedToMs: null,
      requests: 0,
      capitalRows: 0,
      inserted: 0,
      skippedExisting: 0,
      invalid: 0,
      errors: [],
      durationMs: 0,
    };
    results.push(result);
    try {
      // 1) Which market-open buckets in the window have no persisted row?
      const rows = await opts.store.loadCandlesRange(
        target.symbol,
        CANONICAL_TIMEFRAME,
        window.fromSec,
        window.toSec - RECONCILE_BUCKET_SEC, // inclusive DB bound
      );
      const scan = findMissingBuckets(rows, target.calendar, window);
      result.expectedBuckets = scan.expectedBuckets;
      result.missingBuckets = scan.missing.length;
      result.missingSample = scan.missing.slice(0, SAMPLE_LIMIT);

      // 2) Nothing missing (or market closed) → NO REST call at all.
      const range = missingRequestRange(scan.missing);
      if (range) {
        result.requestedFromMs = range.fromMs;
        result.requestedToMs = range.toMs;
        // 3) Authoritative repair — the EXISTING bounded backfill engine,
        //    writing through insertBackfilledBatch (INSERT … DO NOTHING).
        const download = await downloadCapitalHistory({
          symbol: target.symbol,
          decimals: target.decimals,
          fromMs: range.fromMs,
          toMs: range.toMs,
          fetcher: opts.fetcher,
          store: opts.store,
          windowMs: CAPITAL_BACKFILL_WINDOW_MS,
          pauseMs: opts.pauseMs,
          maxRetries: opts.maxRetries,
          backoffMs: opts.backoffMs,
          // A malformed row is REPORTED and never inserted; it must not abort an
          // otherwise-healthy repair run.
                    onInvalid: opts.onInvalid ?? "reject",
          // The downloader's per-step diagnostics are silenced here: the
          // reconciler emits exactly ONE concise summary line per target (see
          // summarizeReconcile), and the downloader's own metrics are folded
          // into it. Downloader failures still propagate via thrown errors and
          // the returned {received,inserted,dbSkipped,invalid} counters.
          logger: () => {},
        });
        result.requests = download.requests;
        result.capitalRows = download.received;
        result.inserted = download.inserted;
        result.skippedExisting = download.dbSkipped;
        result.invalid = download.invalid;
      }
    } catch (err) {
      // Contain EVERYTHING — a rejection escaping here would reach the process
      // `unhandledRejection` guard and restart the backend.
      const message = errorMessage(err);
      result.errors.push(message);
      log(`[capital-reconcile] ${target.symbol}: reconciliation FAILED — ${message}`);
    }
    result.durationMs = Date.now() - startedAt;
    log(summarizeReconcile(result));
  }
  return results;
}

// ── The scheduled reconciler (start/stop/status — the existing service style) ─

export interface CapitalReconcilerOptions extends ReconcileEngineOptions {
  /** Minutes between automatic runs; falls back to settings/defaults. */
  intervalMinutes?: number;
}

/** Observability snapshot — served additively via GET /api/stream/status. */
export interface ReconcilerStatus {
  enabled: boolean;
  intervalMinutes: number;
  lookbackMinutes: number;
  safetyLagMinutes: number;
  targets: string[];
  running: boolean;
  stopped: boolean;
  runs: number;
  /** Runs skipped because the previous one was still in flight. */
  skippedRuns: number;
  lastRunAtMs: number | null;
  lastRunAgoMs: number | null;
  lastDurationMs: number | null;
  lastChecked: number;
  lastMissing: number;
  lastInserted: number;
  lastErrors: string[];
  totals: { missing: number; inserted: number; runsWithErrors: number };
}

/**
 * Periodically repairs genuine missing completed candles. Mirrors the existing
 * service lifecycle (`realtime.start()/stop()`, `emaAlertEngine.start()`): the
 * process starts it once at boot and `installLifecycle` stops it on SIGTERM.
 * It holds NO provider state and touches NO stream/aggregator/quote code.
 */
export class CapitalReconciler {
  private readonly settings: ReconcileSettings;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;

  private runs = 0;
  private skippedRuns = 0;
  private lastRunAtMs: number | null = null;
  private lastDurationMs: number | null = null;
  private lastChecked = 0;
  private lastMissing = 0;
  private lastInserted = 0;
  private lastErrors: string[] = [];
  private totalMissing = 0;
  private totalInserted = 0;
  private runsWithErrors = 0;

  constructor(private readonly opts: CapitalReconcilerOptions) {
    this.settings = resolveReconcileSettings({
      ...(opts.settings ?? {}),
      ...(opts.intervalMinutes !== undefined ? { intervalMinutes: opts.intervalMinutes } : {}),
    });
  }

  /** Immediate first pass, then one pass per interval. Idempotent. */
  start(): void {
    if (this.timer || this.stopped) return;
    const symbols = this.opts.targets.map((t) => t.symbol).join("+") || "(none)";
    console.log(
      `[capital-reconcile] ENABLED — ${symbols}: every ${this.settings.intervalMinutes}m over the last ` +
        `${this.settings.lookbackMinutes}m, skipping the newest ${this.settings.safetyLagMinutes} completed ` +
        `bucket(s); Capital REST repair is INSERT-only (ON CONFLICT DO NOTHING), open buckets only.`,
    );
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.settings.intervalMinutes * 60_000);
  }

  /** Permanently stop scheduling (graceful shutdown). In-flight work drains. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[capital-reconcile] stopped.");
    }
  }

  /**
   * One sequential, non-overlapping pass. NEVER throws and never rejects.
   * Returns the per-target results ([] when skipped/already running).
   */
  async runOnce(nowMs: number = Date.now()): Promise<ReconcileResult[]> {
    if (this.stopped || this.running) {
      if (this.running) this.skippedRuns += 1;
      return [];
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const results = await reconcileTargets(this.opts, nowMs);
      this.record(results, Date.now() - startedAt);
      return results;
    } catch (err) {
      // Belt-and-braces: reconcileTargets already contains per-target failures.
      this.lastErrors = [errorMessage(err)];
      this.runsWithErrors += 1;
      this.lastRunAtMs = Date.now();
      this.lastDurationMs = Date.now() - startedAt;
      console.log(`[capital-reconcile] run FAILED — ${this.lastErrors[0]}`);
      return [];
    } finally {
      this.running = false;
    }
  }

  private record(results: readonly ReconcileResult[], durationMs: number): void {
    this.runs += 1;
    this.lastRunAtMs = Date.now();
    this.lastDurationMs = durationMs;
    this.lastChecked = results.reduce((n, r) => n + r.expectedBuckets, 0);
    this.lastMissing = results.reduce((n, r) => n + r.missingBuckets, 0);
    this.lastInserted = results.reduce((n, r) => n + r.inserted, 0);
    this.lastErrors = results.flatMap((r) => r.errors);
    this.totalMissing += this.lastMissing;
    this.totalInserted += this.lastInserted;
    if (this.lastErrors.length > 0) this.runsWithErrors += 1;
  }

  /** Read-only status — the additive `/api/stream/status` payload. */
  statusSnapshot(): ReconcilerStatus {
    return {
      enabled: true,
      intervalMinutes: this.settings.intervalMinutes,
      lookbackMinutes: this.settings.lookbackMinutes,
      safetyLagMinutes: this.settings.safetyLagMinutes,
      targets: this.opts.targets.map((t) => t.symbol),
      running: this.running,
      stopped: this.stopped,
      runs: this.runs,
      skippedRuns: this.skippedRuns,
      lastRunAtMs: this.lastRunAtMs,
      lastRunAgoMs: this.lastRunAtMs === null ? null : Date.now() - this.lastRunAtMs,
      lastDurationMs: this.lastDurationMs,
      lastChecked: this.lastChecked,
      lastMissing: this.lastMissing,
      lastInserted: this.lastInserted,
      lastErrors: this.lastErrors,
      totals: {
        missing: this.totalMissing,
        inserted: this.totalInserted,
        runsWithErrors: this.runsWithErrors,
      },
    };
  }
}