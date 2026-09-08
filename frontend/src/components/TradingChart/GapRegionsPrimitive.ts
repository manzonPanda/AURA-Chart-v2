/**
 * LWC v5 series primitive that shades detected MARKET-DATA GAPS ("DATA GAP"
 * bands) behind the candles.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Positioning contract (zoom / scroll / resize / history-safe):
 *
 * Like the Pine line/box primitive, this stores ONLY semantic chart-space
 * anchors from services/gapRegions.ts — the real missing interval
 * (startMs/endMs) plus compaction-era logical fallbacks. With TIME-SCALE
 * WHITESPACE registered (WhitespaceBridge), startMs (the first missing slot)
 * and endMs (the first real candle after the outage) are both registered time
 * points, so the band is placed by `timeToCoordinate` — spanning exactly the
 * empty slots between the boundary candles. Without whitespace it falls back
 * to the integer-logical geometry (LWC 5.2 returns 0 for fractional
 * logicals). Full pane height — a gap is a TIME region, not a price region.
 *
 * Visual language: translucent slate fill + thin edges, zOrder "bottom" so
 * candles always paint on top; a subtle "DATA GAP" caption only when the band
 * is wide enough to carry it without clutter.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { SeriesAttachedParameter, Time } from "lightweight-charts";

import type { GapBand } from "../../services/gapRegions";

type TimeScaleLike = {
  /** Linear logical→x conversion; null only while the time scale is empty. */
  logicalToCoordinate(logical: number): number | null;
  /** Exact time→x conversion — non-null only for REGISTERED time points. */
  timeToCoordinate?(time: number): number | null;
};

type ChartLike = {
  timeScale(): TimeScaleLike;
};

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

/** Subtle slate shading — reads as "absent", never as a real price level. */
const GAP_FILL = "rgba(148, 163, 184, 0.22)";
const GAP_EDGE = "rgba(148, 163, 184, 0.55)";
const GAP_TEXT = "rgba(203, 213, 225, 0.85)";
/** Caption is drawn only when the band is at least this wide (px). */
const MIN_LABEL_PX = 40;
/** Chart font stack matching the AURA dark trading UI. */
const FONT_STACK = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

type PrimitivePaneViewZOrder_ = "bottom" | "normal" | "top";
interface IPrimitivePaneView_ {
  zOrder?(): PrimitivePaneViewZOrder_;
  renderer(): IPrimitivePaneRenderer_ | null;
}
interface IPrimitivePaneRenderer_ {
  draw(target: DrawCanvasTarget): void;
}

/** Shared pane view (stable reference — LWC caches views). */
class GapPaneView implements IPrimitivePaneView_ {
  private readonly owner: GapRegionsPrimitive;
  constructor(owner: GapRegionsPrimitive) {
    this.owner = owner;
  }
  zOrder(): PrimitivePaneViewZOrder_ {
    return "bottom";
  }
  renderer(): IPrimitivePaneRenderer_ | null {
    return this.owner.renderer;
  }
}


/**
 * One series-attached gap-shading primitive. Call `setBands()` with fresh
 * geometry; an empty array clears everything drawn.
 */
export class GapRegionsPrimitive {
  private chart: ChartLike | null = null;
  private requestUpdate: (() => void) | null = null;
  private bands: GapBand[] = [];
  private view: GapPaneView | null = null;
  private needsRedraw = true;

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as unknown as ChartLike;
    this.requestUpdate = param.requestUpdate;
    if (this.needsRedraw && this.requestUpdate) {
      this.needsRedraw = false;
      this.requestUpdate();
    }
  }

  detached(): void {
    this.chart = null;
    this.requestUpdate = null;
  }

  /** Update the bands to shade; schedules an LWC repaint. */
  setBands(bands: readonly GapBand[]): void {
    this.bands = [...bands];
    if (this.requestUpdate) this.requestUpdate();
    else this.needsRedraw = true;
  }

  paneViews(): readonly IPrimitivePaneView_[] {
    if (!this.view) this.view = new GapPaneView(this);
    return [this.view] as readonly IPrimitivePaneView_[];
  }

  readonly renderer: IPrimitivePaneRenderer_ = {
    draw: (target: DrawCanvasTarget): void => {
      const chart = this.chart;
      if (!chart || this.bands.length === 0) return;

      target.useBitmapCoordinateSpace((scope) => {
        const ctx = scope.context;
        const px = scope.horizontalPixelRatio > 0 ? scope.horizontalPixelRatio : 1;
        const py = scope.verticalPixelRatio > 0 ? scope.verticalPixelRatio : 1;
        ctx.save();
        ctx.scale(px, py);

        const timeScale = chart.timeScale();
        const width = scope.mediaSize.width;
        const height = scope.mediaSize.height;

        for (const band of this.bands) {
          // TIMESTAMP-FIRST geometry: with whitespace registered, the first
          // missing slot (startMs, e.g. 21:30) and the first real candle after
          // the outage (endMs, e.g. 21:39) are BOTH registered time points, so
          // timeToCoordinate resolves them exactly. Uniform bar spacing makes
          // barW = (xe − xs) / spanIndices exact; the band spans the boundary
          // between the 21:29|21:30 and 21:38|21:39 slots — both boundary
          // candles stay OUTSIDE the band.
          let ax: number | null = null;
          let bx: number | null = null;
          const xs = timeScale.timeToCoordinate?.(band.startMs / 1000) ?? null;
          const xe = timeScale.timeToCoordinate?.(band.endMs / 1000) ?? null;
          if (xs !== null && xe !== null && xe > xs && band.spanIndices > 0) {
            const barW = (xe - xs) / band.spanIndices;
            if (Number.isFinite(barW) && barW > 0) {
              ax = xs - barW / 2;
              bx = xe - barW / 2;
            }
          }
          if (ax === null || bx === null || !Number.isFinite(ax) || !Number.isFinite(bx) || bx - ax < 1) {
            // Fallback (whitespace not registered — e.g. replay cleared it):
            // the compaction-era logical geometry. Center derived from the two
            // INTEGER boundary logicals, never from a fractional
            // `logicalToCoordinate(band.anchorIndex)`: LWC 5.2 returns 0 for
            // every fractional logical (X.5 → 0) while integer logicals map
            // correctly.
            const xl = timeScale.logicalToCoordinate(band.anchorIndex - 0.5);
            const xr = timeScale.logicalToCoordinate(band.anchorIndex + 0.5);
            if (xl === null || xr === null) continue;
            const xc0 = (xl + xr) / 2;
            const barW = Math.abs(xr - xl);
            if (!Number.isFinite(barW) || barW <= 0) continue;
            const w0 = Math.max(1, band.spanIndices * barW);
            ax = xc0 - w0 / 2;
            bx = xc0 + w0 / 2;
          }
          const w = bx - ax;
          const xc = (ax + bx) / 2;
          if (bx < -8 || ax > width + 8) continue; // fully off-viewport

          ctx.save();
          ctx.fillStyle = GAP_FILL;
          ctx.fillRect(ax, 0, w, height);
          ctx.strokeStyle = GAP_EDGE;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(ax + 0.5, 0);
          ctx.lineTo(ax + 0.5, height);
          ctx.moveTo(bx - 0.5, 0);
          ctx.lineTo(bx - 0.5, height);
          ctx.stroke();
          ctx.restore();

          if (w >= MIN_LABEL_PX && ax >= -8 && bx <= width + 8) {
            ctx.save();
            ctx.font = `10px ${FONT_STACK}`;
            ctx.fillStyle = GAP_TEXT;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText("DATA GAP", xc, 8);
            ctx.restore();
          }
        }

        ctx.restore();
      });
    },
  };
}
