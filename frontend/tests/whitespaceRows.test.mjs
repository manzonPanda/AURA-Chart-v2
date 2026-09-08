/**
 * Whitespace plan + Pine anchor remapping tests — the REAL/WHITESPACE
 * separation contract (docs: services/whitespaceRows.ts header).
 *
 * Canonical fixture: the real Sep 7 2026 Spot Gold outage —
 *   21:25…21:29 PH real candles (idx 0…4)
 *   21:30…21:38 PH missing (backend gap 13:30Z → 13:39Z)
 *   21:39…21:43 PH real candles (idx 5…9)
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWhitespacePlan,
  remapLogicalToChart,
} from "../src/services/whitespaceRows.ts";
import { resolveAnchorX } from "../src/services/pineDrawings.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

/** 2026-09-07 13:25:00Z = 21:25 PH. */
const BASE = Date.UTC(2026, 8, 7, 13, 25, 0);
const MIN = 60_000;

function makeCandles() {
  const out = [];
  for (let i = 0; i < 10; i++) {
    // idx 0..4 → 21:25..21:29; idx 5..9 → 21:39..21:43 (the 9-minute outage).
    out.push({ ts: BASE + (i < 5 ? i : i + 9) * MIN, close: 2400 + i });
  }
  return out;
}

/** CandleGap-shaped plain objects (gap minutes are offsets from BASE). */
function gap(startMin, endMin) {
  return [
    {
      instrument: "CS.D.CFIGOLD.CFI.IP",
      timeframe: "MINUTE_1",
      startTime: BASE + startMin * MIN,
      endTime: BASE + endMin * MIN,
      reason: "broker_gap",
    },
  ];
}

// ── whitespace generation ───────────────────────────────────────────────────

test("exact outage: 21:30–21:38 PH yields nine OHLC-free slots between 21:29 and 21:39", () => {
  const plan = buildWhitespacePlan(makeCandles(), gap(5, 14), 60);
  assert.equal(plan.slots.length, 9);
  assert.equal(plan.slots[0], BASE + 5 * MIN); // 21:30
  assert.equal(plan.slots[8], BASE + 13 * MIN); // 21:38
  assert.ok(!plan.slots.includes(BASE + 4 * MIN), "21:29 is a real candle — never a slot");
  assert.ok(!plan.slots.includes(BASE + 14 * MIN), "21:39 is a real candle — never a slot");
  // Anchors reference exactly the two bounding real candles.
  assert.deepEqual(
    plan.anchors.map((a) => a.time),
    [BASE + 4 * MIN, BASE + 14 * MIN],
  );
  assert.deepEqual(plan.anchors.map((a) => a.value), [2404, 2405]);
});

test("no whitespace for non-gap periods (contiguous candles, no gaps)", () => {
  const contiguous = Array.from({ length: 10 }, (_, i) => ({ ts: BASE + i * MIN, close: 1 }));
  assert.deepEqual(buildWhitespacePlan(contiguous, [], 60), { slots: [], anchors: [] });
  const full = Array.from({ length: 20 }, (_, i) => ({ ts: BASE + i * MIN, close: 1 }));
  assert.deepEqual(buildWhitespacePlan(full, gap(2, 8), 60), { slots: [], anchors: [] });
});

test("no duplicate timestamps: overlapping/duplicate gap intervals merge to unique slots", () => {
  const gaps = [...gap(5, 10), ...gap(9, 14), ...gap(5, 14)];
  const plan = buildWhitespacePlan(makeCandles(), gaps, 60);
  assert.equal(plan.slots.length, 9);
  assert.equal(new Set(plan.slots).size, plan.slots.length);
});

test("a real candle always wins: a slot colliding with a real candle is skipped", () => {
  // 21:30 exists as a real candle even though the gap interval covers it.
  const candles = makeCandles();
  candles.splice(5, 0, { ts: BASE + 5 * MIN, close: 2405.5 });
  const plan = buildWhitespacePlan(candles, gap(5, 14), 60);
  assert.ok(!plan.slots.includes(BASE + 5 * MIN));
  assert.equal(plan.slots.length, 8);
});

// ── logical remapping after inserted whitespace ─────────────────────────────

const CANDLE_TIMES = makeCandles().map((c) => c.ts);
const SLOTS = buildWhitespacePlan(makeCandles(), gap(5, 14), 60).slots;

test("remap: identity without slots (no gaps / replay / whitespace disabled)", () => {
  assert.equal(remapLogicalToChart(5, CANDLE_TIMES, []), 5);
  assert.equal(remapLogicalToChart(3.5, CANDLE_TIMES, []), 3.5);
});

test("remap: candle before the gap keeps its engine index; after the gap shifts +9", () => {
  assert.equal(remapLogicalToChart(4, CANDLE_TIMES, SLOTS), 4); // 21:29 candle
  assert.equal(remapLogicalToChart(5, CANDLE_TIMES, SLOTS), 14); // 21:39 candle
  assert.equal(remapLogicalToChart(9, CANDLE_TIMES, SLOTS), 18); // 21:43 candle
});

test("remap: fractional engine logical inside the hole lands on its exact slot", () => {
  // 14335fa semantics: the engine fractional for 21:30 PH on the compacted
  // series is 4 + (21:30−21:29)/(21:39−21:29) = 4.1 (time-proportional). The
  // chart spreads the 10-minute hole uniformly, so 4.1 must land exactly on
  // the 21:30 whitespace slot's chart logical (5). Tolerance guards FP drift.
  const v = remapLogicalToChart(4.1, CANDLE_TIMES, SLOTS);
  assert.ok(Math.abs(v - 5) < 1e-9, `expected ~5 (the 21:30 slot), got ${v}`);
});

test("remap: future extension past the last real candle adds all slots", () => {
  assert.equal(remapLogicalToChart(20, CANDLE_TIMES, SLOTS), 29);
});

// ── Pine drawing positioning across the gap (resolveAnchorX) ────────────────

const KLINES = makeCandles().map((c) => ({ openTime: c.ts, high: 1, low: 1 }));

test("resolveAnchorX: exact whitespace slot resolves time-first (no next-bar snap)", () => {
  const ts = fakeTimeScale(SLOTS, [4, 14]); // registers the 21:30…21:38 slots
  // bar_time 21:30 PH → the 21:30 whitespace point's OWN coordinate (55),
  // NOT the 21:39 candle (145) that a nearest-bar/compacted fallback hits.
  assert.equal(resolveAnchorX(null, BASE + 5 * MIN, KLINES, SLOTS, ts), 55);
});

test("resolveAnchorX: bar_index anchor remaps to the exact post-gap bar slot", () => {
  const ts = fakeTimeScale(SLOTS, [4, 14]);
  assert.equal(resolveAnchorX(5, null, KLINES, SLOTS, ts), 145); // 21:39 candle
  assert.equal(resolveAnchorX(4, null, KLINES, SLOTS, ts), 45); // 21:29 candle
});

test("resolveAnchorX: no whitespace (replay/disabled) → engine logical passthrough", () => {
  const ts = fakeTimeScale([], []);
  // Compacted scale: engine 5 → chart logical 5 (the 21:39 candle's slot).
  assert.equal(resolveAnchorX(5, null, KLINES, [], ts), 55);
});

test("resolveAnchorX: 14335fa fractional fallback on a compacted scale stays valid", () => {
  const ts = fakeTimeScale([], []);
  // No whitespace (replay / absent gaps): bar_time 21:30 falls back to the
  // 14335fa compacted-scale fractional 4.1 → 46 px. The true whitespace slot
  // sits at 55 px (test above) — that 0.9-bar residual is exactly the skew
  // the whitespace scale + time-first resolution eliminate.
  assert.equal(resolveAnchorX(4.1, BASE + 5 * MIN, KLINES, [], ts), 46);
});

test("resolveAnchorX: unregistered time (future session edge) extrapolates from logical", () => {
  const ts = fakeTimeScale(SLOTS, [4, 14]);
  // Future box edge: timeMs is not registered on the scale (beyond the
  // candles) → priority 2: the remapped engine logical (20 → 29) drives
  // LWC's linear bar-space extrapolation.
  assert.equal(resolveAnchorX(20, BASE + 40 * MIN, KLINES, SLOTS, ts), 295);
});

/** Minimal deterministic time-scale double mirroring the LWC coordinate model. */
function fakeTimeScale(slots, gapOwnerIndexes) {
  const registered = new Set();
  const sec = (ms) => Math.floor(ms / 1000);
  const beforeGap = gapOwnerIndexes[0];
  const afterGap = gapOwnerIndexes[1];
  for (const ms of slots) registered.add(sec(ms));
  const logicalOf = (ms) => {
    if (ms <= BASE + 4 * MIN) return Math.round((ms - BASE) / MIN); // pre-gap candles 0..4
    if (registered.has(sec(ms))) {
      const i = slots.indexOf(ms);
      return beforeGap + 1 + i; // slots 21:30…21:38 → chart logicals 5…13
    }
    if (ms > BASE + 14 * MIN) return afterGap + Math.round((ms - (BASE + 14 * MIN)) / MIN);
    return afterGap; // the 21:39 real candle
  };
  const coord = (logical) => 10 * (logical + 0.5); // bar 0 → 15
  return {
    timeToCoordinate(timeSec) {
      return registered.has(timeSec) ? coord(logicalOf(timeSec * 1000)) : null;
    },
    logicalToCoordinate(logical) {
      return coord(logical);
    },
  };
}



