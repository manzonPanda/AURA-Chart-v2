/**
 * LWC v5 series primitive that renders Pine `fill(plot1, plot2, …)` regions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Positioning contract (zoom / scroll / resize / history / replay-safe):
 *
 * Like the line/box primitive, this stores ONLY semantic chart-space anchors
 * from the engine — the per-bar timestamp (epoch ms) and the two resolved
 * boundary PRICES. At every redraw it converts those to screen coordinates
 * through the LIVE chart scales (`timeScale().timeToCoordinate` and the host
 * series' `priceToCoordinate`), so the fill follows its candles/prices no
 * matter how the viewport changes. Fills are anchored by `bar_time` (the
 * engine already resolved any plot `offset` into a real epoch-ms timestamp),
 * so `resolveAnchorX` places them exactly on their candles across whitespace.
 *
 * Geometry: the fill is the shaded band between two boundaries. It is drawn as
 * a sequence of per-bar TRAPEZOIDS (top edge + bottom edge between consecutive
 * bars), each with its own per-bar color. A bar where either boundary is na
 * (a warmup gap) carries NO trapezoid, so the fill genuinely BREAKS there —
 * exactly Pine's semantics — and is never painted across a gap. A uniform
 * script color is used when a bar has no per-bar color.
 *
 * NOT rendered here — pure canvas drawing driven by semantic anchors
 * (Node-testable geometry lives in pineDrawings.ts).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { SeriesAttachedParameter, Time } from "lightweight-charts";

import type { PineFillPoint } from "../../services/pineEngineTypes.ts";
import {
  PINE_DEFAULT_FILL_COLOR,
  pineHexToRgba,
  resolveAnchorX,
  type PineLabelBar,
} from "../../services/pineDrawings.ts";

/** Same structural canvas-target alias as the line/box primitive. */
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

type PrimitivePaneViewZOrder_ = "bottom" | "normal" | "top";
interface IPrimitivePaneView_ {
  zOrder?(): PrimitivePaneViewZOrder_;
  renderer(): IPrimitivePaneRenderer_ | null;
}
interface IPrimitivePaneRenderer_ {
  draw(target: DrawCanvasTarget): void;
}

/** One resolved fill region: per-bar points + a fallback uniform color. */
export interface PineFillRegion {
  points: readonly PineFillPoint[];
  /** Uniform fill color used when a bar carries no per-bar color. */
  color: string;
}

/** Shared pane view for the fill layer (stable reference — LWC caches views). */
class FillPaneView implements IPrimitivePaneView_ {
  private readonly owner: PineFillPrimitive;
  constructor(owner: PineFillPrimitive) {
    this.owner = owner;
  }
  zOrder(): PrimitivePaneViewZOrder_ {
    // Fills sit BEHIND the plots they shade.
    return "bottom";
  }
  renderer(): IPrimitivePaneRenderer_ | null {
    return this.owner.renderer;
  }
}

/**
 * One series-attached fill primitive. Call `setFills(regions)` with a fresh
 * layer; an empty array clears everything drawn.
 */
export class PineFillPrimitive {
  private chart: ChartLike | null = null;
  private series: SeriesLike | null = null;
  private requestUpdate: (() => void) | null = null;
  private fills: PineFillRegion[] = [];
  private view: FillPaneView | null = null;
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

  /** Update the fill regions to paint; schedules an LWC repaint. */
  setFills(fills: readonly PineFillRegion[]): void {
    this.fills = [...fills];
    if (this.requestUpdate) this.requestUpdate();
    else this.needsRedraw = true;
  }

  /**
   * Anchor-remap context for the WHITESPACE time scale (mirrors the line/box
   * primitive). Presentation-only — never affects data.
   */
  setAnchorContext(klines: readonly PineLabelBar[], slots: readonly number[]): void {
    this.anchorKlines = klines;
    this.anchorSlots = slots;
    if (this.requestUpdate) this.requestUpdate();
    else this.needsRedraw = true;
  }

  paneViews(): readonly IPrimitivePaneView_[] {
    if (!this.view) this.view = new FillPaneView(this);
    return [this.view] as readonly IPrimitivePaneView_[];
  }

  readonly renderer: IPrimitivePaneRenderer_ = {
    draw: (target: DrawCanvasTarget): void => {
      const chart = this.chart;
      const series = this.series;
      if (!chart || !series) return;
      if (this.fills.length === 0) return;

      target.useBitmapCoordinateSpace((scope) => {
        const ctx = scope.context;
        const px = scope.horizontalPixelRatio > 0 ? scope.horizontalPixelRatio : 1;
        const py = scope.verticalPixelRatio > 0 ? scope.verticalPixelRatio : 1;
        ctx.save();
        ctx.scale(px, py);

        const timeScale = chart.timeScale();

        for (const region of this.fills) {
          const pts = region.points;
          if (pts.length < 2) continue;
          // Resolve each bar's x + the two boundary y's; a bar with a missing
          // boundary (na gap) or an off-screen/NaN coordinate breaks the run.
          const xs = pts.map((p) =>
            resolveAnchorX(null, p.ts, this.anchorKlines, this.anchorSlots, timeScale),
          );
          const topY = pts.map((p) =>
            typeof p.top === "number" ? series.priceToCoordinate(p.top) : null,
          );
          const botY = pts.map((p) =>
            typeof p.bottom === "number" ? series.priceToCoordinate(p.bottom) : null,
          );

          for (let i = 0; i < pts.length - 1; i++) {
            const x1 = xs[i];
            const x2 = xs[i + 1];
            const t1 = topY[i];
            const t2 = topY[i + 1];
            const b1 = botY[i];
            const b2 = botY[i + 1];
            // Any missing edge ⇒ a genuine break: never bridge across a gap.
            if (x1 === null || x2 === null || t1 === null || t2 === null || b1 === null || b2 === null) continue;
            if (!Number.isFinite(x1) || !Number.isFinite(x2)) continue;
            // Per-bar color: this bar's color, else the region's uniform color.
            const perBar = pts[i]?.color;
            const fillStyle = pineHexToRgba(
              perBar && perBar.length > 0 ? perBar : region.color,
              PINE_DEFAULT_FILL_COLOR,
            );
            ctx.save();
            ctx.fillStyle = fillStyle;
            ctx.beginPath();
            ctx.moveTo(x1, t1);
            ctx.lineTo(x2, t2);
            ctx.lineTo(x2, b2);
            ctx.lineTo(x1, b1);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        }

        ctx.restore();
      });
    },
  };
}

