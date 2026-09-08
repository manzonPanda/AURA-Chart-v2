/**
 * LWC v5 series primitive that renders Pine `line.new()` and `box.new()`
 * drawings.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Positioning contract (zoom / scroll / resize / history / replay-safe):
 *
 * Like the label primitive, this stores ONLY semantic chart-space anchors
 * from pineDrawings.ts — endpoint timeMs (+ optional logical bar index for
 * `xloc.bar_index`) and price. At every redraw it converts those to screen
 * coordinates through the LIVE chart scales (`logicalToCoordinate` /
 * `timeToCoordinate` and the host series' `priceToCoordinate`), so drawings
 * follow their candles/prices no matter how the viewport changes. Bar-index
 * drawings pin via the logical coordinate API (exact bar slots, including
 * future indexes).
 *
 * Style support:
 *   line: solid / dotted / dashed / arrow_left / arrow_right / arrow_both,
 *         width 1–5, extend none/left/right/both (extend clips to the viewport
 *         width), Pine hex color with alpha.
 *   box:  bgcolor fill (translucent default), border stroke with
 *         border_color/border_width/border_style, optional centered text with
 *         size/halign/valign/color.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { SeriesAttachedParameter, Time } from "lightweight-charts";

import type { PineBoxDrawing, PineLabelBar, PineLineDrawing } from "../../services/pineDrawings";
import {
  LABEL_SIZE_PX,
  PINE_DEFAULT_BOX_BORDER_COLOR,
  PINE_DEFAULT_LINE_COLOR,
  pineHexToRgba,
  resolveAnchorX,
} from "../../services/pineDrawings";

/** Same structural canvas-target alias as the label primitive. */
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
  logicalToCoordinate(logical: number): number | null;
  timeToCoordinate?(time: number): number | null;
};

type ChartLike = {
  timeScale(): TimeScaleLike;
};

type SeriesLike = {
  priceToCoordinate(price: number): number | null;
};

/** Default box fill when the script doesn't set bgcolor (TradingView-like). */
const DEFAULT_BOX_FILL = "rgba(41, 98, 255, 0.10)";
/** Chart font stack matching the AURA dark trading UI. */
const FONT_STACK = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** Minimum visible length for a drawing span (guards NaN/zero spans). */
const MIN_LINE_PX = 0.5;

type PrimitivePaneViewZOrder_ = "bottom" | "normal" | "top";
interface IPrimitivePaneView_ {
  zOrder?(): PrimitivePaneViewZOrder_;
  renderer(): IPrimitivePaneRenderer_ | null;
}
interface IPrimitivePaneRenderer_ {
  draw(target: DrawCanvasTarget): void;
}

/** Shared pane view for one drawing set (stable reference — LWC caches views). */
class LineBoxPaneView implements IPrimitivePaneView_ {
  private readonly owner: PineLineBoxPrimitive;
  constructor(owner: PineLineBoxPrimitive) {
    this.owner = owner;
  }
  zOrder(): PrimitivePaneViewZOrder_ {
    return "normal";
  }
  renderer(): IPrimitivePaneRenderer_ | null {
    return this.owner.renderer;
  }
}

/**
 * One series-attached line/box primitive. Call `setDrawings(lines, boxes)`
 * with a fresh layer; empty arrays clear everything drawn.
 */
export class PineLineBoxPrimitive {
  private chart: ChartLike | null = null;
  private series: SeriesLike | null = null;
  private requestUpdate: (() => void) | null = null;
  private lines: PineLineDrawing[] = [];
  private boxes: PineBoxDrawing[] = [];
  private view: LineBoxPaneView | null = null;
  private needsRedraw = true;
  /** Anchor-remap context: the engine candle series + whitespace slots. */
  private anchorKlines: readonly PineLabelBar[] = [];
  private anchorSlots: readonly number[] = [];

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

  /** Update the drawings to paint; schedules an LWC repaint. */
  setDrawings(lines: readonly PineLineDrawing[], boxes: readonly PineBoxDrawing[]): void {
    this.lines = [...lines];
    this.boxes = [...boxes];
    if (this.requestUpdate) this.requestUpdate();
    else this.needsRedraw = true;
  }

  /**
   * Anchor-remap context for the WHITESPACE time scale: the candle series the
   * engine ran on (engine logical → chart logical) and the whitespace slots
   * registered by WhitespaceBridge. Presentation-only — never affects data.
   */
  setAnchorContext(klines: readonly PineLabelBar[], slots: readonly number[]): void {
    this.anchorKlines = klines;
    this.anchorSlots = slots;
    if (this.requestUpdate) this.requestUpdate();
    else this.needsRedraw = true;
  }

  paneViews(): readonly IPrimitivePaneView_[] {
    if (!this.view) this.view = new LineBoxPaneView(this);
    return [this.view] as readonly IPrimitivePaneView_[];
  }
  readonly renderer: IPrimitivePaneRenderer_ = {
    draw: (target: DrawCanvasTarget): void => {
      const chart = this.chart;
      const series = this.series;
      if (!chart || !series) return;
      if (this.lines.length === 0 && this.boxes.length === 0) return;

      target.useBitmapCoordinateSpace((scope) => {
        const ctx = scope.context;
        const px = scope.horizontalPixelRatio > 0 ? scope.horizontalPixelRatio : 1;
        const py = scope.verticalPixelRatio > 0 ? scope.verticalPixelRatio : 1;
        ctx.save();
        ctx.scale(px, py);

        const timeScale = chart.timeScale();
        const width = scope.mediaSize.width;

        // ── boxes (fill first so lines paint on top) ───────────────────────
        for (const box of this.boxes) {
          const left = xFor(box.leftLogical, box.leftMs, this.anchorKlines, this.anchorSlots, timeScale);
          const right = xFor(box.rightLogical, box.rightMs, this.anchorKlines, this.anchorSlots, timeScale);
          if (left === null || right === null) continue;
          const top = series.priceToCoordinate(box.topPrice);
          const bottom = series.priceToCoordinate(box.bottomPrice);
          if (top === null || bottom === null) continue;
          const ax = Math.min(left, right);
          const bx = Math.max(left, right);
          const ay = Math.min(top, bottom);
          const by = Math.max(top, bottom);
          const bw = bx - ax;
          const bh = by - ay;
          if (bw < MIN_LINE_PX || bh < MIN_LINE_PX) continue;
          const blanket = 600;
          if (bx < -blanket || ax > width + blanket || by < -blanket || ay > scope.mediaSize.height + blanket) continue;

          const borderRgb = pineHexToRgba(box.borderColor, PINE_DEFAULT_BOX_BORDER_COLOR);
          const fillStyle =
            box.bgcolor.length > 0
              ? pineHexToRgba(box.bgcolor, DEFAULT_BOX_FILL)
              : rgbaAtMost(borderRgb, DEFAULT_BOX_FILL);
          ctx.save();
          ctx.fillStyle = fillStyle;
          ctx.fillRect(ax, ay, bw, bh);
          ctx.strokeStyle = borderRgb;
          ctx.lineWidth = box.borderWidth;
          applyLineDash(ctx, box.borderStyle);
          ctx.strokeRect(ax, ay, bw, bh);
          ctx.restore();

          if (box.text.length > 0) {
            const cfg = LABEL_SIZE_PX[box.textSize];
            ctx.save();
            ctx.font = `${cfg.font}px ${FONT_STACK}`;
            ctx.fillStyle = pineHexToRgba(box.textColor, "#FFFFFF");
            ctx.textBaseline =
              box.textValign === "top" ? "top" : box.textValign === "bottom" ? "bottom" : "middle";
            ctx.textAlign = box.textHalign === "left" ? "left" : box.textHalign === "right" ? "right" : "center";
            const tx =
              box.textHalign === "left"
                ? ax + cfg.padX
                : box.textHalign === "right"
                  ? bx - cfg.padX
                  : ax + bw / 2;
            const ty =
              box.textValign === "top"
                ? ay + cfg.padY
                : box.textValign === "bottom"
                  ? by - cfg.padY
                  : ay + bh / 2;
            ctx.fillText(box.text, tx, ty);
            ctx.restore();
          }
        }

        // ── lines ──────────────────────────────────────────────────────────
        for (const line of this.lines) {
          let x1 = xFor(line.logical1, line.time1Ms, this.anchorKlines, this.anchorSlots, timeScale);
          let x2 = xFor(line.logical2, line.time2Ms, this.anchorKlines, this.anchorSlots, timeScale);
          if (x1 === null || x2 === null) continue;
          const y1 = series.priceToCoordinate(line.price1);
          const y2 = series.priceToCoordinate(line.price2);
          if (y1 === null || y2 === null) continue;
          // extend.* clips the drawn line to the visible viewport.
          if (line.extend === "left" || line.extend === "both") x1 = Math.min(x1, 0);
          if (line.extend === "right" || line.extend === "both") x2 = Math.max(x2, width);
          if (!Number.isFinite(x2) || !Number.isFinite(x1)) continue;
          if (Math.abs(x2 - x1) < MIN_LINE_PX) continue;

          ctx.save();
          ctx.strokeStyle = pineHexToRgba(line.color, PINE_DEFAULT_LINE_COLOR);
          ctx.lineWidth = line.width;
          applyLineDash(ctx, line.style);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.restore();

          if (line.style === "arrow_left" || line.style === "arrow_both") {
            drawArrowHead(ctx, x1, y1, x2, y2, line.width);
          }
          if (line.style === "arrow_right" || line.style === "arrow_both") {
            drawArrowHead(ctx, x2, y2, x1, y1, line.width);
          }
        }

        ctx.restore();
      });
    },
  };
}
/** Resolve one anchor's x coordinate across the WHITESPACE time scale —
 *  exact time slot first, then the whitespace-remapped logical
 *  (services/pineDrawings `resolveAnchorX`; engine-logical passthrough when
 *  no whitespace is registered). */
function xFor(
  logical: number | null,
  timeMs: number,
  klines: readonly PineLabelBar[],
  slots: readonly number[],
  timeScale: TimeScaleLike,
): number | null {
  return resolveAnchorX(logical, timeMs, klines, slots, timeScale);
}

/** Draw a small arrowhead at (x1,y1) pointing AWAY from (x2,y2). */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
): void {
  const dx = x1 - x2;
  const dy = y1 - y2;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 0.01) return;
  const ux = dx / len;
  const uy = dy / len;
  const size = 6 + width * 1.5;
  const bx = x1 - ux * size;
  const by = y1 - uy * size;
  const px = -uy * (size * 0.45);
  const py = ux * (size * 0.45);
  ctx.save();
  ctx.fillStyle = ctx.strokeStyle ?? "#2962FF";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(bx + px, by + py);
  ctx.lineTo(bx - px, by - py);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Map a normalized Pine style to a canvas line dash. */
function applyLineDash(ctx: CanvasRenderingContext2D, style: string): void {
  if (style === "dashed") {
    ctx.setLineDash([6, 4]);
  } else if (style === "dotted") {
    ctx.setLineDash([1.5, 4]);
  } else {
    ctx.setLineDash([]);
  }
}

/** Take an rgba() string and clamp its alpha to at most `maxAlpha` (0–1). */
function rgbaAtMost(color: string, fallback: string): string {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(color);
  if (!m) return fallback;
  const alpha = m[4] ? Math.min(0.16, Number(m[4])) : 0.1;
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
}