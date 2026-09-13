/**
 * Capital.com historical downloader tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *   (or: npm --prefix backend run test -- capitalBackfill)
 *
 * Covers, per the Phase-8 task contract:
 *   1.  instrument resolution — registry-driven, CAPITAL-provider only, no
 *       hardcoded EPICs; unknown/IG-provider symbols rejected with the list.
 *   2.  historical window semantics — forming minute NEVER requested; the
 *       ceiling is always the last COMPLETED bucket start.
 *   3.  CLI input parsing — date-only/ISO/offset forms, minute alignment.
 *   4.  page validation — the exact rules: minute-aligned stamps, in-window,
 *       numeric OHLC, high ≥ max(open,close), low ≤ min(open,close), high ≥ low,
 *       in-batch duplicate bucket STARTs deduped + counted, malformed rows
 *       reported (never inserted, never guessed).
 *   5.  batching — bounded REST pages (≤1000 bars), sequential, cursor on the
 *       minute grid, exact range coverage, no unbounded accumulation.
 *   6.  dry-run — store NEVER touched (nothing written, nothing opened).
 *   7.  idempotency — re-run over the same range inserts nothing new
 *       (ON CONFLICT DO NOTHING), existing rows byte-identical.
 *   8.  PostgreSQL insertion — REAL PgCandleStore into a per-run TEMP SCHEMA
 *       (structurally unreachable from public.ohlc_candles — the same
 *       isolation as candleStore.pg.test.ts); source='capital',
 *       status='backfilled', timestamptz UTC read-back, unique keys enforced.
 *   9.  abort on invalid — CapitalValidationError, nothing from the failing
 *       page written, prior pages stay persisted (resumable).
 *   10. error/rate-limit handling — bounded retries with backoff, exhaustion
 *       propagates cleanly (no partial silent writes), non-retryable errors
 *       fail fast; the CLI maps 429 kinds to a clear non-zero exit (dead-code
 *       path pinned by the seam contract here).
 *
 * Secrets: no test asserts on, embeds, or prints credentials, CST,
 * X-SECURITY-TOKEN, request headers, DB passwords, or AURA_DB_URL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";

import {
  CAPITAL_BACKFILL_WINDOW_MS,
  CapitalValidationError,
  configuredCapitalInstruments,
  defaultCapitalBackfillRange,
  downloadCapitalHistory,
  historicalWindowEndMs,
  isMinuteAligned,
  lastCompletedBucketStartMs,
  formingBucketStartMs,
  MINUTE_MS,
  parseUtcMinuteInput,
  validateCapitalHistoricalPage,
  type CapitalBackfillRow,
  type CapitalBackfillStore,
} from "../backfill/capitalDownloader.js";
import { CapitalApiError } from "../capital/errors.js";
import type { CapitalHistoricalPricesResponse, CapitalPrice } from "../capital/types.js";
import type { CapitalPricesFetcher } from "../capital/historical.js";
import type { CandleSource } from "../db/candleStore.js";
import { PgCandleStore } from "../db/candleStore.js";
import type { Config } from "../config.js";
import { DAX_INSTRUMENT, SILVER_INSTRUMENT } from "../market/instruments.js";

// ── Fake fetcher (records windows; deterministic bars) ───────────────────────

interface FetchRecord { symbol: string; fromMs: number; toMs: number; max: number; }

class FakeFetcher implements CapitalPricesFetcher {
  readonly records: FetchRecord[] = [];
  /** Malformed/extra raw rows injected verbatim into every page response. */
  readonly rawPrices: CapitalPrice[] = [];
  /** Bars keyed by minute-aligned stamp; each entry = {stamp → OHLC mid values}. */
  readonly bars = new Map<number, { open: number; high: number; low: number; close: number }>();
  /** Failures to inject per call index (then succeed). */
  failures: Array<Error> = [];
  calls = 0;

  addBar(stampMs: number, o: number, h: number, l: number, c: number): void {
    this.bars.set(stampMs, { open: o, high: h, low: l, close: c });
  }

  async getPrices(symbol: string, fromMs: number, toMs: number, max: number): Promise<CapitalHistoricalPricesResponse> {
    this.calls += 1;
    this.records.push({ symbol, fromMs, toMs, max });
    const idx = this.calls - 1;
    if (idx < this.failures.length) throw this.failures[idx];
    const prices: CapitalPrice[] = [...this.rawPrices];
    for (const [stamp, ohlc] of [...this.bars.entries()].sort((a, b) => a[0] - b[0])) {
      // INCLUSIVE `to` — the live-verified Capital semantics: a from/to
      // window returns stamps == `to` too. The downloader relies on this
      // (a single-minute page requests from==to).
      if (stamp >= fromMs && stamp <= toMs) {
        prices.push({
          snapshotTimeUTC: new Date(stamp).toISOString().replace(".000Z", ""),
          openPrice: { openBid: ohlc.open, openAsk: ohlc.open },
          highPrice: { highBid: ohlc.high, highAsk: ohlc.high },
          lowPrice: { lowBid: ohlc.low, lowAsk: ohlc.low },
          closePrice: { closeBid: ohlc.close, closeAsk: ohlc.close },
          lastTradedVolume: 5,
        });
      }
    }
    return { prices };
  }
}

/** In-memory store — records insert calls; dry-run/dup behavior configurable. */
class FakeStore implements CapitalBackfillStore {
  readonly inserted: Array<{ instrument: string; rows: CapitalBackfillRow[]; source: CandleSource }> = [];
  present = new Set<string>();
  failOnRow: number | null = null;

  async insertBackfilledBatch(
    instrument: string,
    _timeframe: string,
    rows: ReadonlyArray<CapitalBackfillRow>,
    source: CandleSource,
  ): Promise<{ inserted: number; skipped: number }> {
    if (this.failOnRow !== null && rows.some((r) => r.time === this.failOnRow)) {
      throw new Error("injected store failure");
    }
    let ins = 0;
    for (const r of rows) {
      const key = `${instrument}|${r.time}`;
      if (this.present.has(key)) continue;
      this.present.add(key);
      ins += 1;
    }
    this.inserted.push({ instrument, rows: [...rows], source });
    return { inserted: ins, skipped: rows.length - ins };
  }
}

const isoBar = (stampMs: number, o: number, h: number, l: number, c: number): CapitalPrice => ({
  snapshotTimeUTC: new Date(stampMs).toISOString().replace(".000Z", ""),
  openPrice: { openBid: o, openAsk: o },
  highPrice: { highBid: h, highAsk: h },
  lowPrice: { lowBid: l, lowAsk: l },
  closePrice: { closeBid: c, closeAsk: c },
  lastTradedVolume: 5,
});

// A Gold session minute: Wednesday 2026-08-26 09:00 UTC (IG_SPOT_GOLD open).
const W = Date.UTC(2026, 7, 26, 9, 0, 0);
const WSEC = W / 1000;
const GOLD_DECIMALS = 2;

const cfg = (): Config =>
  ({
    ig: { defaultEpic: "", goldEpic: "", silverEpic: "" },
    capital: {
      apiKey: "test-key",
      apiPassword: "test-pass",
      identifier: "test-id",
      baseUrl: "https://api-capital.backend-capital.com",
      streamingUrl: "wss://api-streaming-capital.backend-capital.com/connect",
    },
  }) as unknown as Config;

const noLog = (): void => undefined;

// ── 1. Instrument resolution (the ONE registry) ─────────────────────────────

test("1a. configuredCapitalInstruments: exactly the configured CAPITAL-provider instruments", () => {
  const list = configuredCapitalInstruments(cfg());
  assert.deepEqual(list.map((m) => m.epic), ["GOLD"], "Gold resolves to the Capital identity; Silver is still IG-provider and never auto-selected");
  assert.equal(list[0].decimals, GOLD_DECIMALS);
  assert.equal(list[0].provider, "CAPITAL");
});

test("1b. configuredCapitalInstruments: empty without Capital credentials (module inert)", () => {
  const inert = { ig: { defaultEpic: "", goldEpic: "", silverEpic: "" }, capital: { apiKey: "", apiPassword: "", identifier: "", baseUrl: "", streamingUrl: "" } } as unknown as Config;
  assert.deepEqual(configuredCapitalInstruments(inert), []);
});

test("1c. IG-provider instruments (DAX/Silver) are NEVER importable from Capital", () => {
  assert.equal(DAX_INSTRUMENT.provider, "IG");
  assert.equal(SILVER_INSTRUMENT.provider, "IG", "Silver is registered with IG provider — a --symbol=CS.D.CFDSILVER.CMG.IP selection must be refused, never guessed");
});

// ── 2. Historical window semantics (forming minute never touched) ────────────

test("2a. historicalWindowEndMs = the forming bucket's start (exclusive ceiling)", () => {
  const now = W + 23_000; // 09:00:23 → inside bucket [09:00, 09:01)
  assert.equal(formingBucketStartMs(now), W);
  assert.equal(historicalWindowEndMs(now), W);
  assert.equal(lastCompletedBucketStartMs(now), W - MINUTE_MS, "the bucket containing now completes at its start+60s — its start is excluded until rollover");
});

test("2b. minute alignment helpers are exact on the UTC grid", () => {
  assert.ok(isMinuteAligned(W));
  assert.ok(!isMinuteAligned(W + 1234));
  assert.equal(lastCompletedBucketStartMs(W + 61_000), W, "09:01:01 → bucket [09:00,09:01) is complete");
});

test("2c. defaultCapitalBackfillRange: exactly N completed months, ceiling exclusive", () => {
  const now = W + 23_000;
  const r = defaultCapitalBackfillRange(now, 6);
  assert.equal(r.toMs, W, "ceiling = forming bucket start (never the forming minute)");
  const expect = new Date(W);
  expect.setUTCMonth(expect.getUTCMonth() - 6);
  assert.equal(r.fromMs, expect.getTime());
  assert.ok(isMinuteAligned(r.fromMs));
  // 3-month variant
  const r3 = defaultCapitalBackfillRange(now, 3);
  const e3 = new Date(W);
  e3.setUTCMonth(e3.getUTCMonth() - 3);
  assert.equal(r3.fromMs, e3.getTime());
});

// ── 3. CLI input parsing ─────────────────────────────────────────────────────

test("3. parseUtcMinuteInput: date-only/ISO/explicit-offset forms, minute-aligned", () => {
  assert.equal(parseUtcMinuteInput("2026-08-26"), W - 9 * 3_600_000, "date-only means 00:00 UTC");
  assert.equal(parseUtcMinuteInput("2026-08-26T09:00"), W);
  assert.equal(parseUtcMinuteInput("2026-08-26T09:00:00"), W);
  assert.equal(parseUtcMinuteInput("2026-08-26T10:00:00+01:00"), W, "explicit offsets normalize to UTC");
  assert.equal(parseUtcMinuteInput("2026-08-26T09:00:23Z"), W, "sub-minute input aligns DOWN onto the grid");
  assert.ok(Number.isNaN(parseUtcMinuteInput("garbage")));
  assert.ok(Number.isNaN(parseUtcMinuteInput("")));
});

// ── 4. Page validation (the exact contract) ─────────────────────────────────

test("4a. validateCapitalHistoricalPage: bucket-START rows, ascending, OHLC preserved", () => {
  const body: CapitalHistoricalPricesResponse = {
    prices: [
      isoBar(W, 100, 102, 99, 101),
      isoBar(W + MINUTE_MS, 101, 103, 100, 102),
      isoBar(W + 2 * MINUTE_MS, 102, 102.5, 101, 101.75),
    ],
  };
  const page = validateCapitalHistoricalPage(body, GOLD_DECIMALS, { fromMs: W, toMs: W + 3 * MINUTE_MS });
  assert.equal(page.invalid.length, 0);
  assert.equal(page.inBatchDuplicates, 0);
  assert.deepEqual(
    page.rows.map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close })),
    [
      { time: WSEC, open: 100, high: 102, low: 99, close: 101 },
      { time: WSEC + 60, open: 101, high: 103, low: 100, close: 102 },
      { time: WSEC + 120, open: 102, high: 102.5, low: 101, close: 101.75 },
    ],
    "capital mid OHLC of bid==ask is the raw value — the row is the bucket START in epoch seconds",
  );
});

test("4b. out-of-window stamps are rejected (page-boundary guard)", () => {
  const body: CapitalHistoricalPricesResponse = {
    prices: [isoBar(W - MINUTE_MS, 1, 1, 1, 1), isoBar(W + 5 * MINUTE_MS, 1, 1, 1, 1)],
  };
  const page = validateCapitalHistoricalPage(body, GOLD_DECIMALS, { fromMs: W, toMs: W + 3 * MINUTE_MS });
  assert.equal(page.rows.length, 0);
  assert.deepEqual(page.invalid.map((i) => i.reason), ["outside-requested-window", "outside-requested-window"]);
});

// ── batching/engine (5–7, 9) and PG (8) follow in the same file ─────────────
// ── 5. Batching: bounded sequential pages over the exact range ───────────────

test("5a. downloadCapitalHistory: bounded windows cover the range exactly, one batch insert per page", async () => {
  // 250-minute range with a 100-minute window → 3 requests [0,100),[100,200),[200,250).
  const fetcher = new FakeFetcher();
  for (let m = 0; m < 250; m++) fetcher.addBar(W + m * MINUTE_MS, 100 + m, 101 + m, 99 + m, 100.5 + m);
  const store = new FakeStore();
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + 250 * MINUTE_MS,
    fetcher, store, windowMs: 100 * MINUTE_MS, pauseMs: 0, backoffMs: 0, logger: noLog,
  });
  assert.equal(result.requests, 3);
  assert.equal(result.batches, 3);
  // Window boundaries are exact, ascending, minute-aligned, in-range.
  // `to` is the API's INCLUSIVE `to` = ceiling − 1min (each page's own last
  // stamp); the next page begins EXACTLY at that ceiling.
  assert.deepEqual(fetcher.records.map((r) => [r.fromMs, r.toMs]), [
    [W, W + 99 * MINUTE_MS],
    [W + 100 * MINUTE_MS, W + 199 * MINUTE_MS],
    [W + 200 * MINUTE_MS, W + 249 * MINUTE_MS],
  ]);
  assert.ok(fetcher.records.every((r) => r.symbol === "GOLD" && r.max <= 1000));
  assert.ok(
    fetcher.records.every((r) => (r.toMs - r.fromMs) / MINUTE_MS <= 998),
    "every API span stays ≤ 998 minutes (possible stamps ≤ max)",
  );
  assert.equal(result.received, 250);
  assert.equal(result.inserted, 250);
  assert.equal(result.dbSkipped, 0);
  assert.equal(store.inserted.length, 3, "one insert call per page (never one transaction per candle)");
  assert.deepEqual(store.inserted.map((c) => c.source), ["capital", "capital", "capital"]);
  // Rows are bucket-START seconds, ascending, minute-aligned.
  const allRows = store.inserted.flatMap((c) => c.rows);
  assert.deepEqual(allRows.map((r) => r.time), Array.from({ length: 250 }, (_, m) => WSEC + m * 60));
  assert.equal(result.newestBucketSec, WSEC + 249 * 60);
});

test("5b. default window = 999 minutes (Capital rejects wider from/to spans — live-verified)", () => {
  // Live 2026-09-13: a 1000-minute from/to window + max=1000 → 400
  // error.invalid.max.daterange (to is inclusive → 1001 possible stamps);
  // 999-minute windows pass with max=1000 AND max=999. 999 = page size that
  // keeps possible stamps ≤ max.
  assert.equal(CAPITAL_BACKFILL_WINDOW_MS, 999 * MINUTE_MS);
});

test("5c. sub-page range → single request; empty pages tolerated (gaps stay gaps)", async () => {
  const fetcher = new FakeFetcher();
  // Only 2 bars exist inside a 10-minute range (Capital has no candle for the
  // rest) — the downloader inserts exactly 2 rows and manufactures NOTHING.
  fetcher.addBar(W, 100, 101, 99, 100.5);
  fetcher.addBar(W + 5 * MINUTE_MS, 100, 101, 99, 100.5);
  const store = new FakeStore();
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + 10 * MINUTE_MS,
    fetcher, store, pauseMs: 0, backoffMs: 0, logger: noLog,
  });
  assert.equal(result.requests, 1);
  assert.equal(result.received, 2);
  assert.equal(result.inserted, 2);
  assert.equal(result.invalid, 0);
  const times = store.inserted[0].rows.map((r) => r.time);
  assert.deepEqual(times, [WSEC, WSEC + 300]);
});

test("5d. boundary math: API to = ceiling−1min; all stamps inside [from, to) are kept", async () => {
  const fetcher = new FakeFetcher();
  fetcher.addBar(W, 1, 2, 0.5, 1.5);
  fetcher.addBar(W + MINUTE_MS, 1, 2, 0.5, 1.5);
  fetcher.addBar(W + 2 * MINUTE_MS, 1, 2, 0.5, 1.5); // the range's LAST stamp
  const store = new FakeStore();
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + 3 * MINUTE_MS,
    fetcher, store, pauseMs: 0, backoffMs: 0, logger: noLog,
  });
  assert.equal(fetcher.records.length, 1);
  assert.equal(
    fetcher.records[0].toMs,
    W + 2 * MINUTE_MS,
    "the API never requests the exclusive ceiling (overallTo − 1min is the last allowed stamp)",
  );
  assert.equal(result.inserted, 3);
  assert.deepEqual(store.inserted[0].rows.map((r) => r.time), [WSEC, WSEC + 60, WSEC + 120]);
});

// ── 6. Dry-run: the store seam is never touched ──────────────────────────────

test("6. dry-run (store=null): fetches + validates + reports, writes NOTHING", async () => {
  const fetcher = new FakeFetcher();
  for (let m = 0; m < 5; m++) fetcher.addBar(W + m * MINUTE_MS, 100, 101, 99, 100.5);
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + 5 * MINUTE_MS,
    fetcher, store: null, pauseMs: 0, backoffMs: 0, logger: noLog,
  });
  assert.equal(result.dryRun, true, "store=null ⇒ dry-run (the CLI opens NO database connection)");
  assert.equal(result.requests, 1);
  assert.equal(result.received, 5);
  assert.equal(result.inserted, 0, "dry-run inserts nothing");
  assert.equal(result.dbSkipped, 0);
  assert.equal(result.newestBucketSec, null, "dry-run persists nothing — no cursor claim");
  assert.equal(fetcher.calls, 1, "dry-run still exercises the full fetch+validate pipeline");
});

// ── 7. Idempotency: re-run over the same range is an exact no-op ─────────────

test("7. idempotency: interrupted-then-repeated runs never duplicate or overwrite", async () => {
  const fetcher = new FakeFetcher();
  for (let m = 0; m < 120; m++) fetcher.addBar(W + m * MINUTE_MS, 100 + m * 0.01, 101 + m * 0.01, 99 + m * 0.01, 100.5 + m * 0.01);
  const store = new FakeStore();
  const opts = {
    symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + 120 * MINUTE_MS,
    fetcher, store, windowMs: 50 * MINUTE_MS, pauseMs: 0, backoffMs: 0, logger: noLog,
  };
  // Run 1: interrupted halfway (the store throws on the 3rd page).
  store.failOnRow = WSEC + 100 * 60;
  await assert.rejects(() => downloadCapitalHistory(opts), /injected store failure/);
  const afterRun1 = store.present.size;
  assert.equal(afterRun1, 100, "exactly the first two pages persisted before the failure");
  // Run 2 (same range, failure cleared): only the missing buckets are inserted;
  // re-encountered buckets are counted as skipped, never re-written.
  store.failOnRow = null;
  const before = [...store.present].sort();
  const result = await downloadCapitalHistory(opts);
  assert.equal(result.inserted, 20, "only the 20 missing buckets are inserted");
  assert.equal(result.dbSkipped, 100, "the 100 already-present buckets are skipped, never overwritten");
  assert.equal(store.present.size, 120);
  const after = new Set(store.present);
  assert.ok(before.every((k) => after.has(k)), "run 2 changed no pre-existing row identity (every run-1 key survives)");
  // Run 3 (full repeat): every bucket already present → nothing inserted.
  const result3 = await downloadCapitalHistory(opts);
  assert.equal(result3.inserted, 0);
  assert.equal(result3.dbSkipped, 120);
  assert.equal(store.present.size, 120, "exactly one row per (instrument, timeframe, bucket_time)");
});

// ── 9. Abort on invalid: loud failure, failing page written by nothing ──────

test("9a. abort-on-invalid: malformed candle → CapitalValidationError, nothing from the page written", async () => {
  const fetcher = new FakeFetcher();
  // Two good bars + one malformed row (unparseable timestamp) in the page.
  fetcher.addBar(W, 100, 101, 99, 100.5);
  fetcher.addBar(W + MINUTE_MS, 100, 101, 99, 100.5);
  fetcher.rawPrices.push({ snapshotTimeUTC: "not-a-timestamp" });
  const store = new FakeStore();
  await assert.rejects(
    () =>
      downloadCapitalHistory({
        symbol: "GOLD", decimals: GOLD_DECIMALS,
        fromMs: W, toMs: W + 3 * MINUTE_MS,
        fetcher, store, pauseMs: 0, backoffMs: 0, logger: noLog,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CapitalValidationError);
      assert.ok(err.invalid.some((i) => i.reason === "missing-or-unparseable-timestamp"));
      assert.equal(err.symbol, "GOLD");
      assert.ok(err.message.includes("GOLD"), "the failure names the instrument and never embeds secrets");
      return true;
    },
  );
  assert.equal(store.present.size, 0, "the failing page (page 1 here — single page) wrote NOTHING");
});

test("9b. reject-and-continue (--keep-going): invalid rows counted, valid rows still persisted", async () => {
  const fetcher = new FakeFetcher();
  fetcher.addBar(W, 100, 101, 99, 100.5);
  fetcher.rawPrices.push({ snapshotTimeUTC: "garbage-stamp" });
  const store = new FakeStore();
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + 2 * MINUTE_MS,
    fetcher, store, pauseMs: 0, backoffMs: 0, onInvalid: "reject", logger: noLog,
  });
  assert.equal(result.inserted, 1, "the valid candle is still persisted under reject-and-continue");
  assert.equal(result.invalid, 1, "the malformed candle is rejected + counted, never inserted");
  assert.equal(result.invalidReasons["missing-or-unparseable-timestamp"], 1);
  assert.deepEqual(store.inserted[0].rows.map((r) => r.time), [WSEC]);
});

test("9c. OHLC invariant violations are rejected per the required rules", () => {
  const window = { fromMs: W, toMs: W + MINUTE_MS };
  const bad: Array<[number, number, number, number]> = [
    [100, 99, 98, 100], //   high < max(open, close) (close above high)
    [100, 101, 100.5, 100], // low > min(open, close)
    [100, 99.5, 100, 100], //  high < low
  ];
  for (const [o, h, l, c] of bad) {
    const page = validateCapitalHistoricalPage({ prices: [isoBar(W, o, h, l, c)] }, GOLD_DECIMALS, window);
    assert.equal(page.rows.length, 0, `rejected: O${o} H${h} L${l} C${c}`);
    assert.deepEqual(page.invalid.map((i) => i.reason), ["ohlc-invariant-violation"]);
  }
  // Non-numeric OHLC (unusable mid) → rejected as unusable-ohlc.
  const nonNumeric = validateCapitalHistoricalPage(
    { prices: [{ snapshotTimeUTC: new Date(W).toISOString().replace(".000Z", "") }] },
    GOLD_DECIMALS, window,
  );
  assert.equal(nonNumeric.rows.length, 0);
  assert.equal(nonNumeric.invalid[0].reason, "unusable-ohlc");
  // Non-minute-aligned stamp → rejected (unexpected structure, never guessed).
  const offGrid = validateCapitalHistoricalPage(
    { prices: [{ ...isoBar(W + 30_000, 1, 2, 0.5, 1.5), snapshotTimeUTC: new Date(W + 30_000).toISOString().replace(".000Z", "") }] },
    GOLD_DECIMALS, window,
  );
  assert.deepEqual(offGrid.invalid.map((i) => i.reason), ["not-minute-aligned"]);
  // In-batch duplicate bucket START → deduped (first wins) + counted.
  const dupe = validateCapitalHistoricalPage(
    { prices: [isoBar(W, 100, 101, 99, 100.5), isoBar(W, 200, 201, 199, 200.5)] },
    GOLD_DECIMALS, window,
  );
  assert.equal(dupe.rows.length, 1);
  assert.equal(dupe.rows[0].close, 100.5, "first occurrence wins — the later same-bucket row never overwrites it");
  assert.equal(dupe.inBatchDuplicates, 1);
});

// ── 10. Error / rate-limit handling ──────────────────────────────────────────

test("10a. rate_limit (429) is retried with bounded backoff, then succeeds", async () => {
  const fetcher = new FakeFetcher();
  fetcher.addBar(W, 100, 101, 99, 100.5);
  fetcher.failures = [
    new CapitalApiError("rate_limit", 429, "error.too-many.requests"),
    new CapitalApiError("rate_limit", 429, "error.too-many.requests"),
  ];
  const store = new FakeStore();
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + MINUTE_MS,
    fetcher, store, pauseMs: 0, backoffMs: 0, maxRetries: 5, logger: noLog,
  });
  assert.equal(fetcher.calls, 3, "two 429s absorbed by retry");
  assert.equal(result.inserted, 1);
});

test("10b. retry exhaustion (rate_limit) aborts the run CLEANLY (no partial write)", async () => {
  const fetcher = new FakeFetcher();
  fetcher.failures = Array.from({ length: 3 }, () => new CapitalApiError("rate_limit", 429, "error.too-many.requests"));
  const store = new FakeStore();
  await assert.rejects(
    () =>
      downloadCapitalHistory({
        symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + MINUTE_MS,
        fetcher, store, pauseMs: 0, backoffMs: 0, maxRetries: 2, logger: noLog,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CapitalApiError);
      assert.equal((err as CapitalApiError).kind, "rate_limit");
      return true;
    },
  );
  assert.equal(fetcher.calls, 3, "initial attempt + maxRetries=2 — bounded, never a storm");
  assert.equal(store.present.size, 0, "nothing written for the failed page");
});

test("10c. non-retryable errors (auth) fail FAST — no retry storm against the API key", async () => {
  const fetcher = new FakeFetcher();
  fetcher.failures = [new CapitalApiError("auth", 401, "Capital.com authentication failed.")];
  const store = new FakeStore();
  await assert.rejects(
    () =>
      downloadCapitalHistory({
        symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + MINUTE_MS,
        fetcher, store, pauseMs: 0, backoffMs: 0, maxRetries: 5, logger: noLog,
      }),
    (err: unknown) => (err as CapitalApiError).kind === "auth",
  );
  assert.equal(fetcher.calls, 1, "auth failures are never retried (the CLI key must be protected from retry storms)");
  assert.equal(store.present.size, 0);
});

test("10d. network errors are retryable (bounded)", async () => {
  const fetcher = new FakeFetcher();
  fetcher.addBar(W, 100, 101, 99, 100.5);
  fetcher.failures = [new CapitalApiError("network", 502, "Could not reach Capital.com.")];
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + MINUTE_MS,
    fetcher, store: new FakeStore(), pauseMs: 0, backoffMs: 0, maxRetries: 3, logger: noLog,
  });
  assert.equal(fetcher.calls, 2);
  assert.equal(result.inserted, 1);
});

test("10e. range/window misconfiguration dies clearly before any request", async () => {
  const fetcher = new FakeFetcher();
  const store = new FakeStore();
  await assert.rejects(
    () =>
      downloadCapitalHistory({
        symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W + 1234, toMs: W + MINUTE_MS,
        fetcher, store, pauseMs: 0, backoffMs: 0, logger: noLog,
      }),
    /minute-aligned/,
  );
  await assert.rejects(
    () =>
      downloadCapitalHistory({
        symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W,
        fetcher, store, pauseMs: 0, backoffMs: 0, logger: noLog,
      }),
    /Empty range/,
  );
  await assert.rejects(
    () =>
      downloadCapitalHistory({
        symbol: "GOLD", decimals: GOLD_DECIMALS, fromMs: W, toMs: W + MINUTE_MS,
        fetcher, store, windowMs: 90_000, pauseMs: 0, backoffMs: 0, logger: noLog,
      }),
    /whole-minute/,
  );
  assert.equal(fetcher.calls, 0, "misconfiguration never reaches the API");
});

// ── 8. PostgreSQL insertion — REAL PgCandleStore (temp-schema isolation) ──────
// Every PG test writes through the REAL PgCandleStore into a per-run TEMP
// SCHEMA by passing the SCHEMA-QUALIFIED table name — public.ohlc_candles is
// structurally unreachable from these tests (same policy as
// candleStore.pg.test.ts). Skips cleanly when PostgreSQL is unreachable.
function poolConfig(): pg.PoolConfig | null {
  if (process.env.AURA_DB_URL) return { connectionString: process.env.AURA_DB_URL };
  if (process.env.PGPASSWORD) {
    return {
      host: process.env.PGHOST ?? "127.0.0.1",
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? "aura_app",
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE ?? "aura",
    };
  }
  try {
    const url = fs.readFileSync("/etc/aura/postgres.env", "utf8").match(/^AURA_DB_URL=(\S+)/m)?.[1];
    if (url) return { connectionString: url };
  } catch {
    /* not readable as this user — fall through to skip */
  }
  return null;
}

const base = poolConfig();
const probe = base
  ? new pg.Pool({ ...base, max: 1, connectionTimeoutMillis: 4000, application_name: "aura-capital-bf-probe" })
  : null;

let hasPg = false;
try {
  await probe!.query("SELECT 1");
  hasPg = true;
} catch (e) {
  console.log(`# SKIP Capital backfill PG tests: local PostgreSQL not reachable (${(e as Error).message.split("\n")[0]})`);
}
await probe?.end();

/** Unique per run; every test table lives inside it, schema-qualified. */
const SHADOW = `aura_capital_bf_test_${randomBytes(4).toString("hex")}`;
const SHADOW_TABLE = `${SHADOW}.ohlc_candles`;
/** Unique per run so parallel reruns can never collide with each other. */
const PG_INSTRUMENT = `CAPITAL_BF_TEST_${randomBytes(4).toString("hex")}`;

test("8. PgCandleStore: real multi-row historical insert (schema-qualified temp table)", { skip: !hasPg }, async (t) => {
  const pool = new pg.Pool({ ...base!, max: 10, application_name: "aura-capital-bf-pg" });
  const store = new PgCandleStore(pool, SHADOW_TABLE);

  await pool.query(`DROP SCHEMA IF EXISTS ${SHADOW} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SHADOW}`);
  // EXACT production shape of public.ohlc_candles (same columns + constraints).
  await pool.query(`CREATE TABLE ${SHADOW_TABLE} (
    id uuid primary key default gen_random_uuid(),
    instrument text not null,
    timeframe text not null,
    bucket_time timestamptz not null,
    open numeric not null, high numeric not null, low numeric not null, close numeric not null,
    tick_count integer,
    source text not null default 'ig',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    status text not null default 'completed',
    constraint ohlc_candles_instrument_timeframe_bucket_time_key unique (instrument, timeframe, bucket_time),
    constraint ohlc_candles_status_check check (status in ('partial','completed','backfilled'))
  )`);

  t.after(async () => {
    await pool.end();
    const cleanup = new pg.Pool({ ...base!, max: 1, application_name: "aura-capital-bf-cleanup" });
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${SHADOW} CASCADE`);
    } finally {
      await cleanup.end();
    }
  });

  await t.test("multi-row insert persists source='capital', status='backfilled', UTC timestamptz", async () => {
    const rows: CapitalBackfillRow[] = [
      { time: WSEC, open: 4460.1, high: 4461.15, low: 4459, close: 4460.5 },
      { time: WSEC + 60, open: 4460.5, high: 4462, low: 4460, close: 4461.25 },
      { time: WSEC + 120, open: 4461.25, high: 4461.5, low: 4460.75, close: 4461 },
    ];
    const write = await store.insertBackfilledBatch(PG_INSTRUMENT, "MINUTE_1", rows, "capital");
    assert.deepEqual(write, { inserted: 3, skipped: 0 });
    const raw = await pool.query<{
      instrument: string; timeframe: string; source: string; status: string;
      tick_count: number | null; bucket_epoch: string; open: string; high: string; low: string; close: string;
    }>(
      `SELECT instrument, timeframe, source, status, tick_count,
              extract(epoch from bucket_time)::text AS bucket_epoch,
              open::text, high::text, low::text, close::text
         FROM ${SHADOW_TABLE} WHERE instrument=$1 ORDER BY bucket_time ASC`,
      [PG_INSTRUMENT],
    );
    assert.equal(raw.rows.length, 3);
    for (const r of raw.rows) {
      assert.equal(r.instrument, PG_INSTRUMENT);
      assert.equal(r.timeframe, "MINUTE_1", "canonical timeframe only — never MINUTE_3");
      assert.equal(r.source, "capital");
      assert.equal(r.status, "backfilled");
      assert.equal(r.tick_count, null, "historical rows carry no realtime tick diagnostic");
    }
    // timestamptz read-back is the exact UTC instant (epoch seconds preserved).
    assert.deepEqual(raw.rows.map((r) => Number(r.bucket_epoch)), [WSEC, WSEC + 60, WSEC + 120]);
    assert.equal(raw.rows[0].open, "4460.1", "numeric read-back preserves the exact inserted value");
    assert.equal(raw.rows[0].high, "4461.15");
  });

  await t.test("full downloader → real store: buckets minute-aligned, unique key enforced", async () => {
    const fetcher = new FakeFetcher();
    for (let m = 0; m < 7; m++) fetcher.addBar(W + m * MINUTE_MS, 100 + m, 101 + m, 99 + m, 100.5 + m);
    const result = await downloadCapitalHistory({
      symbol: PG_INSTRUMENT, decimals: GOLD_DECIMALS,
      fromMs: W, toMs: W + 7 * MINUTE_MS,
      fetcher, store, windowMs: 4 * MINUTE_MS, pauseMs: 0, backoffMs: 0, logger: noLog,
    });
    // 3 of the 7 buckets already exist from the sub-test above (different OHLC —
    // DO NOTHING keeps the FIRST write); the 4 missing buckets are inserted.
    assert.equal(result.inserted, 4);
    assert.equal(result.dbSkipped, 3, "already-present buckets are skipped, never overwritten");
    const total = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${SHADOW_TABLE} WHERE instrument=$1`,
      [PG_INSTRUMENT],
    );
    assert.equal(total.rows[0].n, "7", "exactly 7 rows for 7 downloaded buckets — no duplicates");
  });

  await t.test("idempotency at the SQL layer: identical re-insert → DO NOTHING (row count + values unchanged)", async () => {
    const rows: CapitalBackfillRow[] = [{ time: WSEC, open: 4460.1, high: 4461.15, low: 4459, close: 4460.5 }];
    const again = await store.insertBackfilledBatch(PG_INSTRUMENT, "MINUTE_1", rows, "capital");
    assert.deepEqual(again, { inserted: 0, skipped: 1 }, "conflict returns nothing — the existing row is NEVER overwritten");
    const raw = await pool.query<{ n: string; open: string; source: string }>(
      `SELECT count(*)::text AS n, open::text AS open, source FROM ${SHADOW_TABLE}
         WHERE instrument=$1 AND timeframe='MINUTE_1' AND extract(epoch from bucket_time)::bigint=$2
         GROUP BY open, source`,
      [PG_INSTRUMENT, WSEC],
    );
    assert.equal(raw.rows.length, 1, "exactly one row per unique key");
    assert.equal(raw.rows[0].open, "4460.1", "original OHLC byte-identical after the re-insert");
    assert.equal(raw.rows[0].source, "capital");
  });

  await t.test("DO NOTHING never overwrites existing live/completed rows", async () => {
    // A pre-existing 'completed' row (as the live stream would have written).
    const liveBucket = WSEC + 600;
    await pool.query(
      `INSERT INTO ${SHADOW_TABLE} (instrument, timeframe, bucket_time, open, high, low, close, status, source, tick_count)
       VALUES ($1,'MINUTE_1',to_timestamp($2),$3,$4,$5,$6,'completed','capital',42)`,
      [PG_INSTRUMENT, liveBucket, 5000.5, 5001, 5000, 5000.75],
    );
    const historical = await store.insertBackfilledBatch(
      PG_INSTRUMENT,
      "MINUTE_1",
      [{ time: liveBucket, open: 1, high: 2, low: 0.5, close: 1.5 }],
      "capital",
    );
    assert.deepEqual(historical, { inserted: 0, skipped: 1 });
    const raw = await pool.query<{ open: string; status: string; tick_count: number | null }>(
      `SELECT open::text AS open, status, tick_count FROM ${SHADOW_TABLE}
         WHERE instrument=$1 AND extract(epoch from bucket_time)::bigint=$2`,
      [PG_INSTRUMENT, liveBucket],
    );
    assert.equal(raw.rows[0].open, "5000.5", "the completed row's OHLC is untouched by the historical import");
    assert.equal(raw.rows[0].status, "completed");
    assert.equal(raw.rows[0].tick_count, 42);
  });

  await t.test("store failure propagates (no silent success on hard PG errors)", async () => {
    const broken = new PgCandleStore(pool, `${SHADOW}.does_not_exist`);
    await assert.rejects(
      () => broken.insertBackfilledBatch(PG_INSTRUMENT, "MINUTE_1", [{ time: WSEC, open: 1, high: 2, low: 0.5, close: 1.5 }], "capital"),
      /does not exist/,
      "a hard store failure must NEVER masquerade as inserted/skipped success",
    );
  });
});

test("8b. cutover safety: public.ohlc_candles holds no test rows (isolation proof)", { skip: !hasPg }, async () => {
  const pool = new pg.Pool({ ...base!, max: 1, application_name: "aura-capital-bf-zero" });
  try {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM public.ohlc_candles WHERE instrument LIKE 'CAPITAL_BF_TEST_%'",
    );
    assert.equal(rows[0].n, "0", "no PG test row ever reached the production table (temp-schema isolation)");
    const shadowLeak = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_namespace WHERE nspname LIKE 'aura_capital_bf_test_%'",
    );
    assert.equal(shadowLeak.rows[0].n, "0", "no test schema leaks after the suite");
  } finally {
    await pool.end();
  }
});

// ── 9. VERIFIED Capital REST semantics (live-empirical 2026-09-13) ───────────

test("9a. page window is 999 minutes — Capital rejects wider from/to spans", () => {
  // Live-verified: a 1000-minute from/to window + max=1000 →
  // 400 {"errorCode":"error.invalid.max.daterange"} (to is INCLUSIVE, so a
  // 1000-minute span can return 1001 stamps); 999-minute windows pass.
  assert.equal(CAPITAL_BACKFILL_WINDOW_MS, 999 * MINUTE_MS);
});

test("9b. 404 on /prices (closed-market empty window) is an EMPTY PAGE — the run continues", async () => {
  // Live-verified: GOLD over a Sunday window → HTTP 404 with NO errorCode,
  // while the same epic serves in-session windows. A six-month import
  // necessarily crosses closed windows, so 404 must never abort the run.
  const fetcher = new FakeFetcher();
  const store = new FakeStore();
  fetcher.failures = [
    new CapitalApiError(
      "invalid_symbol",
      404,
      "Capital.com market not found — check the symbol (e.g. GOLD, not GOLDUS/GOLDAU).",
    ),
  ];
  for (let m = 100; m < 200; m++) fetcher.addBar(W + m * MINUTE_MS, 100 + m, 101 + m, 99 + m, 100.5 + m);
  const result = await downloadCapitalHistory({
    symbol: "GOLD",
    decimals: 2,
    fromMs: W,
    toMs: W + 200 * MINUTE_MS,
    fetcher,
    store,
    windowMs: 100 * MINUTE_MS,
    pauseMs: 0,
    backoffMs: 0,
    logger: noLog,
  });
  assert.equal(result.requests, 2, "both pages were requested");
  assert.equal(result.received, 100, "only page-2 bars count as received (page 1 was an empty 404 page)");
  assert.equal(result.inserted, 100);
  assert.equal(store.inserted.length, 1, "exactly one write (page 2) — the 404 page wrote nothing");
});

test("9c. a genuinely unknown-symbol 404 is still surfaced (not silently swallowed)", async () => {
  // The empty-page rule is scoped to /prices windows; every page 404ing means
  // zero rows everywhere — the run completes with received=0 and inserted=0,
  // which the CLI reports loudly. Nothing is fabricated.
  const fetcher = new FakeFetcher();
  const store = new FakeStore();
  fetcher.failures = [new CapitalApiError("invalid_symbol", 404, "Capital.com market not found")];
  const result = await downloadCapitalHistory({
    symbol: "GOLD",
    decimals: 2,
    fromMs: W,
    toMs: W + 100 * MINUTE_MS,
    fetcher,
    store,
    windowMs: 100 * MINUTE_MS,
    pauseMs: 0,
    backoffMs: 0,
    logger: noLog,
  });
  assert.equal(result.received, 0);
  assert.equal(result.inserted, 0);
  assert.equal(store.inserted.length, 0, "no rows are ever fabricated from empty pages");
});

// ── 10. Pagination/window-boundary regression (the 06:56Z fail-fast) ─────────
//
// Live-verified Capital semantics these tests lock in:
//   - `to` is INCLUSIVE (a from/to window returns stamps == to),
//   - a from/to span whose possible stamps exceed `max` → 400,
//   - a valid epic over an EMPTY (closed-market) window → HTTP 404,
//   - snapshotTimeUTC = candle OPEN time (bucket start).
// The downloader must tile [overallFrom, overallTo) — ceiling EXCLUSIVE — with
// pages of 999 stamps: API to = ceiling − 1min, next cursor = ceiling.

/** Deterministic, invariant-valid OHLC row for a stamp. */
const simBar = (stampMs: number): CapitalPrice => {
  const o = 2000 + ((stampMs / MINUTE_MS) % 1000);
  return isoBar(stampMs, o, o + 2, o - 2, o + 1);
};

function lowerBound(a: readonly number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
function upperBound(a: readonly number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

/** Capital stand-in with the VERIFIED semantics: INCLUSIVE `to`, 404 on empty
 *  windows, O(log n) per request (binary search) so six-month sims stay fast. */
class TilingFetcher implements CapitalPricesFetcher {
  readonly records: FetchRecord[] = [];
  private readonly stamps: number[] = [];
  private readonly byStamp = new Map<number, CapitalPrice>();
  constructor(bars: ReadonlyArray<{ stampMs: number; bar: CapitalPrice }>) {
    for (const { stampMs, bar } of bars) {
      this.byStamp.set(stampMs, bar);
      this.stamps.push(stampMs);
    }
    this.stamps.sort((a, b) => a - b);
  }
  async getPrices(symbol: string, fromMs: number, toMs: number, max: number): Promise<CapitalHistoricalPricesResponse> {
    this.records.push({ symbol, fromMs, toMs, max });
    const lo = lowerBound(this.stamps, fromMs);
    const hi = upperBound(this.stamps, toMs); // INCLUSIVE to → upperBound
    const rows = this.stamps.slice(lo, hi).map((s) => this.byStamp.get(s)!);
    if (rows.length === 0) {
      // Live-verified: a valid epic over an empty window → 404, no errorCode.
      throw new CapitalApiError("invalid_symbol", 404, "Capital.com market not found");
    }
    return { prices: rows };
  }
}

const insertedStampsOf = (store: FakeStore): Set<number> => {
  const out = new Set<number>();
  for (const call of store.inserted) for (const row of call.rows) out.add(row.time * 1000);
  return out;
};

test("10a. pages 1+2: 999-stamp tiling — API to = ceiling−1min, next cursor = ceiling (Tests 1–3)", async () => {
  const T = W;
  const bars: Array<{ stampMs: number; bar: CapitalPrice }> = [];
  for (let m = 0; m < 1998; m++) bars.push({ stampMs: T + m * MINUTE_MS, bar: simBar(T + m * MINUTE_MS) });
  const fetcher = new TilingFetcher(bars);
  const store = new FakeStore();
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: 2, fromMs: T, toMs: T + 1998 * MINUTE_MS,
    fetcher, store, pauseMs: 0, backoffMs: 0, logger: noLog,
  });

  // Test 2: the API request is from=T … to=T+998min (999 buckets possible).
  assert.equal(fetcher.records.length, 2);
  assert.equal(fetcher.records[0].fromMs, T);
  assert.equal(fetcher.records[0].toMs, T + 998 * MINUTE_MS, "API to = ceiling − 1min (inclusive-to semantics)");
  assert.equal(fetcher.records[0].max, 1000);

  // Test 3: the next page BEGINS at T+999min — no overlap with page 1.
  assert.equal(fetcher.records[1].fromMs, T + 999 * MINUTE_MS);
  assert.equal(fetcher.records[1].toMs, T + 1997 * MINUTE_MS);

  // Test 1: exactly 999 buckets per page — 1998 total, no gap, no duplicate.
  const stamps = insertedStampsOf(store);
  assert.equal(stamps.size, 1998);
  assert.equal(result.inserted, 1998);
  assert.equal(result.dbSkipped, 0);
  assert.equal(result.inBatchDuplicates, 0);
  for (let m = 0; m < 1998; m++) assert.ok(stamps.has(T + m * MINUTE_MS), `bucket +${m}min missing`);
  // The page-1 inclusive-boundary stamp (T+998min) IS accepted — the exact
  // regression for the 06:56Z fail-fast (old code rejected its own last stamp).
  assert.ok(stamps.has(T + 998 * MINUTE_MS), "the API inclusive-to stamp must be inserted by its own page");
});

test("10b. empty/404 page advances the cursor by the FULL window (Test 4)", async () => {
  const T = W;
  // Bars exist ONLY in page 2's range → page 1 404s (market closed).
  const bars: Array<{ stampMs: number; bar: CapitalPrice }> = [];
  for (let m = 999; m < 1998; m++) bars.push({ stampMs: T + m * MINUTE_MS, bar: simBar(T + m * MINUTE_MS) });
  const fetcher = new TilingFetcher(bars);
  const store = new FakeStore();
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: 2, fromMs: T, toMs: T + 1998 * MINUTE_MS,
    fetcher, store, pauseMs: 0, backoffMs: 0, logger: noLog,
  });
  assert.equal(fetcher.records.length, 2);
  assert.equal(fetcher.records[0].toMs, T + 998 * MINUTE_MS);
  assert.equal(fetcher.records[1].fromMs, T + 999 * MINUTE_MS, "cursor advanced by the FULL window — no skip, no dup");
  const stamps = insertedStampsOf(store);
  assert.equal(stamps.size, 999);
  assert.equal(result.inserted, 999);
  for (let m = 999; m < 1998; m++) assert.ok(stamps.has(T + m * MINUTE_MS));
  assert.ok(!stamps.has(T), "no closed-window candle was fabricated");
});

test("10c. overall ceiling stays EXCLUSIVE — the forming bucket is never requested nor inserted (Test 5)", async () => {
  const T = W;
  const overallTo = T + 100 * MINUTE_MS;
  const bars: Array<{ stampMs: number; bar: CapitalPrice }> = [];
  for (let m = 0; m < 100; m++) bars.push({ stampMs: T + m * MINUTE_MS, bar: simBar(T + m * MINUTE_MS) });
  const fetcher = new TilingFetcher(bars);
  const store = new FakeStore();
  await downloadCapitalHistory({
    symbol: "GOLD", decimals: 2, fromMs: T, toMs: overallTo,
    fetcher, store, pauseMs: 0, backoffMs: 0, logger: noLog,
  });
  assert.equal(fetcher.records.length, 1);
  assert.equal(fetcher.records[0].toMs, overallTo - MINUTE_MS, "final page requests overallTo − 1min — never the forming bucket");

  // And the validator still rejects a candle stamped exactly AT overallTo.
  const page = validateCapitalHistoricalPage(
    { prices: [isoBar(overallTo, 100, 102, 98, 101)] },
    2,
    { fromMs: T, toMs: overallTo },
  );
  assert.equal(page.rows.length, 0);
  assert.equal(page.invalid.length, 1);
  assert.equal(page.invalid[0].reason, "outside-requested-window");
});

test("10d. final partial page smaller than 999 stamps is handled exactly (Test 6)", async () => {
  const T = W;
  const bars: Array<{ stampMs: number; bar: CapitalPrice }> = [];
  for (let m = 0; m < 1500; m++) bars.push({ stampMs: T + m * MINUTE_MS, bar: simBar(T + m * MINUTE_MS) });
  const fetcher = new TilingFetcher(bars);
  const store = new FakeStore();
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: 2, fromMs: T, toMs: T + 1500 * MINUTE_MS,
    fetcher, store, pauseMs: 0, backoffMs: 0, logger: noLog,
  });
  assert.equal(fetcher.records.length, 2);
  assert.equal(fetcher.records[0].fromMs, T);
  assert.equal(fetcher.records[0].toMs, T + 998 * MINUTE_MS, "full page: 999 stamps");
  assert.equal(fetcher.records[1].fromMs, T + 999 * MINUTE_MS);
  assert.equal(fetcher.records[1].toMs, T + 1499 * MINUTE_MS, "partial page: API to = overallTo − 1min (500 stamps)");
  const stamps = insertedStampsOf(store);
  assert.equal(stamps.size, 1500);
  assert.equal(result.inserted, 1500);
  for (let m = 0; m < 1500; m++) assert.ok(stamps.has(T + m * MINUTE_MS), `bucket +${m}min missing`);
});

test("10e. out-of-request candles are STILL rejected on both sides (Test 7 — validation NOT weakened)", () => {
  const fromMs = W + 100 * MINUTE_MS;
  const toMs = W + 400 * MINUTE_MS; // exclusive ceiling
  const page = validateCapitalHistoricalPage(
    {
      prices: [
        isoBar(fromMs - MINUTE_MS, 100, 102, 98, 101), // BEFORE the request → reject
        isoBar(fromMs, 100, 102, 98, 101),             // first stamp → accept
        isoBar(toMs - MINUTE_MS, 100, 102, 98, 101),   // last stamp → accept
        isoBar(toMs, 100, 102, 98, 101),               // AT the ceiling → reject
      ],
    },
    2,
    { fromMs, toMs },
  );
  assert.equal(page.rows.length, 2);
  assert.deepEqual(page.rows.map((r) => r.time), [fromMs / 1000, (toMs - MINUTE_MS) / 1000]);
  assert.equal(page.invalid.length, 2);
  assert.deepEqual(page.invalid.map((i) => i.reason), ["outside-requested-window", "outside-requested-window"]);
});

test("10f. six-month simulation: exact tiling, no gaps, no dupes, nothing fabricated (Test 8)", async () => {
  // The EXACT range of the failed production run.
  const SIM_FROM = Date.UTC(2026, 2, 13, 12, 20, 0); // 2026-03-13T12:20Z
  const SIM_TO = Date.UTC(2026, 8, 13, 12, 20, 0);   // 2026-09-13T12:20Z (exclusive)
  const totalStamps = (SIM_TO - SIM_FROM) / MINUTE_MS;
  assert.equal(totalStamps, 264960, "matches the real run's bucket count");

  // Mock market: Mon–Fri 00:00–21:59Z open, Sun 23:00–23:59Z open, Sat closed
  // (daily breaks, weekends and DST-shifted sessions all emerge from this).
  const isOpenMinute = (ms: number): boolean => {
    const d = new Date(ms);
    const day = d.getUTCDay();
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (day === 6) return false;
    if (day === 0) return minutes >= 23 * 60;
    return minutes < 22 * 60;
  };

  const bars: Array<{ stampMs: number; bar: CapitalPrice }> = [];
  let openCount = 0;
  for (let m = SIM_FROM; m < SIM_TO; m += MINUTE_MS) {
    if (isOpenMinute(m)) {
      bars.push({ stampMs: m, bar: simBar(m) });
      openCount += 1;
    }
  }

  const fetcher = new TilingFetcher(bars);
  const store = new FakeStore();
  const result = await downloadCapitalHistory({
    symbol: "GOLD", decimals: 2, fromMs: SIM_FROM, toMs: SIM_TO,
    fetcher, store, pauseMs: 0, backoffMs: 0, logger: noLog,
  });

  // (a) EXACT tiling: consecutive pages advance by exactly 999 minutes; every
  //     API span ≤ 998min (possible stamps ≤ max); no window reaches overallTo.
  assert.equal(fetcher.records[0].fromMs, SIM_FROM);
  const expectedPages = Math.ceil(totalStamps / (CAPITAL_BACKFILL_WINDOW_MS / MINUTE_MS));
  assert.ok(fetcher.records.length <= expectedPages, `${fetcher.records.length} pages ≤ ${expectedPages}`);
  for (let i = 0; i < fetcher.records.length; i++) {
    const r = fetcher.records[i];
    assert.equal(r.symbol, "GOLD");
    assert.equal(r.max, 1000);
    const spanMin = (r.toMs - r.fromMs) / MINUTE_MS;
    assert.ok(spanMin >= 0 && spanMin <= 998, `page ${i + 1} span ${spanMin}min violates the verified Capital limit`);
    assert.ok(r.toMs <= SIM_TO - MINUTE_MS, `page ${i + 1} requested the forming bucket`);
    if (i > 0) {
      assert.equal(
        r.fromMs,
        fetcher.records[i - 1].fromMs + CAPITAL_BACKFILL_WINDOW_MS,
        `page ${i + 1} has a tiling gap or overlap`,
      );
    }
  }
  const last = fetcher.records[fetcher.records.length - 1];
  assert.equal(last.toMs, SIM_TO - MINUTE_MS, "the last page ends exactly at overallTo − 1min");

  // (b) coverage: inserted stamps == EXACTLY the open-minute set (no gaps, no
  //     fabricated closed-market candles, nothing outside the range).
  const stamps = insertedStampsOf(store);
  assert.equal(stamps.size, openCount, "no duplicate inserts and no extras");
  const missing: number[] = [];
  for (let m = SIM_FROM; m < SIM_TO; m += MINUTE_MS) {
    if (isOpenMinute(m) && !stamps.has(m)) missing.push(m);
  }
  assert.deepEqual(missing.slice(0, 5), [], `${missing.length} open-market buckets were skipped`);
  for (const s of stamps) assert.ok(s >= SIM_FROM && s < SIM_TO, "inserted stamp outside the overall range");

  // (c) counters agree; the closed windows arrived as 404 empty pages.
  assert.equal(result.inserted, openCount);
  assert.equal(result.received, openCount);
  assert.equal(result.dbSkipped, 0);
  assert.equal(result.invalid, 0);
  assert.equal(result.inBatchDuplicates, 0);
  assert.equal(result.requests, fetcher.records.length);
});
