/**
 * LWC v5 series primitive that renders Pine `label.new()` drawings.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Positioning contract (zoom / scroll / resize / history / replay-safe):
 *
 * The primitive stores ONLY semantic anchors from pineDrawings.ts — `timeMs`
 * (+ optional logical bar index for `xloc.bar_index`) and `price`. At every
 * redraw it converts those to screen coordinates THROUGH THE LIVE chart scales
 * (`timeScale().logicalToCoordinate` / `timeToCoordinate` and the host
 * series' `priceToCoordinate`), so the balloon follows its candle/price no
 * matter how the viewport changes. Bar-index labels use the logical
 * coordinate API so FUTURE indexes (label.new beyond the last bar) land in
 * the correct future bar slot, exactly like LWC places them.
 *
 * The drawn balloon mirrors TradingView's semantics:
 *   style_label_up         → balloon above the anchor, pointer toward it
 *   style_label_down       → balloon below the anchor, pointer toward it
 *   style_label_left/right → balloon to the side, pointer toward the anchor
 *   style_label_center / style_label_none → text (no balloon for `none`)
 *   style_label_{lower,upper}_{left,right} → diagonal corner balloons
 * Sizes map through the AURA dark-UI table (LABEL_SIZE_PX). Colors come from
 * Pine hex (`#RRGGBB`/`#RRGGBBAA`), converted for the canvas on the fly.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * LWC coordinate notes: `logicalToCoordinate` / `timeToCoordinate` /
 * `priceToCoordinate` return `Coordinate | null`, where `Coordinate` is a
 * NOMINAL number (`number & { [Symbol.species]: "Coordinate" }`) — at runtime
 * it is a plain number, never `{ value: number }`. This renderer treats
 * coordinates as plain numbers throughout.
 *
 * Integration: PineBridge attaches one primitive per pane host (the same
 * candle series / carrier that hosts overlay markers + price lines) and calls
 * `setLabels(...)` when a fresh Pine run produces a `"labels"` visual:
 * updates trigger `requestUpdate()` so LWC repaints the balloons in place.
 */

import type { SeriesAttachedParameter, Time } from "lightweight-charts";

import { resolveAnchorX } from "../../services/pineDrawings";
import type { PineLabelBar, PineLabelDrawing } from "../../services/pineDrawings";
import {
  LABEL_SIZE_PX,
  PINE_DEFAULT_LABEL_COLOR,
  labelLayout,
  pineHexToRgba,
} from "../../services/pineDrawings";

/** The canvas target is fancy-canvas's, not re-exported by lightweight-charts — structural alias. */
type DrawCanvasTarget = {
  useBitmapCoordinateSpace: <T>(f: (scope: {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
    bitmapSize: { width: number; height: number };
    horizontalPixelRatio: number;
    verticalPixelRatio: number;
  }) => T) => T;
};

/**
 * Minimal slice of the chart/scale APIs this primitive needs.
 *
 * These are METHOD-typed structural snapshots of LWC's `ITimeScaleApi`. The
 * actual LWC methods are also methods, so TypeScript's method (bivariant)
 * comparison accepts a real chart object here; the method forms also let the
 * parameters stay as plain `number` (LWC's `Logical`/`Coordinate`/`Time` are
 * nominally-branded numbers, erased at runtime).
 */
type TimeScaleLike = {
  logicalToCoordinate(logical: number): number | null;
  timeToCoordinate?(time: number): number | null;
};

type ChartLike = {
  timeScale(): TimeScaleLike;
};

/** Series slice — `priceToCoordinate` is directly on ISeriesApi in LWC v5. */
type SeriesLike = {
  priceToCoordinate(price: number): number | null;
};

/** Default text fill (TradingView's label.new default is color.black). */
const DEFAULT_TEXT_COLOR = "#191919";
/** Chart font stack matching the AURA dark trading UI. */
const FONT_STACK = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** Balloon corner radius (px). */
const CORNER_RADIUS = 4;

type PrimitivePaneViewZOrder_ = "bottom" | "normal" | "top";
interface IPrimitivePaneView_ {
  zOrder?(): PrimitivePaneViewZOrder_;
  renderer(): IPrimitivePaneRenderer_ | null;
}
interface IPrimitivePaneRenderer_ {
  draw(target: DrawCanvasTarget): void;
}

/** Shared pane view for one label set (stable reference — LWC caches view arrays). */
class LabelPaneView implements IPrimitivePaneView_ {
  private readonly owner: PineLabelPrimitive;
  constructor(owner: PineLabelPrimitive) {
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
 * One series-attached label primitive. Call `setLabels()` with a fresh layer
 * of label drawings; `setLabels([])` clears everything drawn.
 */
export class PineLabelPrimitive {
  private chart: ChartLike | null = null;
  private series: SeriesLike | null = null;
  private requestUpdate: (() => void) | null = null;
  private labels: PineLabelDrawing[] = [];
  private view: LabelPaneView | null = null;
  private needsRedraw = true;
  /** Anchor-remap context: the engine candle series + whitespace slots. */
  private anchorKlines: readonly PineLabelBar[] = [];
  private anchorSlots: readonly number[] = [];

  /** LWC calls this once when the primitive is attached to a series. */
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
  setLabels(labels: readonly PineLabelDrawing[]): void {
    this.labels = [...labels];
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

  /** IPanePrimitive — one stable view whose renderer draws every label. */
  paneViews(): readonly IPrimitivePaneView_[] {
    if (!this.view) this.view = new LabelPaneView(this);
    return [this.view] as readonly IPrimitivePaneView_[];
  }

  /** The pane-view renderer: converts semantic anchors → canvas drawing. */
  readonly renderer: IPrimitivePaneRenderer_ = {
    draw: (target: DrawCanvasTarget): void => {
      const chart = this.chart;
      const series = this.series;
      if (!chart || !series || this.labels.length === 0) return;

      target.useBitmapCoordinateSpace((scope) => {
        const ctx = scope.context;
        const px = scope.horizontalPixelRatio > 0 ? scope.horizontalPixelRatio : 1;
        const py = scope.verticalPixelRatio > 0 ? scope.verticalPixelRatio : 1;
        ctx.save();
        // Work in CSS pixels regardless of device pixel ratio (DPI-safe).
        ctx.scale(px, py);

        const timeScale = chart.timeScale();

        for (const label of this.labels) {
          // Anchor X: bar-index labels use the LOGICAL coordinate (keeps future
          // slots and zoom/scroll exact); bar_time labels use the timestamp
          // scale (LWC Time is an epoch-SECOND number).
          // WHITESPACE-AWARE anchor X (services/pineDrawings resolveAnchorX):
          // exact time slot first (registered candles + gap slots), then the
          // whitespace-remapped logical; engine-logical passthrough when no
          // whitespace exists (replay / disabled). Bar_index anchors stay on
          // their own candles after whitespace shifts the chart logicals.
          const xCoord = resolveAnchorX(
            label.logical,
            label.timeMs,
            this.anchorKlines,
            this.anchorSlots,
            timeScale,
          );
          if (xCoord === null) continue;
          const yCoord = series.priceToCoordinate(label.price);
          if (yCoord === null) continue;

          const text = label.text;
          const cfg = LABEL_SIZE_PX[label.size];
          const hasBalloon = label.style !== "none" && label.style !== "label_center";
          if (text.length === 0 && !hasBalloon) continue;

          // Measure the text for this exact font (two-pass inside one frame).
          ctx.save();
          ctx.font = `${cfg.font}px ${FONT_STACK}`;
          const textW = text.length > 0 ? safeMeasure(ctx, text) : 0;
          const textH = cfg.font * 1.25;
          ctx.restore();

          const layout = labelLayout(label, xCoord, yCoord, textW, textH);
          const balloonW = layout.right - layout.left;
          const balloonH = layout.bottom - layout.top;

          // Skip balloons far outside the visible canvas.
          const blanket = 600;
          if (
            layout.right < -blanket ||
            layout.left > scope.mediaSize.width + blanket ||
            layout.bottom < -blanket ||
            layout.top > scope.mediaSize.height + blanket
          ) {
            continue;
          }

          const balloonColor = pineHexToRgba(label.color, PINE_DEFAULT_LABEL_COLOR);
          const textColor = pineHexToRgba(label.textcolor, DEFAULT_TEXT_COLOR);
// Balloon fill.
          if (hasBalloon) {
            ctx.save();
            ctx.fillStyle = balloonColor;
            ctx.beginPath();
            roundedRectPath(ctx, layout.left, layout.top, balloonW, balloonH, CORNER_RADIUS);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }

          // Pointer triangle (the tip lands exactly on the anchor point).
          if (layout.hasPointer) {
            ctx.save();
            ctx.fillStyle = balloonColor;
            ctx.beginPath();
            ctx.moveTo(layout.tipX, layout.tipY);
            ctx.lineTo(layout.base1X, layout.base1Y);
            ctx.lineTo(layout.base2X, layout.base2Y);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }

          // Text — aligned per text.align_*.
          if (text.length > 0) {
            ctx.save();
            ctx.font = `${cfg.font}px ${FONT_STACK}`;
            ctx.fillStyle = textColor;
            ctx.textBaseline = "middle";
            const midY = layout.top + balloonH / 2;
            if (label.textalign === "left") {
              ctx.textAlign = "left";
              ctx.fillText(text, layout.left + cfg.padX, midY);
            } else if (label.textalign === "right") {
              ctx.textAlign = "right";
              ctx.fillText(text, layout.right - cfg.padX, midY);
            } else {
              ctx.textAlign = "center";
              ctx.fillText(text, layout.left + balloonW / 2, midY);
            }
            ctx.restore();
          }
        }

        ctx.restore();
      });
    },
  };
}

/** measureText with a defensive fallback (measureText → TextMetrics, never a bare number). */
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

/** Approximate a 4px rounded rect with a single path (chamfered corners). */
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