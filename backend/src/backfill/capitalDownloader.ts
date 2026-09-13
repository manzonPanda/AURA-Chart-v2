/**
 * Capital.com historical 1-minute downloader — the bounded, idempotent backfill
 * engine that populates the Oracle PostgreSQL store from Capital REST history
 * BEFORE the production live-stream cutover.
 *
 * Architecture (deliberately bounded — never load six months into memory):
 *
 *   Capital REST (existing CapitalClient.getPrices seam)
 *     |
 *     v
 *   bounded historical page (≤ CAPITAL_PAGE_SIZE bars per request)
 *     |
 *     v
 *   normalize + validate (pure — rejects malformed rows, never inserts them)
 *     |
 *     v
 *   PostgreSQL batch insert (PgCandleStore.insertBackfilledBatch — one
 *   multi-row INSERT … ON CONFLICT DO NOTHING per page)
 *     |
 *     v
 *   next page (cursor advances on CLIENT-side bucket grid) → repeat
 *
 * Historical API facts (VERIFIED EMPIRICALLY against the live API 2026-09-13,
 * GOLD — not assumed from docs):
 *   - GET /api/v1/prices/{epic}?resolution=MINUTE&max=N&from=…&to=…
 *   - resolution=MINUTE is Capital's native 1-minute bar. AURA NEVER requests
 *     MINUTE_3 — 3m stays derived from canonical MINUTE_1 rows.
 *   - from/to are "YYYY-MM-DDTHH:MM:SS" UTC wall clock (epoch formats are
 *     rejected with error.invalid.from). BOTH boundaries are INCLUSIVE:
 *     [20:40,20:46] returned 20:40…20:46 (7 stamps for a 6-minute span).
 *   - With from+to present, a window that could return more stamps than `max`
 *     is rejected: 400 error.invalid.max.daterange (1000-minute window +
 *     max=1000 fails; 999-minute window passes) → pages are 999 minutes.
 *   - A `to` in the FUTURE is rejected: 400 error.invalid.daterange → every
 *     window ends at the forming bucket START (never beyond it).
 *   - A VALID epic over a window with NO data (closed market) → HTTP 404 with
 *     no errorCode → treated as an EMPTY page (never a fatal symbol error).
 *   - OPEN stamping (decisive): the daily-break reopen 2026-09-10 22:00 UTC
 *     returned a bar stamped 22:00 — a CLOSE-stamped feed cannot have one
 *     (that bar would cover the 21:00–22:00 break). So snapshotTimeUTC =
 *     BUCKET START, matching the live CandleAggregator grid — no shift.
 *   - No native pagination token — pages are cut by from/to windows on the
 *     minute grid, so the downloader always advances by client-side bucket
 *     math and can never loop forever.
 *   - Rate limits: 10 requests/second per user overall, POST /session 1/second
 *     per key. Sessions expire ~10 minutes (the existing CapitalClient renews
 *     proactively — this engine NEVER touches session internals). HTTP 429 →
 *     error.too-many.requests.
 *   - 429/network/upstream failures are retried with capped exponential
 *     backoff; exhaustion aborts the run CLEANLY (already-persisted pages stay
 *     persisted — a re-run resumes at no extra cost thanks to DO NOTHING).
 *
 * Idempotency: every write is ON CONFLICT (instrument, timeframe, bucket_time)
 * DO NOTHING with status='backfilled' + source='capital'. First writer wins:
 * existing completed/partial/live rows and earlier backfill rows are NEVER
 * overwritten, so an interrupted run can simply be executed again — re-encountered
 * buckets are counted as skipped duplicates and nothing else changes.
 *
 * Historical semantics: missing Capital candles are left missing (no zero-price
 * placeholder rows, no gap manufacturing). The forming/current minute is never
 * requested as historical data (historicalWindowEndMs).
 *
 * Timeframe: canonical MINUTE_1 ONLY (CANONICAL_TIMEFRAME). MINUTE_3 historical
 * rows are never written — the 3m frame is derived ON READ from 1m rows.
 *
 * Secrets: this module never logs credentials, CST, X-SECURITY-TOKEN, request
 * headers, the database password or AURA_DB_URL. Diagnostics carry instrument,
 * ranges, batch counts and OHLC-derived row math only.
 */
import { CapitalApiError } from "../capital/errors.js";
import { parseCapitalPrice, type CapitalPricesFetcher } from "../capital/historical.js";
import { capitalRowTimestamp } from "../capital/time.js";
import { CAPITAL_PAGE_SIZE, type CapitalHistoricalPricesResponse, type CapitalPrice } from "../capital/types.js";
import { isCapitalConfigured, type Config } from "../config.js";
import type { CandleSource } from "../db/candleStore.js";
import { configuredInstruments, type InstrumentMeta } from "../market/instruments.js";
import { CANONICAL_TIMEFRAME } from "../streaming/timeframes.js";
import type { CandleStatus } from "../streaming/types.js";

/** The `source` provenance of every Capital historical row. */
export const CAPITAL_BACKFILL_SOURCE: CandleSource = "capital";
/** The `status` of every Capital historical row. */
export const CAPITAL_BACKFILL_STATUS: CandleStatus = "backfilled";

/** One validated historical candle — `time` is the BUCKET START (epoch SECONDS). */
export interface CapitalBackfillRow {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Structural write seam of the Capital historical downloader. Satisfied by
 * `PgCandleStore.insertBackfilledBatch` (the canonical PostgreSQL store) — no
 * second database connection is ever created, and dry-run passes null.
 */
export interface CapitalBackfillStore {
  insertBackfilledBatch(
    instrument: string,
    timeframe: string,
    rows: ReadonlyArray<CapitalBackfillRow>,
    source: CandleSource,
  ): Promise<{ inserted: number; skipped: number }>;
}

/** Why one malformed Capital row was rejected (diagnostics only — no secrets). */
export interface InvalidHistoricalCandle {
  /** Raw snapshotTimeUTC stamp epoch-ms when parseable, else null. */
  stampMs: number | null;
  reason: string;
}

/** One page's validated output. Rows are ascending, unique by bucket START. */
export interface ValidatedPage {
  rows: CapitalBackfillRow[];
  invalid: InvalidHistoricalCandle[];
  /** Same bucket START twice inside ONE page — deduped (first wins), counted. */
  inBatchDuplicates: number;
}

/**
 * Clear, structured failure for an unexpected Capital historical candle shape.
 * Carries every rejection reason so the operator can decide — malformed data
 * is never silently inserted.
 */
export class CapitalValidationError extends Error {
  constructor(
    public readonly symbol: string,
    public readonly window: { fromMs: number; toMs: number },
    public readonly invalid: InvalidHistoricalCandle[],
  ) {
    super(
      `[capital-backfill] ${symbol}: ${invalid.length} malformed historical candle(s) in the page ` +
        `${new Date(window.fromMs).toISOString()}…${new Date(window.toMs).toISOString()} — aborting (nothing from ` +
        `this page was written). Reasons: ${summarizeReasons(invalid)}. Use --keep-going to reject-and-continue instead.`,
    );
    this.name = "CapitalValidationError";
  }
}

function summarizeReasons(invalid: ReadonlyArray<InvalidHistoricalCandle>): string {
  const counts = new Map<string, number>();
  for (const i of invalid) counts.set(i.reason, (counts.get(i.reason) ?? 0) + 1);
  return [...counts.entries()].map(([r, n]) => `${r}×${n}`).join(", ");
}

// ── Instrument resolution (the ONE registry — never hardcoded EPICs) ─────────

/**
 * CAPITAL-provider instruments this deployment actually configures (from the
 * instrument registry + env config). Today that is exactly ["GOLD"] — Silver
 * is still registered with the IG provider (CS.D.CFDSILVER.CMG.IP), so it is
 * deliberately NOT importable from Capital until it becomes a registered
 * CAPITAL instrument.
 */
export function configuredCapitalInstruments(config: Config): InstrumentMeta[] {
  if (!isCapitalConfigured(config)) return [];
  return configuredInstruments(config).filter((m) => m.provider === "CAPITAL");
}

/**
 * Resolve the instruments to import. No selection → every configured CAPITAL
 * instrument (today: GOLD — nothing unrelated is ever started automatically).
 * An explicit selection must be a registered CAPITAL-provider symbol; anything
 * else dies with the supported list (typo-proof, IG-EPIC-proof).
 */
export function resolveCapitalInstruments(
  config: Config,
  symbols?: ReadonlyArray<string>,
): InstrumentMeta[] {
  const list = configuredCapitalInstruments(config);
  if (list.length === 0) {
    throw new CapitalApiError(
      "not_configured",
      500,
      "No CAPITAL-provider instrument is configured — set CAPITAL_API_KEY / CAPITAL_API_PASSWORD / CAPITAL_IDENTIFIER first.",
    );
  }
  if (!symbols || symbols.length === 0) return list;
  const bySymbol = new Map(list.map((m) => [m.epic, m]));
  // Selections are deduped (order-preserving) so a repeated --symbol can never
  // double-import one market; unknown/IG-provider symbols die with the list.
  const seen = new Set<string>();
  const out: InstrumentMeta[] = [];
  for (const raw of symbols) {
    const s = raw.trim();
    if (seen.has(s)) continue;
    seen.add(s);
    const meta = bySymbol.get(s);
    if (!meta) {
      throw new CapitalApiError(
        "not_configured",
        500,
        `Symbol "${s}" is not a registered CAPITAL-provider instrument. Supported: ${list.map((m) => m.epic).join(", ")}.`,
      );
    }
    out.push(meta);
  }
  if (out.length === 0) {
    throw new CapitalApiError(
      "not_configured",
      500,
      `Empty instrument selection. Supported: ${list.map((m) => m.epic).join(", ")}.`,
    );
  }
  return out;
}

// ── Range math (pure, UTC, minute grid — forming minute never touched) ───────

export const MINUTE_MS = 60_000;

/** Minute-grid alignment check (Capital rows + request windows are all :00s). */
export function isMinuteAligned(ms: number): boolean {
  return Number.isFinite(ms) && ms % MINUTE_MS === 0;
}

/** Start of the minute bucket CONTAINING nowMs (the forming bucket). */
export function formingBucketStartMs(nowMs: number): number {
  return Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
}

/**
 * The newest COMPLETED minute bucket's START — the historical ceiling. The
 * bucket [B, B+60s) completes at B+60s, so while now lies inside [B, B+60s)
 * the last completed bucket start is B−60s.
 */
export function lastCompletedBucketStartMs(nowMs: number): number {
  return formingBucketStartMs(nowMs) - MINUTE_MS;
}

/**
 * Exclusive END of the historical request window: exactly all COMPLETED
 * minutes, never the forming one. Under the verified OPEN stamping (a bar
 * stamped T covers [T, T+60s)) the request filter ts ∈ [from, to) with
 * to = formingBucketStart excludes the forming bar (stamped formingStart) and
 * includes the last completed bar (stamped formingStart − 60s). The
 * `npm run capital:ts-probe` probe re-verifies this empirically before real
 * imports; if Capital ever switched to CLOSE stamping, to would move by one
 * minute — one line here, caught by the probe + integration verification.
 */
export function historicalWindowEndMs(nowMs: number): number {
  return formingBucketStartMs(nowMs);
}

/** Align DOWN onto the minute grid. */
export function minuteAlignDown(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * Parse a UTC CLI date input: "YYYY-MM-DD", "YYYY-MM-DDTHH:MM[:SS]" or any
 * ES-parseable form WITH an explicit Z/offset. Everything is aligned DOWN onto
 * the minute grid; a date-only input means 00:00 UTC. Returns NaN on garbage.
 */
export function parseUtcMinuteInput(raw: string): number {
  const s = raw.trim();
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return minuteAlignDown(Date.parse(`${s}T00:00:00Z`));
  }
  const ms = Date.parse(s.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? minuteAlignDown(ms) : NaN;
}

export interface CapitalBackfillRange {
  fromMs: number;
  toMs: number;
}

/**
 * Default target range: N calendar months (default 6) of COMPLETED minutes
 * ending at the historical ceiling (never the forming minute). UTC throughout.
 */
export function defaultCapitalBackfillRange(nowMs: number, months = 6): CapitalBackfillRange {
  const toMs = historicalWindowEndMs(nowMs);
  const start = new Date(toMs);
  start.setUTCMonth(start.getUTCMonth() - Math.max(0, months));
  return { fromMs: minuteAlignDown(start.getTime()), toMs };
}

// ── Page normalization + validation (pure) ───────────────────────────────────

/**
 * Validate ONE bounded /prices page and map it to bucket-START rows.
 *
 * Rules enforced per row (the caller's required contract):
 *   - authoritative timestamp parseable (snapshotTimeUTC preferred — never the
 *     local `snapshotTime` display form via a naive parse),
 *   - timestamp minute-aligned on the UTC grid (unexpected structure → reject),
 *   - timestamp inside the REQUESTED window (Capital may return the enclosing
 *     page boundary — filtered exactly like the existing seam),
 *   - usable midpoint OHLC (parseCapitalPrice — bid/ask mid, instrument grid),
 *   - high ≥ max(open, close), low ≤ min(open, close), high ≥ low, all finite,
 *   - duplicate bucket START within the page → deduped (first wins) + counted.
 *
 * The instrument identity is enforced UPSTREAM (resolveCapitalInstruments —
 * every page is requested for exactly one verified symbol), so rows carry no
 * per-row instrument and the symbol can never be misattributed mid-batch.
 * Returns ascending rows; malformed rows are REPORTED, never inserted.
 */
export function validateCapitalHistoricalPage(
  body: CapitalHistoricalPricesResponse,
  decimals: number,
  window: { fromMs: number; toMs: number },
): ValidatedPage {
  const rows: CapitalBackfillRow[] = [];
  const invalid: InvalidHistoricalCandle[] = [];
  let inBatchDuplicates = 0;
  const seen = new Set<number>();
  const rawRows = Array.isArray(body.prices) ? body.prices : [];

  for (const raw of rawRows) {
    const p: CapitalPrice = raw ?? {};
    const stampMs = capitalRowTimestamp(p);
    if (!Number.isFinite(stampMs)) {
      invalid.push({ stampMs: null, reason: "missing-or-unparseable-timestamp" });
      continue;
    }
    if (!isMinuteAligned(stampMs)) {
      invalid.push({ stampMs, reason: "not-minute-aligned" });
      continue;
    }
    if (stampMs < window.fromMs || stampMs >= window.toMs) {
      invalid.push({ stampMs, reason: "outside-requested-window" });
      continue;
    }
    const candle = parseCapitalPrice(p, decimals);
    if (!candle) {
      invalid.push({ stampMs, reason: "unusable-ohlc" });
      continue;
    }
    const { open, high, low, close } = candle;
    const o = open, h = high, l = low, c = close;
    if (![o, h, l, c].every((v) => Number.isFinite(v))) {
      invalid.push({ stampMs, reason: "non-numeric-ohlc" });
      continue;
    }
    if (h < Math.max(o, c) || l > Math.min(o, c) || h < l) {
      invalid.push({ stampMs, reason: "ohlc-invariant-violation" });
      continue;
    }
    const bucketSec = Math.floor(stampMs / 1000);
    if (seen.has(bucketSec)) {
      inBatchDuplicates += 1;
      continue;
    }
    seen.add(bucketSec);
    rows.push({ time: bucketSec, open: o, high: h, low: l, close: c });
  }

  rows.sort((a, b) => a.time - b.time);
  return { rows, invalid, inBatchDuplicates };
}

// ── The download engine (bounded, sequential, resumable) ─────────────────────

/**
 * Logical page span — 999 minutes (999 stamps), deliberately NOT 1000.
 *
 * EMPIRICAL (live probe 2026-09-13, GOLD): when BOTH `from` and `to` are
 * present, Capital rejects any window that could contain MORE data points
 * than `max` — HTTP 400 {"errorCode":"error.invalid.max.daterange"}. `to` is
 * INCLUSIVE (verified: window [20:40,20:46] returns 20:40…20:46 = 7 stamps
 * for a 6-minute span), so an N-minute span can return N+1 stamps:
 *   1000-minute span + max=1000 → 400 error.invalid.max.daterange
 *    999-minute span + max=1000 → PASS (999 bars)
 *    999-minute span + max= 999 → PASS (999 bars)
 *
 * SEMANTICS: this constant is the LOGICAL page length in the exclusive
 * [from, to) model — i.e. the STAMP COUNT per page. The API request's
 * inclusive `to` is `ceiling − 1 minute` (the page's own last stamp), so the
 * requested span is 998 minutes (999 possible stamps ≤ max=1000, with slack).
 * Pages tile [overallFrom, overallTo) exactly: next cursor = ceiling —
 * no overlap, no gap, no duplicate request. A 1-stamp final page degenerates
 * to from==to (accepted by Capital — verified live 2026-09-13).
 */
export const CAPITAL_BACKFILL_WINDOW_MS = (CAPITAL_PAGE_SIZE - 1) * MINUTE_MS;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export type CapitalBackfillLogger = (line: string) => void;

export interface CapitalDownloadOptions {
  /** Registered CAPITAL-provider symbol (e.g. "GOLD") — pre-verified upstream. */
  symbol: string;
  /** Instrument quoting decimals (Gold 2) — mid OHLC grid, from the registry. */
  decimals: number;
  /** Inclusive request-window start (minute-aligned, epoch ms). */
  fromMs: number;
  /** Exclusive request-window end (minute-aligned; NEVER beyond the ceiling). */
  toMs: number;
  fetcher: CapitalPricesFetcher;
  /** Canonical store; null = dry-run (fetch + validate + report, write NOTHING). */
  store: CapitalBackfillStore | null;
  /** REST window width (ms). Default 1000 minutes = one full page per request. */
  windowMs?: number;
  /** Sequential pacing between requests (ms). Default 250 — far under 10 req/s. */
  pauseMs?: number;
  /** Bounded retries for 429/network/upstream. Default 5. */
  maxRetries?: number;
  /** Base exponential backoff (ms). Default 2 000; 0 in tests. */
  backoffMs?: number;
  /** "abort" (default — fail clearly) or "reject" (report and continue). */
  onInvalid?: "abort" | "reject";
  logger?: CapitalBackfillLogger;
}

export interface CapitalDownloadResult {
  symbol: string;
  timeframe: string;
  source: CandleSource;
  status: CandleStatus;
  fromMs: number;
  toMs: number;
  requests: number;
  batches: number;
  /** Raw Capital rows returned (before validation). */
  received: number;
  /** Rows inserted via ON CONFLICT DO NOTHING. */
  inserted: number;
  /** Rows skipped because the bucket was ALREADY present (never overwritten). */
  dbSkipped: number;
  /** Duplicate bucket STARTs inside one page. */
  inBatchDuplicates: number;
  /** Rejected malformed rows (with onInvalid="reject"; aborts carry 0 here). */
  invalid: number;
  invalidReasons: Record<string, number>;
  /** Newest bucket START persisted so far (cursor) — null when none. */
  newestBucketSec: number | null;
  dryRun: boolean;
}

const fmtBucket = (sec: number): string => new Date(sec * 1000).toISOString().replace(".000Z", "Z");

const RETRYABLE_KINDS = new Set<CapitalApiError["kind"]>([
  "rate_limit",
  "network",
  "upstream",
  "malformed",
  "session_expired",
]);

async function fetchPageWithRetry(
  fetcher: CapitalPricesFetcher,
  symbol: string,
  fromMs: number,
  toMs: number,
  maxRetries: number,
  backoffMs: number,
  log: CapitalBackfillLogger,
): Promise<CapitalHistoricalPricesResponse> {
  let attempt = 0;
  for (;;) {
    try {
      return await fetcher.getPrices(symbol, fromMs, toMs, CAPITAL_PAGE_SIZE);
    } catch (err) {
      // EMPIRICAL (live probe 2026-09-13, GOLD): Capital answers HTTP 404 with
      // NO errorCode for a VALID epic over a window containing NO data (daily
      // break / weekend closure), while the same epic returns data for
      // in-session windows. A six-month import necessarily crosses fully
      // closed windows, so 404 on /prices means "EMPTY PAGE" here — never a
      // fatal symbol error (symbols are registry-resolved CAPITAL instruments).
      if (err instanceof CapitalApiError && err.kind === "invalid_symbol" && err.status === 404) {
        log(
          `[capital-backfill] ${symbol}: window ${fmtBucket(fromMs / 1000)}…${fmtBucket(toMs / 1000)} ` +
            `returned no data (market closed) — treated as an empty page`,
        );
        return { prices: [] };
      }
      const retryable = err instanceof CapitalApiError && RETRYABLE_KINDS.has(err.kind);
      if (!retryable || attempt >= maxRetries) throw err;
      attempt += 1;
      const delay = Math.min(30_000, backoffMs * 2 ** (attempt - 1));
      log(
        `[capital-backfill] ${symbol}: request failed (kind=${(err as CapitalApiError).kind}, attempt ${attempt}/${maxRetries}) — retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

/**
 * Download one instrument's historical 1-minute candles over [fromMs, toMs).
 * Sequential (one request in flight — never hundreds), bounded pages, one
 * multi-row insert per page, strict validation before every insert.
 */
export async function downloadCapitalHistory(opts: CapitalDownloadOptions): Promise<CapitalDownloadResult> {
  const log = opts.logger ?? ((line: string): void => console.log(line));
  const windowMs = opts.windowMs ?? CAPITAL_BACKFILL_WINDOW_MS;
  const pauseMs = opts.pauseMs ?? 250;
  const maxRetries = opts.maxRetries ?? 5;
  const backoffMs = opts.backoffMs ?? 2_000;
  const onInvalid = opts.onInvalid ?? "abort";

  if (!isMinuteAligned(opts.fromMs) || !isMinuteAligned(opts.toMs)) {
    throw new CapitalApiError("internal", 500, "Range boundaries must be minute-aligned (UTC epoch ms).");
  }
  if (!(opts.toMs > opts.fromMs)) {
    throw new CapitalApiError("internal", 500, "Empty range — toMs must be after fromMs.");
  }
  if (!(windowMs > 0) || windowMs % MINUTE_MS !== 0) {
    throw new CapitalApiError("internal", 500, "windowMs must be a positive whole-minute multiple.");
  }

  const result: CapitalDownloadResult = {
    symbol: opts.symbol,
    timeframe: CANONICAL_TIMEFRAME,
    source: CAPITAL_BACKFILL_SOURCE,
    status: CAPITAL_BACKFILL_STATUS,
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    requests: 0,
    batches: 0,
    received: 0,
    inserted: 0,
    dbSkipped: 0,
    inBatchDuplicates: 0,
    invalid: 0,
    invalidReasons: {},
    newestBucketSec: null,
    dryRun: opts.store === null,
  };
  const totalBuckets = (opts.toMs - opts.fromMs) / MINUTE_MS;

  log(
    `[capital-backfill] ${opts.symbol}: importing ${result.timeframe} (${result.source}/${result.status}) over ` +
      `${new Date(opts.fromMs).toISOString()}…${new Date(opts.toMs).toISOString()} — ${totalBuckets} buckets, ` +
      `≈${Math.ceil(totalBuckets / (windowMs / MINUTE_MS))} bounded request(s), ${result.dryRun ? "DRY-RUN (no writes)" : "writes via PgCandleStore (ON CONFLICT DO NOTHING)"}`,
  );

  let cursor = opts.fromMs;
  while (cursor < opts.toMs) {
    // ── Page math (INCLUSIVE Capital `to`; gap-free, overlap-free tiling) ────
    // Logical page = [cursor, cursor + windowMs) — `windowMs` stamps, ceiling
    // exclusive and EXACTLY the next page's cursor (Test 1/3 semantics). The
    // API's `to` is INCLUSIVE (live-verified), so the request's `to` is the
    // page's OWN last stamp: ceiling − 1 minute. The validator's window is the
    // logical [cursor, ceiling): the inclusive boundary stamp is this page's
    // last bucket (ACCEPTED), and the first stamp of the NEXT page is never
    // requested here — no duplicate requests, no skipped buckets. The global
    // ceiling `opts.toMs` stays EXCLUSIVE: the final page clamps to
    // `overallTo − 1min` so the forming bucket is never requested, and a
    // 1-stamp remainder degenerates to from==to (accepted by Capital — verified
    // live 2026-09-13: returns exactly 1 bar).
    const pageToInclusiveMs = Math.min(cursor + windowMs - MINUTE_MS, opts.toMs - MINUTE_MS);
    const ceilingMs = Math.min(cursor + windowMs, opts.toMs);
    if (!(ceilingMs > cursor)) {
      throw new CapitalApiError("internal", 500, "Pagination invariant broken: empty page window.");
    }
    const body = await fetchPageWithRetry(opts.fetcher, opts.symbol, cursor, pageToInclusiveMs, maxRetries, backoffMs, log);
    result.requests += 1;
    result.batches += 1;

    const rawRows = Array.isArray(body.prices) ? body.prices.length : 0;
    result.received += rawRows;
    const page = validateCapitalHistoricalPage(body, opts.decimals, { fromMs: cursor, toMs: ceilingMs });
    for (const i of page.invalid) {
      result.invalidReasons[i.reason] = (result.invalidReasons[i.reason] ?? 0) + 1;
    }

    if (page.invalid.length > 0 && onInvalid === "abort") {
      for (const i of page.invalid.slice(0, 10)) {
        log(
          `[capital-backfill] ${opts.symbol}: REJECTED ${i.reason} stamp=${i.stampMs === null ? "(unparseable)" : new Date(i.stampMs).toISOString()}`,
        );
      }
      // Nothing from this page was written; prior pages stay persisted (the
      // run is resumable) and the failure is loud, never silent.
      throw new CapitalValidationError(opts.symbol, { fromMs: cursor, toMs: ceilingMs }, page.invalid);
    }
    result.invalid += page.invalid.length;
    result.inBatchDuplicates += page.inBatchDuplicates;

    if (page.rows.length > 0 && opts.store) {
      const write = await opts.store.insertBackfilledBatch(
        opts.symbol,
        CANONICAL_TIMEFRAME,
        page.rows,
        CAPITAL_BACKFILL_SOURCE,
      );
      result.inserted += write.inserted;
      result.dbSkipped += write.skipped;
      const newest = page.rows[page.rows.length - 1].time;
      if (result.newestBucketSec === null || newest > result.newestBucketSec) result.newestBucketSec = newest;
    }

    const doneBuckets = Math.min(totalBuckets, (ceilingMs - opts.fromMs) / MINUTE_MS);
    const pct = totalBuckets > 0 ? ((doneBuckets / totalBuckets) * 100).toFixed(1) : "100.0";
    const remainingBuckets = Math.max(0, totalBuckets - doneBuckets);
    log(
      `[capital-backfill] ${opts.symbol}: page ${result.batches} window=${fmtBucket(cursor / 1000)}…${fmtBucket(pageToInclusiveMs / 1000)} (ceiling ${fmtBucket(ceilingMs / 1000)} exclusive) ` +
        `received=${rawRows} valid=${page.rows.length} inserted=${result.inserted} skipped=${result.dbSkipped} ` +
        `dupes=${result.inBatchDuplicates} invalid=${page.invalid.length} progress=${pct}% remaining≈${remainingBuckets} min / ${Math.ceil(remainingBuckets / (windowMs / MINUTE_MS))} req`,
    );

    cursor = ceilingMs;
    if (cursor < opts.toMs && pauseMs > 0) await sleep(pauseMs);
  }

  log(
    `[capital-backfill] ${opts.symbol}: DONE requests=${result.requests} received=${result.received} ` +
      `inserted=${result.inserted} skipped-present=${result.dbSkipped} inBatchDupes=${result.inBatchDuplicates} ` +
      `invalid=${result.invalid} dryRun=${result.dryRun}` +
      (Object.keys(result.invalidReasons).length
        ? ` reasons=${summarizeReasons(Object.entries(result.invalidReasons).flatMap(([r, n]) => Array.from({ length: n }, () => ({ reason: r, stampMs: null }))))}`
        : ""),
  );
  return result;
}
