/**
 * Unit tests for the "Scroll to most recent bar" button edge-detection +
 * visibility logic. Runs with Node's type stripping:
 *   npm --prefix frontend run test
 * No chart/DOM needed — exercises the pure helpers in historyPagination.ts
 * that the ScrollToLatestButton component relies on.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isAtLatestEdge, shouldShowScrollToLatest } from "../src/services/historyPagination.ts";

/** Helper: epoch seconds for 2026-09-07 21:xx PH (UTC+8), PH = UTC-8. */
function phSec(h, m) {
  // 2026-09-07 13:00 UTC = 21:00 PH
  const base = 1788920400; // 2026-09-07 21:00:00 PH = 13:00 UTC
  return base + (h - 21) * 3600 + m * 60;
}

test("isAtLatestEdge: null visible range counts as at edge (button hidden)", () => {
  assert.equal(isAtLatestEdge(null, phSec(21, 39), 60), true);
});

test("isAtLatestEdge: no latest candle → at edge (no data to scroll to)", () => {
  assert.equal(isAtLatestEdge({ from: 0, to: 100 }, 0, 60), true);
});

test("isAtLatestEdge: 9-minute gap — viewport ending at 21:37 is NOT at edge", () => {
  // Latest real candle: 21:39 (PH). Viewport ends at 21:37 → more than one bucket
  // short of the latest → not at the edge → button should show.
  const latest = phSec(21, 39);
  const range = { from: phSec(21, 29), to: phSec(21, 37) };
  assert.equal(isAtLatestEdge(range, latest, 60), false);
});

test("isAtLatestEdge: 9-minute gap — viewport ending at 21:38 IS at edge", () => {
  // 21:39 - 60s = 21:38; a viewport ending at 21:38 is within one bucket → at edge.
  const latest = phSec(21, 39);
  const range = { from: phSec(21, 29), to: phSec(21, 38) };
  assert.equal(isAtLatestEdge(range, latest, 60), true);
});

test("isAtLatestEdge: large gap — viewport ending at 04:59 is NOT at edge", () => {
  // Latest real candle: 06:01 PH. Viewport ends at 04:59 → far from edge
  // even though there are 150 whitespace slots below → button must show.
  const latest = phSec(6, 1);
  const range = { from: phSec(2, 29), to: phSec(4, 59) };
  assert.equal(isAtLatestEdge(range, latest, 60), false);
});

test("isAtLatestEdge: large gap — viewport ending at 06:01 IS at edge", () => {
  const latest = phSec(6, 1);
  const range = { from: phSec(5, 50), to: phSec(6, 1) };
  assert.equal(isAtLatestEdge(range, latest, 60), true);
});

test("isAtLatestEdge: 3m timeframe uses 3-min bucket tolerance", () => {
  const latest = phSec(21, 39);
  // Viewport ends 1 minute before the latest 3m close (21:39) → within 180s
  // tolerance → still at edge → button hidden.
  const range = { from: phSec(21, 30), to: phSec(21, 38) };
  assert.equal(isAtLatestEdge(range, latest, 180), true);
});

test("shouldShowScrollToLatest: at edge → hidden", () => {
  assert.equal(shouldShowScrollToLatest({ atEdge: true, replayActive: false, hasCandles: true }), false);
});

test("shouldShowScrollToLatest: not at edge, not replay, has candles → visible", () => {
  assert.equal(shouldShowScrollToLatest({ atEdge: false, replayActive: false, hasCandles: true }), true);
});

test("shouldShowScrollToLatest: replay active → always hidden", () => {
  assert.equal(shouldShowScrollToLatest({ atEdge: false, replayActive: true, hasCandles: true }), false);
  assert.equal(shouldShowScrollToLatest({ atEdge: true, replayActive: true, hasCandles: true }), false);
});

test("shouldShowScrollToLatest: no candles → hidden", () => {
  assert.equal(shouldShowScrollToLatest({ atEdge: false, replayActive: false, hasCandles: false }), false);
});

test("whitespace slots do not affect edge detection (large gap)", () => {
  // Even though the gap covers 150 min of whitespace slots, the edge check
  // compares against the LATEST REAL candle (06:01), not a slot timestamp.
  // A viewport ending at 06:00 (the slot just before the latest candle) is
  // within 1 bucket → at edge. A viewport ending at 04:59 is not.
  const latest = phSec(6, 1);
  assert.equal(isAtLatestEdge({ from: phSec(5, 59), to: phSec(6, 0) }, latest, 60), true);
  assert.equal(isAtLatestEdge({ from: phSec(2, 30), to: phSec(4, 59) }, latest, 60), false);
});
