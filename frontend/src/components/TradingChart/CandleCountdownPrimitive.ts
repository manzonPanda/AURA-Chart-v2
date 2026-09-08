/**
 * LWC v5 series primitive that paints the CURRENT CANDLE'S CLOSE COUNTDOWN as
 * a tiny "MM:SS" pill immediately beside the forming candle (e.g. `00:42`
 * beside a 21:29 bar that closes at 21:30).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Contract (live, zoom/scroll/resize-safe):
 *
 *  - The primitive stores ONLY semantic anchors — the candle's bucket-start
 *    timestamp (epoch ms), its CLOSE price and the PRE-FORMATTED "MM:SS"
 *    label. At every redraw it converts those to screen space through the
 *    LIVE chart scales: `timeScale().timeToCoordinate(bucketStart / 1000)`
 *    for X and the host series' `priceToCoordinate(close)` for Y.
 *  - The label is computed by the feeding bridge from the candle's REAL
 *    bucket boundary (`closesAt − now`, services/liveCandle
 *    `candleCloseCountdown`) — NEVER from accumulated timer ticks — and the
 *    bridge re-feeds on a cadence so the pill stays current through the
 *    second. Every WS frame re-anchors the close the countdown runs to.
 *  - The pill is drawn just to the RIGHT of the candle (a small fixed gap),
 *    vertically centered on the candle's close level so it reads as a native
 *    time marker next to the bar. When that would overflow the pane's right
 *    edge, the pill clamps to the pane edge. Off-viewport → not painted.
 *  - Styling is deliberately subtle: translucent slate fill + a hairline
 *    border + the chart's 10px font — no "CLOSE"/"LIVE" text, no icon, no
 *    balloon — it should feel like the axis already printed the time.
 *
 * Integration: a small bridge in TradingChart attaches ONE primitive to the
 * main series (same pattern as GapRegionsPrimitive) and feeds it with the
 * countdown for the live forming candle (`setMarker`). During a replay
 * session the feed is null — a countdown counts LIVE market time, which does
 * not exist on a replaying (historical) chart — so the pill simply vanishes.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { SeriesAttachedParameter, Time } from "lightweight-charts";

/** Same structural canvas-target alias as the sibling primitives. */
type DrawCanvasTarget = {
  useBitmapCoordinateSpace: <T>(f: (scope: {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
    bitmapSize: { width: number; height: number };
    horizontalPixelRatio: number;
    verticalPixelRatio: number;
  }) => T) => T;
};

type TimeScaleLike = {
  timeToCoordinate?(time: number): number | null;
};

type ChartLike = {
  timeScale(): TimeScaleLike;
};

type SeriesLike = {
  priceToCoordinate(price: number): number | null;
};

/** The semantic anchor for one countdown pill. */
export interface CountdownCandle {
  /** Bucket START, epoch ms (the forming candle's real open timestamp). */
  tsMs: number;
  /** The forming candle's close — the pill's vertical anchor. */
  close: number;
  /** Pre-formatted "MM:SS" text (e.g. "00:42" — time remaining until close). */
  label: string;
}

/** Chart font stack matching the AURA dark trading UI. */
const FONT_STACK = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** Pill font size (px) — compact like the axis tick labels. */
const FONT_PX = 10;
/** Pill height (px). */
const PILL_H = 15;
/** Horizontal padding inside the pill (px). */
const PILL_PAD_X = 5;
/** Gap between the candle's time point and the pill's left edge (px). */
const GAP_X = 8;
/** Minimum gap to the pane's right edge when the pill is clamped (px). */
const RIGHT_INSET = 8;
/** Subtle slate palette — matches the DATA GAP caption's neutral language. */
const PILL_FILL = "rgba(30, 41, 59, 0.55)";
const PILL_BORDER = "rgba(148, 163, 184, 0.45)";
const PILL_TEXT = "rgba(203, 213, 225, 0.9)";

type PrimitivePaneViewZOrder_ = "bottom" | "normal" | "top";
interface IPrimitivePaneView_ {
  zOrder?(): PrimitivePaneViewZOrder_;
  renderer(): IPrimitivePaneRenderer_ | null;
}
interface IPrimitivePaneRenderer_ {
  draw(target: DrawCanvasTarget): void;
}

/** Shared pane view (stable reference — LWC caches views). */
class CountdownPaneView implements IPrimitivePaneView_ {
  private readonly owner: CandleCountdownPrimitive;
  constructor(owner: CandleCountdownPrimitive) {
    this.owner = owner;
  }
  zOrder(): PrimitivePaneViewZOrder_ {
    return "top"; // always above candles + overlays
  }
  renderer(): IPrimitivePaneRenderer_ | null {
    return this.owner.renderer;
  }
}

/**
 * One series-attached countdown marker. Call `setMarker(...)` whenever the
 * countdown label (or the candle it anchors to) changes.
 */
export class CandleCountdownPrimitive {
  private chart: ChartLike | null = null;
  private series: SeriesLike | null = null;
  private requestUpdate: (() => void) | null = null;
  private marker: CountdownCandle | null = null;
  private view: CountdownPaneView | null = null;
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

  /** Update the pill (null clears it); schedules a repaint. */
  setMarker(marker: CountdownCandle | null): void {
    this.marker = marker;
    if (this.requestUpdate) this.requestUpdate();
    else this.needsRedraw = true;
  }

  paneViews(): readonly IPrimitivePaneView_[] {
    if (!this.view) this.view = new CountdownPaneView(this);
    return [this.view] as readonly IPrimitivePaneView_[];
  }
/** Exposed for the stable pane-view reference (LWC caches view arrays). */
  readonly renderer: IPrimitivePaneRenderer_ = {
    draw: (target: DrawCanvasTarget): void => {
      const chart = this.chart;
      const series = this.series;
      const marker = this.marker;
      if (!chart || !series || !marker) return;
      const label = marker.label;
      if (label.length === 0) return;

      target.useBitmapCoordinateSpace((scope) => {
        const ctx = scope.context;
        const px = scope.horizontalPixelRatio > 0 ? scope.horizontalPixelRatio : 1;
        const py = scope.verticalPixelRatio > 0 ? scope.verticalPixelRatio : 1;
        ctx.save();
        ctx.scale(px, py);

        const width = scope.mediaSize.width;

        // Anchor X on the candle's time point (epoch SECONDS for LWC).
        const x = chart.timeScale().timeToCoordinate?.(marker.tsMs / 1000) ?? null;
        if (x === null || !Number.isFinite(x)) {
          ctx.restore();
          return; // candle not on the visible scale
        }
        // Text width (defensive fallback mirrors the label primitive).
        ctx.font = `${FONT_PX}px ${FONT_STACK}`;
        const textW = safeMeasure(ctx, label);
        const pillW = textW + PILL_PAD_X * 2;

        // Place immediately to the RIGHT of the candle; clamp to the pane edge.
        let left = x + GAP_X;
        if (left + pillW > width - RIGHT_INSET) left = width - RIGHT_INSET - pillW;
        if (left < 0) left = 0;

        // Anchor Y on the candle's close level.
        const y = series.priceToCoordinate(marker.close) ?? null;
        if (y === null || !Number.isFinite(y)) {
          ctx.restore();
          return;
        }
        const top = y - PILL_H / 2;

        // Skip the pill entirely when the candle is off-viewport.
        if (left + pillW < -8 || left > width + 8) {
          ctx.restore();
          return;
        }

        ctx.save();
        ctx.fillStyle = PILL_FILL;
        ctx.beginPath();
        roundedRectPath(ctx, left, top, pillW, PILL_H, 3);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = PILL_BORDER;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = PILL_TEXT;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, left + PILL_PAD_X, top + PILL_H / 2);
        ctx.restore();

        ctx.restore();
      });
    },
  };
}

/** measureText with a defensive fallback (mirrors the label primitive). */
function safeMeasure(ctx: CanvasRenderingContext2D, text: string): number {
  try {
    const m = ctx.measureText(text);
    const width = typeof m === "object" && m !== null && typeof (m as { width?: unknown }).width === "number"
      ? (m as { width: number }).width
      : NaN;
    return Number.isFinite(width) && width >= 0 ? width : Math.max(10, text.length * 7);
  } catch {
    return Math.max(10, text.length * 7);
  }
}

/** Approximate a rounded rect with a single path (chamfered corners). */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.lineTo(x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.lineTo(x, y + rr);
  ctx.lineTo(x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.lineTo(x, y + h - rr);
  ctx.closePath();
}