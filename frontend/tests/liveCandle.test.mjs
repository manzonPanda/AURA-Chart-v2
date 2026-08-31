/**
 * Unit tests for the live-candle reconciliation core (liveCandle.ts) — the
 * doji-bug fix and the countdown math. Runs with Node's type stripping:
 *   npm --prefix frontend run test
 * No chart/DOM needed; CandleKit's updateBar semantics are mirrored in
 * `modelApply` so the full plan→chart flow is exercised.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  alignBucket,
  planLiveUpdate,
  mergeSameBucket,
  classifyFrame,
  candleCloseCountdown,
  formatCountdown,
} from "../src/services/liveCandle.ts";

/** Mirror of ChartController.updateBar: replace equal-ts, append newer, discard older. */
function modelApply(bars, plan) {
  for (const bar of plan.commits) {
    const last = bars[bars.length - 1];
    if (last && last.ts === bar.ts) bars[bars.length - 1] = bar;
    else if (!last || bar.ts > last.ts) bars.push(bar);
    // else discarded
  }
  return plan.truth;
}

const frame = (time, o, h, l, c, v) => ({ time, open: o, high: h, low: l, close: c, ...(v !== undefined ? { volume: v } : {}) });

// ── Bucket alignment ─────────────────────────────────────────────────────────
test("alignBucket floors to 1m and 3m bucket starts", () => {
  assert.equal(alignBucket(Date.UTC(2026, 7, 31, 9, 1, 29, 999), 60), Date.UTC(2026, 7, 31, 9, 1, 0));
  assert.equal(alignBucket(Date.UTC(2026, 7, 31, 9, 5, 59), 180), Date.UTC(2026, 7, 31, 9, 3, 0));
  assert.equal(alignBucket(Date.UTC(2026, 7, 31, 9, 6, 0), 180), Date.UTC(2026, 7, 31, 9, 6, 0));
});

// ── Merge contract (Issue 1 requirement 3) ───────────────────────────────────
test("same-bucket merge: open immutable, high=max, low=min, close=latest, volume cumulative", () => {
  const truth = { ts: 3600_000, open: 100, high: 101, low: 99, close: 100.5, volume: 30 };
  const merged = mergeSameBucket(truth, { ts: 3600_000, open: 999, high: 102, low: 98.5, close: 101.7, volume: 60 });
  assert.equal(merged.open, 100, "open must never change");
  assert.equal(merged.high, 102);
  assert.equal(merged.low, 98.5);
  assert.equal(merged.close, 101.7, "close = latest valid price");
  assert.equal(merged.volume, 60, "server volume is cumulative, not additive");
});

test("planLiveUpdate seeds truth from the frame's real OHLC (no fabricated all-equal bar)", () => {
  const plan = planLiveUpdate(null, frame(3600, 100, 101.5, 99.2, 101.1, 42), 60, { hidden: true });
  assert.equal(plan.rollover, true);
  assert.equal(plan.skipped, false);
  assert.deepEqual(
    { ...plan.truth, ts: undefined },
    { open: 100, high: 101.5, low: 99.2, close: 101.1, volume: 42, ts: undefined },
  );
});

test("stale/delayed frame never overwrites newer candle state", () => {
  const truth = { ts: 3660_000, open: 102, high: 103, low: 101.8, close: 102.5, volume: 7 };
  const plan = planLiveUpdate(truth, frame(3600, 100, 100.1, 99.9, 100, 5), 60);
  assert.equal(plan.skipped, true, "older bucket must be skipped");
  assert.equal(plan.truth, truth, "truth unchanged");
  assert.equal(plan.commits.length, 0, "nothing painted");
});

// ── Rollover plan: previous bucket re-committed with TRUE final OHLC ────────
test("rollover plan re-commits the closing bucket truth, then appends the new bucket", () => {
  const prev = { ts: 3600_000, open: 100, high: 102.4, low: 99.2, close: 102.1, volume: 90 };
  const plan = planLiveUpdate(prev, frame(3660, 102.2, 102.5, 102, 102.3, 5), 60);
  assert.equal(plan.rollover, true);
  assert.equal(plan.animate, false, "never glide across a boundary");
  assert.equal(plan.commits.length, 2);
  assert.deepEqual(plan.commits[0], prev, "closing bucket's TRUE OHLC re-committed first");
  assert.equal(plan.commits[1].ts, 3660_000);
  assert.equal(plan.truth.ts, 3660_000);
});

// ── Hidden-tab behaviour ─────────────────────────────────────────────────────
test("hidden same-bucket frame commits truth directly (no rAF dependency)", () => {
  const prev = { ts: 3600_000, open: 100, high: 101, low: 99, close: 100.5, volume: 30 };
  const plan = planLiveUpdate(prev, frame(3600, 100, 101.8, 98.9, 101.5, 60), 60, { hidden: true });
  assert.equal(plan.animate, false);
  assert.equal(plan.commits.length, 1);
  assert.equal(plan.commits[0].close, 101.5);
  assert.equal(plan.commits[0].high, 101.8);
  assert.equal(plan.commits[0].low, 98.9);
});

test("visible same-bucket frame glides (no immediate commit — cosmetic layer)", () => {
  const prev = { ts: 3600_000, open: 100, high: 101, low: 99, close: 100.5 };
  const plan = planLiveUpdate(prev, frame(3600, 100, 101.2, 99.1, 101.1, 45), 60, { hidden: false });
  assert.equal(plan.animate, true);
  assert.equal(plan.commits.length, 0);
  assert.equal(plan.truth.close, 101.1);
});

test("unsound frame (non-finite price) is skipped", () => {
  const truth = { ts: 3600_000, open: 100, high: 101, low: 99, close: 100.5 };
  const plan = planLiveUpdate(truth, frame(3600, NaN, 101, 99, 100.6), 60);
  assert.equal(plan.skipped, true);
  assert.equal(plan.truth, truth);
});

test("classifyFrame covers all four kinds", () => {
  const prev = { ts: 3600_000, open: 1, high: 1, low: 1, close: 1 };
  assert.equal(classifyFrame(null, 3600_000), "seed");
  assert.equal(classifyFrame(prev, 3600_000), "same-bucket");
  assert.equal(classifyFrame(prev, 3720_000), "new-bucket");
  assert.equal(classifyFrame(prev, 3540_000), "stale");
});

// ── THE DOJI REGRESSION SCENARIO (Issue 1) ───────────────────────────────────
test("background tab across a rollover commits the closed candle's TRUE OHLC (no doji)", () => {
  const bars = [];
  let truth = null;
  const apply = (f, hidden) => {
    truth = modelApply(bars, planLiveUpdate(truth, f, 60, { hidden }));
  };

  // Visible: bucket opens, one tick so far → the chart currently shows a
  // legitimate one-tick candle (o=h=l=c). This is the state a hidden tab would
  // FREEZE under the old implementation.
  apply(frame(3600, 100, 100, 100, 100, 2), false);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 100);

  // Tab hidden: prices rally to 103 while rAF is paused.
  apply(frame(3600, 100, 101.4, 99.9, 101.2, 20), true);
  apply(frame(3600, 100, 102.6, 99.8, 102.3, 55), true);
  apply(frame(3600, 100, 103.1, 99.8, 103, 80), true);

  // Bucket rolls over while still hidden.
  apply(frame(3660, 103.05, 103.4, 102.9, 103.2, 6), true);

  // The closed candle must carry its TRUE final OHLC — NOT the frozen
  // open=close doji the old implementation committed.
  assert.equal(bars.length, 2, "exactly one new bar appended at rollover (no duplicates)");
  assert.deepEqual(
    { o: bars[0].open, h: bars[0].high, l: bars[0].low, c: bars[0].close },
    { o: 100, h: 103.1, l: 99.8, c: 103 },
    "closed candle = server truth (body preserved, real wicks)",
  );
  assert.equal(bars[1].ts, 3660_000);
  assert.equal(bars[1].open, 103.05);
});

test("hidden tab across MULTIPLE rollovers keeps every closed candle truthful", () => {
  const bars = [];
  let truth = null;
  const apply = (f, hidden) => {
    truth = modelApply(bars, planLiveUpdate(truth, f, 60, { hidden }));
  };
  apply(frame(3600, 100, 100.2, 99.9, 100.1, 4), false);
  apply(frame(3660, 100.1, 100.9, 100.0, 100.7, 9), true);
  apply(frame(3720, 100.7, 101.6, 100.5, 101.4, 12), true);
  apply(frame(3720, 100.7, 101.9, 100.4, 101.8, 25), true);
  apply(frame(3780, 101.8, 102.2, 101.5, 102, 3), true);
  assert.equal(bars.length, 4, "one bar per bucket — no duplicates");
  assert.equal(bars[0].close, 100.1);
  assert.equal(bars[1].close, 100.7);
  assert.equal(bars[2].close, 101.8);
  assert.equal(bars[2].high, 101.9);
  assert.equal(bars[2].low, 100.4);
  assert.equal(bars[3].open, 101.8);
});

// ── Delayed / batched delivery (Issue 1 requirement 2) ───────────────────────
test("batched delivery converges: applying only the latest snapshot == applying every frame", () => {
  const frames = [
    frame(3600, 100, 100.4, 99.8, 100.2, 5),
    frame(3600, 100, 100.9, 99.7, 100.8, 14),
    frame(3600, 100, 101.3, 99.6, 101.1, 30),
    frame(3600, 100, 101.7, 99.5, 101.5, 47),
  ];
  // Every frame, one by one (hidden → direct commits).
  const barsA = [];
  let truthA = null;
  for (const f of frames) truthA = modelApply(barsA, planLiveUpdate(truthA, f, 60, { hidden: true }));
  // The tab was throttled and only the LAST frame gets processed.
  const barsB = [];
  const truthB = modelApply(barsB, planLiveUpdate(null, frames[frames.length - 1], 60, { hidden: true }));
  assert.deepEqual(barsA, barsB, "full snapshots → last-write-wins converges");
  assert.deepEqual(truthA, truthB);
  assert.equal(barsA.length, 1);
  assert.equal(barsA[0].close, 101.5);
});

test("out-of-order frame after a rollover is discarded (chart keeps newer state)", () => {
  const bars = [];
  let truth = null;
  const apply = (f, hidden) => {
    truth = modelApply(bars, planLiveUpdate(truth, f, 60, { hidden }));
  };
  apply(frame(3600, 100, 101, 99.5, 100.8, 10), false);
  apply(frame(3660, 100.9, 101.4, 100.7, 101.2, 4), false);
  // A delayed frame for the OLD bucket arrives after the rollover.
  apply(frame(3600, 100, 101, 99.5, 100.9, 11), false);
  assert.equal(bars.length, 2, "no bar replaced/appended by the stale frame");
  assert.equal(bars[1].close, 101.2, "newer candle state intact");
  assert.equal(truth.ts, 3660_000);
});

// ── 3m timeframe path ────────────────────────────────────────────────────────
test("3m buckets merge and roll over on the 180s grid", () => {
  const bars = [];
  let truth = null;
  const apply = (f, hidden) => {
    truth = modelApply(bars, planLiveUpdate(truth, f, 180, { hidden }));
  };
  const t0 = 3600; // 01:00:00 UTC → 3m buckets at :00, :03, :06
  apply(frame(t0 + 10, 200, 200.5, 199.8, 200.2, 3), false);
  apply(frame(t0 + 95, 200, 201.2, 199.5, 200.9, 11), false);
  apply(frame(t0 + 125, 200, 201.8, 199.2, 201.5, 19), false);
  apply(frame(t0 + 190, 201.5, 202, 201.2, 201.8, 2), false); // next 3m bucket
  assert.equal(bars.length, 2);
  assert.equal(bars[0].ts, alignBucket(t0 * 1000, 180), "bucket start on the 180s grid");
  assert.equal(bars[0].close, 201.5);
  assert.equal(bars[0].high, 201.8);
  assert.equal(bars[0].low, 199.2);
  assert.equal(bars[1].ts, alignBucket((t0 + 180) * 1000, 180), "next bucket = t0+180s");
});

// ── Countdown (Issue 2) ──────────────────────────────────────────────────────
const BUCKET_1M = 60;
const BUCKET_3M = 180;
const BUCKET_MS_1M = BUCKET_1M * 1000;

test("1m countdown derives from the candle's actual bucket boundary", () => {
  const bucketStart = Date.UTC(2026, 7, 31, 9, 0, 0); // 09:00:00Z
  const closesAt = bucketStart + BUCKET_MS_1M;
  const now = closesAt - 42_000;
  const cd = candleCloseCountdown({ time: bucketStart / 1000 }, BUCKET_1M, now);
  assert.equal(cd.bucketStartMs, bucketStart);
  assert.equal(cd.closesAtMs, closesAt);
  assert.equal(cd.label, "00:42");
  assert.equal(cd.active, true);
});

test("3m countdown runs on the 180s boundary", () => {
  const bucketStart = Date.UTC(2026, 7, 31, 9, 3, 0);
  const now = bucketStart + 138_000; // 42s before the :06:00 close
  const cd = candleCloseCountdown({ time: bucketStart / 1000 }, BUCKET_3M, now);
  assert.equal(cd.closesAtMs, bucketStart + 180_000);
  assert.equal(cd.label, "00:42");
  assert.equal(cd.active, true);
});

test("countdown holds at 00:00 past the boundary (no duplicate candles) until the WS rolls over", () => {
  const bucketStart = Date.UTC(2026, 7, 31, 9, 0, 0);
  const past = bucketStart + BUCKET_MS_1M + 30_000; // 30s past the close
  const cd = candleCloseCountdown({ time: bucketStart / 1000 }, BUCKET_1M, past);
  assert.equal(cd.remainingMs, 0);
  assert.equal(cd.label, "00:00");
  assert.equal(cd.active, false, "held — the WS stream owns candle creation");
  // When the next candle frame finally arrives, the countdown resets cleanly:
  const next = candleCloseCountdown({ time: (bucketStart + BUCKET_MS_1M) / 1000 }, BUCKET_1M, past);
  assert.equal(next.active, true);
  assert.equal(next.label, "00:30");
});

test("countdown clamps a backwards-skewed browser clock to the full bucket", () => {
  const bucketStart = Date.UTC(2026, 7, 31, 9, 0, 0);
  const cd = candleCloseCountdown({ time: bucketStart / 1000 }, BUCKET_1M, bucketStart - 15_000);
  assert.equal(cd.remainingMs, BUCKET_MS_1M);
  assert.equal(cd.label, "01:00");
  const cd3 = candleCloseCountdown({ time: bucketStart / 1000 }, BUCKET_3M, bucketStart - 999_999);
  assert.equal(cd3.label, "03:00");
});

test("countdown is null without a candle; formatter covers edge values", () => {
  assert.equal(candleCloseCountdown(null, BUCKET_1M, Date.now()), null);
  assert.equal(candleCloseCountdown({ time: NaN }, BUCKET_1M, Date.now()), null);
  assert.equal(formatCountdown(0), "00:00");
  assert.equal(formatCountdown(999), "00:01"); // ceil: never shows 00:00 early
  assert.equal(formatCountdown(42_000), "00:42");
  assert.equal(formatCountdown(60_000), "01:00");
  assert.equal(formatCountdown(185_000), "03:05");
});
