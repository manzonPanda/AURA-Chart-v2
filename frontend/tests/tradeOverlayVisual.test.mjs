/**
 * P3-D VISUAL REFINEMENT — trade entry/exit marker tests (pure, no DOM).
 * Runs with Node's type stripping:  npm --prefix frontend run test
 *
 * Mandated matrix (all through the REAL TradeOverlayPrimitive renderer —
 * fake LWC timeScale + priceToCoordinate + canvas call recorder):
 *   1.  LONG entry triangle orientation        10. Losing trade → red dotted
 *   2.  LONG exit reverse-triangle             11. TP line NOT rendered
 *   3.  SHORT entry triangle                   12. SL line NOT rendered
 *   4.  SHORT exit reverse-triangle            13. Exact entry timestamp intact
 *   5.  Normal scale                           14. Exact exit timestamp intact
 *   6.  Inverted scale (flip; prices don't)    15. 1m rendering intact
 *   7.  Entry TIP = exact entry price          16. 3m rendering intact
 *   8.  Exit  TIP = exact exit price           17. Open trade behavior intact
 *   9.  Win → green dotted line                18. Account/epic switch intact
 *
 * No existing test is weakened; this file only ADDS coverage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TradeOverlayPrimitive,
  resolveExactTimeX,
  detectScaleOrientation,
  markerApex,
  bandOutcome,
} from "../src/components/TradingChart/TradeOverlayPrimitive.ts";
import { overlaysForEpic } from "../src/services/tradeOverlay.ts";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIMITIVE_SRC = fs.readFileSync(
  path.join(FRONTEND_ROOT, "src/components/TradingChart/TradeOverlayPrimitive.ts"),
  "utf8",
);

// ── fake chart: registered-time timeScale (same contract as the proven
//    tradeOverlayExactX suite) + a linear, optionally INVERTED price scale ────
function makeScale({ firstSec, lastSec, gridSec, barSpacingPx = 9, originPx = 100 }) {
  return {
    timeToCoordinate(time) {
      if (!Number.isFinite(time)) return null;
      const idx = (time - firstSec) / gridSec;
      if (!Number.isInteger(idx)) return null; // not a registered chart point
      if (time < firstSec || time > lastSec) return null;
      return originPx + idx * barSpacingPx;
    },
  };
}

const PX_PER_PRICE = 4;
// BASE_Y chosen so XAUUSD-range fixture prices (~4300) land WELL inside a
// 4000px canvas: y = 17400 − 4·price ≈ 100–160px (no EDGE_MARGIN clamping).
const BASE_Y = 17400;
function makeSeries({ invert = false } = {}) {
  return {
    // Normal: higher price → SMALLER y (up). Inverted: larger y (down).
    priceToCoordinate(price) {
      if (!Number.isFinite(price)) return null;
      return invert ? BASE_Y + price * PX_PER_PRICE : BASE_Y - price * PX_PER_PRICE;
    },
  };
}

/** Canvas 2D recorder: captures every fill/stroke with its state + vertices. */
function makeCtx() {
  const stack = [];
  const ctx = {
    fills: [],
    strokes: [],
    texts: [],
    arcs: [],
    strokeStyle: null,
    fillStyle: null,
    lineWidth: 1,
    dash: [],
    _pts: null,
    save() {
      stack.push({
        strokeStyle: ctx.strokeStyle,
        fillStyle: ctx.fillStyle,
        lineWidth: ctx.lineWidth,
        dash: [...ctx.dash],
      });
    },
    restore() {
      const s = stack.pop();
      if (s) {
        ctx.strokeStyle = s.strokeStyle;
        ctx.fillStyle = s.fillStyle;
        ctx.lineWidth = s.lineWidth;
        ctx.dash = s.dash;
      }
    },
    scale() {},
    beginPath() {
      ctx._pts = [];
    },
    moveTo(x, y) {
      ctx._pts.push({ x, y });
    },
    lineTo(x, y) {
      ctx._pts.push({ x, y });
    },
    closePath() {},
    setLineDash(d) {
      ctx.dash = [...d];
    },
    getLineDash() {
      return [...ctx.dash];
    },
    fill() {
      ctx.fills.push({ color: ctx.fillStyle, pts: ctx._pts.map((p) => ({ ...p })) });
    },
    stroke() {
      ctx.strokes.push({
        color: ctx.strokeStyle,
        lineWidth: ctx.lineWidth,
        dash: [...ctx.dash],
        pts: ctx._pts.map((p) => ({ ...p })),
      });
    },
    fillText(t) {
      ctx.texts.push(t);
    },
    arc(...a) {
      ctx.arcs.push(a);
    },
  };
  return ctx;
}

const T0 = Date.UTC(2026, 8, 23, 12, 0, 0) / 1000; // 12:00:00Z grid origin

/** Render overlay(s) through the REAL primitive; returns recorded canvas calls. */
function render(overlays, { invert = false, gridSec = 60, formingMs = null } = {}) {
  const scale = makeScale({
    firstSec: T0,
    lastSec: T0 + 3600 * gridSec,
    gridSec,
    barSpacingPx: 9,
  });
  const series = makeSeries({ invert });
  const prim = new TradeOverlayPrimitive();
  prim.attached({
    chart: { timeScale: () => scale },
    series,
    requestUpdate: () => {},
  });
  prim.setOverlays(overlays, formingMs, gridSec);
  const ctx = makeCtx();
  prim.renderer.draw({
    useBitmapCoordinateSpace: (cb) =>
      cb({
        context: ctx,
        mediaSize: { width: 4000, height: 4000 },
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      }),
  });
  return { ctx, scale, series };
}

/** Base fixture — real FTM3·224776-shaped XAUUSD row (T1 from the P3-D audit). */
const BASE_OVERLAY = {
  key: "t:15981486",
  mt5Symbol: "XAUUSD",
  epic: "GOLD",
  resolved: true,
  direction: "Buy",
  entryBucketMs: Date.UTC(2026, 8, 23, 12, 10, 0),
  exitBucketMs: Date.UTC(2026, 8, 23, 12, 13, 0),
  entryExactMs: Date.UTC(2026, 8, 23, 12, 10, 55), // 15:10:55 Helsinki
  exitExactMs: Date.UTC(2026, 8, 23, 12, 13, 20),
  entryPrice: 4315.11,
  exitPrice: 4317.08,
  sl: 4312.19,
  tp: 4326.47,
  lots: 0.17,
  pnl: 33.49,
  rrr: "2.1",
  status: "closed",
};
function ov(over = {}) {
  return { ...BASE_OVERLAY, ...over };
}

/** Recorded triangle fills (3 vertices) — entry = smaller x (earlier time). */
function triangles(ctx) {
  return ctx.fills.filter((f) => f.pts.length === 3);
}
function splitMarkers(ctx) {
  const tris = triangles(ctx);
  assert.ok(tris.length >= 1, "at least one triangle must be painted");
  const sorted = [...tris].sort((a, b) => a.pts[0].x - b.pts[0].x);
  return { entry: sorted[0], exit: sorted[1] ?? null, all: sorted };
}
/** Apex in SCREEN space: "up" ⇔ both base vertices are BELOW the tip. */
function apexOf(tri) {
  const [tip, b1, b2] = tri.pts;
  if (b1.y > tip.y && b2.y > tip.y) return "up";
  if (b1.y < tip.y && b2.y < tip.y) return "down";
  return "degenerate";
}
/** Every dashed stroke the primitive painted (the connecting band(s)). */
function bands(ctx) {
  return ctx.strokes.filter((s) => s.dash.length > 0);
}

// ── 1–5. LONG/SHORT entry/exit orientation on the NORMAL scale ───────────────
test("1+5: LONG entry triangle points UP on the normal scale (tip at price)", () => {
  const { ctx, series } = render([ov({ direction: "Buy" })]);
  const { entry } = splitMarkers(ctx);
  assert.equal(apexOf(entry), "up", "long entry apex points up on screen");
  assert.equal(entry.pts[0].y, series.priceToCoordinate(BASE_OVERLAY.entryPrice));
  assert.equal(detectScaleOrientation(series, BASE_OVERLAY.entryPrice), "normal");
});

test("2+5: LONG exit is the REVERSE triangle — points DOWN on the normal scale", () => {
  const { ctx } = render([ov({ direction: "Buy" })]);
  const { entry, exit } = splitMarkers(ctx);
  assert.ok(exit, "a closed trade paints an exit marker");
  assert.equal(apexOf(exit), "down", "long exit apex points down on screen");
  assert.notEqual(apexOf(exit), apexOf(entry), "exit apex is REVERSE of entry");
});

test("3+5: SHORT entry triangle points DOWN on the normal scale", () => {
  const { ctx } = render([ov({ direction: "Sell" })]);
  const { entry } = splitMarkers(ctx);
  assert.equal(apexOf(entry), "down", "short entry apex points down on screen");
});

test("4+5: SHORT exit is the REVERSE triangle — points UP on the normal scale", () => {
  const { ctx } = render([ov({ direction: "Sell" })]);
  const { entry, exit } = splitMarkers(ctx);
  assert.ok(exit, "a closed trade paints an exit marker");
  assert.equal(apexOf(exit), "up", "short exit apex points up on screen");
  assert.notEqual(apexOf(exit), apexOf(entry), "exit apex is REVERSE of entry");
});

// ── 6. INVERTED scale — directions flip, numerical anchors do not ────────────
test("6: inverted scale flips ALL four apexes while tips stay on the same prices", () => {
  const cases = [
    { direction: "Buy", normal: { entry: "up", exit: "down" }, inverted: { entry: "down", exit: "up" } },
    { direction: "Sell", normal: { entry: "down", exit: "up" }, inverted: { entry: "up", exit: "down" } },
  ];
  for (const c of cases) {
    // NORMAL scale:
    const n = render([ov({ direction: c.direction })]);
    assert.equal(detectScaleOrientation(n.series, BASE_OVERLAY.entryPrice), "normal");
    const nM = splitMarkers(n.ctx);
    assert.equal(apexOf(nM.entry), c.normal.entry, `${c.direction} entry normal`);
    assert.equal(apexOf(nM.exit), c.normal.exit, `${c.direction} exit normal`);
    // INVERTED scale:
    const i = render([ov({ direction: c.direction })], { invert: true });
    assert.equal(
      detectScaleOrientation(i.series, BASE_OVERLAY.entryPrice),
      "inverted",
      "orientation is MEASURED from priceToCoordinate, not hardcoded",
    );
    const iM = splitMarkers(i.ctx);
    assert.equal(apexOf(iM.entry), c.inverted.entry, `${c.direction} entry inverted`);
    assert.equal(apexOf(iM.exit), c.inverted.exit, `${c.direction} exit inverted`);
    // SAME numerical anchors — only the visual direction moved:
    assert.equal(iM.entry.pts[0].y, i.series.priceToCoordinate(BASE_OVERLAY.entryPrice));
    assert.equal(iM.exit.pts[0].y, i.series.priceToCoordinate(BASE_OVERLAY.exitPrice));
    assert.notEqual(iM.entry.pts[0].y, nM.entry.pts[0].y, "y follows the scale's mapping");
  }
});

test("6b: pure helpers — markerApex flips with orientation, never with price", () => {
  assert.equal(markerApex("entry", "Buy", "normal"), "up");
  assert.equal(markerApex("exit", "Buy", "normal"), "down");
  assert.equal(markerApex("entry", "Sell", "normal"), "down");
  assert.equal(markerApex("exit", "Sell", "normal"), "up");
  assert.equal(markerApex("entry", "Buy", "inverted"), "down");
  assert.equal(markerApex("exit", "Buy", "inverted"), "up");
  assert.equal(markerApex("entry", "Sell", "inverted"), "up");
  assert.equal(markerApex("exit", "Sell", "inverted"), "down");
});

// ── 7–8. TIP anchoring to the exact execution prices ─────────────────────────
test("7: entry triangle TIP is exactly the coordinate of overlay.entryPrice", () => {
  for (const invert of [false, true]) {
    const { ctx, series } = render([ov()], { invert });
    const { entry } = splitMarkers(ctx);
    assert.equal(entry.pts[0].y, series.priceToCoordinate(BASE_OVERLAY.entryPrice));
    // The TIP — not the center: base vertices are a full triangle-height away.
    const [, b1, b2] = entry.pts;
    assert.ok(Math.abs(b1.y - entry.pts[0].y) >= 10 && Math.abs(b2.y - entry.pts[0].y) >= 10);
  }
});

test("8: exit triangle TIP is exactly the coordinate of overlay.exitPrice", () => {
  for (const invert of [false, true]) {
    const { ctx, series } = render([ov()], { invert });
    const { exit } = splitMarkers(ctx);
    assert.ok(exit, "closed trade renders exit marker");
    assert.equal(exit.pts[0].y, series.priceToCoordinate(BASE_OVERLAY.exitPrice));
    assert.notEqual(exit.pts[0].y, series.priceToCoordinate(BASE_OVERLAY.entryPrice));
  }
});

// ── 9–10. Dotted result-colored connecting line ──────────────────────────────
test("9: winning trade (pnl > 0) uses a GREEN DOTTED connecting line", () => {
  const { ctx } = render([ov({ pnl: 33.49, status: "closed" })]);
  const b = bands(ctx);
  assert.equal(b.length, 1, "exactly one connecting band");
  assert.equal(b[0].color, "#26a69a", "green");
  assert.deepEqual(b[0].dash, [2, 3], "dotted, NOT solid");
  assert.equal(bandOutcome({ status: "closed", pnl: 33.49 }), "win");
});

test("10: losing trade (pnl < 0) uses a RED DOTTED connecting line", () => {
  const { ctx } = render([ov({ pnl: -34.86, status: "closed" })]);
  const b = bands(ctx);
  assert.equal(b.length, 1, "exactly one connecting band");
  assert.equal(b[0].color, "#ef5350", "red");
  assert.deepEqual(b[0].dash, [2, 3], "dotted, NOT solid");
  assert.equal(bandOutcome({ status: "closed", pnl: -34.86 }), "loss");
});

test("9b/10b: break-even and unknown P/L are never arbitrarily classified", () => {
  assert.equal(bandOutcome({ status: "closed", pnl: 0 }), "neutral");
  assert.equal(bandOutcome({ status: "closed", pnl: null }), "neutral");
  assert.equal(bandOutcome({ status: "open", pnl: null }), "open");
  const even = bands(render([ov({ pnl: 0 })]).ctx);
  assert.equal(even[0].color, "rgba(148, 163, 184, 0.9)", "keeps the pre-existing gray");
  assert.deepEqual(even[0].dash, [2, 3], "still dotted");
});

// ── 11–12. TP/SL rendering removed (rendering-only change) ───────────────────
test("11+12: TP and SL lines are NOT rendered even when the data is present", () => {
  const { ctx } = render([ov({ sl: 4312.19, tp: 4326.47 })]);
  // The overlay still CARRIES the data (rendering-only removal)…
  assert.equal(BASE_OVERLAY.sl, 4312.19);
  assert.equal(BASE_OVERLAY.tp, 4326.47);
  // …but nothing is painted at their coordinates:
  const slY = makeSeries().priceToCoordinate(4312.19);
  const tpY = makeSeries().priceToCoordinate(4326.47);
  for (const s of ctx.strokes) {
    if (s.pts.length < 2) continue;
    const horizontal = s.pts.every((p) => p.y === s.pts[0].y);
    if (horizontal) {
      assert.notEqual(s.pts[0].y, slY, "no horizontal line at the SL price");
      assert.notEqual(s.pts[0].y, tpY, "no horizontal line at the TP price");
    }
  }
  assert.equal(ctx.texts.length, 0, "no SL/TP labels");
  assert.deepEqual(ctx.arcs, [], "no leftover ring geometry");
});

test("11b/12b: source guard — the SL/TP painter is gone from the primitive", () => {
  const src = PRIMITIVE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!src.includes("drawLevel"), "drawLevel removed");
  assert.ok(!src.includes("SL_COLOR"), "SL color removed");
  assert.ok(!src.includes("TP_COLOR"), "TP color removed");
  // The HISTORICAL path paints no captions. Text exists in this file ONLY for the
  // additive read-only live/risk plate labels, so scope the assertion to the
  // historical painters rather than the whole module.
  const historical = src.slice(0, src.indexOf("drawLiveOverlays("));
  assert.ok(!historical.includes("fillText"), "no historical overlay captions at all");
});

// ── 13–16. Exact timestamps + 1m/3m rendering (P3-D interpolation intact) ────
test("13+15: 1m — entry/exit TIPS sit at the exact interpolated timestamps", () => {
  const { ctx, scale } = render([ov()], { gridSec: 60 });
  const { entry, exit } = splitMarkers(ctx);
  const wantEntryX = resolveExactTimeX(BASE_OVERLAY.entryExactMs, 60_000, scale);
  const wantExitX = resolveExactTimeX(BASE_OVERLAY.exitExactMs, 60_000, scale);
  assert.equal(typeof wantEntryX, "number");
  assert.equal(entry.pts[0].x, wantEntryX, "entry tip X = exact interpolated entry time");
  assert.equal(exit.pts[0].x, wantExitX, "exit tip X = exact interpolated exit time");
  // NOT the bucket start (the P3-D regression this guards against):
  const entryBucketX = scale.timeToCoordinate(BASE_OVERLAY.entryBucketMs / 1000);
  assert.ok(entry.pts[0].x > entryBucketX, "entry is INSIDE its candle, not at bucket start");
  // Exit timestamp travels with the band end too:
  const band = bands(ctx)[0];
  assert.equal(band.pts[band.pts.length - 1].x, wantExitX, "band ends at the exact exit time");
});

test("14+16: 3m — exact :55s timestamp still resolves on the 180s grid", () => {
  // 12:10:55 → minute%3 = 1 — NOT a registered 3m point (the old null-skip).
  const gridSec = 180;
  const { ctx, scale } = render([ov()], { gridSec });
  assert.equal(
    scale.timeToCoordinate(BASE_OVERLAY.entryExactMs / 1000),
    null,
    "the exact time is not itself registered on 3m",
  );
  const { entry, exit } = splitMarkers(ctx);
  const wantEntryX = resolveExactTimeX(BASE_OVERLAY.entryExactMs, 180_000, scale);
  const wantExitX = resolveExactTimeX(BASE_OVERLAY.exitExactMs, 180_000, scale);
  assert.equal(entry.pts[0].x, wantEntryX, "1m-bucketed trade renders on the 3m chart");
  assert.equal(exit.pts[0].x, wantExitX, "exit interpolates on 3m too");
});

// ── 17. Open trade behavior preserved ────────────────────────────────────────
test("17: open trade — entry only, dashed slate extension to the forming bucket", () => {
  const open = ov({
    exitBucketMs: null,
    exitExactMs: null,
    exitPrice: null,
    pnl: null,
    status: "open",
  });
  const formingMs = Date.UTC(2026, 8, 23, 12, 30, 0);
  const { ctx, scale } = render([open], { formingMs });
  const tris = triangles(ctx);
  assert.equal(tris.length, 1, "open trade renders ONLY the entry triangle");
  const b = bands(ctx);
  assert.equal(b.length, 1, "open band still drawn");
  assert.deepEqual(b[0].dash, [5, 4], "pre-existing open dashed pattern");
  assert.equal(b[0].color, "rgba(148, 163, 184, 0.75)", "pre-existing open slate");
  assert.equal(
    b[0].pts[b[0].pts.length - 1].x,
    scale.timeToCoordinate(formingMs / 1000),
    "extends to the forming bucket (registered point), never an invented time",
  );
  assert.equal(b[0].pts[0].y, b[0].pts[1].y, "horizontal at the entry price (no exit price)");
  assert.equal(bandOutcome({ status: "open", pnl: null }), "open", "never classified won/lost");
});

// ── 18. Account/epic switching — visibility filter unchanged ─────────────────
test("18: overlaysForEpic still scopes rendering to the selected instrument", () => {
  const gold = ov({ key: "t:1", epic: "GOLD", resolved: true });
  // Different trade window → strictly different geometry after a switch:
  const other = ov({
    key: "t:2",
    epic: "NQ",
    resolved: true,
    entryExactMs: Date.UTC(2026, 8, 23, 14, 20, 12),
    exitExactMs: Date.UTC(2026, 8, 23, 14, 25, 40),
    entryPrice: 4350.5,
    exitPrice: 4344.75,
  });
  const unresolved = ov({ key: "t:3", epic: "DE40", resolved: false });
  const all = [gold, other, unresolved];

  const onGold = overlaysForEpic(all, "GOLD");
  assert.deepEqual(onGold.map((o) => o.key), ["t:1"]);
  const { ctx } = render(onGold);
  assert.equal(triangles(ctx).length, 2, "only the selected epic's entry+exit paint");

  // Switching the selection repaints ONLY the new set — no stale markers.
  const onNq = overlaysForEpic(all, "NQ");
  const switched = render(onNq);
  assert.deepEqual(onNq.map((o) => o.key), ["t:2"]);
  assert.equal(triangles(switched.ctx).length, 2);
  assert.notEqual(
    triangles(switched.ctx)[0].pts[0].x,
    triangles(ctx)[0].pts[0].x,
    "different trade → different geometry (full repaint, no carry-over)",
  );
  assert.deepEqual(overlaysForEpic(all, null), [], "no epic ⇒ nothing renders");
});
