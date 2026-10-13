/**
 * plot.style_linebr → INDEPENDENT HORIZONTAL SEGMENTS (no diagonal connectors).
 *
 * REGRESSION CONTEXT: fractal levels are `plot.style_linebr` series. Lightweight
 * Charts 5.2.1's LineSeries joins ALL finite points into one polyline and drops
 * the value-less whitespace rows, so two distinct levels that share a slot were
 * bridged by a DIAGONAL (browser pixel proof: 161 ink rows via LineSeries vs 9
 * via a primitive). PineBridge now routes `type === "line" && breakOnNa`
 * visuals through `linebrSegmentsToDrawings()` → PineLineBoxPrimitive instead.
 * The adapter is extracted into services/pineDrawings.ts (pure, Node-testable)
 * so these tests exercise the EXACT production code.
 *
 * Matrix:
 *   A adapter: contiguous run → 1 horizontal segment, exact endpoints
 *   B adapter: two levels at different prices + whitespace gap → 2 segments,
 *              never one diagonal (no segment straddles the gap)
 *   C adapter: leading/trailing/all whitespace + id/order invariants
 *   D engine:  real fractal.pine, two up-fractals (110 then 105) reusing slot 1
 *             → "Up level 1" carries both runs; adapter yields 2 horizontal
 *             segments confined to their own run (offset lands on the pivot)
 *   E wiring: PineBridge routes linebr via the primitive (never LineSeries),
 *             clears stale series, the sawLinebr render guard, line.new() and
 *             continuous style_line paths untouched
 *
 * Run: npm --prefix frontend run test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { linebrIdBase, linebrSegmentsToDrawings } from "../src/services/pineDrawings.ts";
import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import { FRACTAL_PINE_SOURCE, finiteSegments, fractalSeries } from "./fractalFixture.mjs";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");

const T0 = 1_704_153_600_000;
const MIN = 60_000;
/** Row builders mirroring the engine's linebr series shape. */
const v = (i, price) => ({ ts: T0 + i * MIN, value: price });
const ws = (i) => ({ ts: T0 + i * MIN }); // whitespace (na) row — the LINE BREAK

// ── A: contiguous run → one horizontal segment ───────────────────────────────

test("adapter: one contiguous finite run collapses to ONE horizontal segment", () => {
  const rows = [v(0, 110), v(1, 110), v(2, 110), v(3, 110)];
  const segs = linebrSegmentsToDrawings(rows, "#009688", 2, 1);
  assert.equal(segs.length, 1, "four contiguous rows = one level = one segment");
  const s = segs[0];
  assert.equal(s.price1, 110);
  assert.equal(s.price2, 110, "HORIZONTAL — price1 === price2 by construction");
  assert.equal(s.time1Ms, T0, "starts at the first finite row (offset already resolved)");
  assert.equal(s.time2Ms, T0 + 3 * MIN, "ends at the last finite row");
  assert.equal(s.xloc, "bar_time");
  assert.equal(s.logical1, null);
  assert.equal(s.logical2, null);
  assert.equal(s.extend, "none");
  assert.equal(s.style, "solid");
  assert.equal(s.color, "#009688");
  assert.equal(s.width, 2);
  assert.equal(s.forceOverlay, false);
  assert.equal(s.id, 1, "id = idBase + index (first segment = the base itself)");
});

// ── B: the diagonal bug — two levels, one gap, two segments ──────────────────

test("adapter: two levels at DIFFERENT prices separated by whitespace → 2 horizontal segments, NEVER a diagonal", () => {
  // Level 1 (110) lives bars 10..12, level 2 (105) lives bars 20..22. Bars
  // 13..19 are whitespace — under LineSeries these two runs were JOINED by a
  // diagonal from (12,110) to (20,105).
  const rows = [v(10, 110), v(11, 110), v(12, 110), ws(13), ws(14), ws(15), ws(16), ws(17), ws(18), ws(19), v(20, 105), v(21, 105), v(22, 105)];
  const segs = linebrSegmentsToDrawings(rows, "#009688", 2, 100);
  assert.equal(segs.length, 2, "the whitespace gap BREAKS the line — one segment per level");

  const [a, b] = segs;
  assert.equal(a.price1, 110);
  assert.equal(a.price2, 110, "level 1 is horizontal");
  assert.equal(a.time1Ms, T0 + 10 * MIN);
  assert.equal(a.time2Ms, T0 + 12 * MIN);
  assert.equal(b.price1, 105);
  assert.equal(b.price2, 105, "level 2 is horizontal");
  assert.equal(b.time1Ms, T0 + 20 * MIN);
  assert.equal(b.time2Ms, T0 + 22 * MIN);

  // THE anti-diagonal invariant: no segment may straddle the gap — every
  // segment lies entirely inside ONE run of the source data.
  const gapStart = T0 + 13 * MIN;
  const gapEnd = T0 + 19 * MIN;
  for (const s of segs) {
    assert.ok(s.time2Ms < gapStart || s.time1Ms > gapEnd, `segment [${s.time1Ms},${s.time2Ms}] must not cross the whitespace gap`);
    assert.equal(s.price1, s.price2, "a diagonal needs price1 !== price2 — structurally impossible here");
  }
  assert.ok(b.time1Ms > a.time2Ms, "segments are emitted in ascending time order");
  assert.equal(b.id, 101, "ids ascend densely from the visual's idBase");
});

// ── C: whitespace edges, all-whitespace, ids/order ───────────────────────────

test("adapter: leading/trailing whitespace trimmed; all-whitespace yields zero segments; ids stay dense", () => {
  const rows = [ws(0), ws(1), v(2, 99), v(3, 99), ws(4), v(5, 101), ws(6), ws(7)];
  const segs = linebrSegmentsToDrawings(rows, "#F44336", 1, 7);
  assert.equal(segs.length, 2, "edge whitespace produces no empty segments");
  assert.deepEqual(
    segs.map((s) => [s.time1Ms, s.time2Ms, s.price1]),
    [
      [T0 + 2 * MIN, T0 + 3 * MIN, 99],
      [T0 + 5 * MIN, T0 + 5 * MIN, 101],
    ],
  );
  assert.deepEqual(
    segs.map((s) => s.id),
    [7, 8],
    "ids are dense (no gaps from trimmed whitespace) so the primitive map never leaks stale entries",
  );
  assert.deepEqual(linebrSegmentsToDrawings([ws(0), ws(1)], "#fff", 1, 1), [], "all-whitespace → nothing, no throw");
  assert.deepEqual(linebrSegmentsToDrawings([], "#fff", 1, 1), [], "empty series → nothing, no throw");
});

test("linebrIdBase: deterministic, positive, and collision-free across all fractal visual keys", () => {
  assert.equal(linebrIdBase("Up level 1"), linebrIdBase("Up level 1"), "same key → same base (redraws never churn ids)");
  const keys = [];
  for (let i = 1; i <= 12; i++) keys.push(`Up level ${i}`, `Down level ${i}`);
  const bases = keys.map((k) => linebrIdBase(k));
  for (let i = 0; i < bases.length; i++) {
    assert.ok(Number.isSafeInteger(bases[i]) && bases[i] > 0, `${keys[i]} base is a positive safe integer`);
    assert.equal(bases[i] % 1_000_000, 1, "base ≡ 1 (mod 1e6) — the segment-count stride");
    for (let j = i + 1; j < bases.length; j++) {
      assert.notEqual(bases[i], bases[j], `${keys[i]} and ${keys[j]} never share drawing ids`);
    }
  }
});

// ── D: engine-level — two real fractals at different prices ──────────────────

/**
 * 35 deterministic 1m bars producing EXACTLY two up-fractals that reuse slot 1
 * ("Up level 1"): pivot idx 10 at high 110, pivot idx 30 at high 105 (the first
 * level retires at emission bar 27, so the second reuses its slot). Closes
 * never reach either level, so neither truncates. The mid-tape trough creates a
 * down-fractal (harmless — different series).
 */
function twoFractalBars() {
  const highs = [
    100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, // pivot 10 (110)
    109, 108, 107, 106, 105, 104, 103, 102, 101, 100, 99, 98, 97, 96, 95, // trough at 25
    97, 99, 101, 103, 105, // pivot 30 (105)
    102, 101, 100, 99,
  ];
  return highs.map((h, i) => ({
    ts: T0 + i * MIN,
    open: h - 3,
    high: h,
    low: h - 6,
    close: h - 3,
    volume: 1000,
  }));
}

test("engine + adapter: slot-reused fractal levels (110 then 105) render as 2 horizontal segments confined to their own lifetimes", async () => {
  const bars = twoFractalBars();
  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, 60, null);
  const run = await eng.computeScriptVisuals({ id: "linebr-diag", source: FRACTAL_PINE_SOURCE, bindings: [] });
  assert.ok(run, "script must run");
  eng.dispose();

  // The slot-reuse regression: "Up level 1" must carry BOTH lifetimes as
  // separate finite runs (the shared-slot case that produced the diagonal).
  const up1 = fractalSeries(run, "Up level 1");
  assert.ok(up1, "Up level 1 series must exist");
  const runs = finiteSegments(up1);
  assert.equal(runs.length, 2, "two retired/reused lifetimes = two finite runs separated by whitespace");
  assert.equal(runs[0][0].value, 110, "first lifetime is the 110 resistance");
  assert.equal(runs[1][0].value, 105, "second lifetime is the 105 resistance");

  // Offset alignment: the first finite row lands ON its pivot candle.
  assert.equal(runs[0][0].ts, T0 + 10 * MIN, "110 level starts on its pivot (idx 10)");
  assert.equal(runs[1][0].ts, T0 + 30 * MIN, "105 level starts on its pivot (idx 30)");

  // The adapter is fed exactly what PineBridge feeds it.
  const segs = linebrSegmentsToDrawings(up1.data, "#009688", 2, 1);
  assert.equal(segs.length, 2, "one horizontal segment per lifetime — the diagonal is gone");
  assert.equal(segs[0].price1, 110);
  assert.equal(segs[0].price2, 110);
  assert.equal(segs[1].price1, 105);
  assert.equal(segs[1].price2, 105);

  // Each segment is confined to its own run's time span (no straddling).
  const runSpans = runs.map((r) => [r[0].ts, r[r.length - 1].ts]);
  segs.forEach((s, i) => {
    assert.equal(s.time1Ms, runSpans[i][0], `segment ${i} starts where its run starts`);
    assert.equal(s.time2Ms, runSpans[i][1], `segment ${i} ends where its run ends`);
  });
});

// ── E: PineBridge wiring (source-pinned — the .tsx is not Node-importable) ───

test("wiring: linebr visuals route through the primitive adapter and NEVER reach LineSeries", () => {
  const src = readSrc("src/components/TradingChart/PineBridge.tsx");
  // The branch gate + adapter call + early continue (skips addSeries(LineSeries)).
  assert.match(src, /if \(v\.type === "line" && v\.breakOnNa\) \{/);
  assert.match(src, /linebrSegmentsToDrawings\(v\.data, segColor, segWidth, idBase\)/);
  // Stale series cleanup: a previously-painted LineSeries for this ident is removed.
  assert.match(src, /A linebr visual no longer owns a data series/);
  // The render guard clears stale levels even when a run yields ZERO segments.
  assert.match(src, /if \(sawLinebr \|\| paneLines\.length > 0 \|\| paneBoxes\.length > 0\)/);
  // The adapter is imported from the pure service module (the tested code).
  assert.match(src, /import \{ linebrIdBase, linebrSegmentsToDrawings \} from "\.\.\/\.\.\/services\/pineDrawings"/);
});

test("wiring: line.new() drawings and continuous style_line series keep their existing paths", () => {
  const src = readSrc("src/components/TradingChart/PineBridge.tsx");
  // line.new() visuals still merge into the pane/overlay drawing lists.
  assert.match(src, /else if \(v\.type === "lines"\) \{[\s\S]*?seenDrawings = true;/);
  // Continuous lines (SMA/EMA/Bollinger) still use LineSeries + whitespace toLineData.
  assert.match(src, /const s = chart\.addSeries\(\s*LineSeries,/);
  assert.match(src, /series\.setData\(v\.data\.map\(\(p\) => toLineData\(p, stripColor\)\)\)/);
});



