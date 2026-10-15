/**
 * DrawingAnnotationPrimitive — paints text annotations on top of CandleKit's
 * drawing shapes (TrendLine, Rectangle).
 *
 * WHY THIS EXISTS: CandleKit's `DrawingPrimitive` renders only the shape
 * geometry (`color`, `width`, `dashed`, `fill`) — it has no concept of a text
 * label. AURA layers text on top WITHOUT a second drawing system: this
 * primitive is attached to the SAME candle series, reads the SAME
 * `DrawingEngine`, and paints only the annotation text. The model, selection,
 * dragging, lock and persistence all stay in CandleKit + DrawingLayer — nothing
 * here mutates a drawing.
 *
 * POSITIONING (zoom / scroll / resize / move-safe): at every repaint the anchor
 * is re-projected through the LIVE chart scales — `timeScale().timeToCoordinate`
 * for X and the host series' `priceToCoordinate` for Y — exactly the contract
 * `DrawingController.project()` uses, so a label tracks its line/rectangle no
 * matter how the viewport changes. Placement math (above / below / center) is
 * the pure `labelAnchorForTool` helper (services/drawingAnnotations.ts), shared
 * with the unit tests.
 *
 * RENDERING SAFETY: the label is drawn with the canvas `fillText`. User text is
 * NEVER interpreted as HTML/markdown and never reaches innerHTML.
 */

import type { SeriesAttachedParameter, Time } from "lightweight-charts";

import {
  isAnnotatableTool,
  labelAnchorForTool,
  normalizeTextStyle,
  type TextPlacement,
} from "../../services/drawingAnnotations.ts";

/** The canvas target is fancy-canvas's, not re-exported by lightweight-charts. */
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
 * Minimal structural slices of the LWC chart/scale APIs this primitive needs.
 * Method-typed snapshots keep the branded `Time`/`Coordinate` types as plain
 * numbers at the boundary (they are plain numbers at runtime).
 */
type TimeScaleLike = {
  timeToCoordinate(time: number): number | null;
};
type ChartLike = {
  timeScale(): TimeScaleLike;
};
type SeriesLike = {
  priceToCoordinate(price: number): number | null;
};

/** The slice of a CandleKit `Drawing` this primitive reads (structural). */
export interface AnnotatedDrawing {
  id: string;
  tool: string;
  points: readonly { time: number; price: number }[];
  style?: Record<string, unknown>;
}

/** The slice of a CandleKit `DrawingEngine` this primitive subscribes to. */
export interface DrawingEngineLike {
  getDrawings(): readonly AnnotatedDrawing[];
  onChange(cb: () => void): () => void;
}

/** Chart font stack matching the AURA dark trading UI. */
const FONT_STACK = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Skip labels this far outside the visible canvas (px, pre-HiDPI). */
const OFFSCREEN_MARGIN = 400;

interface LabelSpec {
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  textAlign: "left" | "center" | "right";
  textBaseline: "top" | "middle" | "bottom";
  /** Legibility plate alpha behind the glyphs (higher over a filled shape). */
  plateAlpha: number;
}

type PrimitivePaneViewZOrder_ = "bottom" | "normal" | "top";
interface IPrimitivePaneView_ {
  zOrder?(): PrimitivePaneViewZOrder_;
  renderer(): IPrimitivePaneRenderer_ | null;
}
interface IPrimitivePaneRenderer_ {
  draw(target: DrawCanvasTarget): void;
}

/** Stable pane view (LWC caches view arrays). */
class AnnotationPaneView implements IPrimitivePaneView_ {
  private readonly owner: DrawingAnnotationPrimitive;
  constructor(owner: DrawingAnnotationPrimitive) {
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
 * One series-attached annotation primitive bound to a `DrawingEngine`. It
 * re-projects every labelled drawing on each repaint and paints the text.
 */
export class DrawingAnnotationPrimitive {
  private engine: DrawingEngineLike | null = null;
  private chart: ChartLike | null = null;
  private series: SeriesLike | null = null;
  private requestUpdate: (() => void) | null = null;
  private view: AnnotationPaneView | null = null;
  private offChange: (() => void) | null = null;
  /** Projected labels for the current frame (rebuilt on every updateAllViews). */
  private specs: LabelSpec[] = [];

  /** Bind the engine (its `onChange` drives repaints as labels are edited). */
  setEngine(engine: DrawingEngineLike | null): void {
    if (this.offChange) {
      this.offChange();
      this.offChange = null;
    }
    this.engine = engine;
    if (engine) {
      this.offChange = engine.onChange(() => this.requestUpdate?.());
    }
    this.specs = [];
    this.requestUpdate?.();
  }

  /** LWC calls this once when the primitive is attached to a series. */
  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as unknown as ChartLike;
    this.series = param.series as unknown as SeriesLike;
    this.requestUpdate = param.requestUpdate;
    this.requestUpdate?.();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    if (this.offChange) {
      this.offChange();
      this.offChange = null;
    }
  }

  /** IPanePrimitive — one stable view whose renderer draws every label. */
  paneViews(): readonly IPrimitivePaneView_[] {
    if (!this.view) this.view = new AnnotationPaneView(this);
    return [this.view] as readonly IPrimitivePaneView_[];
  }

  /**
   * Rebuild the label specs from the engine through the LIVE scales. Called by
   * LWC before each paint (and by us on engine change), so labels follow pan /
   * zoom / resize and any move/reshape/edit automatically.
   */
  updateAllViews(): void {
    const chart = this.chart;
    const series = this.series;
    this.specs = [];
    if (!chart || !series || !this.engine) return;
    const next: LabelSpec[] = [];
    for (const d of this.engine.getDrawings()) {
      if (!isAnnotatableTool(d.tool)) continue;
      const ns = normalizeTextStyle(d.style);
      if (ns.text.length === 0) continue;
      const projected = d.points.map((p) => ({
        x: chart.timeScale().timeToCoordinate(p.time),
        y: series.priceToCoordinate(p.price),
      }));
      // Every anchor must project on-screen; a scrolled-out shape is skipped,
      // mirroring DrawingPrimitive.
      if (projected.some((a) => a.x == null || a.y == null)) continue;
      const pts = projected as { x: number; y: number }[];
      const anchor = labelAnchorForTool(d.tool, pts, ns.textPlacement as TextPlacement, ns.textSize, 1);
      if (!anchor) continue;
      // A translucent plate sits behind the glyphs so text stays legible over a
      // filled rectangle; trend lines (no fill) get a lighter plate.
      const hasFill = d.tool === "Rectangle" && Boolean(d.style && d.style.fill);
      next.push({
        x: anchor.x,
        y: anchor.y,
        text: ns.text,
        fontSize: ns.textSize,
        color: ns.textColor,
        textAlign: anchor.textAlign,
        textBaseline: anchor.textBaseline,
        plateAlpha: hasFill ? 0.0 : 0.45,
      });
    }
    this.specs = next;
  }

  /** The pane-view renderer: draws every projected label as canvas text. */
  readonly renderer: IPrimitivePaneRenderer_ = {
    draw: (target: DrawCanvasTarget): void => {
      if (this.specs.length === 0) return;
      target.useBitmapCoordinateSpace((scope) => {
        const { context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope;
        const mediaW = scope.mediaSize.width;
        const mediaH = scope.mediaSize.height;
        for (const s of this.specs) {
          const x = s.x * hpr;
          const y = s.y * vpr;
          // Skip labels far outside the visible canvas.
          if (
            x < -OFFSCREEN_MARGIN ||
            x > mediaW + OFFSCREEN_MARGIN ||
            y < -OFFSCREEN_MARGIN ||
            y > mediaH + OFFSCREEN_MARGIN
          ) {
            continue;
          }
          ctx.save();
          ctx.font = `${Math.max(1, Math.round(s.fontSize * hpr))}px ${FONT_STACK}`;
          ctx.textAlign = s.textAlign;
          ctx.textBaseline = s.textBaseline;
          const width = safeMeasure(ctx, s.text);
          // Legibility plate behind the glyphs (semi-transparent dark pill).
          if (s.plateAlpha > 0) {
            const padX = 4 * hpr;
            const plateH = Math.round(s.fontSize * hpr) + 4 * hpr;
            let left = x - width / 2 - padX;
            if (s.textAlign === "left") left = x - padX;
            else if (s.textAlign === "right") left = x - width - padX;
            const top = y - plateH / 2;
            ctx.fillStyle = `rgba(4, 9, 15, ${s.plateAlpha})`;
            ctx.beginPath();
            ctx.rect(left, top, width + padX * 2, plateH);
            ctx.fill();
          }
          ctx.fillStyle = s.color;
          ctx.fillText(s.text, x, y);
          ctx.restore();
        }
      });
    },
  };
}

/** measureText with a defensive fallback (TextMetrics, never a bare number). */
function safeMeasure(ctx: CanvasRenderingContext2D, text: string): number {
  try {
    const m = ctx.measureText(text);
    const width = typeof m === "object" && m !== null ? (m as { width?: unknown }).width : NaN;
    if (typeof width === "number" && Number.isFinite(width) && width >= 0) return width;
    return Math.max(10, text.length * 7);
  } catch {
    return Math.max(10, text.length * 7);
  }
}
