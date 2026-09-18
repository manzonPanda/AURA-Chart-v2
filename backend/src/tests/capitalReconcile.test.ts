/**
 * Automatic Capital.com reconciliation tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *   (or: npm --prefix backend run test -- capitalReconcile)
 *
 * Covers the 2026-09-15 reliability contract for the DISTINCT-OHLC-stream hole
 * repair. NOTHING here talks to Capital or touches a production table: the
 * engine is driven by a fake fetcher + fake store, and the PostgreSQL
 * integration block uses a per-run TEMP SCHEMA (structurally unreachable from
 * public.ohlc_candles — identical isolation to candleStore.pg.test.ts /
 * capitalBackfill.test.ts).
 *
 * Pinned guarantees:
 *   1. settings clamping — the safety lag can never drop below 1 minute.
 *   2. scan-window geometry — lookback width, forming bucket NEVER scanned, the
 *      newest `safetyLagMinutes` completed buckets NEVER scanned.
 *   3. calendar-aware detection — buckets in the (corrected) evening window are
 *      expected; the 22:00–23:00 Europe/London break and weekends never are.
 *   4. tight REST range — only the missing span is requested, so closed-market
 *      periods inside the window are never fetched.
 *   5. zero REST traffic when nothing is missing (the common case).
 *   6. INSERT-only writes: existing rows are never requested, never
 *      overwritten; the conflict path is counted as skippedExisting.
 *   7. failure containment: REST/DB failures are reported, never thrown.
 *   8. observability: one concise summary line per target per run.
 *   9. lifecycle: start/stop/overlap guards, additive status snapshot.
 *  10. PostgreSQL integration (skipped without a DB): a pre-existing completed
 *      live row survives byte-identical; only the genuinely missing bucket is
 *      inserted as capital/backfilled; nothing is ever deleted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";

import {
  CapitalReconciler,
  RECONCILE_DEFAULTS,
  RECONCILE_BUCKET_SEC,
  findMissingBuckets,
  missingRequestRange,
  reconcileScanWindow,
  reconcileTargets,
  resolveReconcileSettings,
  summarizeReconcile,
  supportsReconciliation,
  type ReconcileStore,
} from "../backfill/reconcile.js";
import { CAPITAL_BACKFILL_WINDOW_MS, MINUTE_MS } from "../backfill/capitalDownloader.js";
import type { CapitalBackfillRow } from "../backfill/capitalDownloader.js";
import type { CandleSource } from "../db/candleStore.js";
import { PgCandleStore } from "../db/candleStore.js";
import { IG_GERMANY_40, IG_SPOT_GOLD, isBucketExpected } from "../market/calendar.js";
import type { CapitalHistoricalPricesResponse, CapitalPrice } from "../capital/types.js";
import type { CapitalPricesFetcher } from "../capital/historical.js";

// ── Fixed clock: Monday 2026-09-14 22:20:30 UTC (BST, evening session) ──────
// London 23:20:30 → the post-break Globex window (London 23:00–24:00), i.e. the
// exact hour the calendar fix restored. Chosen so an examined range can also
// straddle the 21:00–21:59 UTC (= 22:00–22:59 BST) daily break.
const NOW_MS = Date.UTC(2026, 8, 14, 22, 20, 30);
const SEC = (h: number, m: number, day = 14): number => Math.floor(Date.UTC(2026, 8, day, h, m, 0) / 1000);
const mon = (h: number, m: number): number => SEC(h, m);
const monMs = (h: number, m: number): number => mon(h, m) * 1000;

const GOLD = { symbol: "GOLD", decimals: 2, calendar: IG_SPOT_GOLD };
const noLog = (): void => undefined;

const settings = (lookbackMinutes: number, safetyLagMinutes = 3) =>
  ({ intervalMinutes: 15, lookbackMinutes, safetyLagMinutes });
// ─ Fake Capital REST fetcher (records windows; serves injected bars) ───────

class FakeFetcher implements CapitalPricesFetcher {
  readonly records: Array<{ symbol: string; fromMs: number; toMs: number; max: number }> = [];
  /** Bars keyed by minute-aligned stamp (ms). */
  readonly bars = new Map<number, { open: number; high: number; low: number; close: number }>();
  /** Error injected on the Nth call (1-based); later calls succeed. */
  failOnCall: number | null = null;
  failure: Error = new Error("injected Capital REST failure");
  calls = 0;

  addBar(stampMs: number, o = 2000, h = o, l = o, c = o): this {
    this.bars.set(stampMs, { open: o, high: h, low: l, close: c });
    return this;
  }

  async getPrices(
    symbol: string,
    fromMs: number,
    toMs: number,
    max: number,
  ): Promise<CapitalHistoricalPricesResponse> {
    this.calls += 1;
    this.records.push({ symbol, fromMs, toMs, max });
    if (this.failOnCall !== null && this.calls === this.failOnCall) throw this.failure;
    const prices: CapitalPrice[] = [];
    for (const [stamp, ohlc] of [...this.bars.entries()].sort((a, b) => a[0] - b[0])) {
      // INCLUSIVE `to` — live-verified Capital semantics.
      if (stamp >= fromMs && stamp <= toMs) {
        prices.push({
          snapshotTimeUTC: new Date(stamp).toISOString().replace(".000Z", ""),
          openPrice: { openBid: ohlc.open, openAsk: ohlc.open },
          highPrice: { highBid: ohlc.high, highAsk: ohlc.high },
          lowPrice: { lowBid: ohlc.low, lowAsk: ohlc.low },
          closePrice: { closeBid: ohlc.close, closeAsk: ohlc.close },
          lastTradedVolume: 4,
        });
      }
    }
    return { prices };
  }
}

// ── Fake store (records the DB read window + every offered batch) ───────────

class FakeStore implements ReconcileStore {
  /** Buckets the "database" already holds (epoch seconds). */
  present = new Set<number>();
  /** Live-race simulation: these buckets refuse the insert (row appeared). */
  protectedBuckets = new Set<number>();
  readonly loadRanges: Array<{ instrument: string; timeframe: string; fromSec: number; toSec: number }> = [];
  readonly batches: Array<{ instrument: string; timeframe: string; rows: CapitalBackfillRow[]; source: CandleSource }> = [];
  /** Optional gate so a run can be held in flight (overlap test). */
  gate: Promise<void> | null = null;

  async loadCandlesRange(instrument: string, timeframe: string, fromSec: number, toSec: number) {
    this.loadRanges.push({ instrument, timeframe, fromSec, toSec });
    if (this.gate) await this.gate;
    return [...this.present]
      .filter((t) => t >= fromSec && t <= toSec)
      .sort((a, b) => a - b)
      .map((t) => ({ time: t, status: "completed" }));
  }

  async insertBackfilledBatch(
    instrument: string,
    timeframe: string,
    rows: ReadonlyArray<CapitalBackfillRow>,
    source: CandleSource,
  ) {
    this.batches.push({ instrument, timeframe, rows: [...rows], source });
    let inserted = 0;
    for (const r of rows) {
      if (this.present.has(r.time) || this.protectedBuckets.has(r.time)) continue;
      this.present.add(r.time);
      inserted += 1;
    }
    return { inserted, skipped: rows.length - inserted };
  }

  /** Every bucket ever offered to the write path, in order. */
  offered(): number[] {
    return this.batches.flatMap((b) => b.rows.map((r) => r.time));
  }
}

/** All open buckets of a contiguous minute span (calendar-driven, read-only). */
const openBuckets = (fromSec: number, toSec: number): number[] => {
  const out: number[] = [];
  for (let b = fromSec; b < toSec; b += RECONCILE_BUCKET_SEC) {
    if (isBucketExpected(b, IG_SPOT_GOLD, RECONCILE_BUCKET_SEC)) out.push(b);
  }
  return out;
};

// ── 1. Settings: clamped into the safe envelope ──────────────────────────────

test("1a. resolveReconcileSettings: defaults are 15m interval / 180m lookback / 3m safety lag", () => {
  assert.deepEqual(resolveReconcileSettings(), RECONCILE_DEFAULTS);
  assert.equal(RECONCILE_DEFAULTS.intervalMinutes, 15);
  assert.equal(RECONCILE_DEFAULTS.lookbackMinutes, 180);
  assert.equal(RECONCILE_DEFAULTS.safetyLagMinutes, 3);
});

test("1b. resolveReconcileSettings: the safety lag can never drop below 1 minute", () => {
  assert.equal(resolveReconcileSettings({ safetyLagMinutes: 0 }).safetyLagMinutes, 1);
  assert.equal(resolveReconcileSettings({ safetyLagMinutes: -5 }).safetyLagMinutes, 1);
});

test("1c. resolveReconcileSettings: invalid/garbage values fall back safely", () => {
  assert.equal(resolveReconcileSettings({ safetyLagMinutes: Number.NaN }).safetyLagMinutes, 3);
  assert.equal(resolveReconcileSettings({ intervalMinutes: 0 }).intervalMinutes, 1);
  assert.equal(resolveReconcileSettings({ intervalMinutes: 99_999 }).intervalMinutes, 1440);
  // Ceiling is 10080 minutes (7 days) — raised from 999 so the 7200-minute
  // (5-day) startup recovery can paginate through multiple REST pages.
  assert.equal(resolveReconcileSettings({ lookbackMinutes: 50_000 }).lookbackMinutes, 10080);
  assert.equal(resolveReconcileSettings({ startupLookbackMinutes: 50_000 }).startupLookbackMinutes, 10080);
  assert.equal(resolveReconcileSettings({ safetyLagMinutes: 99_999 }).safetyLagMinutes, 60);
});

// ── 1d. Startup lookback defaults and configurability ─────────────────────

test("1d. startupLookbackMinutes defaults to 7200 (5 days)", () => {
  assert.equal(resolveReconcileSettings({}).startupLookbackMinutes, 7200);
  assert.equal(RECONCILE_DEFAULTS.startupLookbackMinutes, 7200);
});

test("1e. lookbackMinutes stays 180 by default; startupLookbackMinutes stays 7200", () => {
  const s = resolveReconcileSettings({});
  assert.equal(s.lookbackMinutes, 180, "recurring default unchanged");
  assert.equal(s.startupLookbackMinutes, 7200, "startup default is 5 days");
  assert.notEqual(s.lookbackMinutes, s.startupLookbackMinutes, "must be distinct");
});

test("1f. lookbackMinutes=7200 is NOT clamped to 999 (ceiling raised to 10080)", () => {
  // Before the change, 7200 would silently become 999. Now it passes through.
  assert.equal(resolveReconcileSettings({ lookbackMinutes: 7200 }).lookbackMinutes, 7200);
  // 180 still passes through unchanged.
  assert.equal(resolveReconcileSettings({ lookbackMinutes: 180 }).lookbackMinutes, 180);
});

test("1g. startupLookbackMinutes can be configured independently from lookbackMinutes", () => {
  const s = resolveReconcileSettings({ lookbackMinutes: 180, startupLookbackMinutes: 1440 });
  assert.equal(s.lookbackMinutes, 180, "recurring lookback unchanged");
  assert.equal(s.startupLookbackMinutes, 1440, "startup lookback is configurable");
});

// ── 1h. First-run override vs normal run (startup vs recurring) ────────────
// This is the core regression test: the startup override must widen the scan
// window for the FIRST run only, and subsequent runs must use the normal
// 180-minute lookback — never 7200.

test("1h. runOnce with override uses startup lookback (7200m); without override uses normal (180m)", () => {
  // Startup scan window (7200 min wide, via override):
  const startupWindow = reconcileScanWindow(NOW_MS, {
    ...resolveReconcileSettings({}),
    lookbackMinutes: 7200,
  });
  assert.equal(
    (startupWindow.toSec - startupWindow.fromSec) / RECONCILE_BUCKET_SEC,
    7200,
    "startup scan window spans exactly 7200 minutes",
  );

  // Normal recurring scan window (180 min wide):
  const normalWindow = reconcileScanWindow(NOW_MS, settings(180, 3));
  assert.equal(
    (normalWindow.toSec - normalWindow.fromSec) / RECONCILE_BUCKET_SEC,
    180,
    "recurring scan window spans exactly 180 minutes",
  );

  // The startup window extends much further back than the recurring window:
  assert.ok(
    startupWindow.fromSec < normalWindow.fromSec,
    "startup window starts further back than the normal window",
  );
});

test("1i. CapitalReconciler: first runOnce call uses startupLookback, second uses normal lookback", async () => {
  // NOW_MS = Mon 2026-09-14 22:20 UTC (BST).
  //   normal  180-min window ≈ Sep 14 19:17…22:17 UTC
  //   startup 7200-min window ≈ Sep  9 22:17…Sep 14 22:17 UTC
  // Two holes: one inside the narrow window, one ~4.5 days old — only the
  // startup recovery scan can see the older one.
  const recentHole = mon(22, 10);          // Sep 14 22:10 UTC — inside 180 min
  const oldHole = SEC(10, 0, 10) * 1000;   // Thu Sep 10 10:00 UTC — outside 180 min, inside 7200 min
  // Verify assumptions:
  const nw = reconcileScanWindow(NOW_MS, settings(180, 3));
  const sw = reconcileScanWindow(NOW_MS, { ...resolveReconcileSettings({}), lookbackMinutes: 7200 });
  assert.ok(recentHole >= nw.fromSec && recentHole < nw.toSec, "recent hole must be in the 180-min window");
  assert.ok(oldHole < nw.fromSec * 1000, "old hole must be OUTSIDE the 180-min window");
  assert.ok(oldHole >= sw.fromSec * 1000 && oldHole < sw.toSec * 1000, "old hole must be INSIDE the 7200-min window");

  // Both holes sit on MARKET-OPEN minutes — the Gold calendar is consulted, so a
  // weekend / daily-break / holiday stamp could never be used as a hole here:
  assert.equal(isBucketExpected(recentHole, IG_SPOT_GOLD, RECONCILE_BUCKET_SEC), true, "recent hole is a market-open bucket");
  assert.equal(isBucketExpected(oldHole / 1000, IG_SPOT_GOLD, RECONCILE_BUCKET_SEC), true, "old hole is a market-open bucket");

  // Start with all buckets present in BOTH windows, then introduce the two holes:
  const normalBuckets = openBuckets(nw.fromSec, nw.toSec);
  const wideBuckets = openBuckets(sw.fromSec, sw.toSec);
  const store = new FakeStore();
  store.present = new Set([...normalBuckets, ...wideBuckets]);
  store.present.delete(recentHole);     // hole within 180 min
  store.present.delete(oldHole / 1000); // hole outside 180 min but within 7200 min

  const fetcher = new FakeFetcher()
    .addBar(recentHole * 1000, 2000, 2010, 1990, 2005)
    .addBar(oldHole, 2000, 2010, 1990, 2005);

  const reconciler = new CapitalReconciler({
    store,
    fetcher,
    targets: [GOLD],
    settings: { intervalMinutes: 15, lookbackMinutes: 180, safetyLagMinutes: 3, startupLookbackMinutes: 7200 },
    pauseMs: 0,
    logger: noLog,
  });

  // ── First run: startup recovery with the 7200-min override ───────────────
  const firstResults = await reconciler.runOnce(NOW_MS, 7200);
  assert.equal(firstResults.length, 1);
  assert.equal(
    (firstResults[0].toMs - firstResults[0].fromMs) / (RECONCILE_BUCKET_SEC * 1000),
    7200,
    "first run uses a 7200-minute scan window",
  );
  assert.equal(firstResults[0].missingBuckets, 2, "both holes are found in the wide window");
  assert.equal(firstResults[0].inserted, 2, "both holes are inserted as capital/backfilled");
  // The wide range spans ~4.5 days ⇒ the EXISTING downloader tiles it into
  // 999-minute pages. This proves startup recovery needs no downloader change.
  assert.ok(
    fetcher.calls > 1,
    `a 5-day startup range must paginate through multiple REST pages (got ${fetcher.calls})`,
  );
  assert.ok(
    fetcher.records.every((r) => r.toMs - r.fromMs < CAPITAL_BACKFILL_WINDOW_MS),
    "every request stays inside the unchanged 999-minute page window",
  );

  // ── Simulate state after first run: both holes filled ─────────────────────
  store.present.add(recentHole);
  store.present.add(oldHole / 1000);
  fetcher.calls = 0;
  fetcher.records.length = 0;

  // ── Second run: normal recurring without override ─────────────────────────
  const secondResults = await reconciler.runOnce(NOW_MS);
  assert.equal(secondResults.length, 1);
  assert.equal(
    (secondResults[0].toMs - secondResults[0].fromMs) / (RECONCILE_BUCKET_SEC * 1000),
    180,
    "second run uses 180-minute scan window — NOT 7200",
  );
  assert.equal(secondResults[0].missingBuckets, 0, "nothing missing in the narrow window (both holes already filled)");
  assert.equal(fetcher.calls, 0, "no REST traffic when nothing is missing");
});

// ── 1j. start() wiring: startup pass vs scheduled passes ──────────────────
// The regression this guards against: every recurring run accidentally
// inheriting the 5-day startup lookback.

test("1j. start() wires ONLY the immediate pass to startupLookbackMinutes (7200); ticks keep 180", () => {
  const reconciler = new CapitalReconciler({
    store: new FakeStore(),
    fetcher: new FakeFetcher(),
    targets: [GOLD],
    settings: { intervalMinutes: 15, lookbackMinutes: 180, startupLookbackMinutes: 7200 },
    logger: noLog,
  });

  // Record the override passed to each pass — no I/O, no REST, no DB.
  const passes: Array<number | undefined> = [];
  (reconciler as unknown as { runOnce: (n?: number, o?: number) => Promise<unknown> }).runOnce =
    async (_nowMs?: number, override?: number): Promise<unknown> => {
      passes.push(override);
      return [];
    };

  // Capture the scheduler registration and neutralise it (nothing is leaked).
  const realSetInterval = globalThis.setInterval;
  const scheduled: { ms: number; tick: (() => void) | null } = { ms: -1, tick: null };
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    scheduled.tick = fn;
    scheduled.ms = ms;
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof globalThis.setInterval;

  const quiet = console.log;
  console.log = () => {};
  try {
    reconciler.start();
    // The IMMEDIATE startup pass carries the extended 5-day lookback.
    assert.deepEqual(passes, [7200], "the immediate startup pass uses startupLookbackMinutes (7200)");
    assert.equal(scheduled.ms, 15 * 60_000, "the recurring interval is unchanged (15 minutes)");
    assert.ok(scheduled.tick !== null, "a recurring pass was registered");
    // ONE scheduled tick — it must NOT carry the startup override.
    scheduled.tick!();
    assert.equal(passes.length, 2, "a scheduled tick triggered exactly one pass");
    assert.equal(passes[1], undefined, "scheduled passes keep the 180-minute lookback — never 7200");
    // The status surface reports both depths distinctly.
    const status = reconciler.statusSnapshot();
    assert.equal(status.lookbackMinutes, 180, "status.lookbackMinutes is the recurring depth");
    assert.equal(status.startupLookbackMinutes, 7200, "status.startupLookbackMinutes is the startup depth");
  } finally {
    console.log = quiet;
    globalThis.setInterval = realSetInterval;
  }
});



test("2a. reconcileScanWindow: width = lookback, end = forming − safetyLag", () => {
  const w = reconcileScanWindow(NOW_MS, settings(25, 3));
  assert.equal(w.formingStartSec, mon(22, 20), "forming bucket = the bucket containing now");
  assert.equal(w.toSec, mon(22, 17), "3 completed buckets are deliberately left alone");
  assert.equal(w.fromSec, mon(21, 52), "25-minute lookback window");
  assert.equal((w.toSec - w.fromSec) / RECONCILE_BUCKET_SEC, 25);
  assert.ok(w.toSec <= w.formingStartSec - 3 * RECONCILE_BUCKET_SEC, "never the forming bucket");
});

test("2b. reconcileScanWindow: the newest completed bucket is always excluded (lag ≥ 1)", () => {
  const w = reconcileScanWindow(NOW_MS, settings(60, 1));
  const newestCompleted = w.formingStartSec - RECONCILE_BUCKET_SEC;
  assert.equal(w.toSec, newestCompleted, "lag=1 excludes exactly the just-closed bucket");
  assert.ok(w.toSec < newestCompleted + 1);
});

// ── 3. Calendar-aware detection (the corrected evening window) ───────────────

test("3a. findMissingBuckets: evening-window buckets are expected; the break is not", () => {
  // Window 21:52…22:16 UTC on Monday 2026-09-14 (BST): the first 8 minutes are
  // the daily break (London 22:52–23:00), the last 17 are the restored evening
  // session (London 23:00–24:00). Before the calendar fix, expectedBuckets was
  // 0 here and NO hole could ever be detected in the evening session.
  const w = reconcileScanWindow(NOW_MS, settings(25, 3));
  const open = openBuckets(w.fromSec, w.toSec);
  assert.equal(open.length, 17);
  const rows = open.map((t) => ({ time: t }));
  const scan = findMissingBuckets(rows, IG_SPOT_GOLD, w);
  assert.equal(scan.expectedBuckets, 17, "exactly the OPEN buckets are examined");
  assert.deepEqual(scan.missing, [], "a filled evening session reports nothing");
  assert.ok(!open.includes(mon(21, 59)), "the break bucket is never expected");
  assert.ok(open.includes(mon(22, 0)), "the first post-break bucket IS expected");
});

test("3b. findMissingBuckets: a hole inside the evening session is detected", () => {
  const w = reconcileScanWindow(NOW_MS, settings(25, 3));
  const rows = openBuckets(w.fromSec, w.toSec)
    .filter((t) => t !== mon(22, 4))
    .map((t) => ({ time: t }));
  const scan = findMissingBuckets(rows, IG_SPOT_GOLD, w);
  assert.equal(scan.expectedBuckets, 17);
  assert.deepEqual(scan.missing, [mon(22, 4)], "the genuine hole is the ONLY missing bucket");
});

test("3c. findMissingBuckets: a fully closed window expects nothing (no false gaps)", () => {
  const satMs = Date.UTC(2026, 8, 12, 12, 0, 0); // Saturday — market closed
  const w = reconcileScanWindow(satMs, settings(60, 3));
  const scan = findMissingBuckets([], IG_SPOT_GOLD, w);
  assert.equal(scan.expectedBuckets, 0);
  assert.deepEqual(scan.missing, []);
});

test("3d. a 7200-minute (5-day) startup window still respects the Gold calendar exactly", () => {
  // The SAME calendar the recurring scan uses, over the extended startup depth:
  // Wed 2026-09-09 22:17 UTC → Mon 2026-09-14 22:17 UTC, i.e. it contains a
  // full weekend (Sat 12th + Sun 13th) and 5 daily 21:00–21:59 UTC breaks.
  const w = reconcileScanWindow(NOW_MS, { ...resolveReconcileSettings({}), lookbackMinutes: 7200 });
  assert.equal((w.toSec - w.fromSec) / RECONCILE_BUCKET_SEC, 7200, "startup window is 5 days wide");

  const open = openBuckets(w.fromSec, w.toSec);
  assert.ok(open.length > 0, "a 5-day window contains market-open buckets");
  assert.ok(open.length < 7200, "closed periods are excluded — NOT every minute is expected");
  const openSet = new Set(open);

  // The Saturday UTC closure is entirely inside the London Saturday closure.
  const SAT_OPEN = Math.floor(Date.UTC(2026, 8, 12, 0, 0) / 1000); // Sat 00:00 UTC
  const SAT_CLOSE = Math.floor(Date.UTC(2026, 8, 13, 0, 0) / 1000); // Sun 00:00 UTC
  assert.ok(
    open.every((t) => !(t >= SAT_OPEN && t < SAT_CLOSE)),
    "no bucket in the Saturday closure is ever expected",
  );

  // Spot-check the recurring exclusions at 5-day scale (UTC in BST = London − 1h):
  const at = (y: number, m: number, d: number, h: number, mi: number): number =>
    Math.floor(Date.UTC(y, m, d, h, mi, 0) / 1000);
  assert.ok(!openSet.has(at(2026, 8, 12, 12, 0)), "Saturday midday is closed");
  assert.ok(!openSet.has(at(2026, 8, 13, 5, 0)), "Sunday morning is closed (weekend)");
  assert.ok(!openSet.has(at(2026, 8, 13, 21, 30)), "Sunday 22:30 London is inside the weekend closure");
  assert.ok(!openSet.has(at(2026, 8, 14, 21, 30)), "Monday 22:30 London is the daily break (21:00-21:59 UTC)");
  assert.ok(!openSet.has(at(2026, 8, 11, 21, 30)), "Friday 22:30 London is the Friday-evening week close");
  assert.ok(openSet.has(at(2026, 8, 13, 22, 30)), "Sunday 23:30 London reopens the week (22:00-22:59 UTC)");
  assert.ok(openSet.has(at(2026, 8, 10, 19, 0)), "mid-week 20:00 London is open");
  assert.ok(openSet.has(at(2026, 8, 14, 19, 0)), "the newest full day is open");

  // A 5-day window that is fully populated expects zero gaps (no false repair,
  // hence no wasted Capital REST traffic after a clean recovery)…
  const filled = findMissingBuckets(open.map((t) => ({ time: t })), IG_SPOT_GOLD, w);
  assert.equal(filled.expectedBuckets, open.length);
  assert.deepEqual(filled.missing, []);

  // …and one deleted bucket anywhere in those 5 days is still detected.
  const hole = open[Math.floor(open.length / 2)]!;
  const holed = findMissingBuckets(
    open.filter((t) => t !== hole).map((t) => ({ time: t })),
    IG_SPOT_GOLD,
    w,
  );
  assert.deepEqual(holed.missing, [hole], "a multi-day-old hole is detected by the startup scan");
});

// ── 4. Tight REST range (closed periods are never fetched) ──────────────────

test("4a. missingRequestRange: tightest window covering every missing bucket", () => {
  assert.equal(missingRequestRange([]), null);
  assert.deepEqual(missingRequestRange([mon(22, 4)]), {
    fromMs: monMs(22, 4),
    toMs: monMs(22, 5),
  });
  assert.deepEqual(missingRequestRange([mon(22, 9), mon(22, 3), mon(22, 6)]), {
    fromMs: monMs(22, 3),
    toMs: monMs(22, 10),
  });
  assert.equal(missingRequestRange([Number.NaN]), null);
});

// ── 5. End-to-end repair through the EXISTING backfill engine ──────────────

test("5a. reconcileTargets: repairs exactly the genuine holes, INSERT-only", async () => {
  const w = reconcileScanWindow(NOW_MS, settings(15, 3)); // 22:02…22:17 UTC
  const store = new FakeStore();
  store.present = new Set(openBuckets(w.fromSec, w.toSec));
  store.present.delete(mon(22, 5));
  store.present.delete(mon(22, 12));

  const fetcher = new FakeFetcher()
    // CLOSED break (21:30 UTC = 22:30 BST) — must never be requested or written.
    .addBar(monMs(21, 30), 1900, 1900, 1900, 1900)
    .addBar(monMs(22, 5), 2000, 2010, 1990, 2005)
    .addBar(monMs(22, 12), 2005, 2020, 2000, 2015)
    // Inside the safety lag (newest completed buckets) — must never be requested.
    .addBar(monMs(22, 18), 2020, 2030, 2010, 2025)
    // The forming bucket — must never be requested.
    .addBar(monMs(22, 20), 2025, 2035, 2015, 2030);

  const lines: string[] = [];
  const results = await reconcileTargets(
    { store, fetcher, targets: [GOLD], settings: settings(15, 3), logger: (l) => lines.push(l) },
    NOW_MS,
  );

  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.expectedBuckets, 15, "15 open buckets in the 15-minute window");
  assert.equal(r.missingBuckets, 2);
  assert.deepEqual(r.missingSample, [mon(22, 5), mon(22, 12)]);
  assert.equal(r.requests, 1);
  assert.equal(r.capitalRows, 2, "Capital REST returned exactly the two missing minutes");
  assert.equal(r.inserted, 2);
  assert.equal(r.skippedExisting, 0);
  assert.equal(r.invalid, 0);
  assert.deepEqual(r.errors, []);
  assert.equal(r.safetyLagMinutes, 3);

  // The DB read window excludes the forming bucket AND the safety lag.
  assert.deepEqual(store.loadRanges[0], {
    instrument: "GOLD",
    timeframe: "MINUTE_1",
    fromSec: w.fromSec,
    toSec: mon(22, 16), // inclusive bound = toSec − 1 minute
  });

  // ONE tight REST request — only the missing span, never the closed break,
  // never the safety-lag or forming buckets.
  assert.equal(fetcher.records.length, 1);
  assert.deepEqual(fetcher.records[0].fromMs, monMs(22, 5));
  // Capital's `to` is INCLUSIVE and equals the page's OWN last stamp, so the
  // downloader converts our EXCLUSIVE ceiling (missingRequestRange = newest
  // missing + 1 minute = 22:13) back to the inclusive 22:12 — verified against
  // capitalDownloader's `pageToInclusiveMs = toMs − MINUTE_MS`.
  assert.deepEqual(fetcher.records[0].toMs, monMs(22, 12));
  assert.equal(
    missingRequestRange([mon(22, 12)])?.toMs,
    monMs(22, 13),
    "reconcile hands the engine an EXCLUSIVE ceiling one minute past the newest hole",
  );
  assert.ok(fetcher.records[0].toMs <= monMs(22, 17) - 60_000, "never into the safety lag");

  // NOTHING else was ever offered to the write path: existing rows are never
  // overwritten and closed-market buckets are never inserted.
  assert.deepEqual(store.offered(), [mon(22, 5), mon(22, 12)]);
  assert.equal(store.batches[0].source, "capital", "provenance stays 'capital'");
  assert.equal(store.batches[0].timeframe, "MINUTE_1");

  // Observability: exactly one concise summary line for this run.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[capital-reconcile\] GOLD: window /);
  assert.match(lines[0], /checked=15 missing=2/);
  assert.match(lines[0], /requests=1 capitalRows=2 inserted=2 skippedExisting=0 invalid=0 errors=0/);
});

test("5b. reconcileTargets: nothing missing → ZERO Capital REST traffic", async () => {
  const w = reconcileScanWindow(NOW_MS, settings(15, 3));
  const store = new FakeStore();
  store.present = new Set(openBuckets(w.fromSec, w.toSec));
  const fetcher = new FakeFetcher().addBar(monMs(22, 5));

  const lines: string[] = [];
  const [r] = await reconcileTargets(
    { store, fetcher, targets: [GOLD], settings: settings(15, 3), logger: (l) => lines.push(l) },
    NOW_MS,
  );

  assert.equal(r.expectedBuckets, 15);
  assert.equal(r.missingBuckets, 0);
  assert.equal(r.inserted, 0);
  assert.equal(fetcher.calls, 0, "the common case costs no REST request and no rate-limit budget");
  assert.equal(store.batches.length, 0, "nothing written when nothing is missing");
  assert.match(lines[0], /missing=0/);
  assert.match(lines[0], /nothing to repair/);
});

test("5c. reconcileTargets: a live-race winner is protected by ON CONFLICT (skipped, never overwritten)", async () => {
  const w = reconcileScanWindow(NOW_MS, settings(15, 3));
  const store = new FakeStore();
  store.present = new Set(openBuckets(w.fromSec, w.toSec));
  store.present.delete(mon(22, 5));
  // The realtime collector closed bucket 22:05 between the scan and the insert.
  store.protectedBuckets = new Set([mon(22, 5)]);
  const fetcher = new FakeFetcher().addBar(monMs(22, 5), 2000, 2010, 1990, 2005);

  const [r] = await reconcileTargets({ store, fetcher, targets: [GOLD], settings: settings(15, 3), logger: noLog }, NOW_MS);

  assert.equal(r.missingBuckets, 1);
  assert.equal(r.inserted, 0, "the conflicting insert landed nothing");
  assert.equal(r.skippedExisting, 1, "the conflict is counted, not hidden");
  assert.deepEqual(store.offered(), [mon(22, 5)], "offered once, refused by the conflict guard");
});

test("5d. reconcileTargets: per-target calendars are respected (DAX is closed at 22:20 UTC)", async () => {
  const w = reconcileScanWindow(NOW_MS, settings(15, 3));
  const store = new FakeStore();
  store.present = new Set(openBuckets(w.fromSec, w.toSec));
  const fetcher = new FakeFetcher();

  const results = await reconcileTargets(
    {
      store,
      fetcher,
      targets: [GOLD, { symbol: "DAX", decimals: 1, calendar: IG_GERMANY_40 }],
      settings: settings(15, 3),
      logger: noLog,
    },
    NOW_MS,
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].expectedBuckets, 15, "GOLD evening session is open");
  assert.equal(results[1].expectedBuckets, 0, "DAX is closed after its 21:00 UK close — never repaired");
  assert.equal(fetcher.calls, 0, "nothing missing for either target → no REST traffic at all");
});

// ── 6. Production gate + REAL PostgreSQL write path ─────────────────────────
// The gate: reconciliation can ONLY ever run against the PostgreSQL store
// (PgCandleStore owns insertBackfilledBatch). The Supabase shim has no batch
// insert, so it can never satisfy ReconcileStore — no second persistence
// implementation can exist.

// Same isolation as candleStore.pg.test.ts / capitalBackfill.test.ts: every
// write goes to a per-run TEMP SCHEMA, and the final assertions prove
// public.ohlc_candles was never touched. Skips cleanly without PostgreSQL.
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
  ? new pg.Pool({ ...base, max: 1, connectionTimeoutMillis: 4000, application_name: "aura-reconcile-test-probe" })
  : null;

let hasPg = false;
try {
  await probe!.query("SELECT 1");
  hasPg = true;
} catch (e) {
  console.log(`# SKIP reconciliation PostgreSQL tests: database not reachable (${(e as Error).message.split("\n")[0]})`);
}
await probe?.end();

/** Unique per run; the test table lives inside it, schema-qualified. */
const SHADOW = `aura_reconcile_test_${randomBytes(4).toString("hex")}`;
const SHADOW_TABLE = `${SHADOW}.ohlc_candles`;
/** Per-run instrument that CANNOT exist in public.ohlc_candles. */
const PG_INSTRUMENT = `RECON_TEST_${randomBytes(4).toString("hex")}`;

test("6a. supportsReconciliation: TRUE only for the PostgreSQL store", async () => {
  const lazyPool = new pg.Pool({
    connectionString: base?.connectionString ?? "postgres://aura@127.0.0.1:5432/aura",
    max: 1,
  });
  const realStore = new PgCandleStore(lazyPool, "public.ohlc_candles");
  assert.equal(supportsReconciliation(realStore), true, "PgCandleStore owns insertBackfilledBatch — the production gate opens");
  assert.equal(supportsReconciliation(null), false);
  assert.equal(supportsReconciliation(undefined), false);
  assert.equal(supportsReconciliation({}), false);
  assert.equal(
    supportsReconciliation({ loadCandlesRange: async () => [] }),
    false,
    "the Supabase shim has no insertBackfilledBatch — it can never qualify",
  );
  assert.equal(
    supportsReconciliation({ insertBackfilledBatch: async () => ({ inserted: 0, skipped: 0 }) }),
    false,
    "the range read is required too",
  );
  await lazyPool.end();
});

// ── 6b. REAL PostgreSQL end-to-end: INSERT-only, live rows byte-identical ───

test(
  "6b. PostgreSQL end-to-end: only genuine holes are inserted; live rows survive byte-identical",
  { skip: !hasPg },
  async () => {
    const pool = new pg.Pool({ ...base!, max: 4, idleTimeoutMillis: 30_000, application_name: "aura-reconcile-test" });
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${SHADOW} CASCADE`);
      await pool.query(`CREATE SCHEMA ${SHADOW}`);
      await pool.query(`CREATE TABLE ${SHADOW_TABLE} (
        id uuid primary key default gen_random_uuid(),
        instrument text not null,
        timeframe text not null,
        bucket_time timestamptz not null,
        open numeric not null, high numeric not null, low numeric not null, close numeric not null,
        tick_count integer,
        source text not null default 'capital',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        status text not null default 'completed',
        constraint ohlc_candles_instrument_timeframe_bucket_time_key unique (instrument, timeframe, bucket_time),
        constraint ohlc_candles_status_check check (status in ('partial','completed','backfilled'))
      )`);

      const w = reconcileScanWindow(NOW_MS, settings(15, 3));
      const open = openBuckets(w.fromSec, w.toSec);
      const holes = [mon(22, 5), mon(22, 9)];
      const preexisting = open.filter((t) => !holes.includes(t));

      // Seed the window exactly as the LIVE pipeline leaves it: `completed` rows
      // with real ticks — NOT backfilled rows. This is the "existing candles are
      // never overwritten" proof.
      for (const t of preexisting) {
        await pool.query(
          `INSERT INTO ${SHADOW_TABLE}
             (instrument, timeframe, bucket_time, open, high, low, close, source, status, tick_count)
           VALUES ($1,'MINUTE_1',$2,2000,2010,1990,2005,'capital','completed',7)`,
          [PG_INSTRUMENT, new Date(t * 1000).toISOString()],
        );
      }

      const snapshot = async (): Promise<Record<string, unknown>[]> =>
        (
          await pool.query(
            `SELECT bucket_time, open, high, low, close, tick_count, status, source, created_at, updated_at
               FROM ${SHADOW_TABLE} WHERE instrument=$1 ORDER BY bucket_time ASC`,
            [PG_INSTRUMENT],
          )
        ).rows as Record<string, unknown>[];
      const key = (row: Record<string, unknown>): string => new Date(row.bucket_time as string).toISOString();
      const publicRows = async (): Promise<number> =>
        (await pool.query(`SELECT count(*)::int AS n FROM public.ohlc_candles WHERE instrument=$1`, [PG_INSTRUMENT]))
          .rows[0].n as number;

      const before = await snapshot();
      assert.equal(before.length, preexisting.length);
      assert.equal(await publicRows(), 0, "the per-run instrument cannot pre-exist in public.ohlc_candles");

      const fetcher = new FakeFetcher();
      for (const t of holes) fetcher.addBar(t * 1000, 2001, 2011, 1999, 2006);

      const [r] = await reconcileTargets(
        {
          store: new PgCandleStore(pool, SHADOW_TABLE),
          fetcher,
          targets: [{ symbol: PG_INSTRUMENT, decimals: 2, calendar: IG_SPOT_GOLD }],
          settings: settings(15, 3),
          logger: noLog,
        },
        NOW_MS,
      );

      assert.equal(r.expectedBuckets, 15);
      assert.equal(r.missingBuckets, 2);
      assert.equal(r.inserted, 2, "exactly the two genuine holes");
      assert.equal(r.skippedExisting, 0);
      assert.deepEqual(r.errors, []);

      const after = await snapshot();
      assert.equal(after.length, open.length, "no duplicates created, nothing deleted");
      const beforeBy = new Map(before.map((row) => [key(row), row]));
      const afterBy = new Map(after.map((row) => [key(row), row]));

      // (a) every pre-existing live row is UNCHANGED — values, status, source,
      //     tick_count AND updated_at (proving no UPDATE ever ran on it).
      for (const [k, b] of beforeBy) {
        const a = afterBy.get(k);
        assert.ok(a, `pre-existing bucket ${k} still present`);
        assert.equal(Number(a.open), Number(b.open), `${k} open`);
        assert.equal(Number(a.high), Number(b.high), `${k} high`);
        assert.equal(Number(a.low), Number(b.low), `${k} low`);
        assert.equal(Number(a.close), Number(b.close), `${k} close`);
        assert.equal(a.status, b.status, `${k} status`);
        assert.equal(a.source, b.source, `${k} source`);
        assert.equal(a.tick_count, b.tick_count, `${k} tick_count`);
        assert.equal(String(a.updated_at), String(b.updated_at), `${k} updated_at — no UPDATE was issued`);
      }

      // (b) the genuine holes arrived as Capital/backfilled rows with no ticks.
      for (const t of holes) {
        const row = afterBy.get(new Date(t * 1000).toISOString());
        assert.ok(row, `hole ${t} repaired`);
        assert.equal(row.status, "backfilled");
        assert.equal(row.source, "capital");
        assert.equal(row.tick_count, null, "no realtime ticks were involved");
        assert.equal(Number(row.open), 2001);
        assert.equal(Number(row.high), 2011);
        assert.equal(Number(row.low), 1999);
        assert.equal(Number(row.close), 2006);
      }

      // (c) nothing was written outside the shadow schema.
      assert.equal(await publicRows(), 0, "reconciliation wrote ONLY to the schema-qualified store");
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${SHADOW} CASCADE`).catch(() => undefined);
      await pool.end();
    }
  },
);