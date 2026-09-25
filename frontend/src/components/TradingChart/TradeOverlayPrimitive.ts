/**
 * LWC v5 series primitive that renders the HISTORICAL MT5 TRADE OVERLAY
 * (P3-B) — an additive, presentation-only layer on the main series:
 *
 *   ENTRY   — direction-colored triangle TIP-anchored at the exact entry
 *             execution price (Buy = teal apex-up, Sell = red apex-down under
 *             the normal price scale).
 *   EXIT    — REVERSE triangle of the entry marker (visual refinement), same
 *             direction color, TIP-anchored at the exact exit execution price
 *             (LONG exit points down, SHORT exit points up).
 *   BAND    — DOTTED line connecting entry → exit (closed trades): green when
 *             pnl > 0, red when pnl < 0, the pre-existing neutral slate when
 *             break-even/unknown; open trades keep the dashed slate extension
 *             to the forming bucket and are never classified won/lost.
 *
 * Apex orientation is MEASURED from the chart's actual price→coordinate
 * behavior ({@link detectScaleOrientation}) — an inverted price scale flips
 * the visual directions while the tip stays anchored to the SAME numerical
 * execution price. TP/SL are deliberately NOT rendered (the sl/tp fields stay
 * on the overlay model for other consumers).
 *
 * Positioning contract (same as GapRegionsPrimitive / pineLabelPrimitive):
 * only SEMANTIC anchors are stored — EXACT execution epoch-ms resolved via
 * {@link resolveExactTimeX} (direct `timeToCoordinate` when the exact time is
 * a registered point, otherwise linear interpolation between the bracketing
 * registered chart points — the proven pineDrawings pattern, so a trade at
 * 15:10:55 renders at its true intra-candle position on BOTH 1m and 3m) and
 * prices via the series' `priceToCoordinate`. Overlays never touch candle
 * data, never register a second series, and render nothing when the overlay
 * set is empty. zOrder "top" so markers read above the candles; the band is
 * translucent so structure stays visible.
 *
 * Feeds exclusively from services/tradeOverlay.ts (P1 rows → geometry) —
 * this file does NO time conversion and NO symbol normalization.
 *
 * LIVE POSITION + ACCOUNT-RISK LAYER (additive, READ-ONLY) — the same canvas
 * primitive, in the TradingView annotation idiom:
 *
 *   LEVEL — a thin horizontal rule across the pane at the level's authoritative
 *           price. The live position's own level is SOLID neutral position blue;
 *           the MT5 SL/TP levels are dashed [3,3]; the three account-risk
 *           levels (profit target, daily loss, max drawdown) are dashed [6,4]
 *           in their own semantic colours. A level whose price is not derivable
 *           (D3) draws NO line at all — a price is never invented.
 *   PILL  — a compact rounded plate on ONE shared right-edge ladder, anchored
 *           to the level's line. Only levels with an authoritative price
 *           coordinate and whose line is inside the visible pane receive a pill.
 *           There is NO fallback placement: a level whose price cannot be
 *           derived (or is outside the visible pane) draws no label at all —
 *           never a floating plate parked in the upper-right corner.
 *   TAG   — the same price rendered by the chart's own RIGHT PRICE SCALE through
 *           LWC `priceAxisViews()` (see {@link LevelAxisView}), in the level's
 *           colour, visible only while the level's price coordinate is inside
 *           the pane.
 *
 * PRODUCT RULE: the account-risk layer is projected ONLY while an applicable
 * live position is open on the chart's instrument (enforced upstream in
 * services/tradeOverlay.ts and App.tsx). Configured account limits alone are
 * NEVER chart decorations.
 *
 * Nothing in this layer is interactive: no pointer/click/drag handler is ever
 * registered, no trade state is held, and no value can be dragged or edited.
 */
import type { SeriesAttachedParameter, Time } from "lightweight-charts";

import type {
  LiveTradeOverlay,
  RiskLevelKind,
  RiskLevelOverlay,
  TradeOverlay,
} from "../../services/tradeOverlay";

type TimeScaleLike = {
  /** Exact time→x conversion — non-null only for REGISTERED time points. */
  timeToCoordinate?(time: number): number | null;
};

type ChartLike = {
  timeScale(): TimeScaleLike;
};

/** Series slice — `priceToCoordinate` is directly on ISeriesApi in LWC v5. */
type SeriesLike = {
  priceToCoordinate(price: number): number | null;
};

/** Same structural canvas-target alias as the sibling primitives. */
type DrawCanvasTarget = {
  useBitmapCoordinateSpace: <T>(f: (scope: {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
    horizontalPixelRatio: number;
    verticalPixelRatio: number;
  }) => T) => T;
};

/** How far (in whole buckets) to probe outward for a registered neighbor. */
const MAX_BRACKET_PROBE = 8;

/**
 * Exact execution-time → screen X for a timestamp that is usually NOT itself
 * a registered chart point (`timeToCoordinate` returns null for those —
 * live-proven, and fractional `logicalToCoordinate` collapses to 0).
 *
 * Resolution order (the proven pineDrawings `fractionalLogicalToCoordinate`
 * neighbor-probe pattern, applied in TIME space):
 *   1. Direct `timeToCoordinate(exact)` — exact times that ARE registered.
 *   2. Bracket on the chart's OWN bucket grid: probe the containing bucket
 *      start and the next one (walking ≤ MAX_BRACKET_PROBE steps outward when
 *      a slot is unregistered — gaps/edges), then interpolate strictly between
 *      those two REGISTERED coordinates:
 *          x = x0 + (x1 - x0) · (exact - t0) / (t1 - t0)
 *      No pixel-per-minute constant, no barSpacing math — only the chart's
 *      actual registered time points.
 *   3. Right-edge fallback (no registered point after `t0` — trade inside the
 *      newest bucket): extend the line through the PREVIOUS bracket
 *      `(t0 - bucket, t0)` — same two-neighbor slope probe pineDrawings uses.
 *   4. Nothing registered nearby ⇒ null (caller skips, as before).
 *
 * Pure — node-testable against a fake timeScale.
 */
export function resolveExactTimeX(
  exactMs: number,
  bucketMs: number,
  timeScale: TimeScaleLike,
): number | null {
  if (!Number.isFinite(exactMs)) return null;
  const at = (sec: number): number | null => {
    const x = timeScale.timeToCoordinate?.(sec);
    return typeof x === "number" && Number.isFinite(x) ? x : null;
  };
  // 1) registered exact point
  const direct = at(exactMs / 1000);
  if (direct !== null) return direct;
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) return null;
  // 2) bracketing registered points on the chart grid
  const grid = Math.floor(exactMs / bucketMs) * bucketMs;
  let t0: number | null = null;
  let x0: number | null = null;
  for (let k = 0; k <= MAX_BRACKET_PROBE; k++) {
    const t = grid - k * bucketMs;
    const x = at(t / 1000);
    if (x !== null) { t0 = t; x0 = x; break; }
  }
  if (t0 === null || x0 === null) return null;
  let t1: number | null = null;
  let x1: number | null = null;
  for (let k = 1; k <= MAX_BRACKET_PROBE + 1; k++) {
    const t = grid + k * bucketMs;
    const x = at(t / 1000);
    if (x !== null) { t1 = t; x1 = x; break; }
  }
  if (t1 !== null && x1 !== null && t1 > t0) {
    return x0 + ((x1 - x0) * (exactMs - t0)) / (t1 - t0);
  }
  // 3) right edge — extend through the previous registered neighbor
  const xm = at((t0 - bucketMs) / 1000);
  if (xm !== null) {
    return x0 + ((x0 - xm) * (exactMs - t0)) / bucketMs;
  }
  // Lone registered point: the bucket-start coordinate is the best truthful
  // position available (degenerate — one visible bar).
  return x0;
}

/**
 * Screen-space orientation of the price axis, MEASURED from the series' own
 * price→coordinate behavior (never hardcoded from the BUY/SELL flag alone):
 * a probe price one unit higher maps to a SMALLER y (up) on the normal scale
 * and to a LARGER y when the chart's price scale is inverted. Undecidable
 * probes (null / identical coordinates) fall back to "normal" — the
 * pre-refinement orientation, so nothing flips without evidence.
 */
export type ScaleOrientation = "normal" | "inverted";

export function detectScaleOrientation(series: SeriesLike, probePrice: number): ScaleOrientation {
  const y0 = series.priceToCoordinate(probePrice);
  const y1 = series.priceToCoordinate(probePrice + 1);
  if (y0 === null || y1 === null || y1 === y0) return "normal";
  return y1 > y0 ? "inverted" : "normal";
}

/** Visual apex direction of a marker triangle in SCREEN space. */
export type MarkerApex = "up" | "down";

/**
 * The ENTRY marker keeps the pre-existing orientation (Buy up / Sell down on
 * the normal scale); the EXIT marker is always the REVERSE triangle. An
 * inverted price axis flips BOTH — the apex is presentation only: the tip
 * stays anchored to the same execution-price coordinate either way.
 */
export function markerApex(
  marker: "entry" | "exit",
  direction: "Buy" | "Sell",
  orientation: ScaleOrientation,
): MarkerApex {
  const base: MarkerApex =
    direction === "Buy"
      ? marker === "entry"
        ? "up"
        : "down"
      : marker === "entry"
        ? "down"
        : "up";
  if (orientation === "normal") return base;
  return base === "up" ? "down" : "up";
}

/** Result classification for the entry→exit band (existing model semantics). */
export type BandOutcome = "win" | "loss" | "neutral" | "open";

/**
 * Win/loss straight from the ALREADY-ESTABLISHED `status` + `pnl` fields —
 * no second profit calculation is introduced:
 *   open            → "open"  (never classified won/lost)
 *   closed, pnl > 0 → "win"
 *   closed, pnl < 0 → "loss"
 *   closed, pnl = 0 / null → "neutral" (break-even or unknown keeps the
 *   pre-existing gray band — never arbitrarily a win or a loss)
 */
export function bandOutcome(overlay: Pick<TradeOverlay, "status" | "pnl">): BandOutcome {
  if (overlay.status === "open") return "open";
  const pnl = overlay.pnl;
  if (pnl !== null && pnl > 0) return "win";
  if (pnl !== null && pnl < 0) return "loss";
  return "neutral";
}

/** Live open-trade P&L outcome — informational only, never a trade decision. */
export type LivePnlTone = "profit" | "loss" | "flat";

/**
 * Classify a LIVE position's floating P&L for COLOR purposes only.
 *
 * This is NOT a win/loss classification of a completed trade: the position is
 * still open, so nothing here implies an outcome. It exists purely so the label
 * and marker can be tinted by sign, mirroring the closed band semantics.
 * Break-even (0) is its own neutral tone, never folded into profit or loss.
 */
export function livePnlTone(netPnl: number): LivePnlTone {
  if (!Number.isFinite(netPnl) || netPnl === 0) return "flat";
  return netPnl > 0 ? "profit" : "loss";
}

/** Compact signed USD for a live P&L label, e.g. `+$58.08` / `-$12.50`. */
export function formatLivePnl(netPnl: number): string {
  if (!Number.isFinite(netPnl)) return "P/L —";
  const rounded = Math.round(netPnl * 100) / 100;
  const sign = rounded < 0 ? "-" : "+";
  return `${sign}$${Math.abs(rounded).toFixed(2)}`;
}

/**
 * Compact signed R for a live label, e.g. `" +1.63R"`; null 1R ⇒ no R suffix.
 *
 * The leading space is intentional: it is the separator between the money and
 * the R in the composed label (`BUY 0.33 +$58.08 +1.63R`). Returning `""` for
 * an unknown 1R means the separator disappears with it, so the label can never
 * end in a dangling space or show a fake `0.00R`.
 */
export function formatLiveR(liveR: number | null): string {
  if (liveR === null || !Number.isFinite(liveR)) return "";
  return ` ${liveR > 0 ? "+" : ""}${liveR.toFixed(2)}R`;
}

/** Lot size for a live label, e.g. `0.33` / `1.50`; always two decimals. */
export function formatLots(lots: number): string {
  if (!Number.isFinite(lots)) return "";
  return lots.toFixed(2);
}

/**
 * Price for a price-scale tag / risk-label suffix. Uses the chart's own
 * `minimumPrice` precision when the caller supplies it; otherwise it renders the
 * standard two-decimal axis form, so a tag reads exactly like the numbers beside
 * it on the scale. Purely a label formatter — it never changes the value being
 * anchored, and it never rounds the price the line is drawn at.
 */
export function formatPrice(price: number, precision?: number | undefined): string {
  if (!Number.isFinite(price)) return "";
  if (typeof precision === "number" && Number.isFinite(precision) && precision >= 0) {
    return price.toFixed(Math.min(precision, 8));
  }
  return price.toFixed(2);
}

/** Direction colors (AURA teal/red, matching the candle palette). */
const BUY_COLOR = "#26a69a";
const SELL_COLOR = "#ef5350";
/**
 * Band stroke — open keeps the pre-existing dashed slate "still live"; closed
 * is DOTTED and result-colored: green win / red loss / slate neutral (a
 * break-even or unknown P/L keeps the pre-existing gray — never invented).
 */
const BAND_NEUTRAL = "rgba(148, 163, 184, 0.9)";
const BAND_OPEN = "rgba(148, 163, 184, 0.75)";
const BAND_WIN = BUY_COLOR;
const BAND_LOSS = SELL_COLOR;
const OPEN_BAND_DASH: readonly number[] = [5, 4];
const CLOSED_BAND_DASH: readonly number[] = [2, 3];
const MARKER_RING = "rgba(15, 23, 42, 0.9)";
/** Marker geometry (px, media space). */
const TRIANGLE_H = 14;
const TRIANGLE_W = 12;
/** Exit-triangle outline width (keeps the pre-refinement exit emphasis). */
const EXIT_STROKE_W = 2;
// ── Pill chrome: one shared "TradingView-style" label treatment ────────────────
// The pill is deliberately NOT a generic tooltip: it is a compact rounded
// plate, dark and translucent, with a semantic accent bar on its leading edge,
// a hairline border tinted to the level's colour and compact uppercase text.
// No shadow, no card, no panel — it reads as part of the chart, not a dashboard
// layered on top of it.
const PILL_R = 6; // corner radius (px) — a rounded pill, never a sharp rectangle
const PILL_PAD_X = 8; // horizontal breathing room inside the pill
const PILL_ACCENT_W = 3; // semantic accent bar on the leading edge
const PILL_ACCENT_H = 8; // accent bar height (centred in the 16px pill)
const PILL_ACCENT_GAP = 5; // gap between the accent bar and the text
const PILL_FONT = "600 10px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
/** Dark translucent plate — readable on a dark chart without a hard black box. */
const PILL_PLATE = "rgba(15, 23, 42, 0.88)";
/** Hairline border alpha: visible enough to group text, faint enough to recede. */
const PILL_BORDER_ALPHA = 0.7;
/** Neutral default border, used when a level supplies no semantic colour. */
const PILL_BORDER = `rgba(148, 163, 184, ${PILL_BORDER_ALPHA})`;

const EDGE_MARGIN_PX = 32; // skip drawing when fully off-viewport

// ── LIVE / ACCOUNT-RISK presentation tokens (read-only, informational) ──
/** Right-edge gutter: the pill ladder's margin (shared with the price scale). */
const RISK_LABEL_GUTTER = 8;
/** Every pill is exactly one rung tall; the ladder spacing derives from this. */
const RISK_LABEL_H = 16;
/** Alpha of the hairline that ties a de-collided pill back to its true price. */
const LEVEL_LEADER_ALPHA = 0.5;

/**
 * Account-risk stroke colours — profit green, daily loss amber, max drawdown
 * red. These identify the MEANING of the level, never the instrument or the
 * direction.
 */
const RISK_PROFIT = "#22c55e";
const RISK_DAILY = "#f59e0b";
const RISK_DRAWDOWN = "#ef5350";
const RISK_TEXT = "#e8eef9";
const RISK_PLATE = "rgba(15, 23, 42, 0.88)";
/**
 * The account-risk dash pattern. It is the visual signature of a risk line
 * (solid = the live position's own level, [3,3] = the position's MT5 SL/TP), so
 * one dash style can never be mistaken for another meaning.
 */
const RISK_LINE_DASH: readonly number[] = [6, 4];

// ── LIVE position tokens ──
// The open position's own LEVEL is the neutral TradingView-style position blue:
// the direction is already carried by the entry marker's colour and by the pill
// text, so the rule that says "this is where I am in the market" stays neutral.
// The pill plate is tinted by the P&L sign instead, keeping the established
// profit/loss coding for the money — never a new colour language.
const LIVE_ENTRY_COLOR = "#4c8dff";
const LIVE_PLATE_PROFIT = "rgba(6, 44, 38, 0.92)"; // teal-tinted dark
const LIVE_PLATE_LOSS = "rgba(56, 18, 22, 0.92)"; // red-tinted dark
const LIVE_PLATE_FLAT = PILL_PLATE;
const LIVE_TEXT = "#f1f5f9";
/**
 * Price-scale tag text: near-black on the bright semantic fill, matching the
 * library's own luminance rule for axis labels on light backgrounds.
 */
const AXIS_TAG_TEXT = "#0b1220";

// Pill hairlines, tinted to the same semantic colours as the level's line so a
// label and its rule read as one object. Same alpha as PILL_BORDER_ALPHA.
const BUY_BORDER = `rgba(34, 197, 94, ${PILL_BORDER_ALPHA})`;
const SELL_BORDER = `rgba(239, 83, 80, ${PILL_BORDER_ALPHA})`;
const RISK_PROFIT_BORDER = `rgba(34, 197, 94, ${PILL_BORDER_ALPHA})`;
const RISK_DAILY_BORDER = `rgba(245, 158, 11, ${PILL_BORDER_ALPHA})`;
const RISK_DRAWDOWN_BORDER = `rgba(239, 83, 80, ${PILL_BORDER_ALPHA})`;

/** The solid stroke colour of an account-risk level (semantic, never arbitrary). */
function riskColor(kind: RiskLevelKind): string {
  return kind === "profitTarget" ? RISK_PROFIT : kind === "dailyLoss" ? RISK_DAILY : RISK_DRAWDOWN;
}

/** The hairline colour of an account-risk pill — the same hue as its line. */
function riskBorder(kind: RiskLevelKind): string {
  return kind === "profitTarget"
    ? RISK_PROFIT_BORDER
    : kind === "dailyLoss"
      ? RISK_DAILY_BORDER
      : RISK_DRAWDOWN_BORDER;
}

/** Hit-free by design: live overlays expose no hover/click/drag surface. */

/**
 * Pure helper: vertical de-collision for the compact right-edge pill ladder.
 *
 * Rungs are walked TOP-DOWN and pushed apart so two levels that resolve to
 * nearby (or off-screen) prices never overlap. Top-down matches the order the
 * caller supplies — {@link layoutLevelRungs} sorts by the TRUE price first, so
 * the ladder reads like the price scale itself.
 *
 * The LINE is never moved — only the label box — so every level stays anchored
 * to its exact price. A `null` y (no derivable price) yields a `null` top so the
 * caller can leave that descriptor unpainted. Pure, so the collision rule is
 * node-testable without a canvas.
 */
export function layoutRiskLabelTops(
  ys: readonly (number | null)[],
  height: number,
): readonly (number | null)[] {
  const tops: (number | null)[] = new Array(ys.length).fill(null);
  const maxTop = Math.max(0, height - RISK_LABEL_H);
  let lastBottom = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i]!;
    if (y === null || !Number.isFinite(y)) continue;
    let top = Math.min(Math.max(y - RISK_LABEL_H / 2, 0), maxTop);
    if (top < lastBottom) top = lastBottom;
    tops[i] = top;
    lastBottom = top + RISK_LABEL_H + 2;
  }
  return tops;
}

/**
 * One pill rung of the shared right-edge ladder — a live position's P&L pill OR
 * an account-risk level's pill.
 *
 * `y` is the level's TRUE price coordinate, produced by the series'
 * `priceToCoordinate` (always finite, never null). Rows are created ONLY when a
 * level has an authoritative price AND that price produces a coordinate on the
 * current chart scale. A threshold whose price was not derived (or cannot be
 * mapped) is NOT a chart level and does NOT produce a row: it receives NO line,
 * NO pill, and NO price-scale tag.
 *
 * Nothing here is a trade handle: a rung is display data only.
 */
interface LevelRow {
  /** Ladder identity — positional, never derived from a trade ticket. */
  readonly key: string;
  /** The level's exact price coordinate (the line's own geometry). */
  readonly y: number;
  readonly text: string;
  readonly plate: string;
  readonly textColor: string;
  /** Solid semantic colour: the pill's accent bar and its leader hairline. */
  readonly accent: string;
  /** Hairline border tinted to the same hue. */
  readonly border: string;
}

/**
 * A rung after vertical de-collision:
 * `top` is the plate's pixel top when the level's line is inside the visible
 * pane (0..height), or `null` when the line sits outside the visible pane.
 * There is NO fallback placement: a `null` top means NO pill is drawn, so an
 * off-screen level never parks a label in the chart's corner.
 */
interface LaidOutLevelRow extends LevelRow {
  readonly top: number | null;
}

/**
 * Lay the right-edge pill ladder out ONCE, for BOTH layers.
 *
 * Rungs are ordered by their TRUE price — the highest price sits at the top, so
 * the ladder reads like the price scale itself (on an inverted scale the order
 * simply mirrors, because every y already comes from the chart). Rungs that
 * would overlap are pushed apart by {@link layoutRiskLabelTops}; a displaced
 * pill keeps a leader hairline back to its own level, so no line ever moves for
 * presentation.
 *
 * PILLS ARE ANCHORED STRICTLY TO VISIBLE LINES: only rungs whose price line is
 * inside the visible pane (0..height) receive a pill plate. Off-screen levels
 * and price-less levels get `top === null` (NO pill drawn) — there is NO
 * fallback stack, and labels are NEVER parked in the upper-right corner.
 *
 * Pure — no canvas, no chart, so the collision rule stays node-testable.
 */
function layoutLevelRungs(
  rows: readonly LevelRow[],
  height: number,
): readonly LaidOutLevelRow[] {
  // Only levels whose line is INSIDE the pane receive a pill: a level outside
  // the visible price range keeps its (invisibly painted) line and gets NO
  // label — never a fallback position, never a corner placement.
  const onPane = rows
    .filter((row) => row.y >= 0 && row.y <= height)
    .slice()
    .sort((a, b) => a.y - b.y);

  const tops = layoutRiskLabelTops(
    onPane.map((row) => row.y),
    height,
  );
  const byKey = new Map<string, number>();
  onPane.forEach((row, i) => {
    const top = tops[i];
    if (top !== null && top !== undefined) byKey.set(row.key, top);
  });

  return rows.map((row) => ({ ...row, top: byKey.get(row.key) ?? null }));
}

type PrimitivePaneViewZOrder_ = "bottom" | "normal" | "top";
interface IPrimitivePaneView_ {
  zOrder?(): PrimitivePaneViewZOrder_;
  renderer(): IPrimitivePaneRenderer_ | null;
}
interface IPrimitivePaneRenderer_ {
  draw(target: DrawCanvasTarget): void;
}

/** Shared pane view (stable reference — LWC caches views). */
class TradeOverlayPaneView implements IPrimitivePaneView_ {
  private readonly owner: TradeOverlayPrimitive;
  constructor(owner: TradeOverlayPrimitive) {
    this.owner = owner;
  }
  zOrder(): PrimitivePaneViewZOrder_ {
    return "top";
  }
  renderer(): IPrimitivePaneRenderer_ | null {
    return this.owner.renderer;
  }
}

/**
 * One tag on the RIGHT PRICE SCALE (LWC `priceAxisViews`).
 *
 * This is the TradingView-native half of a level annotation: the chart's own
 * price scale paints the level's price as an axis tag in the level's colour, so
 * the price stays readable exactly where a trader looks for it, and the chart
 * library — not this primitive's canvas — owns the tag's geometry.
 *
 * The methods are pure getters: they report the current coordinate and colours
 * and nothing else. LWC re-reads them on every layout pass, so the tag always
 * sits on the chart's own mapping for that price — the number can never drift
 * from the level.
 */
interface IPrimitiveAxisView_ {
  /** Vertical distance from the pane top, in pixels. */
  coordinate(): number;
  text(): string;
  textColor(): string;
  backColor(): string;
  visible?(): boolean;
  tickVisible?(): boolean;
}

/** The coordinate source a price-scale tag reads (the series' price→pixel map). */
type LevelCoordinateSource = {
  levelCoordinate(price: number): number | null;
  /** Pane height from the latest draw pass, or null before any draw. */
  paneHeightLimit?(): number | null;
};

/** A price-scale tag bound to ONE authoritative price. */
class LevelAxisView implements IPrimitiveAxisView_ {
  private readonly owner: LevelCoordinateSource;
  private readonly price: number;
  private readonly color: string;

  constructor(owner: LevelCoordinateSource, price: number, color: string) {
    this.owner = owner;
    this.price = price;
    this.color = color;
  }

  /** The chart's own price→pixel mapping — never a re-derived price. */
  coordinate(): number {
    const y = this.owner.levelCoordinate(this.price);
    // A large negative sentinel keeps the library's automatic label placement
    // from reserving a blank slot for a level that has no coordinate right now;
    // `visible()` hides that case entirely.
    return y === null ? -1e6 : y;
  }

  /** The price, formatted — exactly the value the line is anchored to. */
  text(): string {
    return formatPrice(this.price);
  }

  /** Dark text on the bright semantic fill (the library's luminance rule). */
  textColor(): string {
    return AXIS_TAG_TEXT;
  }

  /** Solid semantic fill: the level's own line colour. */
  backColor(): string {
    return this.color;
  }

  visible(): boolean {
    const y = this.owner.levelCoordinate(this.price);
    if (y === null) return false;
    // An off-pane level is invisible on the scale as well: the axis tag must
    // never park at the scale's edge for a line that isn't in view.
    const height = this.owner.paneHeightLimit?.();
    return height === undefined || height === null || (y >= 0 && y <= height);
  }

  /** A short coloured tick on the scale, so the tag ties to its line. */
  tickVisible(): boolean {
    return true;
  }
}

/**
 * One series-attached trade-overlay primitive. Call `setOverlays()` with
 * fresh geometry; an empty array clears everything drawn.
 * `formingBucketMs` (epoch-ms of the current forming candle, or null) is the
 * ONLY live element: open trades extend to it — never to an invented time.
 */
export class TradeOverlayPrimitive {
  private chart: ChartLike | null = null;
  private series: SeriesLike | null = null;
  private requestUpdate: (() => void) | null = null;
  private overlays: TradeOverlay[] = [];
  private liveOverlays: LiveTradeOverlay[] = [];
  private riskLevels: RiskLevelOverlay[] = [];
  private formingBucketMs: number | null = null;
  /** The CHART's current candle bucket (epoch-ms) — drives exact-X bracketing. */
  private bucketMs = 60_000;
  private view: TradeOverlayPaneView | null = null;
  private needsRedraw = true;
  /** Pane height captured from the latest draw pass (keeps off-pane tags hidden). */
  private lastPaneHeight: number | null = null;
  /**
   * Cached price-scale tags. LWC caches the mapped labels by ARRAY REFERENCE and
   * re-reads each view's coordinate/colours on every layout pass, so the array
   * is rebuilt only when the level set or the attached series changes.
   */
  private axisViews: readonly IPrimitiveAxisView_[] = [];
  /** Signature of the state the cached tags were built from. */
  private axisSignature = "";

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as unknown as ChartLike;
    this.series = param.series as unknown as SeriesLike;
    this.requestUpdate = param.requestUpdate;
    // A re-attach means a new chart/series: the price→coordinate mapping the
    // cached tags read has changed, so they must be rebuilt.
    this.invalidateAxisViews();
    if (this.needsRedraw && this.requestUpdate) {
      this.needsRedraw = false;
      this.requestUpdate();
    }
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.invalidateAxisViews();
  }

  /**
   * Update the overlays to render; schedules an LWC repaint.
   * `bucketSec` is the chart's CURRENT candle timeframe (60 on 1m, 180 on 3m)
   * — TradeOverlayBridge passes TradingChart's `resolutionToBucketSec` value so
   * exact-time bracketing always follows the chart, never a hard-coded grid.
   */
  setOverlays(
    overlays: readonly TradeOverlay[],
    formingBucketMs: number | null,
    bucketSec?: number,
  ): void {
    this.overlays = [...overlays];
    this.formingBucketMs = formingBucketMs;
    if (bucketSec !== undefined && Number.isFinite(bucketSec) && bucketSec > 0) {
      this.bucketMs = bucketSec * 1000;
    }
    if (this.requestUpdate) this.requestUpdate();
    else this.needsRedraw = true;
  }

  /**
   * Update the LIVE open-trade and account-risk overlays (read-only).
   *
   * These are pure display descriptors built from the authoritative server
   * state. This method only stores them and repaints — it exposes no command,
   * no callback and no mutable trade handle, so nothing a user does with the
   * chart can reach MT5. Passing empty arrays clears the layer.
   */
  setLiveOverlays(
    live: readonly LiveTradeOverlay[],
    risk: readonly RiskLevelOverlay[],
  ): void {
    this.liveOverlays = [...live];
    this.riskLevels = [...risk];
    this.invalidateAxisViews();
    if (this.requestUpdate) this.requestUpdate();
    else this.needsRedraw = true;
  }

  /**
   * PRICE-SCALE TAGS (read-only) — the price of every drawn level, painted by
   * the chart's own RIGHT price scale in the level's colour.
   *
   * This is the "price stays visible on the scale" half of the annotation: the
   * tag reads the SAME authoritative price the horizontal line is anchored to
   * (both go through the series' `priceToCoordinate`), so the two can never
   * disagree. A level without a derivable price contributes no tag — never a
   * fabricated number.
   *
   * LWC re-reads the view objects on every layout pass, so the returned array is
   * rebuilt only when the level set or the series changes (its own cache keys on
   * the array reference).
   */
  priceAxisViews(): readonly IPrimitiveAxisView_[] {
    const signature = this.axisSignatureFor();
    if (signature !== this.axisSignature) {
      this.axisSignature = signature;
      this.axisViews = this.buildAxisViews();
    }
    return this.axisViews;
  }

  /**
   * The chart's OWN price→coordinate mapping, or null when it has no
   * coordinate for that price. Shared by the price-scale tags — never a
   * re-derived or adjusted price.
   */
  levelCoordinate(price: number): number | null {
    const series = this.series;
    if (!series) return null;
    const y = series.priceToCoordinate(price);
    return y !== null && Number.isFinite(y) ? y : null;
  }

  /** Visible pane height from the latest draw pass (null before first draw). */
  paneHeightLimit(): number | null {
    return this.lastPaneHeight;
  }

  /** Cheap identity of the current level set — drives the tag cache. */
  private axisSignatureFor(): string {
    const parts: string[] = [];
    for (const live of this.liveOverlays) {
      parts.push(`p:${live.direction}:${live.entryPrice}:${live.sl ?? "-"}:${live.tp ?? "-"}`);
    }
    for (const level of this.riskLevels) {
      parts.push(`r:${level.kind}:${level.price === null ? "-" : level.price}`);
    }
    return parts.join("|");
  }

  /** One tag per authoritative level price, in ladder order. */
  private buildAxisViews(): readonly IPrimitiveAxisView_[] {
    const views: IPrimitiveAxisView_[] = [];
    for (const live of this.liveOverlays) {
      if (Number.isFinite(live.entryPrice)) {
        views.push(new LevelAxisView(this, live.entryPrice, LIVE_ENTRY_COLOR));
      }
      if (live.sl !== null && Number.isFinite(live.sl)) {
        views.push(new LevelAxisView(this, live.sl, SELL_COLOR));
      }
      if (live.tp !== null && Number.isFinite(live.tp)) {
        views.push(new LevelAxisView(this, live.tp, BUY_COLOR));
      }
    }
    for (const level of this.riskLevels) {
      if (level.price === null || !Number.isFinite(level.price)) continue;
      views.push(new LevelAxisView(this, level.price, riskColor(level.kind)));
    }
    return views;
  }

  /** Drop the cached tags so the next read rebuilds them from the new state. */
  private invalidateAxisViews(): void {
    this.axisSignature = "";
    this.axisViews = [];
  }

  paneViews(): readonly IPrimitivePaneView_[] {
    if (!this.view) this.view = new TradeOverlayPaneView(this);
    return [this.view] as readonly IPrimitivePaneView_[];
  }

  readonly renderer: IPrimitivePaneRenderer_ = {
    draw: (target: DrawCanvasTarget): void => {
      const chart = this.chart;
      const series = this.series;
      // Gate on ANY layer being populated. The historical and live layers are
      // independent (an account can have open positions and no closed trades in
      // view), so neither may short-circuit the other.
      if (!chart || !series) return;
      if (
        this.overlays.length === 0 &&
        this.liveOverlays.length === 0 &&
        this.riskLevels.length === 0
      ) {
        return;
      }
      target.useBitmapCoordinateSpace((scope) => {
        this.lastPaneHeight = scope.mediaSize.height;
      });
      this.drawOverlays(chart, series, target);
      // The live/risk layer is INDEPENDENT: an account can have open MT5
      // positions and no closed trades in view, so neither layer may gate the
      // other. Both are read-only drawing over the same chart/series.
      this.drawLiveOverlays(chart, series, target);
      this.drawRiskLevels(chart, series, target);
    },
  };

  private drawOverlays(
    chart: ChartLike,
    series: SeriesLike,
    target: DrawCanvasTarget,
  ): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const px = scope.horizontalPixelRatio > 0 ? scope.horizontalPixelRatio : 1;
      const py = scope.verticalPixelRatio > 0 ? scope.verticalPixelRatio : 1;
      ctx.save();
      ctx.scale(px, py);

      const timeScale = chart.timeScale();
      const width = scope.mediaSize.width;
      const height = scope.mediaSize.height;

      for (const overlay of this.overlays) {
        // EXACT execution time, not the bucket start: interpolated between the
        // chart's bracketing registered points (works on 1m AND 3m — a 1m-
        // floored time is irrelevant here because entryExactMs carries the
        // true seconds, and the bracket runs on THIS chart's bucket grid).
        const ex = resolveExactTimeX(overlay.entryExactMs, this.bucketMs, timeScale);
        if (ex === null) continue; // nothing registered near the entry (edge)
        const ey = series.priceToCoordinate(overlay.entryPrice);
        if (ey === null) continue;
        if (ex < -EDGE_MARGIN_PX || ex > width + EDGE_MARGIN_PX) continue;
        this.drawTrade(ctx, timeScale, series, overlay, ex, ey, height);
      }

      ctx.restore();
    });
  }

  /** One trade: dotted result-colored band + entry triangle + reverse exit triangle. */
  private drawTrade(
    ctx: CanvasRenderingContext2D,
    timeScale: TimeScaleLike,
    series: SeriesLike,
    overlay: TradeOverlay,
    ex: number,
    ey: number,
    height: number,
  ): void {
    // Band end: the EXACT exit instant (closed trade), or the forming bucket
    // for open trades (extended strictly forward in time — never invented).
    const exitExact = overlay.exitExactMs;
    const endIsExit = exitExact !== null;
    const endIsForming =
      !endIsExit &&
      this.formingBucketMs !== null &&
      this.formingBucketMs > overlay.entryExactMs;
    let exEnd: number | null = null;
    if (endIsExit) {
      // Same exact-time bracketing as the entry — exit ring and band end sit
      // at the true intra-candle position of time_close on 1m AND 3m.
      exEnd = resolveExactTimeX(exitExact, this.bucketMs, timeScale);
    } else if (endIsForming && this.formingBucketMs !== null) {
      // The forming bucket IS a registered point (the live candle) — direct.
      exEnd = timeScale.timeToCoordinate?.(this.formingBucketMs / 1000) ?? null;
    }
    const eyEnd =
      (endIsExit || endIsForming) && overlay.exitPrice !== null
        ? series.priceToCoordinate(overlay.exitPrice)
        : ey; // open trade: horizontal at the entry price
    const color = overlay.direction === "Buy" ? BUY_COLOR : SELL_COLOR;
    // Screen-space orientation MEASURED from the chart's actual price→coordinate
    // behavior — normal and inverted scales flip the apexes together, while the
    // tip anchor (the execution-price coordinate) never moves.
    const orientation = detectScaleOrientation(series, overlay.entryPrice);

    // TRADE BAND — DOTTED entry → exit, colored by the existing result
    // semantics (pnl > 0 green / pnl < 0 red / break-even-or-unknown slate)…
    // open trades keep the pre-existing dashed slate extension to the forming
    // bucket and are never classified won/lost.
    if (exEnd !== null && eyEnd !== null) {
      const yClamped = Math.max(-EDGE_MARGIN_PX, Math.min(height + EDGE_MARGIN_PX, eyEnd));
      if (Math.abs(exEnd - ex) > 1) {
        const outcome = bandOutcome(overlay);
        ctx.save();
        if (outcome === "open") {
          ctx.strokeStyle = BAND_OPEN;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([...OPEN_BAND_DASH]);
        } else {
          ctx.strokeStyle =
            outcome === "win" ? BAND_WIN : outcome === "loss" ? BAND_LOSS : BAND_NEUTRAL;

          ctx.lineWidth = 1.25;
          ctx.setLineDash([...CLOSED_BAND_DASH]);
        }
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(exEnd, yClamped);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ENTRY marker — direction-colored triangle, TIP exactly at the entry price.
    this.drawTriangle(ctx, ex, ey, markerApex("entry", overlay.direction, orientation), color, 1);

    // EXIT marker — REVERSE triangle at the independently-mapped EXACT exit
    // time/price. The TIP is anchored to overlay.exitPrice (never candle
    // OHLC/center/close); only its screen direction mirrors the entry marker.
    const exitX =
      overlay.exitExactMs !== null
        ? resolveExactTimeX(overlay.exitExactMs, this.bucketMs, timeScale)
        : null;
    const exitY =
      exitX !== null && overlay.exitPrice !== null
        ? series.priceToCoordinate(overlay.exitPrice)
        : null;
    if (exitX !== null && exitY !== null) {
      this.drawTriangle(
        ctx,
        exitX,
        exitY,
        markerApex("exit", overlay.direction, orientation),
        color,
        EXIT_STROKE_W,
      );
    }
  }

  /**
   * One marker triangle: the TIP (first vertex) sits EXACTLY on the anchor
   * coordinate passed in — the execution-price Y and the exact-time X — and
   * the base sits on the side the apex points away from. Fill = direction
   * color; navy ring stroke outlines it (the exit marker keeps the heavier
   * pre-refinement outline).
   */
  private drawTriangle(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    apex: MarkerApex,
    fill: string,
    strokeWidth: number,
  ): void {
    const bodyY = apex === "up" ? y + TRIANGLE_H : y - TRIANGLE_H;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y); // TIP — the exact execution-price anchor
    ctx.lineTo(x - TRIANGLE_W / 2, bodyY);
    ctx.lineTo(x + TRIANGLE_W / 2, bodyY);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = MARKER_RING;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * LIVE open-trade layer — READ-ONLY visualization of actual MT5 state, drawn
   * in the TradingView annotation idiom: a thin horizontal level, a compact
   * rounded pill sitting ON that level, and the level's price tagged on the
   * right price scale.
   *
   * For each open position on the CURRENT chart instrument:
   *   • the position's own LEVEL — a thin SOLID rule across the pane at the real
   *     `entryPrice`, in the neutral position blue (direction is carried by the
   *     marker's colour and by the pill's own BUY/SELL text);
   *   • an entry triangle TIP-anchored at that same price, with its orientation
   *     MEASURED from the chart (`detectScaleOrientation`), so an inverted scale
   *     flips the visual apex while the numeric anchor does not move;
   *   • dashed SL/TP levels at the ACTUAL MT5 values (null = not set, so nothing
   *     is drawn at price 0);
   *   • a compact `BUY 0.33 +$58.08 +1.63R` pill on the shared right-edge
   *     ladder, de-collided against the account-risk pills.
   *
   * This method draws. It registers NO event handlers, exposes no callback, and
   * holds no mutable trade handle — the canvas output is the only product, so a
   * user cannot drag, edit or command anything from here.
   */
  private drawLiveOverlays(
    chart: ChartLike,
    series: SeriesLike,
    target: DrawCanvasTarget,
  ): void {
    if (this.liveOverlays.length === 0) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const px = scope.horizontalPixelRatio > 0 ? scope.horizontalPixelRatio : 1;
      const py = scope.verticalPixelRatio > 0 ? scope.verticalPixelRatio : 1;
      ctx.save();
      ctx.scale(px, py);

      const width = scope.mediaSize.width;
      const height = scope.mediaSize.height;
      const timeScale = chart.timeScale();
      // The SAME ladder the account-risk pass lays out: one shared, de-collided
      // pill rail for both layers, so a live P&L pill can never cover a risk
      // label (or the reverse).
      const rungByKey = this.rungIndex(series, height);

      this.liveOverlays.forEach((live, index) => {
        const ey = series.priceToCoordinate(live.entryPrice);
        if (ey === null || !Number.isFinite(ey)) return;
        const x = this.resolveLiveX(live.openTime, timeScale);
        const color = live.direction === "Buy" ? BUY_COLOR : SELL_COLOR;
        const orientation = detectScaleOrientation(series, live.entryPrice);

        // SL / TP: real MT5 levels, dashed, thinner than the entry marker.
        // Their colours are semantic (stop red / target green), independent of
        // whether the position itself is BUY or SELL.
        if (live.sl !== null) {
          const slY = series.priceToCoordinate(live.sl);
          if (slY !== null && Number.isFinite(slY)) {
            this.drawLiveLevel(ctx, x, slY, width, SELL_COLOR);
          }
        }
        if (live.tp !== null) {
          const tpY = series.priceToCoordinate(live.tp);
          if (tpY !== null && Number.isFinite(tpY)) {
            this.drawLiveLevel(ctx, x, tpY, width, BUY_COLOR);
          }
        }

        // The open position's own level: a thin SOLID line across the pane at
        // the actual MT5 entry price, so the eye can trace the pill and the
        // price-scale tag straight back to the price. Solid (not dashed) keeps
        // the dash channel exclusive to SL/TP and the account-risk levels. It
        // needs no registered time — only the marker below does.
        this.drawLiveEntryLevel(ctx, ey, width);

        // ENTRY marker — direction-colored triangle, TIP exactly at the entry
        // price. Without a registered time point the LEVEL and its pill still
        // render; only the marker needs a time anchor.
        if (x !== null && x >= -EDGE_MARGIN_PX && x <= width + EDGE_MARGIN_PX) {
          this.drawTriangle(ctx, x, ey, markerApex("entry", live.direction, orientation), color, 1);
        }

        // Live-position pills on the ladder, drawn AFTER the lines so they read
        // above them. SL/TP use their own shared rungs, so they also participate
        // in de-collision and leaders without a second ladder implementation.
        for (const key of [`live:${index}`, `live:${index}:sl`, `live:${index}:tp`]) {
          const rung = rungByKey.get(key);
          if (rung) this.drawRung(ctx, rung, width);
        }
      });

      ctx.restore();
    });
  }

  /** The laid-out pill ladder, indexed by rung key (shared by both layers). */
  private rungIndex(series: SeriesLike, height: number): ReadonlyMap<string, LaidOutLevelRow> {
    const rungs = layoutLevelRungs(this.buildLevelRows(series), height);
    const byKey = new Map<string, LaidOutLevelRow>();
    for (const rung of rungs) byKey.set(rung.key, rung);
    return byKey;
  }

  /** Live open-time → X, using the same exact-time contract as historical rows. */
  private resolveLiveX(openTime: string | null, timeScale: TimeScaleLike): number | null {
    if (openTime === null) return null;
    const parsed = Date.parse(
      openTime.includes("T") ? openTime : `${openTime.replace(" ", "T")}Z`,
    );
    if (!Number.isFinite(parsed)) return null;
    return resolveExactTimeX(parsed, this.bucketMs, timeScale);
  }

  /**
   * Every pill that belongs on the shared right-edge ladder: the live positions
   * of the CURRENT instrument first, then the three account-risk levels.
   *
   * STRICT GATING: a level becomes a row ONLY when it has an authoritative price
   * AND the series produces a finite coordinate for it. A threshold whose price
   * was not derived (or cannot be mapped) is NOT a chart level: it produces NO
   * row, gets NO line, gets NO pill, and gets NO price-scale tag — there is NO
   * fallback plate parked in the chart's corner.
   */
  private buildLevelRows(series: SeriesLike): LevelRow[] {
    const rows: LevelRow[] = [];
    const coord = (price: number): number | null => {
      const y = series.priceToCoordinate(price);
      return y !== null && Number.isFinite(y) ? y : null;
    };

    this.liveOverlays.forEach((live, index) => {
      const y = coord(live.entryPrice);
      if (y === null) return;
      const tone = livePnlTone(live.netPnl);
      rows.push({
        key: `live:${index}`,
        y,
        // Direction, size, money and R — the established live label contract.
        text: `${live.direction.toUpperCase()} ${formatLots(live.lots)} ${formatLivePnl(live.netPnl)}${formatLiveR(live.liveR)}`,
        // The plate is tinted by the P&L sign (the established money coding) and
        // the accent bar carries the same tone, so the pill reads at a glance.
        plate:
          tone === "profit" ? LIVE_PLATE_PROFIT : tone === "loss" ? LIVE_PLATE_LOSS : LIVE_PLATE_FLAT,
        textColor: LIVE_TEXT,
        accent: tone === "profit" ? BUY_COLOR : tone === "loss" ? SELL_COLOR : LIVE_ENTRY_COLOR,
        border: tone === "loss" ? SELL_BORDER : tone === "profit" ? BUY_BORDER : PILL_BORDER,
      });
      if (live.sl !== null) {
        const slY = coord(live.sl);
        if (slY !== null) {
          rows.push({
            key: `live:${index}:sl`,
            y: slY,
            text: `STOP LOSS  @ ${formatPrice(live.sl)}`,
            plate: RISK_PLATE,
            textColor: RISK_TEXT,
            accent: SELL_COLOR,
            border: SELL_BORDER,
          });
        }
      }
      if (live.tp !== null) {
        const tpY = coord(live.tp);
        if (tpY !== null) {
          rows.push({
            key: `live:${index}:tp`,
            y: tpY,
            text: `TAKE PROFIT  @ ${formatPrice(live.tp)}`,
            plate: RISK_PLATE,
            textColor: RISK_TEXT,
            accent: BUY_COLOR,
            border: BUY_BORDER,
          });
        }
      }
    });

    this.riskLevels.forEach((level, index) => {
      if (level.price === null) return;
      const y = coord(level.price);
      if (y === null) return;
      rows.push({
        key: `risk:${index}`,
        y,
        text: this.riskLabelText(level),
        plate: RISK_PLATE,
        textColor: RISK_TEXT,
        accent: riskColor(level.kind),
        border: riskBorder(level.kind),
      });
    });

    return rows;
  }

  /**
   * One laid-out pill on the right-edge ladder.
   *
   * Only levels whose line is inside the visible pane receive a pill (`top !== null`).
   * When `top === null` (level off-pane), this method returns immediately: NO
   * plate is drawn anywhere on screen.
   *
   * The plate is centred on its level's EXACT price whenever the ladder did not
   * have to push it away. When it was pushed, a hairline leader in the level's
   * own colour ties the pill back to the true line — the LINE never moves, so
   * an annotation can never imply a price the level does not have.
   */
  private drawRung(ctx: CanvasRenderingContext2D, rung: LaidOutLevelRow, width: number): void {
    if (rung.top === null) return;
    const right = width - RISK_LABEL_GUTTER;
    const plateWidth = this.pillWidth(ctx, rung.text, true);
    this.drawPillLeader(ctx, right - plateWidth - 1.5, rung.y, rung.top, rung.accent);
    this.drawPlateLabel(
      ctx,
      rung.text,
      right,
      rung.top,
      rung.plate,
      rung.textColor,
      "right",
      rung.border,
      rung.accent,
    );
  }

  /**
   * A hairline leader from a displaced pill back to its TRUE level price, in the
   * level's own colour. Drawn only when the ladder had to move the pill off its
   * level — a pill that covers its line needs no leader — so the relationship
   * between label and price is never ambiguous.
   *
   * SOLID by design: a dash pattern is the visual signature of a price line
   * (SL/TP [3,3], account risk [6,4]) and a leader is not a price line.
   */
  private drawPillLeader(
    ctx: CanvasRenderingContext2D,
    x: number,
    levelY: number,
    top: number,
    color: string,
  ): void {
    const bottom = top + RISK_LABEL_H;
    let from: number;
    let to: number;
    if (levelY < top) {
      from = levelY;
      to = top;
    } else if (levelY > bottom) {
      from = bottom;
      to = levelY;
    } else {
      return; // the plate already sits on its line
    }
    if (to - from < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = LEVEL_LEADER_ALPHA;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, from);
    ctx.lineTo(x, to);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The open position's own level: a thin SOLID rule across the pane at the
   * exact MT5 entry price, in the neutral TradingView-like position blue, so the
   * eye can trace its pill and price-scale tag straight back to the price.
   *
   * SOLID (not dashed) on purpose: the dashed channel is reserved for SL/TP and
   * the account-risk levels, so one dash style can never be mistaken for
   * another meaning. The Y is the chart's own coordinate for `entryPrice` — the
   * line is never snapped to a candle, centre, or close.
   */
  private drawLiveEntryLevel(ctx: CanvasRenderingContext2D, y: number, width: number): void {
    ctx.save();
    ctx.strokeStyle = LIVE_ENTRY_COLOR;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width - RISK_LABEL_GUTTER, y);
    ctx.stroke();
    ctx.restore();
  }

  /** A dashed SL/TP level spanning the pane, drawn under the markers. */
  private drawLiveLevel(
    ctx: CanvasRenderingContext2D,
    x: number | null,
    y: number,
    width: number,
    color: string,
  ): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x === null ? 0 : Math.max(0, x), y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * ACCOUNT-RISK layer — informational overlays for the three configured
   * allowances, rendered as TradingView-style annotations: a thin dashed rule
   * across the chart at the solved price, a compact pill sitting on that rule,
   * and the price tagged on the right price scale.
   *
   * A horizontal line and pill are drawn ONLY for levels whose price was
   * mathematically derived (D3) AND whose line is on the visible pane; a level
   * whose price could not be proven (or cannot be mapped) draws NOTHING — no
   * line, no pill, no price-scale tag. These levels are read-only: no value here
   * can be dragged or edited, and the pill ladder is shared with the live layer
   * so the two can never cover each other.
   */
  private drawRiskLevels(
    chart: ChartLike,
    series: SeriesLike,
    target: DrawCanvasTarget,
  ): void {
    if (this.riskLevels.length === 0) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const px = scope.horizontalPixelRatio > 0 ? scope.horizontalPixelRatio : 1;
      const py = scope.verticalPixelRatio > 0 ? scope.verticalPixelRatio : 1;
      ctx.save();
      ctx.scale(px, py);

      const width = scope.mediaSize.width;
      const height = scope.mediaSize.height;
      void chart; // time scale is irrelevant: risk levels are horizontal.

      // The SAME shared ladder the live pass draws from.
      const rungByKey = this.rungIndex(series, height);

      this.riskLevels.forEach((level, index) => {
        const rung = rungByKey.get(`risk:${index}`);
        if (!rung) return;

        // The LINE stays on the EXACT derived price: never snapped, never
        // clamped, never moved for layout. Visibility only decides where the
        // PILL is placed. The y comes straight from the chart's own mapping, so
        // nothing here can introduce a price the backend did not solve.
        ctx.save();
        ctx.strokeStyle = riskColor(level.kind);
        ctx.lineWidth = 1;
        ctx.setLineDash([...RISK_LINE_DASH]);
        ctx.beginPath();
        ctx.moveTo(0, rung.y);
        ctx.lineTo(width - RISK_LABEL_GUTTER, rung.y);
        ctx.stroke();
        ctx.restore();

        this.drawRung(ctx, rung, width);
      });

      ctx.restore();
    });
  }

  /** Risk label text. The monetary amount is always shown; the price suffix is
   * appended only when one was actually derived. */
  private riskLabelText(level: RiskLevelOverlay): string {
    return level.price === null ? level.label : `${level.label}  @ ${formatPrice(level.price)}`;
  }

  /**
   * A compact ROUNDED PILL label — the single chart-native label treatment shared
   * by the live-position and account-risk levels.
   *
   * Deliberately NOT a generic tooltip or a dashboard card: a small dark
   * translucent plate, softly rounded corners, a semantic accent bar on the
   * leading edge, a hairline border tinted to the level's colour and compact
   * uppercase text. No shadow, no gradient, no panel — it reads as part of the
   * chart.
   *
   * The rounded outline is built from `moveTo`/`lineTo` + four `arc` calls rather
   * than `roundRect`, so it works on every canvas implementation (and keeps the
   * draw calls explicit). Every filled path has 4 or more vertices, so a pill (or
   * its accent bar) can never be mistaken for a 3-point entry/exit triangle.
   *
   * Purely visual: the drawn area is never registered for hit-testing, so it
   * cannot receive pointer, drag, or edit events. The text is painted in ONE
   * `fillText` call — the hierarchy comes from the plate, the accent and the
   * border, never from layering more glyphs over the chart.
   */
  private drawPlateLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    plate: string,
    color: string,
    align: "center" | "right" = "center",
    border: string = PILL_BORDER,
    accent?: string,
  ): void {
    ctx.save();
    ctx.font = PILL_FONT;
    ctx.textBaseline = "middle";
    const hasAccent = accent !== undefined;
    const w = this.pillWidth(ctx, text, hasAccent);
    const h = RISK_LABEL_H;
    const left = align === "right" ? x - w : x - w / 2;
    const r = Math.min(PILL_R, h / 2, w / 2);

    this.traceRoundedRect(ctx, left, y, w, h, r);
    ctx.fillStyle = plate;
    ctx.fill();
    // Hairline border in the level's semantic colour — groups the text without
    // competing with the horizontal level line.
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (accent !== undefined) {
      // A compact accent bar in the level's own colour: the pill's identity,
      // readable at a glance without a second text colour or a second text call.
      const barX = left + PILL_PAD_X / 2;
      const barY = y + (h - PILL_ACCENT_H) / 2;
      this.traceRoundedRect(ctx, barX, barY, PILL_ACCENT_W, PILL_ACCENT_H, PILL_ACCENT_W / 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }

    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.fillText(text, left + this.pillTextInset(hasAccent), y + h / 2);
    ctx.restore();
  }

  /** Exact pill width for a label — shared by the painter and the leader. */
  private pillWidth(ctx: CanvasRenderingContext2D, text: string, accent: boolean): number {
    const measured = this.measurePillText(ctx, text);
    return measured + PILL_PAD_X * 2 + (accent ? PILL_ACCENT_W + PILL_ACCENT_GAP : 0);
  }

  /** Where the text starts inside the plate (after the accent bar, if any). */
  private pillTextInset(accent: boolean): number {
    return PILL_PAD_X + (accent ? PILL_ACCENT_W + PILL_ACCENT_GAP : 0);
  }

  /** Text width under the pill font, without leaking the font onto the caller. */
  private measurePillText(ctx: CanvasRenderingContext2D, text: string): number {
    ctx.save();
    ctx.font = PILL_FONT;
    const width = ctx.measureText(text).width;
    ctx.restore();
    return width;
  }

  /**
   * Rounded-rectangle PATH (no fill, no stroke) at a given pixel box: four corner
   * arcs joined by four straight edges. Explicit arcs keep this portable across
   * canvas implementations and keep the recorded path unambiguous.
   */
  private traceRoundedRect(
    ctx: CanvasRenderingContext2D,
    left: number,
    top: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    const r = Math.max(0, Math.min(radius, height / 2, width / 2));
    ctx.beginPath();
    ctx.moveTo(left + r, top);
    ctx.lineTo(left + width - r, top);
    ctx.arc(left + width - r, top + r, r, -Math.PI / 2, 0);
    ctx.lineTo(left + width, top + height - r);
    ctx.arc(left + width - r, top + height - r, r, 0, Math.PI / 2);
    ctx.lineTo(left + r, top + height);
    ctx.arc(left + r, top + height - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(left, top + r);
    ctx.arc(left + r, top + r, r, Math.PI, (3 * Math.PI) / 2);
    ctx.closePath();
  }
}
