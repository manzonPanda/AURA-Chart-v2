/**
 * Settled-boundary tests — the DATA GAP pending-vs-confirmed semantics.
 *
 * Covers the 2026-09-16 forensic fix (Design D-lite):
 *   - `advanceSettledBoundary`: ONLY a fully error-free reconciler run advances
 *     the settled frontier; a failed run keeps the previous boundary (its scan
 *     result is not authoritative); a skipped pass is a no-op.
 *   - `resolveSettledToSec` / `filterSettledGaps`: bucket starts strictly below
 *     the boundary are DATA-GAP eligible; at/after it ⇒ pending ⇒ dropped.
 *   - The 22:06-style worst case (repaired ~17m16s after bucket start) never
 *     becomes a DATA GAP: the run that repaired it is the first whose scan end
 *     passed the bucket, so by the time the bucket is eligible it is present.
 *   - The 20:59-style permanent hole (Capital has no candle) becomes eligible
 *     exactly when the first successful scan passes it.
 *
 * Run: npm --prefix backend test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { advanceSettledBoundary, CapitalReconciler, type ReconcileResult, type ReconcileStore, type ReconcileTarget, type SettledScanBoundary } from "../backfill/reconcile.js";
import type { CapitalPricesFetcher } from "../capital/historical.js";
import { deriveGapIntervals } from "../market/gapDetector.js";
import { filterSettledGaps, resolveSettledToSec } from "../routes/candlesDb.js";
import type { MarketCalendar } from "../market/calendar.js";

/** 2024-01-08 is a Monday. `sec` = epoch seconds of January `d`, `h:m` UTC. */
const sec = (d: number, h: number, m: number): number => Math.floor(Date.UTC(2024, 0, d, h, m) / 1000);
const MIN = 60;

/** Mon–Fri 08:00–21:00 UTC dealing window, no holidays (mirrors gapIntervals.test). */
const WEEK_WINDOWS = [{ openMin: 8 * 60, closeMin: 21 * 60 }];
const CAL: MarketCalendar = {
  id: "test-mkt",
  label: "Test market (UTC)",
  timezone: "UTC",
  windowsByWeekday: { 1: WEEK_WINDOWS, 2: WEEK_WINDOWS, 3: WEEK_WINDOWS, 4: WEEK_WINDOWS, 5: WEEK_WINDOWS, 6: [], 7: [] },
  closedDates: [],
};

const result = (over: Partial<ReconcileResult>): ReconcileResult => ({
  symbol: "TEST",
  fromMs: 0,
  toMs: 0,
  safetyLagMinutes: 3,
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
  ...over,
});

const FRESH: SettledScanBoundary = { lastScanFromMs: null, lastScanToMs: null, lastRunSucceeded: false };

// ── advanceSettledBoundary ───────────────────────────────────────────────────

test("settled boundary: an error-free run advances the frontier to the run's scan window", () => {
  const fromMs = sec(8, 7, 20) * 1000;
  const toMs = sec(8, 10, 20) * 1000; // EXCLUSIVE scan end (forming 10:23 − 3m lag)
  const next = advanceSettledBoundary(FRESH, [
    result({ fromMs, toMs, expectedBuckets: 180, missingBuckets: 0, inserted: 0 }),
  ]);
  assert.equal(next.lastRunSucceeded, true);
  assert.equal(next.lastScanFromMs, fromMs);
  assert.equal(next.lastScanToMs, toMs);
});

test("settled boundary: a FAILED run never advances the frontier", () => {
  const good = advanceSettledBoundary(FRESH, [
    result({ fromMs: 1000, toMs: 2000, expectedBuckets: 10, missingBuckets: 0 }),
  ]);
  const afterFailure = advanceSettledBoundary(good, [
    result({ fromMs: 2000, toMs: 3000, expectedBuckets: 10, missingBuckets: 1, errors: ["CapitalError: 503"] }),
  ]);
  // The failed run's window must NOT become the boundary…
  assert.notEqual(afterFailure.lastScanToMs, 3000);
  // …the previous successful boundary stands untouched…
  assert.equal(afterFailure.lastScanToMs, 2000);
  assert.equal(afterFailure.lastScanFromMs, 1000);
  // …and the failure is visible to consumers.
  assert.equal(afterFailure.lastRunSucceeded, false);
});

test("settled boundary: a run with zero targets (skipped pass) is a no-op", () => {
  const prev: SettledScanBoundary = { lastScanFromMs: 1000, lastScanToMs: 2000, lastRunSucceeded: true };
  assert.deepEqual(advanceSettledBoundary(prev, []), prev);
});

// ── resolveSettledToSec / filterSettledGaps ──────────────────────────────────

test("settled boundary: the reconciler frontier wins when available (floored to seconds)", () => {
  const resolved = resolveSettledToSec(() => 1_700_000_000.9, 0);
  assert.equal(resolved, 1_700_000_000);
});

test("settled boundary: without a reconciler frontier the 20-minute grace fallback applies", () => {
  const nowMs = sec(8, 12, 0) * 1000;
  assert.equal(resolveSettledToSec(undefined, nowMs), sec(8, 12, 0) - 20 * 60);
  assert.equal(resolveSettledToSec(() => null, nowMs), sec(8, 12, 0) - 20 * 60);
  assert.equal(resolveSettledToSec(() => Number.NaN, nowMs), sec(8, 12, 0) - 20 * 60);
});

test("settled boundary: strict < semantics — a bucket AT the boundary is still pending", () => {
  const settledToSec = sec(8, 10, 20);
  const gaps = [
    { start: (settledToSec - 60) * 1000, end: settledToSec * 1000 }, // scanned (last bucket below toSec)
    { start: settledToSec * 1000, end: (settledToSec + 60) * 1000 }, // exactly the boundary — NOT scanned
    { start: (settledToSec + 120) * 1000, end: (settledToSec + 180) * 1000 }, // newer — pending
  ];
  const kept = filterSettledGaps(gaps, settledToSec);
  assert.deepEqual(kept, [gaps[0]]);
});

// ── The 22:06-style worst case (production 2026-09-16 evidence) ──────────────

test("worst-case repair (~17m16s): the bucket is never DATA-GAP eligible before it is repaired", () => {
  // Production shape: bucket B=10:06 skipped by DISTINCT delivery. Runs every
  // 15m with scan end = forming − 3m:
  //   run@10:08 → scan end 10:05 → 10:06 NOT scanned (pending)
  //   run@10:23 → scan end 10:20 → 10:06 scanned AND repaired (Capital had it)
  const B = sec(8, 10, 6);
  // 10:01–10:05 present, 10:06 skipped by DISTINCT delivery, 10:07/10:08
  // present — the hole is INTERIOR, which is why the payload reports it while
  // it exists (a trailing hole is shielded by the scan frontier).
  const oneMinGaps = deriveGapIntervals(
    [0, 1, 2, 3, 4, 5, 7, 8].map((i) => B + (i - 6) * MIN),
    CAL,
    60,
    { toSec: sec(8, 10, 20) },
  ).map((g) => ({ start: g.startMs, end: g.endMs }));
  assert.equal(oneMinGaps.length, 1);
  assert.equal(oneMinGaps[0]!.start, B * 1000);

  // Stage 1 — before the repairing run: the frontier is the 10:08 run's scan
  // end (10:05). The bucket is at/after the boundary ⇒ PENDING ⇒ dropped.
  const boundaryAfterRun1 = advanceSettledBoundary(FRESH, [
    result({ fromMs: sec(8, 7, 5) * 1000, toMs: sec(8, 10, 5) * 1000, expectedBuckets: 180 }),
  ]);
  assert.deepEqual(filterSettledGaps(oneMinGaps, boundaryAfterRun1.lastScanToMs! / 1000), []);

  // Stage 2 — the 10:23 run repairs the bucket (inserted=1) and advances the
  // frontier to 10:20. The bucket is now eligible — but it EXISTS, so the
  // candle-presence rule (Rule A) removes it from the chart regardless.
  const boundaryAfterRun2 = advanceSettledBoundary(boundaryAfterRun1, [
    result({
      fromMs: sec(8, 7, 20) * 1000,
      toMs: sec(8, 10, 20) * 1000,
      expectedBuckets: 180,
      missingBuckets: 1,
      capitalRows: 1,
      inserted: 1,
    }),
  ]);
  assert.equal(boundaryAfterRun2.lastRunSucceeded, true);
  assert.equal(boundaryAfterRun2.lastScanToMs! / 1000, sec(8, 10, 20));
  // Repaired ⇒ the next derive over the repaired times yields NO interval at all.
  const repairedTimes = [0, 1, 2, 3, 4, 5, 6].map((i) => B + (i - 6) * MIN);
  assert.deepEqual(deriveGapIntervals(repairedTimes, CAL, 60, { toSec: sec(8, 10, 20) }), []);
});

// ── The 20:59-style permanent hole (Capital has no candle) ───────────────────

test("permanent hole (Capital missing): eligible exactly when the first successful scan passes it", () => {
  // Production shape: Friday 20:59Z skipped; every reconciler run retries it
  // (capitalRows=0) until lookback expiry — genuinely missing forever.
  const B = sec(8, 20, 59);
  const gaps = deriveGapIntervals(
    [B - 60, B + 60 * 2], // 20:58 present, 20:59 missing, 21:00+ closed (window ends 21:00)
    CAL,
    60,
    { toSec: sec(8, 21, 5) },
  ).map((g) => ({ start: g.startMs, end: g.endMs }));
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.start, B * 1000);

  // The 21:08 run scans to 21:05 — past the hole — and does NOT repair it.
  const boundary = advanceSettledBoundary(FRESH, [
    result({
      fromMs: sec(8, 18, 5) * 1000,
      toMs: sec(8, 21, 5) * 1000,
      expectedBuckets: 175,
      missingBuckets: 3,
      capitalRows: 2,
      inserted: 2,
    }),
  ]);
  // Bucket 20:59 < scan end 21:05 ⇒ eligible ⇒ stays a DATA GAP candidate.
  const kept = filterSettledGaps(gaps, boundary.lastScanToMs! / 1000);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.start, B * 1000);

  // Before that run (frontier 20:05), the hole was pending — suppressed.
  const earlyBoundary = advanceSettledBoundary(FRESH, [
    result({ fromMs: sec(8, 17, 5) * 1000, toMs: sec(8, 20, 5) * 1000, expectedBuckets: 170 }),
  ]);
  assert.deepEqual(filterSettledGaps(gaps, earlyBoundary.lastScanToMs! / 1000), []);
});
// ── 3M: derived-on-read bucket omitted by one pending 1M constituent ─────────
//
// MINUTE_3 is derived from MINUTE_1 by `aggregateCompleteToMinutes()`, which
// requires ALL THREE constituents. One 1M row pending reconciliation therefore
// removes the whole 3M candle from the payload even though the live 3M candle
// closed and 2/3 constituents persisted (production: 1M 02:38 pending ⇒ 3M
// 02:36 omitted, reported as a 3-bar DATA GAP).

/** Mon 2024-01-08 09:00 UTC is 3-minute aligned; 09:33/09:36/09:39 too. */
const macro3m = (h: number, m: number): number => sec(8, h, m);

test("3M pending: a macro bucket whose 1M constituent is pending is never a DATA GAP", () => {
  // History carries 09:33 and 09:39 — the 09:36 macro bucket is absent because
  // its 09:38 constituent has not been reconciled yet.
  const times = [macro3m(9, 33), macro3m(9, 39)];
  const derived = deriveGapIntervals(times, CAL, 180, { toSec: macro3m(9, 45) }).map((g) => ({
    start: g.startMs,
    end: g.endMs,
  }));
  assert.equal(derived.length, 1);
  assert.equal(derived[0]!.start, macro3m(9, 36) * 1000); // 3-bar-wide interval

  // The newest successful run scanned only to 09:35 ⇒ the macro bucket is
  // PENDING ⇒ suppressed (no DATA GAP), even though it is genuinely absent
  // from the derived payload.
  const pending = advanceSettledBoundary(FRESH, [
    result({ fromMs: sec(8, 6, 35) * 1000, toMs: macro3m(9, 35) * 1000, expectedBuckets: 180 }),
  ]);
  assert.deepEqual(filterSettledGaps(derived, pending.lastScanToMs! / 1000), []);
});

test("3M confirmed: the same macro bucket becomes a real DATA GAP once the constituent is genuinely missing", () => {
  const times = [macro3m(9, 33), macro3m(9, 39)];
  const derived = deriveGapIntervals(times, CAL, 180, { toSec: macro3m(9, 45) }).map((g) => ({
    start: g.startMs,
    end: g.endMs,
  }));

  // The run scanned to 09:45, past the macro bucket, and Capital returned no
  // 09:38 ⇒ genuinely missing ⇒ the derived bucket stays absent AND is now
  // DATA-GAP eligible.
  const confirmed = advanceSettledBoundary(FRESH, [
    result({
      fromMs: sec(8, 6, 45) * 1000,
      toMs: macro3m(9, 45) * 1000,
      expectedBuckets: 180,
      missingBuckets: 1,
      capitalRows: 0,
      inserted: 0,
    }),
  ]);
  const kept = filterSettledGaps(derived, confirmed.lastScanToMs! / 1000);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.start, macro3m(9, 36) * 1000);
});

test("3M repaired: once all three 1M constituents exist the derived bucket is absent from the gap list (Rule A)", () => {
  // The 09:38 constituent was reconciled ⇒ the 3M derivation now yields 09:36,
  // so no interval is produced for it at all — nothing to shade.
  const times = [macro3m(9, 33), macro3m(9, 36), macro3m(9, 39)];
  assert.deepEqual(deriveGapIntervals(times, CAL, 180, { toSec: macro3m(9, 45) }), []);
});

test("1M and 3M stay independent: the 1M view still reports only the single real minute", () => {
  // Raw MINUTE_1 truth for the same incident: 09:38 is the one missing bucket.
  const oneMinTimes = [macro3m(9, 37), macro3m(9, 39)];
  const oneMin = deriveGapIntervals(oneMinTimes, CAL, 60, { toSec: macro3m(9, 45) }).map((g) => ({
    start: g.startMs,
    end: g.endMs,
  }));
  assert.equal(oneMin.length, 1);
  assert.equal(oneMin[0]!.start, macro3m(9, 38) * 1000);
  // After the successful scan passes it, exactly one minute — not three.
  const settled = advanceSettledBoundary(FRESH, [
    result({ fromMs: sec(8, 6, 45) * 1000, toMs: macro3m(9, 45) * 1000, expectedBuckets: 180 }),
  ]);
  assert.equal(filterSettledGaps(oneMin, settled.lastScanToMs! / 1000).length, 1);
});

// ─ Wiring: the live CapitalReconciler instance behind the router ────────────
//
// The production router receives `() => reconciler?.settledScanToSec() ?? null`
// (backend/src/index.ts), so the frontier must mutate IN PLACE on the long-lived
// instance — no router/gateway recreation. These tests exercise the class
// itself, including the defensive throw path in `runOnce()`.

/** Sunday 2024-01-07: outside CAL's Mon–Fri window ⇒ zero expected buckets ⇒
 *  no Capital REST call ⇒ an error-free run that advances the frontier. */
const SUNDAY = Date.UTC(2024, 0, 7, 12, 0);

const stubStore = (): ReconcileStore =>
  ({
    loadCandlesRange: async () => [],
    insertBackfilledBatch: async () => 0,
  }) as unknown as ReconcileStore;

const TARGET: ReconcileTarget = { symbol: "TEST", decimals: 2, calendar: CAL };

test("wiring: settledScanToSec() reflects a successful run on the same instance (no recreation)", async () => {
  const reconciler = new CapitalReconciler({
    store: stubStore(),
    fetcher: {} as unknown as CapitalPricesFetcher,
    targets: [TARGET],
  });
  // Nothing scanned yet ⇒ null ⇒ consumers fall back to the 20-minute grace.
  assert.equal(reconciler.settledScanToSec(), null);
  assert.equal(reconciler.statusSnapshot().lastRunSucceeded, false);

  const quiet = console.log;
  console.log = () => {};
  try {
    await reconciler.runOnce(SUNDAY);
  } finally {
    console.log = quiet;
  }

  // Window = [08:57, 11:57) on a closed day ⇒ toSec 11:57 becomes the frontier.
  assert.equal(reconciler.settledScanToSec(), sec(7, 11, 57));
  const status = reconciler.statusSnapshot();
  assert.equal(status.lastRunSucceeded, true);
  assert.equal(status.lastScanToMs, sec(7, 11, 57) * 1000);
  assert.equal(status.lastScanFromMs, sec(7, 8, 57) * 1000);
  assert.deepEqual(status.lastErrors, []);
});

test("wiring: a THROWN run neither advances the frontier nor reports success", async () => {
  // The target list throws mid-iteration, escaping reconcileTargets' per-target
  // catch — the only path that reaches runOnce's defensive catch.
  let boom = false;
  const targets: ReconcileTarget[] = [];
  Object.defineProperty(targets, Symbol.iterator, {
    value: function* (): Generator<ReconcileTarget> {
      if (boom) throw new Error("boom");
      yield TARGET;
    },
  });

  const reconciler = new CapitalReconciler({
    store: stubStore(),
    fetcher: {} as unknown as CapitalPricesFetcher,
    targets,
  });

  const quiet = console.log;
  console.log = () => {};
  try {
    await reconciler.runOnce(SUNDAY); // success: frontier established
    const boundary = reconciler.settledScanToSec();
    assert.equal(boundary, sec(7, 11, 57));
    assert.equal(reconciler.statusSnapshot().lastRunSucceeded, true);

    boom = true;
    const results = await reconciler.runOnce(SUNDAY); // throws internally
    assert.deepEqual(results, []);

    // The previous successful boundary STANDS (never over-advanced)…
    assert.equal(reconciler.settledScanToSec(), boundary);
    assert.equal(reconciler.statusSnapshot().lastScanToMs, sec(7, 11, 57) * 1000);
    // …and the failure is reflected (never a stale "success").
    const failed = reconciler.statusSnapshot();
    assert.equal(failed.lastRunSucceeded, false);
    assert.equal(failed.lastErrors.length, 1);
    assert.match(failed.lastErrors[0]!, /boom/);

    // A later healthy run recovers the flag (the boundary is never wedged).
    boom = false;
    await reconciler.runOnce(SUNDAY);
    assert.equal(reconciler.statusSnapshot().lastRunSucceeded, true);
  } finally {
    console.log = quiet;
  }
});