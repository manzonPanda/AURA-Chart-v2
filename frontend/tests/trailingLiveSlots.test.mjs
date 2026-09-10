/**
 * Regression guard for the LIVE trailing-whitespace feature.
 *
 * `buildWhitespacePlan` now supports `opts.live`. When live (NOT replay), it
 * appends exactly `RIGHT_OFFSET_BARS` (8) OHLC-FREE, bucket-aligned, strictly
 * future time slots after the last real candle so Lightweight Charts can render
 * native X-axis tick labels into the empty right-side area (TradingView-style),
 * without emitting any fake OHLC data.
 *
 * Run: npm --prefix frontend run test  (Node --experimental-strip-types)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildWhitespacePlan } from "../src/services/whitespaceRows.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const BASE = Date.UTC(2026, 8, 7, 13, 25, 0); // 2026-09-07 13:25:00Z
const MIN = 60_000;

function candles(n = 10, start = BASE) {
  // ascending real candles, 1 minute apart, each with a distinct close.
  return Array.from({ length: n }, (_, i) => ({
    ts: start + i * MIN,
    close: 2400 + i,
  }));
}

// Canonical outage fixture mirroring whitespaceRows.test.mjs:
//   21:25..21:29 real (idx 0..4) | 21:30..21:38 missing | 21:39..21:43 real
function outageCandles() {
  return Array.from({ length: 10 }, (_, i) => ({
    ts: BASE + (i < 5 ? i : i + 9) * MIN,
    close: 2400 + i,
  }));
}
const outageGap = [
  { instrument: "X", timeframe: "MINUTE_1", startTime: BASE + 5 * MIN, endTime: BASE + 14 * MIN, reason: "broker_gap" },
];

// ── trailing slot core behavior ─────────────────────────────────────────────

test("live mode: empty gaps still produces exactly 8 trailing OHLC-free slots", () => {
  const plan = buildWhitespacePlan(candles(10), [], 60, { live: true });
  assert.equal(plan.slots.length, 8);
  assert.equal(plan.anchors.length, 0); // trailing slots carry NO anchor/close
});

test("live defaults to OFF: calling without opts produces no trailing slots", () => {
  const plan = buildWhitespacePlan(candles(10), [], 60);
  assert.equal(plan.slots.length, 0);
  assert.equal(plan.anchors.length, 0);
});

test("live:false explicitly produces no trailing slots", () => {
  const plan = buildWhitespacePlan(candles(10), [], 60, { live: false });
  assert.equal(plan.slots.length, 0);
  assert.equal(plan.anchors.length, 0);
});

test("exactly 8 future slots — bounded and stable (not an unbounded series)", () => {
  for (const n of [1, 5, 10, 50]) {
    const plan = buildWhitespacePlan(candles(n), [], 60, { live: true });
    assert.equal(plan.slots.length, 8, `n=${n} expected 8 trailing slots`);
  }
});

test("trailing slots are strictly after the last real candle", () => {
  const cs = candles(10);
  const lastTs = cs[cs.length - 1].ts;
  const plan = buildWhitespacePlan(cs, [], 60, { live: true });
  assert.ok(plan.slots.every((s) => s > lastTs), "every slot must be > last candle");
  assert.ok(!plan.slots.includes(lastTs), "the last real candle must never be a slot");
});

test("trailing slots are bucket-aligned (1m grid) starting at next bucket", () => {
  const cs = candles(10);
  const lastTs = cs[cs.length - 1].ts;
  const plan = buildWhitespacePlan(cs, [], 60, { live: true });
  assert.equal(plan.slots[0], lastTs + MIN); // first future bucket
  assert.equal(plan.slots[7], lastTs + 8 * MIN); // 8th slot
  assert.ok(plan.slots.every((s) => s % MIN === 0), "all slots lie on the minute grid");
  for (let i = 1; i < plan.slots.length; i++) {
    assert.equal(plan.slots[i], plan.slots[i - 1] + MIN);
  }
});

test("3m timeframe: trailing slots are 3-minute aligned", () => {
  const THREE_MIN = 180_000;
  // 3m candles must be 3-minute spaced AND start on the 3-minute grid, else
  // `lastTs` is not grid-aligned and `lastBucketStart` snaps backward.
  const alignedBase = Date.UTC(2026, 8, 7, 13, 24, 0); // 13:24Z == 3-min grid
  const cs = Array.from({ length: 5 }, (_, i) => ({ ts: alignedBase + i * THREE_MIN, close: 2400 + i }));
  const lastTs = cs[cs.length - 1].ts;
  const plan = buildWhitespacePlan(cs, [], 180, { live: true });
  assert.equal(plan.slots.length, 8);
  assert.equal(plan.slots[0], lastTs + THREE_MIN); // lastTs is grid-aligned
  assert.equal(plan.slots[7], lastTs + 8 * THREE_MIN);
  assert.ok(plan.slots.every((s) => s % THREE_MIN === 0));
});

test("no duplicate timestamps: trailing slots never collide with real candles", () => {
  const cs = candles(10);
  const candleTimes = new Set(cs.map((c) => c.ts));
  const plan = buildWhitespacePlan(cs, [], 60, { live: true });
  assert.equal(new Set(plan.slots).size, plan.slots.length);
  assert.ok(!plan.slots.some((s) => candleTimes.has(s)), "trailing slot collides with a candle");
  const combined = new Set([...cs.map((c) => c.ts), ...plan.slots]);
  assert.equal(combined.size, cs.length + plan.slots.length);
});

test("live mode does not mutate the input candles array", () => {
  const cs = candles(10);
  const before = JSON.stringify(cs);
  buildWhitespacePlan(cs, [], 60, { live: true });
  assert.equal(JSON.stringify(cs), before, "candles must be untouched");
});

// ── integration with historical gaps ────────────────────────────────────

test("live + a gap: trailing slots appended AFTER gap slots; gap region unchanged", () => {
  const cs = outageCandles();
  const lastTs = cs[cs.length - 1].ts; // BASE + 18*MIN (21:43 PH)
  const live = buildWhitespacePlan(cs, outageGap, 60, { live: true });
  const plain = buildWhitespacePlan(cs, outageGap, 60); // no live (replay/exhausted)

  // Gap region is identical to the non-live plan:
  assert.deepEqual(
    live.slots.slice(0, plain.slots.length),
    plain.slots,
    "gap slots must be unchanged when live is enabled",
  );
  // Trailing region is exactly 8 future slots after the last real candle:
  assert.equal(live.slots.length, plain.slots.length + 8);
  const trailing = live.slots.slice(plain.slots.length);
  assert.equal(trailing[0], lastTs + MIN);
  assert.equal(trailing[7], lastTs + 8 * MIN);
  assert.ok(trailing.every((s) => s > lastTs));

  // Anchors (real-candle closes used only for gap bounding) are untouched:
  assert.deepEqual(live.anchors, plain.anchors);
  // No trailing timestamp hides a value — anchors contain only the gap bounds:
  assert.equal(live.anchors.length, 2);
  assert.ok(!live.anchors.some((a) => trailing.includes(a.time)));
});

test("live:false with a gap is byte-identical to the legacy 3-arg call (replay unchanged)", () => {
  const planOpts = buildWhitespacePlan(outageCandles(), outageGap, 60, { live: false });
  const planLegacy = buildWhitespacePlan(outageCandles(), outageGap, 60);
  assert.deepEqual(planOpts, planLegacy);
  assert.equal(planOpts.slots.length, 9); // the 21:30..21:38 outage slots only
  assert.equal(planOpts.anchors.length, 2);
});

test("live:true with a gap never duplicates the 8th trailing slot or a real candle", () => {
  const cs = outageCandles();
  const plan = buildWhitespacePlan(cs, outageGap, 60, { live: true });
  assert.equal(new Set(plan.slots).size, plan.slots.length);
  assert.ok(!plan.slots.includes(BASE + 18 * MIN)); // last real candle (21:43)
  assert.ok(!plan.slots.includes(BASE + 14 * MIN)); // 21:39 real candle
});

test("exhausted session (no candles) yields nothing even with live:true", () => {
  assert.deepEqual(buildWhitespacePlan([], [], 60, { live: true }), { slots: [], anchors: [] });
});

test("no trailing slot ever carries an OHLC value (slots are pure timestamps)", () => {
  const cs = outageCandles();
  const plan = buildWhitespacePlan(cs, outageGap, 60, { live: true });
  assert.ok(plan.slots.every((s) => typeof s === "number"));
  // The ONLY place a `value` (close) lives is `anchors`, and the trailing
  // region contributes none — proving the future area is OHLC-free.
  const lastTs = cs[cs.length - 1].ts;
  const trailing = plan.slots.filter((s) => s > lastTs);
  assert.ok(!plan.anchors.some((a) => trailing.includes(a.time)));
});

