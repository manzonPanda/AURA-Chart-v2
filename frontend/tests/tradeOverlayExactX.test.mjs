/**
 * Post-P3-D positioning fix — EXACT-TIME X resolution tests (pure, no chart/DOM).
 * Runs with Node's type stripping:  npm --prefix frontend run test
 *
 * Covers the mandated matrix:
 *   7.  1m exact-time positioning (interpolation between registered points)
 *   8.  3m exact-time positioning (minute%3≠0 still resolves)
 *   9.  exact NON-registered chart timestamps use interpolation
 *   10. 3m trades no longer disappear because timeToCoordinate() returns null
 *   (direct-registered fast path + right-edge slope fallback + null contract)
 *
 * The unit under test is the exported resolveExactTimeX() from
 * TradeOverlayPrimitive.ts — the exact function the renderer calls. The fake
 * timeScale reproduces Lightweight Charts' proven live behavior:
 * timeToCoordinate(t) is non-null ONLY for registered time points.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveExactTimeX } from "../src/components/TradingChart/TradeOverlayPrimitive.ts";

/**
 * Fake LWC timeScale: registered points at `gridSec` intervals starting at
 * `firstSec`, linearly mapped to pixels with the given barSpacing — exactly
 * how the real scale lays out a contiguous candle series. Non-registered
 * times return null (the live-proven contract).
 */
function makeScale({ firstSec, lastSec, gridSec, barSpacingPx, originPx = 100 }) {
  return {
    timeToCoordinate(time) {
      if (!Number.isFinite(time)) return null;
      const idx = (time - firstSec) / gridSec;
      if (!Number.isInteger(idx)) return null; // not on the registered grid
      if (time < firstSec || time > lastSec) return null; // outside loaded data
      return originPx + idx * barSpacingPx;
    },
    /** expected pixel for a registered time (test oracle) */
    expected(timeSec) {
      return this.timeToCoordinate(timeSec);
    },
  };
}

const T0 = Date.UTC(2026, 8, 23, 12, 0, 0) / 1000; // 12:00:00Z grid origin
const SPACING = 9; // barSpacing the live chart showed in the audit

// ── 7. 1m exact-time positioning ──────────────────────────────────────────────
test("7: 1m — exact :55s timestamp interpolates INSIDE its candle, not the left edge", () => {
  // 15:10:55 Helsinki → 12:10:55Z (naive digits, post OID-1114 contract).
  const exactMs = Date.UTC(2026, 8, 23, 12, 10, 55);
  const scale = makeScale({
    firstSec: T0,
    lastSec: T0 + 3600 * 60,
    gridSec: 60,
    barSpacingPx: SPACING,
  });
  // Direct call for the exact time is null (non-registered) — the OLD failure.
  assert.equal(scale.timeToCoordinate(exactMs / 1000), null);

  const x = resolveExactTimeX(exactMs, 60_000, scale);
  // Oracle inputs must be epoch SECONDS (the fake scale's unit).
  const bucketSec = Math.floor(exactMs / 1000 / 60) * 60; // 12:10:00Z
  const bucketX = scale.expected(bucketSec);
  const nextX = scale.expected(bucketSec + 60);
  assert.ok(typeof x === "number", "interpolated X is a number");
  // Formula oracle: x0 + (x1−x0)·(55/60)
  assert.ok(
    Math.abs(x - (bucketX + (nextX - bucketX) * (55 / 60))) < 1e-9,
    `x=${x} expected=${bucketX + (nextX - bucketX) * (55 / 60)}`,
  );
  // Strictly to the RIGHT of the candle's left edge, but within the candle.
  assert.ok(x > bucketX, "marker is not glued to the bucket start");
  assert.ok(x < nextX, "marker stays inside its own candle");
  // Intra-candle offset ≈ 55/60 of one bar (9px → 8.25px — audit's value).
  assert.ok(Math.abs(x - bucketX - SPACING * (55 / 60)) < 1e-9);
});

// ── 8. 3m exact-time positioning ──────────────────────────────────────────────
test("8: 3m — minute%3≠0 exact time resolves on the 180s grid (audit T1: 12:10:55)", () => {
  const exactMs = Date.UTC(2026, 8, 23, 12, 10, 55); // minute 10, 10%3=1
  const scale = makeScale({
    firstSec: T0,
    lastSec: T0 + 3600 * 180,
    gridSec: 180, // registered ONLY at minute%3===0 (12:09, 12:12, …)
    barSpacingPx: SPACING,
  });
  // 12:10:55 is not registered; even the OLD 1m bucket (12:10:00) is not.
  assert.equal(scale.timeToCoordinate(exactMs / 1000), null);
  assert.equal(scale.timeToCoordinate(Math.floor(exactMs / 1000 / 60) * 60), null);

  const x = resolveExactTimeX(exactMs, 180_000, scale);
  const bucket3m = Math.floor(exactMs / 1000 / 180) * 180; // 12:09:00Z (9%3=0)
  const x0 = scale.expected(bucket3m);
  const x1 = scale.expected(bucket3m + 180);
  assert.ok(typeof x === "number", "3m X resolves");
  // Interpolated across the containing 3m candle: (12:10:55−12:09:00)/180 = 115/180
  assert.ok(
    Math.abs(x - (x0 + (x1 - x0) * (115 / 180))) < 1e-9,
    `x=${x} expected=${x0 + (x1 - x0) * (115 / 180)}`,
  );
  assert.ok(x > x0 && x < x1, "inside the 3m candle");
});

test("8b: 3m — minute%3==0 exact time too (audit T2: 10:33:56)", () => {
  const exactMs = Date.UTC(2026, 8, 23, 10, 33, 56); // 33%3=0 → 10:33 registered
  const scale = makeScale({
    firstSec: T0 - 3600 * 180,
    lastSec: T0 + 3600 * 180,
    gridSec: 180,
    barSpacingPx: SPACING,
  });
  const x = resolveExactTimeX(exactMs, 180_000, scale);
  const bucket3m = Math.floor(exactMs / 1000 / 180) * 180; // 10:33:00Z (33%3=0)
  const x0 = scale.expected(bucket3m);
  const x1 = scale.expected(bucket3m + 180);
  assert.ok(
    Math.abs(x - (x0 + (x1 - x0) * (56 / 180))) < 1e-9,
    `x=${x}`,
  );
  assert.ok(x > x0 && x < x1, "inside the 3m candle");
});

// ── 9. exact non-registered timestamps use interpolation ─────────────────────
test("9: non-registered exact timestamp → interpolation (never null when bracketed)", () => {
  const scale = makeScale({
    firstSec: T0,
    lastSec: T0 + 3600 * 60,
    gridSec: 60,
    barSpacingPx: SPACING,
  });
  for (const sec of [0, 7, 23, 41, 59]) {
    const exactMs = Date.UTC(2026, 8, 23, 12, 30, sec);
    const x = resolveExactTimeX(exactMs, 60_000, scale);
    assert.equal(typeof x, "number", `:${sec}s resolves`);
    const x0 = scale.expected(Math.floor(exactMs / 1000 / 60) * 60); // epoch SECONDS
    assert.ok(Math.abs(x - (x0 + SPACING * (sec / 60))) < 1e-9, `:${sec}s px`);
  }
});

// ── 10. 3m no longer disappears ───────────────────────────────────────────────
test("10: the OLD null-skip case now yields a drawable coordinate on 3m", () => {
  // Reproduces the audit's live failure: overlay entry bucket floored to 1m
  // (12:10:00) while the 3m chart registers only 12:09/12:12 → ttc null →
  // the primitive `continue`d and the marker NEVER painted.
  const scale = makeScale({
    firstSec: T0,
    lastSec: T0 + 3600 * 180,
    gridSec: 180,
    barSpacingPx: SPACING,
  });
  const oldBucketSec = Math.floor(Date.UTC(2026, 8, 23, 12, 10, 55) / 1000 / 60) * 60; // 12:10:00Z (seconds)
  assert.equal(scale.timeToCoordinate(oldBucketSec), null); // old code's skip
  const painted = resolveExactTimeX(Date.UTC(2026, 8, 23, 12, 10, 55), 180_000, scale);
  assert.equal(typeof painted, "number"); // now it draws
});

// ── contracts: direct hit, right edge, nothing nearby ────────────────────────
test("direct: an exact time that IS registered returns its coordinate unchanged", () => {
  const scale = makeScale({
    firstSec: T0,
    lastSec: T0 + 3600 * 60,
    gridSec: 60,
    barSpacingPx: SPACING,
  });
  const regMs = Date.UTC(2026, 8, 23, 12, 5, 0);
  assert.equal(resolveExactTimeX(regMs, 60_000, scale), scale.expected(regMs / 1000));
});

test("right edge: no registered point after t0 → slope extended from the previous neighbor", () => {
  // Registered only up to 12:10:00 — a trade at 12:10:41 (inside the forming/
  // newest bucket) has NO t1. The slope from (12:09, 12:10) extends the line.
  const lastReg = Date.UTC(2026, 8, 23, 12, 10, 0) / 1000;
  const scale = {
    timeToCoordinate(time) {
      if (!Number.isFinite(time)) return null;
      const idx = (time - T0) / 60;
      if (!Number.isInteger(idx) || time < T0 || time > lastReg) return null;
      return 100 + idx * SPACING;
    },
  };
  const x = resolveExactTimeX(Date.UTC(2026, 8, 23, 12, 10, 41), 60_000, scale);
  const x0 = scale.timeToCoordinate(lastReg);
  const xm = scale.timeToCoordinate(lastReg - 60);
  assert.ok(typeof x === "number");
  assert.ok(Math.abs(x - (x0 + ((x0 - xm) * 41) / 60)) < 1e-9, `x=${x}`);
  assert.ok(x > x0, "extends rightward past the last registered point");
});

test("null contract: nothing registered anywhere nearby → null (caller skips)", () => {
  const scale = { timeToCoordinate: () => null };
  assert.equal(resolveExactTimeX(Date.UTC(2026, 8, 23, 12, 10, 55), 60_000, scale), null);
});

test("guard: non-finite exact time or invalid bucket → null (never NaN paint)", () => {
  const scale = makeScale({
    firstSec: T0,
    lastSec: T0 + 3600 * 60,
    gridSec: 60,
    barSpacingPx: SPACING,
  });
  assert.equal(resolveExactTimeX(NaN, 60_000, scale), null);
  assert.equal(resolveExactTimeX(Infinity, 60_000, scale), null);
  // bucket 0 with an unregistered exact → the direct probe already failed → null
  assert.equal(resolveExactTimeX(Date.UTC(2026, 8, 23, 12, 30, 41), 0, scale), null);
});
