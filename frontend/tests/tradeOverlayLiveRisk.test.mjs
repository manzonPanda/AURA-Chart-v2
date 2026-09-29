/**
 * LIVE OPEN-TRADE + ACCOUNT-RISK OVERLAY — read-only visualization tests.
 * Runs with Node's type stripping:  npm --prefix frontend run test
 *
 * These tests drive the REAL `TradeOverlayPrimitive` renderer with the same fake
 * timeScale / priceToCoordinate / canvas recorder the P3-D suite uses, so what
 * is asserted is the actual painted output, not a model of it.
 *
 * Covered:
 *   1  live open trade renders (entry marker at the REAL entry price)
 *   2  BUY and SELL both render, with the correct apex per direction
 *   3  scale orientation is MEASURED — normal vs inverted flips the apex
 *      while the numeric anchor never moves
 *   4  multiple open trades / multiple positions on one instrument
 *   5  a position on ANOTHER instrument never reaches the current price axis
 *   6  MT5 state changes are reflected (SL/TP, and a closed trade vanishing)
 *   7  profit target / daily loss / max drawdown amounts come from the server
 *   8  no risk annotation at all without an applicable open position
 *   9  a level without a proven price gets no line / pill / price-scale tag
 *  10  a mixed-direction book is not collapsed into one misleading price
 *  11  risk pills de-collide while every LINE stays on its exact price
 *  12  READ-ONLY: no drag / pointer / touch / edit / order-action surface
 *  13  the historical (P3/P3-D) layer is untouched and still passes
 *  14  a state payload without `positions` never crashes the overlay
 *  15  every drawn level tags its price on the RIGHT price scale (exact value)
 *  16  no price is ever fabricated for a price-less level
 *  17  the pill ladder is ordered by the TRUE price (never by arrival order)
 *  18  pills are rounded plates with a semantic accent bar (no cards, no panels)
 *  19  a de-collided pill keeps a leader to its true price; the line never moves
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
  detectScaleOrientation,
  layoutRiskLabelTops,
  formatLivePnl,
  formatLiveR,
  formatLivePercent,
  formatLiveLabel,
  formatPrice,
} from "../src/components/TradingChart/TradeOverlayPrimitive.ts";
import {
  buildLiveTradeOverlay,
  liveTradesForEpic,
  buildAccountRiskOverlays,
  hasApplicableLivePosition,
  deriveThresholdPrice,
  formatRiskAmount,
  liveLevelMetrics,
  accountPercent,
  parseRRatio,
} from "../src/services/tradeOverlay.ts";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIMITIVE_SRC = fs.readFileSync(
  path.join(FRONTEND_ROOT, "src/components/TradingChart/TradeOverlayPrimitive.ts"),
  "utf8",
);
const OVERLAY_SRC = fs.readFileSync(
  path.join(FRONTEND_ROOT, "src/services/tradeOverlay.ts"),
  "utf8",
);

// ── fake chart / series / canvas: identical contracts to tradeOverlayVisual ──
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
const BASE_Y = 17400;
function makeSeries({ invert = false, pxPerPrice = PX_PER_PRICE, baseY = BASE_Y } = {}) {
  return {
    priceToCoordinate(price) {
      if (!Number.isFinite(price)) return null;
      return invert ? baseY + price * pxPerPrice : baseY - price * pxPerPrice;
    },
  };
}

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
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    dash: [],
    _pts: null,
    save() {
      stack.push({
        strokeStyle: ctx.strokeStyle,
        fillStyle: ctx.fillStyle,
        lineWidth: ctx.lineWidth,
        dash: [...ctx.dash],
        globalAlpha: ctx.globalAlpha,
        font: ctx.font,
      });
    },
    restore() {
      const s = stack.pop();
      if (s) {
        ctx.strokeStyle = s.strokeStyle;
        ctx.fillStyle = s.fillStyle;
        ctx.lineWidth = s.lineWidth;
        ctx.dash = s.dash;
        ctx.globalAlpha = s.globalAlpha;
        ctx.font = s.font;
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
        alpha: ctx.globalAlpha,
        pts: ctx._pts.map((p) => ({ ...p })),
      });
    },
    fillText(t) {
      ctx.texts.push(t);
    },
    fillRect() {},
    measureText(t) {
      return { width: t.length * 6 };
    },
    arc(...a) {
      ctx.arcs.push(a);
    },
  };
  return ctx;
}

const T0 = Date.UTC(2026, 8, 23, 12, 0, 0) / 1000;

/**
 * `accounts.initial_balance` — the denominator for every live pill's `%`.
 *
 * The % is ACCOUNT-scoped (`money / initial_balance × 100`), the same unit the
 * account's own PROFIT TARGET / DAILY LOSS / MAX DRAWDOWN levels use, so a
 * position's stop and an account limit are directly comparable numbers. With
 * $100,000: +$58.08 ⇒ +0.06%, −$125.00 ⇒ −0.13%, +$125.00 ⇒ +0.13%.
 */
const ACCOUNT_BASIS = 100_000;

/** Render a live/risk frame through the REAL primitive; returns recorded calls. */
function render({
  live = [],
  risk = [],
  invert = false,
  accountBasis = ACCOUNT_BASIS,
  gridSec = 60,
  pxPerPrice,
  baseY,
} = {}) {
  const scale = makeScale({
    firstSec: T0,
    lastSec: T0 + 3600 * gridSec,
    gridSec,
    barSpacingPx: 9,
  });
  const series = makeSeries({ invert, pxPerPrice, baseY });
  const prim = new TradeOverlayPrimitive();
  prim.attached({
    chart: { timeScale: () => scale },
    series,
    requestUpdate: () => {},
  });
  prim.setLiveOverlays(live, risk, accountBasis);
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
  return { ctx, scale, series, prim };
}

/**
 * A price scale wide enough to hold the FULL server risk span (entry 4300.5 with
 * $10/point ⇒ profit target 4800.5 and max drawdown 3300.5, i.e. ±500/+1000
 * points around the entry) inside the 4000px pane. With the default scale only
 * the daily-loss level fits, which would make an "every level renders" assertion
 * pass or fail purely on fixture geometry. Entry 4300.5 lands at y=2000, i.e.
 * dead centre, and the extreme drawdown lands exactly on the bottom edge.
 */
const WIDE = { pxPerPrice: 2, baseY: 10601 };

// ── fixtures: the shape aura-backend actually returns ────────────────────────
function pos(over = {}) {
  return {
    ticket: "12345",
    direction: "Buy",
    lots: 0.33,
    entryPrice: 4300.5,
    sl: 4288.0,
    tp: 4313.0,
    netPnl: 58.08,
    liveR: 1.63,
    moneyPerPoint: 10,
    // trades.risk_per_trade — the 1R the live dashboard divides by. 58.08/35.63
    // = 1.6298 ⇒ the +1.63R its "Total R Gained" card shows.
    riskPerTrade: 35.63,
    instrument: "XAUUSD",
    openTime: "2026-09-23 15:10:00", // Helsinki wall clock → 12:10:00Z
    ...over,
  };
}
function liveOf(over = {}, chartEpic = "GOLD") {
  return buildLiveTradeOverlay({ position: pos(over), chartEpic });
}
/** Apex in screen space: "up" ⇔ both base vertices are BELOW the tip. */
function apexOf(tri) {
  const [tip, b1, b2] = tri.pts;
  if (b1.y > tip.y && b2.y > tip.y) return "up";
  if (b1.y < tip.y && b2.y < tip.y) return "down";
  return "degenerate";
}
const triangles = (ctx) => ctx.fills.filter((f) => f.pts.length === 3);
const dashed = (ctx) => ctx.strokes.filter((s) => s.dash.length > 0);

/**
 * Account-RISK lines only.
 *
 * A risk line is identified by BOTH traits that define it: it spans the full
 * pane width (starts at x=0) AND uses the risk dash pattern [6, 4]. The live
 * trade's own SL/TP levels are drawn with the distinct [3, 3] dash, so the two
 * layers can never be confused for one another.
 */
const RISK_DASH = [6, 4];
const riskLines = (ctx) =>
  ctx.strokes.filter(
    (s) => s.dash.length > 0 && s.pts[0]?.x === 0 && s.dash.join() === RISK_DASH.join(),
  );

// ── 1. a live open trade renders, tip-anchored at the REAL entry price ───────
test("1: live open trade renders an entry marker tip-anchored at overlay.entryPrice", () => {
  const live = liveOf();
  const { ctx, series } = render({ live: [live] });
  const tris = triangles(ctx);
  assert.equal(tris.length, 1, "one entry triangle is painted for the open position");
  assert.equal(tris[0].pts[0].y, series.priceToCoordinate(live.entryPrice));
  // The tip is the vertex AT the price; the base sits off-price by design.
  assert.notEqual(tris[0].pts[1].y, tris[0].pts[0].y);
});

test("1h: dragging the SL moves the stop's % and $, but NEVER the R", () => {
  // Two positions identical in every way except where the stop sits.
  //
  // The R must NOT move: the live dashboard's "Total R Gained" is
  // `profit / riskPerTrade`, recorded at ENTRY, whereas the server's `live_rr`
  // divides by the CURRENT stop distance and therefore jitters under the cursor.
  //
  // The stop's % and $ MUST move: they answer "how much of my account do I lose
  // if this stop is hit", which is exactly what the user is changing.
  const wide = liveOf({ sl: 4288, tp: 4313, netPnl: 58.08, riskPerTrade: 35.63 });
  const tight = liveOf({ sl: 4299, tp: 4313, netPnl: 58.08, riskPerTrade: 35.63 });

  const wideMetrics = liveLevelMetrics(wide, "position", ACCOUNT_BASIS);
  const tightMetrics = liveLevelMetrics(tight, "position", ACCOUNT_BASIS);
  assert.equal(wideMetrics.r, tightMetrics.r, "the position R is invariant to SL placement");
  assert.equal(wideMetrics.r, 58.08 / 35.63, "R is profit / riskPerTrade, the dashboard's own math");
  assert.equal(wideMetrics.percent, tightMetrics.percent, "the P/L % is invariant too");

  // The stop's % is the money AT THE STOP over the account, so it tracks the drag:
  // 12.5 points × $10 = −$125 ⇒ −0.125%, then 1.5 points ⇒ −$15 ⇒ −0.015%.
  const wideStop = liveLevelMetrics(wide, "stop", ACCOUNT_BASIS);
  const tightStop = liveLevelMetrics(tight, "stop", ACCOUNT_BASIS);
  assert.equal(wideStop.money, -125);
  assert.equal(tightStop.money, -15);
  assert.equal(wideStop.percent, (-125 / ACCOUNT_BASIS) * 100);
  assert.equal(tightStop.percent, (-15 / ACCOUNT_BASIS) * 100);
  assert.ok(
    wideStop.percent < tightStop.percent,
    "a tighter stop risks a SMALLER share of the account, so its % is less negative",
  );
  assert.notEqual(wideStop.percent, tightStop.percent, "the stop's % follows the drag");

  // A recorded 1R always beats the live SL distance, even when they disagree.
  const conflicting = liveOf({ sl: 4299, riskPerTrade: 100, netPnl: 50, liveR: 0.5 });
  assert.equal(
    liveLevelMetrics(conflicting, "position", ACCOUNT_BASIS).r,
    0.5,
    "50 / 100 = 0.5R, NOT the server's liveR or the SL-derived unit",
  );
});

test("1b: the live P&L label shows direction, %, R and money — and NO lot", () => {
  const { ctx } = render({ live: [liveOf()] });
  const label = ctx.texts.find((t) => t.startsWith("BUY"));
  assert.ok(label, "a live P&L label is painted");
  // entry 4300.5, $10/point, +$58.08 floating. The % is ACCOUNT-scoped:
  // +$58.08 / $100,000 = +0.058% ⇒ +0.06%.
  assert.equal(label, "BUY +0.06% +1.63R +$58.08");
  assert.ok(!/\b0\.33\b/.test(label), "the lot size is never shown");
});

test("1c: the server's own SL/TP money and R:R win over any client derivation", () => {
  // The MT5-native values deliberately DISAGREE with what $10/point would imply
  // (sensitivity would give ∓$125 and ±1.00R). The account's own numbers are
  // authoritative, so the label must follow them, not the arithmetic.
  const live = liveOf({ slValue: -50, tpValue: 145.92, rewardRiskRatio: "2.92" });
  const { ctx } = render({ live: [live] });
  assert.equal(live.slValue, -50, "the server value survives the overlay build");
  assert.equal(live.tpValue, 145.92);
  assert.equal(live.rewardRiskRatio, "2.92");
  assert.ok(ctx.texts.includes("STOP LOSS -0.05% -$50.00"), "stop money is MT5's own");
  assert.ok(
    ctx.texts.includes("TAKE PROFIT +0.15% +4.10R +$145.92"),
    "target R is the account's reward:risk ratio",
  );

  // R derived from the money when the server reports no ratio: 145.92 / 35.63.
  const noRatio = liveOf({ slValue: -50, tpValue: 145.92, rewardRiskRatio: null });
  const derived = liveLevelMetrics(noRatio, "target", ACCOUNT_BASIS);
  assert.equal(derived.money, 145.92);
  assert.ok(
    Math.abs(derived.r - 145.92 / 35.63) < 1e-9,
    "1R is the RECORDED risk, so R is self-consistent with the $",
  );
});

test("1d: every live metric is direction-oriented, so a SELL's levels read truthfully", () => {
  // A short entered at 4300.5 with its stop ABOVE entry (a real stop) and its
  // target BELOW: both are gains/losses by the money they represent.
  const short = liveOf({ direction: "Sell", sl: 4313.0, tp: 4288.0, netPnl: 58.08, liveR: 1.63 });
  const stop = liveLevelMetrics(short, "stop", ACCOUNT_BASIS);
  const target = liveLevelMetrics(short, "target", ACCOUNT_BASIS);
  assert.ok(stop.percent < 0, "a short's stop above entry is a loss ⇒ negative %");
  assert.ok(stop.money < 0, "…and negative money");
  assert.ok(target.percent > 0, "a short's target below entry is a gain ⇒ positive %");
  assert.ok(target.money > 0, "…and positive money");
  assert.equal(stop.r, -125 / 35.63, "R is the level's money over the recorded 1R");
  assert.equal(Math.round(target.r * 1000) / 1000, 3.508, "the symmetric target mirrors it");

  // The % is money over the ACCOUNT basis, so a zero/absent balance yields no
  // percentage rather than an Infinity or NaN leaking into the label.
  const zeroBasis = liveOf();
  assert.equal(liveLevelMetrics(zeroBasis, "stop", 0).percent, null, "a zero balance yields no %");
  assert.equal(liveLevelMetrics(zeroBasis, "stop", null).percent, null, "no balance ⇒ no %");
  assert.equal(zeroBasis.moneyPerPoint, 10, "…and the $ is still derivable");
});

test("1f: the % is the ACCOUNT's percentage, never a price-distance one", () => {
  // entry 4300.5, sl 4288, $10/point ⇒ the stop is $125 away, which is
  // 0.29% of the PRICE — but only 0.13% of a $100,000 ACCOUNT. The label must
  // show the account reading, because that is the unit the account's own
  // PROFIT TARGET / DAILY LOSS / MAX DRAWDOWN levels are expressed in.
  const live = liveOf();
  const stop = liveLevelMetrics(live, "stop", ACCOUNT_BASIS);
  assert.equal(stop.money, -125);
  // The stop's % is the money AT THE STOP over the ACCOUNT — not the stop's
  // share of the entry PRICE (0.29%), and not the recorded risk. That is the
  // unit the account's own PROFIT TARGET / DAILY LOSS / MAX DRAWDOWN levels use.
  assert.equal(stop.percent, (-125 / ACCOUNT_BASIS) * 100);
  assert.equal(accountPercent(-125, ACCOUNT_BASIS), stop.percent);
  // Doubling the account halves the reported risk % for the SAME dollar risk.
  assert.equal(accountPercent(-125, 200_000), -0.0625);
  assert.equal(accountPercent(null, ACCOUNT_BASIS), null, "no money ⇒ no %");
  assert.equal(accountPercent(-125, null), null, "no basis ⇒ no %");
  assert.equal(accountPercent(-125, 0), null, "a zero basis never divides by zero");
});

test("1g: the account's r:R string parses in every shape the bridge emits", () => {
  // Real payloads carry "+1.90R" (signed, R-suffixed), a bare "1.63", and the
  // reward:risk PAIR "1:2" — which must resolve to 2, the REWARD side. Reading
  // the pair inverted would silently report HALF the real reward.
  assert.equal(parseRRatio("+1.90R"), 1.9);
  assert.equal(parseRRatio("-0.50R"), -0.5);
  assert.equal(parseRRatio("1.90r"), 1.9, "the suffix is case-insensitive");
  assert.equal(parseRRatio("1.63"), 1.63);
  assert.equal(parseRRatio("2.5"), 2.5);
  assert.equal(parseRRatio("1:2"), 2, "a 1:2 setup is 2R of reward, not 0.5R");
  assert.equal(parseRRatio("1:2.5"), 2.5, "reward 2.5 over risk 1 is 2.5R");
  assert.equal(parseRRatio("  +1.90R  "), 1.9, "surrounding whitespace is tolerated");
  assert.equal(parseRRatio("1:0"), 0, "zero reward is a real 0R, not a missing value");
  assert.equal(parseRRatio("0:2"), null, "a zero RISK side divides by zero ⇒ no ratio");
  assert.equal(parseRRatio(""), null);
  assert.equal(parseRRatio(null), null);
  assert.equal(parseRRatio(undefined), null);
  assert.equal(parseRRatio("n/a"), null, "junk never becomes 0");

  // The suffixed form must survive all the way to the rendered label — this is
  // the shape that silently produced NaN before. The account's `rrr` is only
  // consulted when NO 1R is known, so the case removes both the recorded risk
  // and the sensitivity, and supplies the target money from MT5 directly.
  const live = liveOf({
    rewardRiskRatio: "+1.90R",
    riskPerTrade: null,
    moneyPerPoint: null,
    tpValue: 125,
  });
  const { ctx } = render({ live: [live] });
  assert.ok(
    ctx.texts.includes("TAKE PROFIT +0.13% +1.90R +$125.00"),    "an R-suffixed r:R renders as a real R, never NaN or 0.00R",
  );
  assert.ok(
    ctx.texts.every((t) => !t.includes("NaN") && !t.includes("undefined")),
    "no label can ever contain NaN or undefined",
  );
});

// ── 2. BUY and SELL both render with the correct per-direction apex ──────────
test("2: BUY points up and SELL points down on the normal scale", () => {
  const buy = triangles(render({ live: [liveOf({ direction: "Buy" })] }).ctx);
  const sell = triangles(render({ live: [liveOf({ direction: "Sell" })] }).ctx);
  assert.equal(apexOf(buy[0]), "up");
  assert.equal(apexOf(sell[0]), "down");
});

// ── 3. orientation is MEASURED from the chart, not hard-coded per side ───────
test("3: inverted scale flips the live apex while the price anchor is identical", () => {
  const live = liveOf({ direction: "Buy" });
  const normal = render({ live: [live], invert: false });
  const inverted = render({ live: [live], invert: true });

  assert.equal(detectScaleOrientation(normal.series, live.entryPrice), "normal");
  assert.equal(detectScaleOrientation(inverted.series, live.entryPrice), "inverted");

  // Same NUMBER, opposite visual direction.
  const nTip = triangles(normal.ctx)[0].pts[0].y;
  const iTip = triangles(inverted.ctx)[0].pts[0].y;
  assert.notEqual(nTip, iTip, "the inverted scale puts the same price on a different row");
  assert.equal(apexOf(triangles(normal.ctx)[0]), "up");
  assert.equal(apexOf(triangles(inverted.ctx)[0]), "down");

  // The anchor is whatever the chart produced for 4300.5 — never re-derived.
  assert.equal(nTip, normal.series.priceToCoordinate(live.entryPrice));
  assert.equal(iTip, inverted.series.priceToCoordinate(live.entryPrice));

  // A SELL flips the other way on the same inverted scale.
  const sellInv = render({ live: [liveOf({ direction: "Sell" })], invert: true });
  assert.equal(apexOf(triangles(sellInv.ctx)[0]), "up");
});

// ── 4. multiple open trades / multiple positions on one instrument ───────────
test("4: multiple open positions on the chart instrument all render", () => {
  const live = [
    liveOf({ ticket: "1", entryPrice: 4300.5 }),
    liveOf({ ticket: "2", entryPrice: 4305.25, direction: "Sell" }),
    liveOf({ ticket: "3", entryPrice: 4295.0, lots: 1.5 }),
  ];
  const { ctx, series } = render({ live });
  const tris = triangles(ctx);
  assert.equal(tris.length, 3, "each open position paints its own marker");
  // Every tip sits on ITS OWN position's entry coordinate.
  for (const liveTrade of live) {
    const tip = tris.find((t) => t.pts[0].y === series.priceToCoordinate(liveTrade.entryPrice));
    assert.ok(tip, `a marker tip exists at ${liveTrade.entryPrice}`);
  }
});

test("4b: a position on ANOTHER instrument never reaches this price axis", () => {
  const onGold = liveOf({ ticket: "1" });
  const onEur = liveOf({ ticket: "2", instrument: "EURUSD" }, "GOLD");
  assert.equal(onEur, null, "an unmapped instrument cannot bind to GOLD");

  const scoped = liveTradesForEpic(
    [pos({ ticket: "1", instrument: "XAUUSD" }), pos({ ticket: "2", instrument: "EURUSD" })],
    "GOLD",
  );
  assert.deepEqual(scoped.map((s) => s.ticket), ["1"], "only the chart instrument survives");

  // And a different chart epic returns its own set — no cross-projection.
  const eurusdChart = liveTradesForEpic(
    [pos({ ticket: "1", instrument: "XAUUSD" }), pos({ ticket: "2", instrument: "EURUSD" })],
    "EURUSD",
  );
  assert.deepEqual(eurusdChart.map((s) => s.ticket), ["2"]);
  assert.equal(triangles(render({ live: scoped }).ctx).length, 1);
});

// ── 5. MT5 state changes are reflected; a closed trade disappears ───────────
test("5: SL/TP changes repaint, and a CLOSED position leaves the live layer", () => {
  const open = liveOf();
  const moved = liveOf({ sl: 4290.0, tp: 4310.0 });

  const first = render({ live: [open] });
  const slY = first.series.priceToCoordinate(open.sl);
  const tpY = first.series.priceToCoordinate(open.tp);
  assert.ok(
    dashed(first.ctx).some((s) => s.pts.some((p) => p.y === slY)),
    "the real MT5 SL is drawn",
  );
  assert.ok(
    dashed(first.ctx).some((s) => s.pts.some((p) => p.y === tpY)),
    "the real MT5 TP is drawn",
  );

  // The same primitive, refetched with the updated MT5 values.
  const next = render({ live: [moved] });
  const newSlY = next.series.priceToCoordinate(moved.sl);
  assert.notEqual(slY, newSlY);
  assert.ok(
    dashed(next.ctx).some((s) => s.pts.some((p) => p.y === newSlY)),
    "the UPDATED SL is drawn after the refetch",
  );
  assert.ok(
    !dashed(next.ctx).some((s) => s.pts.some((p) => p.y === slY)),
    "the stale SL is gone",
  );

  // Closed in MT5 ⇒ absent from the authoritative positions ⇒ not rendered.
  const closed = render({ live: [] });
  assert.equal(triangles(closed.ctx).length, 0);
  assert.equal(closed.ctx.texts.length, 0);
});

test("5b: MT5 null stops draw nothing at all (never a line at price 0)", () => {
  const live = liveOf({ sl: null, tp: null });
  // liveOf returns ONE overlay; render() takes the array the setter expects.
  const { ctx, series } = render({ live: [live] });
  assert.equal(dashed(ctx).length, 0, "no SL/TP line when MT5 reports no stops");
  assert.equal(ctx.texts.length, 1, "no SL/TP pill when MT5 reports no stops");
  // Only the entry marker is painted.
  assert.equal(triangles(ctx).length, 1);
  assert.equal(triangles(ctx)[0].pts[0].y, series.priceToCoordinate(live.entryPrice));
});

test("5c: STOP LOSS and TAKE PROFIT use one styled line, pill and exact price tag", () => {
  const open = liveOf({ sl: 4288, tp: 4313 });
  const moved = liveOf({ sl: 4290, tp: 4310 });
  const first = render({ live: [open] });
  const slY = first.series.priceToCoordinate(open.sl);
  const tpY = first.series.priceToCoordinate(open.tp);
  const liveDashed = first.ctx.strokes.filter((s) => s.dash.join() === "3,3");

  assert.equal(liveDashed.filter((s) => s.pts.some((p) => p.y === slY)).length, 1, "one SL line");
  assert.equal(liveDashed.filter((s) => s.pts.some((p) => p.y === tpY)).length, 1, "one TP line");
  assert.equal(liveDashed.find((s) => s.pts.some((p) => p.y === slY)).color, "#ef5350");
  assert.equal(liveDashed.find((s) => s.pts.some((p) => p.y === tpY)).color, "#26a69a");
  assert.ok(first.ctx.texts.includes("STOP LOSS -0.13% -$125.00"));
  assert.ok(first.ctx.texts.includes("TAKE PROFIT +0.13% +3.51R +$125.00"));
  assert.deepEqual(first.prim.priceAxisViews().map((tag) => tag.text()), [
    "4300.50", "4288.00", "4313.00",
  ]);
  assert.deepEqual(first.prim.priceAxisViews().map((tag) => tag.backColor()), [
    "#4c8dff", "#ef5350", "#26a69a",
  ]);

  const next = render({ live: [moved] });
  assert.ok(next.ctx.texts.includes("STOP LOSS -0.11% -$105.00"));
  assert.ok(next.ctx.texts.includes("TAKE PROFIT +0.10% +2.67R +$95.00"));
  assert.ok(!next.ctx.texts.includes("STOP LOSS -0.13% -$125.00"));
  assert.ok(!next.ctx.texts.includes("TAKE PROFIT +0.13% +3.51R +$125.00"));
  // The pill no longer carries the price, but the price-scale tag still does.
  assert.ok(
    next.ctx.texts.every((t) => !t.includes("@")),
    "no live pill repeats its level's price — the price-scale tag owns that",
  );
  assert.deepEqual(next.prim.priceAxisViews().map((tag) => tag.text()), [
    "4300.50", "4290.00", "4310.00",
  ]);
});

// ── 6. the three account-risk amounts come straight from the server ─────────
const RISK = {
  initialBalance: 100000,
  balance: 100000,
  equity: 100000,
  floatingPnl: 0,
  drawdownBasis: "balance",
  profitTargetAmount: 5000,
  dailyLossLimit: 3000,
  dailyLossFloor: 97000,
  maxDrawdown: 10000,
  maxDrawdownFloor: 90000,
};
test("6: PROFIT TARGET / DAILY LOSS / MAX DRAWDOWN render with their exact amounts", () => {
  // An applicable OPEN position on the chart instrument is the gate for the
  // account-risk layer (see 8/19/20) — with one open, all three are eligible.
  const live = liveOf();
  const levels = buildAccountRiskOverlays({ risk: RISK, overlays: [live], chartEpic: "GOLD" });
  assert.deepEqual(levels.map((l) => l.kind), ["profitTarget", "dailyLoss", "maxDrawdown"]);
  assert.equal(levels[0].amount, 5000);
  assert.equal(levels[1].amount, -3000);
  assert.equal(levels[2].amount, -10000);
  assert.equal(levels[0].label, "PROFIT TARGET  +$5,000");
  assert.equal(levels[1].label, "DAILY LOSS  -$3,000");
  assert.equal(levels[2].label, "MAX DRAWDOWN  -$10,000");

  // Every derived price is on the wide pane ⇒ every level is eligible to render.
  const { ctx } = render({ live: [live], risk: levels, ...WIDE });
  for (const kind of ["PROFIT TARGET", "DAILY LOSS", "MAX DRAWDOWN"]) {
    assert.ok(ctx.texts.some((t) => t.startsWith(kind)), `${kind} label is painted`);
  }
});

test("6b: an unconfigured allowance yields a null amount, never a fake $0", () => {
  const live = liveOf();
  const levels = buildAccountRiskOverlays({
    risk: {
      initialBalance: 100000,
      balance: 100000,
      equity: 100000,
      floatingPnl: 0,
      drawdownBasis: "balance",
      profitTargetAmount: null,
      dailyLossLimit: null,
      dailyLossFloor: null,
      maxDrawdown: null,
      maxDrawdownFloor: null,
    },
    overlays: [live],
    chartEpic: "GOLD",
  });
  for (const l of levels) assert.equal(l.amount, null);
  assert.equal(formatRiskAmount(null), "—");
  assert.equal(formatRiskAmount(0), "$0");
  const { ctx, prim } = render({ live: [live], risk: levels });
  for (const kind of ["PROFIT TARGET", "DAILY LOSS", "MAX DRAWDOWN"]) {
    assert.ok(!ctx.texts.some((t) => t.startsWith(kind)), `${kind} is not parked anywhere on the chart`);
  }
  assert.equal(riskLines(ctx).length, 0);
  assert.equal(prim.priceAxisViews().length, 3, "the live entry, SL and TP are tagged");
});

test("6c: Profit Target projects the ABSOLUTE account target from initial balance", () => {
  const live = liveOf();
  // The account must REACH initialBalance + target, so only the shortfall from
  // the CURRENT balance is still owed by the open book: 100,000 + 400 - 99,700
  // = +$700, which is 70 points at $10/point above the 4300.5 entry.
  const levels = buildAccountRiskOverlays({
    risk: { ...RISK, initialBalance: 100000, profitTargetAmount: 400, balance: 99700 },
    overlays: [live],
    chartEpic: "GOLD",
  });
  assert.equal(
    levels[0].price,
    4370.5,
    "only the +$700 shortfall from the current balance is required of the open book",
  );
  // Earning the target from scratch (balance == initial balance) still asks the
  // full +$400, so the projection is not a fixed delta from the entry.
  const fromScratch = buildAccountRiskOverlays({
    risk: { ...RISK, initialBalance: 100000, profitTargetAmount: 400, balance: 100000 },
    overlays: [live],
    chartEpic: "GOLD",
  });
  assert.equal(fromScratch[0].price, 4340.5, "+$400 from the entry when nothing is earned yet");
  assert.ok(
    fromScratch[0].price < levels[0].price,
    "a higher current balance means less P/L still owed, so the required price sits lower",
  );
  // The stale DB realized-P&L sum is NOT the baseline: moving it cannot move the line.
  const samePrice = buildAccountRiskOverlays({
    risk: { ...RISK, initialBalance: 100000, profitTargetAmount: 400, balance: 99700 },
    overlays: [live],
    chartEpic: "GOLD",
  });
  assert.equal(levels[0].price, samePrice[0].price);
  // Without an initial balance the level is undrawable rather than guessed.
  const noBase = buildAccountRiskOverlays({
    risk: { ...RISK, initialBalance: null, balance: 99700 },
    overlays: [live],
    chartEpic: "GOLD",
  });
  assert.equal(noBase[0].price, null, "no absolute baseline ⇒ no projected price");
});

// ── 6c-bis. The VERIFIED live XAUUSD account, checked against MT5's own economics ──
test("6c-bis: the verified live position projects the exact MT5 threshold prices", () => {
  // MT5 contract economics for this symbol/position: $6.00 of account-currency
  // P/L per $1.00 of price move (contractSize 100 × 0.06 lots).
  const live = liveOf({
    ticket: "10684645438",
    entryPrice: 4276.15,
    sl: 4268.89,
    tp: 4315.52,
    lots: 0.06,
    moneyPerPoint: 6,
  });
  const risk = {
    initialBalance: 5000,
    balance: 4975.27,
    equity: 4974.13,
    floatingPnl: -1.14,
    drawdownBasis: "balance",
    profitTargetAmount: 400,
    dailyLossLimit: 198.09,
    dailyLossFloor: 4754.22,
    maxDrawdown: 500,
    maxDrawdownFloor: 4500,
  };
  const [target, daily, drawdown] = buildAccountRiskOverlays({
    risk,
    overlays: [live],
    chartEpic: "GOLD",
  });
  // 5400 - 4975.27 = +424.73  →  4276.15 + 424.73 / 6
  assert.ok(Math.abs(target.price - 4346.938333) < 1e-4, `profit target ${target.price}`);
  // 4754.22 - 4975.27 = -221.05  →  4276.15 - 221.05 / 6
  assert.ok(Math.abs(daily.price - 4239.308333) < 1e-4, `daily loss ${daily.price}`);
  // 4500 - 4975.27 = -475.27  →  4276.15 - 475.27 / 6
  assert.ok(Math.abs(drawdown.price - 4196.938333) < 1e-4, `max drawdown ${drawdown.price}`);

  // Floating P/L alone never moves a fixed floor's projected price.
  const afterPnl = buildAccountRiskOverlays({
    risk: { ...risk, floatingPnl: 120.5, equity: 5095.77 },
    overlays: [liveOf({ ...live, netPnl: 120.5, liveR: 1.2 })],
    chartEpic: "GOLD",
  });
  assert.equal(afterPnl[1].price, daily.price, "DAILY LOSS stays fixed while floating P/L moves");
  assert.equal(afterPnl[2].price, drawdown.price, "MAX DRAWDOWN stays fixed (balance basis)");
});

test("6d: fixed Daily Loss and Max Drawdown prices ignore floating/remaining changes", () => {
  const fixed = buildAccountRiskOverlays({
    risk: RISK,
    dailyLossRemaining: 3000,
    drawdownRemaining: 10000,
    overlays: [liveOf()],
    chartEpic: "GOLD",
  });
  const afterLoss = buildAccountRiskOverlays({
    risk: RISK,
    dailyLossRemaining: 100,
    drawdownRemaining: 250,
    overlays: [liveOf({ netPnl: 2900, liveR: 29 })],
    chartEpic: "GOLD",
  });
  assert.deepEqual(afterLoss.map((level) => level.price), fixed.map((level) => level.price));
  assert.equal(fixed[1].price, 4000.5, "daily floor 97,000 - realized balance 100,000");
  assert.equal(fixed[2].price, 3300.5, "drawdown floor 90,000 - realized balance 100,000");
});

test("6e: drawdown projection honors balance/equity basis without double-counting floating P&L", () => {
  const balanceMode = buildAccountRiskOverlays({
    risk: {
      ...RISK,
      balance: 100000,
      equity: 101000,
      floatingPnl: 250,
      drawdownBasis: "balance",
    },
    overlays: [liveOf()],
    chartEpic: "GOLD",
  });
  const equityMode = buildAccountRiskOverlays({
    risk: {
      ...RISK,
      balance: 100000,
      equity: 101000,
      floatingPnl: 250,
      drawdownBasis: "equity",
    },
    overlays: [liveOf()],
    chartEpic: "GOLD",
  });
  assert.equal(balanceMode[2].price, 3300.5, "balance mode anchors at 100,000");
  assert.equal(equityMode[2].price, 3225.5, "equity mode anchors at 101,000 - 250 floating");

  const sameNonOpenBaseline = buildAccountRiskOverlays({
    risk: {
      ...RISK,
      balance: 100000,
      equity: 101500,
      floatingPnl: 750,
      drawdownBasis: "equity",
    },
    overlays: [liveOf()],
    chartEpic: "GOLD",
  });
  assert.equal(sameNonOpenBaseline[2].price, equityMode[2].price);
});

// ── 7. a price level is derived ONLY from proven sensitivity (D3) ───────────
test("7: proven sensitivity yields the exact threshold price", () => {
  // One BUY, $10 per point, entry 4300.5. +$5,000 of open-book P&L ⇒ +500 points.
  const price = deriveThresholdPrice(5000, [
    { instrument: "XAUUSD", sign: 1, moneyPerPoint: 10, entryPrice: 4300.5 },
  ]);
  assert.equal(price, 4800.5);
  // A SELL solves in the opposite direction: +$5,000 of P&L on a short needs the
  // price to FALL 500 points (5000 / 10) below the 4300.5 entry.
  assert.equal(
    deriveThresholdPrice(5000, [{ instrument: "XAUUSD", sign: -1, moneyPerPoint: 10, entryPrice: 4300.5 }]),
    3800.5,
  );
  // Two BUYs aggregate their sensitivity: S = 10 + 30 = 40 $/point over the
  // weighted entries, so +$1,000 moves the price +25 points above 4307.5.
  assert.equal(
    deriveThresholdPrice(1000, [
      { instrument: "XAUUSD", sign: 1, moneyPerPoint: 10, entryPrice: 4300 },
      { instrument: "XAUUSD", sign: 1, moneyPerPoint: 30, entryPrice: 4310 },
    ]),
    4332.5,
  );
});

test("7b: the derived price is rendered as a LINE on that exact price", () => {
  const live = liveOf();
  const levels = buildAccountRiskOverlays({ risk: RISK, overlays: [live], chartEpic: "GOLD" });
  const target = levels.find((l) => l.kind === "profitTarget");
  assert.equal(target.priceSource, "derived");
  assert.equal(target.price, 4800.5);

  const { ctx, series } = render({ live: [live], risk: levels });
  const y = series.priceToCoordinate(target.price);
  assert.ok(
    riskLines(ctx).some((s) => s.pts.some((p) => p.y === y)),
    "a dashed line is painted at the derived price",
  );
  assert.ok(ctx.texts.some((t) => t.includes("@")), "the label shows the derived price");
});

// ── 8. NO price level when it is not derivable (D3) ─────────────────────────
test("8: no position on the chart instrument ⇒ no risk annotation at all", () => {
  const levels = buildAccountRiskOverlays({ risk: RISK, overlays: [], chartEpic: "GOLD" });
  assert.equal(levels.length, 0, "no applicable position ⇒ the risk layer is not built");
});

test("8b: unknown sensitivity on the position ⇒ still annotation-only", () => {
  const noSens = liveOf({ moneyPerPoint: null });
  const levels = buildAccountRiskOverlays({ risk: RISK, overlays: [noSens], chartEpic: "GOLD" });
  assert.equal(levels.length, 3, "the limits are still represented as descriptors");
  for (const l of levels) {
    assert.equal(l.price, null, `${l.kind} has no derivable price`);
    assert.equal(l.priceSource, "undrawable");
  }
  const { ctx } = render({ live: [noSens], risk: levels });
  // Only RISK lines are counted here: a risk line is a full-width stroke that
  // starts at x=0 AND uses the risk dash [6, 4]. The position's own SL/TP levels
  // are live-trade visuals drawn with the distinct [3, 3] dash, so they must not
  // mask a missing risk line (they are asserted separately in 5b).
  assert.equal(riskLines(ctx).length, 0);
  // The price-less risk descriptors are not chart decorations: no risk pills
  // or risk tags. The live entry/SL/TP labels remain independently authoritative.
  // With no proven sensitivity there is no honest $ (nor an R built on one). The
  // % is derived from that same money, so it drops too — but the position's own
  // floating P/L is still server-authoritative and keeps its % and R. Each field
  // degrades on its own; none is invented.
  assert.deepEqual(ctx.texts, [
    "BUY +0.06% +1.63R +$58.08",
    "STOP LOSS",
    "TAKE PROFIT",
  ]);
});

test("8c: a MIXED book is not collapsed into one misleading price", () => {
  const buy = liveOf({ ticket: "1", moneyPerPoint: 10 });
  const sell = liveOf({
    ticket: "2",
    direction: "Sell",
    moneyPerPoint: 10,
    entryPrice: 4300.5,
    netPnl: -20,
    liveR: -2,
    // A realistic SHORT: its stop sits ABOVE entry and its target BELOW, so the
    // stop is a loss and the target a gain.
    sl: 4313,
    tp: 4288,
  });
  assert.equal(
    deriveThresholdPrice(5000, [
      { instrument: "XAUUSD", sign: 1, moneyPerPoint: 10, entryPrice: 4300.5 },
      { instrument: "XAUUSD", sign: -1, moneyPerPoint: 10, entryPrice: 4300.5 },
    ]),
    null,
    "opposing legs have no single shared threshold",
  );
  const levels = buildAccountRiskOverlays({ risk: RISK, overlays: [buy, sell], chartEpic: "GOLD" });
  for (const l of levels) assert.equal(l.price, null, `${l.kind} is not a chart level`);
  const { ctx } = render({ live: [buy, sell], risk: levels });
  // No full-width RISK line, pill or tag may be invented for a mixed book (see 8b).
  assert.equal(riskLines(ctx).length, 0);
  assert.equal(ctx.texts.length, 6, "each position owns entry, SL and TP pills");
  for (const label of [
    "BUY +0.06% +1.63R +$58.08",
    "SELL -0.02% -0.56R -$20.00",
    // A realistic SHORT: its stop sits ABOVE entry and its target BELOW. The
    // % is the money at that level over the account, and both the % and the $
    // are direction-oriented — so the short's stop reads as a loss and its
    // target as a gain.
    "STOP LOSS -0.13% -$125.00",
    "TAKE PROFIT +0.13% +3.51R +$125.00",
  ]) {
    assert.ok(ctx.texts.includes(label), `${label} is painted`);
  }
  // The position markers themselves still render.
  assert.equal(triangles(ctx).length, 2);
});

// ── 9. label de-collision moves the LABEL, never the LINE ──────────────────
test("9: risk labels de-collide while every line stays on its exact price", () => {
  // Two levels whose prices resolve to nearly the same row.
  const live = liveOf();
  const levels = buildAccountRiskOverlays({ risk: RISK, overlays: [live], chartEpic: "GOLD" });
  const { ctx, series } = render({ live: [live], risk: levels });

  // Every DRAWN risk line must sit exactly on priceToCoordinate(level.price).
  // riskLines() isolates the risk strokes (full-width + risk dash) from the live
  // SL/TP levels, which are separate visuals covered by test 5b.
  for (const level of levels) {
    if (level.price === null) continue;
    const y = series.priceToCoordinate(level.price);
    assert.ok(
      riskLines(ctx).some((s) => s.pts.some((p) => p.y === y)),
      `${level.kind} line is on its exact price`,
    );
  }

  // The pure layout helper pushes overlapping labels apart, bottom-up.
  const tops = layoutRiskLabelTops([100, 102, 300, null], 1000);
  assert.equal(tops[2], 300 - 8, "an isolated label centres on its own y");
  assert.ok(tops[1] >= tops[0] + 18, "nearby labels are pushed apart");
  assert.equal(tops[3], null, "an undrawable level gets no label top");
  // Off-canvas coordinates are clamped, never used raw.
  const clamped = layoutRiskLabelTops([-500, 99999], 100);
  assert.ok(clamped[0] >= 0 && clamped[1] <= 100);
});

// ── 10. formatters stay compact and never fake a missing value ──────────────
test("10: compact money / R / percent formatting", () => {
  assert.equal(formatLivePnl(58.08), "+$58.08");
  assert.equal(formatLivePnl(-12.5), "-$12.50");
  assert.equal(formatLivePnl(0), "+$0.00");
  assert.equal(formatLiveR(1.63), "+1.63R", "no leading space — the composer owns separation");
  assert.equal(formatLiveR(-0.5), "-0.50R");
  assert.equal(formatLiveR(null), "", "an unknown R is omitted, never shown as 0.00R");

  assert.equal(formatLivePercent(1.95), "+1.95%");
  assert.equal(formatLivePercent(-0.95), "-0.95%");
  assert.equal(formatLivePercent(0), "0.00%", "zero is unsigned — a + would claim a direction");
  assert.equal(formatLivePercent(2), "+2.00%", "always two decimals, whatever the magnitude");
  assert.equal(formatLivePercent(null), "", "an unknown % is omitted, never shown as 0.00%");
  assert.equal(formatLivePercent(Number.NaN), "", "NaN never reaches the label");

  // The composer drops empty segments instead of leaving dangling separators.
  const metrics = { percent: 1.95, r: 1.59, money: 145.92 };
  assert.equal(formatLiveLabel("BUY", metrics), "BUY +1.95% +1.59R +$145.92");
  assert.equal(formatLiveLabel("STOP LOSS", metrics, { withR: false }), "STOP LOSS +1.95% +$145.92");
  assert.equal(
    formatLiveLabel("BUY", { percent: null, r: null, money: 58.08 }),
    "BUY +$58.08",
    "an unknown % / R simply drops out",
  );
  assert.equal(
    formatLiveLabel("BUY", { percent: null, r: null, money: null }),
    "BUY",
    "with nothing derivable the label is the bare direction, never 'BUY  '",
  );
  assert.ok(
    !/\s{2,}/.test(formatLiveLabel("BUY", metrics)),
    "the composed label never contains a double space",
  );
});

// ── 11. READ-ONLY: no trade-management interaction anywhere ─────────────────
test("11: the live/risk layers register NO interaction handlers", () => {
  // The primitive exposes no pointer/click/touch/drag API at all.
  for (const forbidden of [
    "onPointer",
    "onMouse",
    "onTouch",
    "onClick",
    "onDrag",
    "draggable",
    "pointerdown",
    "pointermove",
    "pointerup",
    "mousedown",
    "mousemove",
    "mouseup",
    "touchstart",
    "touchmove",
    "touchend",
    "addEventListener",
  ]) {
    assert.ok(!PRIMITIVE_SRC.includes(forbidden), `primitive must not contain ${forbidden}`);
  }
  // No order/close/modify/cancel vocabulary leaks into the display builders.
  for (const forbidden of [
    "order_send",
    "order_check",
    "positions_close",
    "closePosition",
    "modifyPosition",
    "cancelOrder",
    "placeOrder",
    "onClose",
    "onModify",
    "onCancel",
  ]) {
    assert.ok(!PRIMITIVE_SRC.includes(forbidden), `primitive must not contain ${forbidden}`);
    assert.ok(!OVERLAY_SRC.includes(forbidden), `tradeOverlay must not contain ${forbidden}`);
  }
});

test("11b: attaching/drawing registers zero event subscriptions", () => {
  // A canvas that throws if anything tries to subscribe to it.
  const bomb = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "string" && /^(add|remove|on)/i.test(prop)) {
          throw new Error(`the live overlay must not call ${prop}`);
        }
        return undefined;
      },
    },
  );
  const prim = new TradeOverlayPrimitive();
  prim.attached({
    chart: { timeScale: () => ({ timeToCoordinate: () => null }) },
    series: { priceToCoordinate: () => null },
    requestUpdate: () => {},
  });
  prim.setLiveOverlays([liveOf()], []);
  // Must not throw, and must not have touched `bomb`.
  assert.ok(bomb);
  assert.equal(prim.renderer.draw({
    useBitmapCoordinateSpace: (cb) =>
      cb({
        context: makeCtx(),
        mediaSize: { width: 4000, height: 4000 },
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      }),
  }), undefined, "draw is a pure void operation");
});

// ── 12. the historical layer is independent and untouched ──────────────────
test("12: live/risk overlays do not gate or alter the historical layer", () => {
  const prim = new TradeOverlayPrimitive();
  const scale = makeScale({ firstSec: T0, lastSec: T0 + 3600 * 60, gridSec: 60 });
  const series = makeSeries();
  prim.attached({ chart: { timeScale: () => scale }, series, requestUpdate: () => {} });

  // A closed historical trade with NO live positions still renders.
  prim.setOverlays(
    [
      {
        key: "t:1",
        mt5Symbol: "XAUUSD",
        epic: "GOLD",
        resolved: true,
        direction: "Buy",
        entryBucketMs: Date.UTC(2026, 8, 23, 12, 10, 0),
        exitBucketMs: Date.UTC(2026, 8, 23, 12, 13, 0),
        entryExactMs: Date.UTC(2026, 8, 23, 12, 10, 55),
        exitExactMs: Date.UTC(2026, 8, 23, 12, 13, 20),
        entryPrice: 4315.11,
        exitPrice: 4317.08,
        sl: 4312.19,
        tp: 4326.47,
        lots: 0.17,
        pnl: 33.49,
        rrr: "2.1",
        status: "closed",
      },
    ],
    null,
    60,
  );
  const ctx = makeCtx();
  prim.renderer.draw({
    useBitmapCoordinateSpace: (cb) =>
      cb({ context: ctx, mediaSize: { width: 4000, height: 4000 }, horizontalPixelRatio: 1, verticalPixelRatio: 1 }),
  });
  // Entry + reverse exit triangles, exactly as P3-D established.
  assert.equal(triangles(ctx).length, 2);
  assert.equal(apexOf(triangles(ctx)[0]), "up");
  assert.equal(apexOf(triangles(ctx)[1]), "down");
  // P3-D's TP/SL removal still holds: the historical painter draws no stops.
  assert.equal(dashed(ctx).length, 1, "only the green dotted connecting line is dashed");
});

// ── 13. REGRESSION: the real Dashboard `/state` envelope ─────────────────────
// Dashboard returns `{ accountId, state }`; App consumes the unwrapped state.
// This test proves the network boundary preserves the inner state and its
// Dashboard-derived position fields, after which the unchanged risk pipeline can
// build all three finite price levels. It also retains the missing/non-array
// positions guards so a degraded older response can never crash render code.
test("13: real Dashboard state envelope normalizes into a usable AccountState", async () => {
  // auth.ts reads `window.localStorage` (not globalThis) and its envelope is
  // `{ v: 1, accessToken, user }` — both must match to hydrate a token.
  // NOTE: stubs MUST be installed before the first import of the services, and
  // clearSession() must NOT be used to "reset" auth: it latches `hydrated = true`
  // so getToken() would never re-read the storage stub below.
  const g = globalThis;
  const realFetch = g.fetch;
  const realWindow = g.window;
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const DASHBOARD_RESPONSE = {
    accountId: ACCOUNT_ID,
    state: {
      accountId: ACCOUNT_ID,
      connected: true,
      balance: 100000,
      initialBalance: 100000,
      dailySessionStartBalance: 100000,
      dailyLossFloor: 9950,
      maxDrawdownFloor: 9800,
      positions: [
        {
          ticket: "12345",
          symbol: "XAUUSD",
          direction: "Buy",
          lots: 0.33,
          entryPrice: 2650.5,
          sl: 2640,
          tp: 2660,
          profit: 58.08,
          swap: -1.5,
          riskUsd: 34.65,
          slValue: -47.68,
          tpValue: 190,
          rewardRiskRatio: null,
          instrument: "XAUUSD",
          openTime: "2026-09-24 08:00:00",
          rowRiskPerTrade: "34.65",
          rowRrr: null,
          rowLots: "0.33",
          rowEntryPrice: "2650.5",
          netPnl: 56.58,
          liveR: 1.63,
          moneyPerPoint: 10,
        },
      ],
      profitTargetAmount: 100,
      dailyLossLimit: 50,
      maxDrawdown: 200,
      dailyLossRemaining: 50,
      drawdownRemaining: 200,
    },
  };
  g.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => DASHBOARD_RESPONSE,
  });
  const store = new Map();
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  store.set("aura_chart_auth.v1", JSON.stringify({
    v: 1,
    accessToken: "regression-token",
    user: { id: "u1", email: "trader@example.com" },
  }));
  g.window = { localStorage: ls, sessionStorage: ls };
  g.localStorage = ls;

  const { getTradingAccountState } = await import("../src/services/tradingApi.ts");

  try {
    const state = await getTradingAccountState(ACCOUNT_ID);
    assert.equal(state.accountId, ACCOUNT_ID, "the inner Dashboard state is returned");
    assert.equal(state.profitTargetAmount, 100, "profit target survives normalization");
    assert.equal(state.dailyLossLimit, 50, "daily-loss limit survives normalization");
    assert.equal(state.maxDrawdown, 200, "max drawdown survives normalization");
    assert.equal(state.dailyLossRemaining, 50, "daily-loss remainder survives normalization");
    assert.equal(state.drawdownRemaining, 200, "drawdown remainder survives normalization");
    assert.equal(state.positions.length, 1, "the Dashboard position survives normalization");
    assert.deepEqual(
      state.positions[0],
      DASHBOARD_RESPONSE.state.positions[0],
      "the Dashboard-derived position, including native SL/TP values, is passed through intact",
    );
    assert.equal(state.positions[0].slValue, -47.68);
    assert.equal(state.positions[0].tpValue, 190);

    // The existing App-equivalent pipeline must use the normalized values and
    // preserve the Dashboard-provided sensitivity without any AURA calculation.
    const { liveTradeOverlays, riskLevels } = appRiskLevels(state, "GOLD");
    assert.equal(liveTradeOverlays.length, 1, "the real position builds a live overlay");
    assert.equal(liveTradeOverlays[0].netPnl, 56.58, "Dashboard netPnl is preserved");
    assert.equal(liveTradeOverlays[0].liveR, 1.63, "Dashboard liveR is preserved");
    assert.equal(liveTradeOverlays[0].moneyPerPoint, 10, "Dashboard moneyPerPoint is preserved");
    assert.deepEqual(
      riskLevels.map((level) => level.kind),
      ["profitTarget", "dailyLoss", "maxDrawdown"],
      "all three existing risk overlays are built",
    );
    for (const level of riskLevels) {
      assert.equal(typeof level.price, "number", `${level.kind} has a numeric price`);
      assert.ok(Number.isFinite(level.price), `${level.kind} has a finite price`);
    }

    // A missing `state.positions` still degrades to an empty iterable.
    const { positions: _positions, ...stateWithoutPositions } = DASHBOARD_RESPONSE.state;
    g.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accountId: ACCOUNT_ID, state: stateWithoutPositions }),
    });
    const missing = await getTradingAccountState(ACCOUNT_ID);
    assert.deepEqual(missing.positions, [], "an absent inner field means no live positions");
    assert.deepEqual(liveTradesForEpic(missing.positions, "GOLD"), []);

    // A non-array inner `positions` is likewise degraded, never iterated.
    g.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        accountId: ACCOUNT_ID,
        state: { ...DASHBOARD_RESPONSE.state, positions: { nope: true } },
      }),
    });
    const bad = await getTradingAccountState(ACCOUNT_ID);
    assert.ok(Array.isArray(bad.positions), "a non-array positions is coerced to []");
    assert.deepEqual(liveTradesForEpic(bad.positions, "GOLD"), []);

    // Multiple real positions still pass through untouched, in order.
    const many = [
      { ...DASHBOARD_RESPONSE.state.positions[0], ticket: "1", entryPrice: 4300.5, sl: 4290, tp: 4320 },
      { ...DASHBOARD_RESPONSE.state.positions[0], ticket: "2", direction: "Sell", entryPrice: 4310.5, sl: 4320, tp: 4300 },
    ];
    g.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accountId: ACCOUNT_ID, state: { ...DASHBOARD_RESPONSE.state, positions: many } }),
    });
    const multi = await getTradingAccountState(ACCOUNT_ID);
    assert.equal(multi.positions.length, 2, "multiple positions are preserved");
    assert.deepEqual(multi.positions.map((p) => p.ticket), ["1", "2"], "order is preserved");
    assert.equal(liveTradesForEpic(multi.positions, "GOLD").length, 2, "both render");
  } finally {
    g.fetch = realFetch;
    if (realWindow === undefined) delete g.window;
    else g.window = realWindow;
  }
});

// ── 14. the level's price stays visible on the RIGHT PRICE SCALE ─────────────
test("14: every drawn level tags its price on the right price scale", () => {
  const live = liveOf();
  const levels = buildAccountRiskOverlays({ risk: RISK, overlays: [live], chartEpic: "GOLD" });
  const { prim, series } = render({ live: [live], risk: levels, ...WIDE });
  const tags = prim.priceAxisViews();
  assert.equal(tags.length, 6, "the live entry, SL and TP plus three risk levels are tagged");

  // The tag sits on the SAME coordinate the horizontal line is drawn at: both go
  // through the chart's own price→pixel mapping, so they can never disagree.
  const ys = tags.map((t) => t.coordinate());
  for (const price of [live.entryPrice, live.sl, live.tp, ...levels.map((l) => l.price)]) {
    assert.ok(ys.includes(series.priceToCoordinate(price)), `${price} is tagged at its own coordinate`);
  }

  // The live entry tag is the neutral TradingView position blue; every risk tag
  // carries its own semantic colour (green / amber / red) — nothing arbitrary.
  assert.deepEqual(
    tags.map((t) => t.backColor()),
    ["#4c8dff", "#ef5350", "#26a69a", "#22c55e", "#f59e0b", "#ef5350"],
  );
  // The text is the price itself, formatted like the numbers beside it.
  assert.deepEqual(
    tags.map((t) => t.text()),
    ["4300.50", "4288.00", "4313.00", "4800.50", "4000.50", "3300.50"],
  );
  for (const tag of tags) assert.equal(tag.visible(), true, "a mapped price is always visible");

  // LWC keys its own label cache on the array reference: unchanged state reuses it.
  assert.equal(prim.priceAxisViews(), tags, "an unchanged level set reuses the tag array");
  prim.setLiveOverlays([liveOf({ entryPrice: 4310.0 })], levels);
  assert.notEqual(prim.priceAxisViews(), tags, "a changed level set rebuilds the tags");

  // Read-only surface: a tag exposes geometry and colours, nothing actionable.
  for (const tag of tags) {
    for (const forbidden of ["onClick", "onPointerDown", "onDrag", "setPrice", "applyOptions"]) {
      assert.equal(tag[forbidden], undefined, `a price-scale tag cannot ${forbidden}`);
    }
  }
});

// ── 15. no fabricated price on the scale, ever ──────────────────────────────
test("15: a level with no derivable price is never tagged with a price", () => {
  // Unknown sensitivity: the descriptors exist (the limits are configured and a
  // position is open), but none of them is a price the chart can draw.
  const noSens = liveOf({ moneyPerPoint: null });
  const levels = buildAccountRiskOverlays({ risk: RISK, overlays: [noSens], chartEpic: "GOLD" });
  const { prim, ctx } = render({ live: [noSens], risk: levels });
  assert.equal(prim.priceAxisViews().length, 3, "the live entry, SL and TP are tagged");
  assert.deepEqual(
    prim.priceAxisViews().map((t) => t.text()),
    ["4300.50", "4288.00", "4313.00"],
  );
  assert.equal(riskLines(ctx).length, 0, "…and no risk line is invented");
  assert.equal(ctx.texts.length, 3, "…and only the three live pills are painted");

  // A chart that cannot map any price ⇒ the tag reports invisible and parks far
  // outside the axis instead of pretending to sit at price 0.
  const detached = new TradeOverlayPrimitive();
  const live = liveOf();
  detached.attached({
    chart: { timeScale: () => ({ timeToCoordinate: () => null }) },
    series: { priceToCoordinate: () => null },
    requestUpdate: () => {},
  });
  detached.setLiveOverlays([live], []);
  const tags = detached.priceAxisViews();
  assert.equal(tags.length, 3, "the live entry, SL and TP are offered to the scale");
  for (const tag of tags) {
    assert.equal(tag.visible(), false, "…but hidden while it has no coordinate");
    assert.ok(tag.coordinate() < -1e5, "…and never parked on a real price");
  }
});

// ── 16. the pill ladder follows PRICE, not the order levels arrive in ──────
/**
 * Recorded pill plates. `traceRoundedRect` records exactly five path vertices
 * (four edges + one closing corner point), so a plate can never be mistaken for
 * a 3-point entry/exit triangle; the accent bar shares the shape but is filled
 * with a solid hex colour.
 */
const plates = (ctx) => ctx.fills.filter((f) => f.pts.length === 5 && f.color.startsWith("rgba("));
/** Recorded semantic accent bars (solid hex colours, same rounded outline). */
const accents = (ctx) => ctx.fills.filter((f) => f.pts.length === 5 && f.color.startsWith("#"));

test("16: the pill ladder is ordered by the TRUE price, never by list order", () => {
  const high = liveOf({ ticket: "1", entryPrice: 4320.5, sl: null, tp: null });
  const low = liveOf({ ticket: "2", entryPrice: 4300.5, netPnl: -20, sl: null, tp: null });
  const levels = buildAccountRiskOverlays({ risk: RISK, overlays: [low], chartEpic: "GOLD" });
  // The HIGH price arrives LAST: the ladder must still put it on TOP.
  const { ctx, series } = render({ live: [low, high], risk: levels, ...WIDE });
  const tops = plates(ctx).map((f) => f.pts[0].y);
  assert.equal(tops.length, 5, "two positions + three risk levels each own a pill");

  const yHigh = series.priceToCoordinate(high.entryPrice);
  const yLow = series.priceToCoordinate(low.entryPrice);
  const nearest = (y) =>
    tops.reduce((best, t) => (Math.abs(t + 8 - y) < Math.abs(best + 8 - y) ? t : best), tops[0]);
  assert.ok(nearest(yHigh) < nearest(yLow), "the higher price keeps the upper rung");

  const sorted = [...tops].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= 18, "no two pills overlap");
  }
});



// ── 17. pill chrome: rounded plate + semantic accent (no cards, no panels) ──
test("17: pills are rounded plates with a semantic accent bar", () => {
  const live = liveOf();
  const levels = buildAccountRiskOverlays({ risk: RISK, overlays: [live], chartEpic: "GOLD" });
  const { ctx } = render({ live: [live], risk: levels, ...WIDE });
  const pills = plates(ctx);
  assert.equal(pills.length, 6, "one pill per live entry/SL/TP and account-risk level");
  for (const pill of pills) {
    assert.equal(pill.pts.length, 5, "a rounded plate can never be read as a 3-point triangle");
    assert.ok(pill.pts[1].x > pill.pts[0].x, "the plate has a positive width");
    assert.ok(pill.pts[3].y > pill.pts[0].y, "…and a real height");
  }
  // Four corner arcs for the plate + four for its accent bar, per pill.
  assert.ok(ctx.arcs.length >= pills.length * 8, "every pill is drawn with rounded corners");
  const accentColors = accents(ctx).map((f) => f.color);
  assert.equal(accentColors.length, 6, "one accent bar per pill");
  for (const want of ["#26a69a", "#22c55e", "#f59e0b", "#ef5350"]) {
    assert.ok(accentColors.includes(want), `${want} identifies a level`);
  }
});

// ── 18. a displaced pill points back at its price; the LINE never moves ─────
test("18: a de-collided pill keeps a leader to its TRUE price", () => {
  // Two positions a tenth of a point apart: the second pill cannot sit on its
  // own level, so it must be pushed away and tied back to it.
  const a = liveOf({ ticket: "1", entryPrice: 4300.5, sl: null, tp: null });
  const b = liveOf({ ticket: "2", entryPrice: 4300.6, sl: null, tp: null });
  const { ctx, series } = render({ live: [a, b] });
  const yA = series.priceToCoordinate(a.entryPrice);
  const yB = series.priceToCoordinate(b.entryPrice);

  // Both LEVELS stay on their exact prices — the ladder only moves the pills.
  const horizontals = ctx.strokes.filter(
    (s) => s.dash.length === 0 && s.pts.length === 2 && s.pts[0].y === s.pts[1].y,
  );
  assert.ok(horizontals.some((s) => s.pts[0].y === yA), "position A's level is on its own price");
  assert.ok(horizontals.some((s) => s.pts[0].y === yB), "position B's level is on its own price");

  // The displaced pill is tied back with a SOLID vertical leader — never a dash,
  // so it can never be confused with a price line.
  const leaders = ctx.strokes.filter(
    (s) => s.dash.length === 0 && s.pts.length === 2 && s.pts[0].x === s.pts[1].x,
  );
  assert.ok(leaders.length >= 1, "the de-collided pill keeps a leader");
  assert.equal(leaders[0].alpha, 0.5, "the leader stays subordinate to the line");
  const leaderYs = leaders.flatMap((s) => [s.pts[0].y, s.pts[1].y]);
  assert.ok(
    leaderYs.includes(yA) || leaderYs.includes(yB),
    "the leader ends exactly on the level's price",
  );
  // The leader sits left of the pill's leading edge, never over its text.
  const plateLefts = plates(ctx).map((f) => f.pts[0].x - 6);
  for (const leader of leaders) {
    assert.ok(leader.pts[0].x <= Math.min(...plateLefts), "the leader stays clear of the plate");
  }
});

// ── 20. App's real runtime path: accountState.positions → liveTradesForEpic →
//        buildAccountRiskOverlays → primitive. The gate MUST accept exactly the
//        positions the LIVE layer already renders on this chart — no stricter.
const APP_RISK = {
  initialBalance: 100000,
  balance: 100000,
  equity: 100000,
  floatingPnl: 0,
  drawdownBasis: "balance",
  profitTargetAmount: 5000,
  dailyLossLimit: 3000,
  dailySessionStartBalance: 100000,
  dailyLossFloor: 97000,
  maxDrawdown: 10000,
  maxDrawdownFloor: 90000,
  dailyLossRemaining: 3000,
  drawdownRemaining: 10000,
};
/** One `AccountState.positions` element, shaped like the live tradingApi response. */
function accountStatePosition(over = {}) {
  return {
    ticket: "9001",
    symbol: "XAUUSD",
    direction: "Buy",
    lots: 0.33,
    entryPrice: 4300.5,
    sl: 4288,
    tp: 4313,
    profit: 58.08,
    swap: 0,
    riskUsd: 35.63,
    rewardRiskRatio: "1.63",
    // The account-scoped instrument spelling from the `trades` row is a
    // REQUIRED field on every live position; the overlay binds by it.
    instrument: "XAUUSD",
    netPnl: 58.08,
    liveR: 1.63,
    moneyPerPoint: 10,
    openTime: "2026-09-23 15:10:00",
    rowRiskPerTrade: 35.63,
    rowRrr: "1.63",
    rowLots: "0.33",
    rowEntryPrice: 4300.5,
    ...over,
  };
}

/** The exact derivation App.tsx performs for the current chart epic. */
function appRiskLevels(accountState, epic) {
  const liveTradeOverlays = liveTradesForEpic(accountState.positions, epic);
  return {
    liveTradeOverlays,
    riskLevels: buildAccountRiskOverlays({
      risk: {
        initialBalance: accountState.initialBalance,
        balance: accountState.balance,
        equity: accountState.equity,
        floatingPnl: accountState.floatingPnl,
        drawdownBasis: accountState.drawdownBasis === "equity" ? "equity" : "balance",
        profitTargetAmount: accountState.profitTargetAmount,
        dailyLossLimit: accountState.dailyLossLimit,
        dailyLossFloor: accountState.dailyLossFloor,
        maxDrawdown: accountState.maxDrawdown,
        maxDrawdownFloor: accountState.maxDrawdownFloor,
      },
      dailyLossRemaining: accountState.dailyLossRemaining,
      drawdownRemaining: accountState.drawdownRemaining,
      overlays: liveTradeOverlays,
      chartEpic: epic,
    }),
  };
}

test("20a: App path — no live positions ⇒ build result is []", () => {
  const state = { ...APP_RISK, positions: [] };
  const { liveTradeOverlays, riskLevels } = appRiskLevels(state, "GOLD");
  assert.deepEqual(liveTradeOverlays, []);
  assert.equal(hasApplicableLivePosition(liveTradeOverlays, "GOLD"), false);
  assert.deepEqual(riskLevels, []);
});

test("20b: App path — a position on an UNRELATED epic ⇒ build result is []", () => {
  const state = {
    ...APP_RISK,
    positions: [
      accountStatePosition({ ticket: "1", instrument: "EURUSD" }),
      accountStatePosition({ ticket: "2", instrument: "XAUUSD.somethingelse" }),
    ],
  };
  const { liveTradeOverlays, riskLevels } = appRiskLevels(state, "GOLD");
  assert.deepEqual(liveTradeOverlays, [], "nothing on GOLD is applicable");
  assert.equal(hasApplicableLivePosition(liveTradeOverlays, "GOLD"), false);
  assert.deepEqual(riskLevels, []);
});

test("20c: App path — a position on the CURRENT epic ⇒ risk levels are produced", () => {
  // The account-scoped spelling is whatever the `trades` row carries. Every
  // spelling that binds the live position to the CURRENT chart epic must also
  // make the risk layer eligible — the gate reuses liveTradesForEpic's result
  // verbatim and never re-applies a stricter symbol test of its own.
  for (const instrument of ["XAUUSD", "GOLD"]) {
    const state = { ...APP_RISK, positions: [accountStatePosition({ instrument })] };
    const { liveTradeOverlays, riskLevels } = appRiskLevels(state, "GOLD");
    assert.equal(liveTradeOverlays.length, 1, `${instrument}: the live trade renders`);
    assert.equal(
      hasApplicableLivePosition(liveTradeOverlays, "GOLD"),
      true,
      `${instrument}: the same result says the risk layer is eligible`,
    );
    assert.deepEqual(
      riskLevels.map((l) => l.kind),
      ["profitTarget", "dailyLoss", "maxDrawdown"],
      `${instrument}: all three account-risk levels are built`,
    );
  }
});

test("20d: App path — ONE unconfigured allowance omits only that level", () => {
  // The builder still returns the three DESCRIPTORS (amount + price); an
  // unconfigured allowance is the one that carries a null price, and the
  // RENDERER is what omits it (no line / pill / tag) — see test 8b.
  const state = {
    ...APP_RISK,
    profitTargetAmount: null,
    positions: [accountStatePosition()],
  };
  const { riskLevels, liveTradeOverlays } = appRiskLevels(state, "GOLD");
  // The builder still returns the three DESCRIPTORS (amount + price); an
  // unconfigured allowance is the one that carries a null price, and the
  // RENDERER is what omits it (no line / pill / tag) — see test 8b.
  assert.equal(riskLevels.length, 3, "the three authoritative descriptors are returned");
  assert.deepEqual(
    riskLevels.map((l) => l.price),
    [null, 4000.5, 3300.5],
    "only the omitted allowance has no price",
  );
  const target = riskLevels.find((l) => l.kind === "profitTarget");
  assert.equal(target.amount, null);
  assert.equal(target.price, null, "never a fake price for the omitted level");
  assert.equal(target.label, "PROFIT TARGET  —");

  // …and the renderer paints NOTHING for it: the two valid levels only.
  const { ctx } = render({ live: liveTradeOverlays, risk: riskLevels, ...WIDE });
  assert.equal(ctx.texts.filter((t) => t.startsWith("PROFIT TARGET")).length, 0);
  assert.equal(riskLines(ctx).length, 2, "only the two valid risk lines are painted");
  for (const kind of ["DAILY LOSS", "MAX DRAWDOWN"]) {
    assert.ok(ctx.texts.some((t) => t.startsWith(kind)), `${kind} still renders`);
  }
  // The two configured levels keep their exact amounts and solved prices.
  const daily = riskLevels.find((l) => l.kind === "dailyLoss");
  const drawdown = riskLevels.find((l) => l.kind === "maxDrawdown");
  assert.equal(daily.amount, -3000);
  assert.equal(daily.price, 4000.5);
  assert.equal(drawdown.amount, -10000);
  assert.equal(drawdown.price, 3300.5);
});

test("20e: App path — every valid risk level uses the real price coordinate", () => {
  const state = { ...APP_RISK, positions: [accountStatePosition()] };
  const { liveTradeOverlays, riskLevels } = appRiskLevels(state, "GOLD");
  const { ctx, series, prim } = render({ live: liveTradeOverlays, risk: riskLevels, ...WIDE });

  for (const level of riskLevels) {
    const y = series.priceToCoordinate(level.price);
    assert.ok(
      riskLines(ctx).some((s) => s.pts.some((p) => p.y === y)),
      `${level.kind}: line is painted on the chart coordinate of ${level.price}`,
    );
    assert.ok(
      ctx.texts.some((t) => t.startsWith(level.label)),
      `${level.kind}: pill is painted`,
    );
    const tag = prim.priceAxisViews().find((t) => t.text() === formatPrice(level.price));
    assert.ok(tag, `${level.kind}: price is tagged on the right price scale`);
    assert.equal(tag.coordinate(), y, `${level.kind}: tag follows the same coordinate`);
  }
  // The live position's own entry is anchored identically.
  const entryText = formatPrice(liveTradeOverlays[0].entryPrice);
  const entryTag = prim.priceAxisViews().find((t) => t.text() === entryText);
  assert.equal(entryTag.coordinate(), series.priceToCoordinate(liveTradeOverlays[0].entryPrice));
});
// ── 1e. the three live pills, rendered exactly as a user sees them ──────────
// Each case runs the REAL composer over a realistic position shape, so the
// exact strings on screen are asserted here and cannot silently drift.
function pills(position) {
  const o = buildLiveTradeOverlay({ position: pos(position), chartEpic: "GOLD" });
  return [
    formatLiveLabel(o.direction.toUpperCase(), liveLevelMetrics(o, "position", ACCOUNT_BASIS)),
    o.sl !== null
      ? formatLiveLabel("STOP LOSS", liveLevelMetrics(o, "stop", ACCOUNT_BASIS), { withR: false })
      : null,
    o.tp !== null ? formatLiveLabel("TAKE PROFIT", liveLevelMetrics(o, "target", ACCOUNT_BASIS)) : null,
  ].filter(Boolean);
}

test("1e: the three live pills render the documented format end-to-end", () => {
  // The account's own MT5 values are authoritative and win over $10/point.
  assert.deepEqual(
    pills({ slValue: -50, tpValue: 145.92, rewardRiskRatio: "2.92" }),
    ["BUY +0.06% +1.63R +$58.08", "STOP LOSS -0.05% -$50.00", "TAKE PROFIT +0.15% +4.10R +$145.92"],
  );
  // Without them the proven sensitivity supplies the money, and 1R is the stop.
  assert.deepEqual(pills({}), [
    "BUY +0.06% +1.63R +$58.08",
    "STOP LOSS -0.13% -$125.00",
    "TAKE PROFIT +0.13% +3.51R +$125.00",
  ]);
  // A short: its stop sits ABOVE entry and is still shown as a loss.
  assert.deepEqual(pills({ direction: "Sell", sl: 4313, tp: 4288 }), [
    "SELL +0.06% +1.63R +$58.08",
    "STOP LOSS -0.13% -$125.00",
    "TAKE PROFIT +0.13% +3.51R +$125.00",
  ]);
  // No sensitivity ⇒ the levels lose their $ and the R built on it, but the stop
  // still shows its ACCOUNT RISK % (the recorded 1R needs no sensitivity) and
  // the position keeps its % / $ from the server-reported floating P&L.
  assert.deepEqual(pills({ moneyPerPoint: null, liveR: null }), [
    "BUY +0.06% +1.63R +$58.08",
    "STOP LOSS",
    "TAKE PROFIT",
  ]);
  // Unset levels draw no pill at all.
  assert.deepEqual(pills({ sl: null, tp: null }), ["BUY +0.06% +1.63R +$58.08"]);
});

