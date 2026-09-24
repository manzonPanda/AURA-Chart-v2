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
 */
import type { SeriesAttachedParameter, Time } from "lightweight-charts";

import type { TradeOverlay } from "../../services/tradeOverlay";

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
const EDGE_MARGIN_PX = 32; // skip drawing when fully off-viewport

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
  private formingBucketMs: number | null = null;
  /** The CHART's current candle bucket (epoch-ms) — drives exact-X bracketing. */
  private bucketMs = 60_000;
  private view: TradeOverlayPaneView | null = null;
  private needsRedraw = true;

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as unknown as ChartLike;
    this.series = param.series as unknown as SeriesLike;
    this.requestUpdate = param.requestUpdate;
    if (this.needsRedraw && this.requestUpdate) {
      this.needsRedraw = false;
      this.requestUpdate();
    }
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
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

  paneViews(): readonly IPrimitivePaneView_[] {
    if (!this.view) this.view = new TradeOverlayPaneView(this);
    return [this.view] as readonly IPrimitivePaneView_[];
  }

  readonly renderer: IPrimitivePaneRenderer_ = {
    draw: (target: DrawCanvasTarget): void => {
      const chart = this.chart;
      const series = this.series;
      if (!chart || !series || this.overlays.length === 0) return;
      this.drawOverlays(chart, series, target);
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
}
