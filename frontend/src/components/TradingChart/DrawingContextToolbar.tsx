import { useEffect, useRef, useState } from "react";
import type { ChartViewApi, DrawingEngine, DrawingStyle } from "@getcandlekit/charts/react";

import { clampMenuPosition } from "./contextMenu";
import {
  desiredToolbarPosition,
  toolbarAnchorPoint,
  type Pt,
} from "./drawingToolbarGeometry";
import {
  clampFontSize,
  clampOpacity,
  defaultPlacement,
  isAnnotatableTool,
  normalizeTextStyle,
  sanitizeTextPatch,
  splitColorAlpha,
  withAlpha,
  MAX_TEXT_LENGTH,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  type TextPlacement,
} from "../../services/drawingAnnotations";

/**
 * DrawingContextToolbar — the compact floating toolbar that appears when a
 * supported drawing (trend line, rectangle) is SELECTED.
 *
 * CONTRACT (reuses the existing drawing architecture — no second system):
 *   - reads selection + mutates through CandleKit's OWN `DrawingEngine`
 *     (`getSelectedId`, `getById`, `setStyle`, `removeSelected`); every edit is
 *     a `setStyle` on the drawing's existing `style` object, so annotations and
 *     settings persist through the EXISTING DrawingSync → /api/drawings path
 *     with no schema change (see services/drawingAnnotations.ts);
 *   - annotation TEXT is never this component's to render — DrawingAnnotation-
 *     Primitive paints it; this is only the editor + placement UI;
 *   - it never draws, never starts a tool, never pans the chart.
 *
 * POSITIONING: the selected drawing's anchors are projected through the LIVE
 * chart scales every frame, so the toolbar tracks pan / zoom / resize / drag.
 * The desired position (just off the drawing's end anchor) is clamped into the
 * chart container with the SAME `clampMenuPosition` the right-click menu uses,
 * so it always stays inside the visible chart area.
 *
 * EVENT ISOLATION: the toolbar is a sibling overlay of the chart canvas, not a
 * child of it, so its pointer events never reach the DrawingController's chart
 * listeners — a toolbar click can never start a pan, drag a drawing, or arm a
 * new tool. `onPointerDown`/`onMouseDown` stop propagation defensively too.
 */

/** Line widths offered for the shape settings (matches the indicator editor). */
const LINE_WIDTHS = [1, 2, 3, 4];

/** Any hex / rgb / rgba string → #rrggbb for `<input type="color">`. */
function toPickerHex(color: unknown): string {
  const { color: base } = splitColorAlpha(typeof color === "string" ? color : "", "#000000");
  if (base.length === 4) {
    return `#${base[1]}${base[1]}${base[2]}${base[2]}${base[3]}${base[3]}`;
  }
  return base.slice(0, 7);
}

/** A drawing's style as a loose record (CandleKit's DrawingStyle is a closed type). */
function styleRecord(style: unknown): Record<string, unknown> {
  return style && typeof style === "object" ? (style as Record<string, unknown>) : {};
}

/**
 * Apply a style patch through the engine. AURA's annotation/styling fields live
 * inside the same `style` object as CandleKit's, but are not part of its closed
 * `DrawingStyle` type — so the patch is widened here. The engine merges the
 * patch into the drawing's existing style and round-trips every key.
 */
function patchStyle(engine: DrawingEngine, id: string, patch: Record<string, unknown>): void {
  engine.setStyle(id, patch as Partial<DrawingStyle>);
}

interface Props {
  /** CandleKit drawing engine (from the per-scope DrawingController). */
  engine: DrawingEngine;
  /** The chart API (for live-scale projection) — from TradingChart's onReady. */
  chartApi: ChartViewApi | null;
  /** The chart container (`.chart-canvas-wrap`) — positioning context. */
  containerRef: { current: HTMLDivElement | null };
}

export function DrawingContextToolbar({ engine, chartApi, containerRef }: Props) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => engine.getSelectedId());
  const [pos, setPos] = useState<Pt>({ x: 0, y: 0 });
  const [panel, setPanel] = useState<null | "text" | "settings">(null);

  // ── Selection tracking (single source: the engine) ─────────────────────────
  useEffect(() => engine.onChange(() => setSelectedId(engine.getSelectedId())), [engine]);

  // The selected drawing, only when it is a supported (annotatable) tool.
  const selected = selectedId ? engine.getById(selectedId) : undefined;
  const tool: string | null = selected && isAnnotatableTool(selected.tool) ? selected.tool : null;
  const visible = tool !== null;

  // A different selection / scope closes any open editor panel.
  useEffect(() => {
    setPanel(null);
  }, [selectedId]);

  // ── Reposition on pan / zoom / resize / move ───────────────────────────────
  // Recomputed from the LIVE scales so the toolbar follows the drawing. State
  // only changes when the pixel position actually moves → no needless renders.
  useEffect(() => {
    if (!visible) return;
    const chart = chartApi?.controller?.getChart() as unknown as
      | {
          timeScale(): {
            timeToCoordinate(t: unknown): number | null;
            subscribeVisibleTimeRangeChange(cb: () => void): void;
            unsubscribeVisibleTimeRangeChange(cb: () => void): void;
          };
          chartElement(): HTMLElement;
        }
      | undefined;
    const series = chartApi?.controller?.getSeries() as unknown as
      | { priceToCoordinate(pr: number): number | null }
      | undefined;
    if (!chart || !series) return;

    const recompute = (): void => {
      if (!selected) return;
      const anchors: Pt[] = [];
      for (const p of selected.points) {
        const x = chart.timeScale().timeToCoordinate(p.time);
        const y = series.priceToCoordinate(p.price);
        if (x == null || y == null) return; // anchor off-screen → skip this frame
        anchors.push({ x, y });
      }
      const anchor = toolbarAnchorPoint(anchors);
      const host = containerRef.current;
      const bar = barRef.current;
      if (!anchor || !host || !bar) return;
      const next = clampMenuPosition(
        desiredToolbarPosition(anchor),
        { width: bar.offsetWidth, height: bar.offsetHeight },
        { width: host.clientWidth, height: host.clientHeight },
      );
      setPos((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
    };

    recompute();
    chart.timeScale().subscribeVisibleTimeRangeChange(recompute);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(recompute);
      ro.observe(containerRef.current ?? chart.chartElement());
    }
    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(recompute);
      ro?.disconnect();
    };
  }, [chartApi, selected, visible, selectedId, engine, containerRef]);

  if (!visible || !selected || !tool) return null;

  return (
    <div
      className="drawing-context-bar"
      role="toolbar"
      aria-label="Selected drawing actions"
      ref={barRef}
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="drawing-ctx-btn"
        title="Text annotation"
        aria-label="Text annotation"
        aria-pressed={panel === "text"}
        onClick={() => setPanel((p) => (p === "text" ? null : "text"))}
      >
        T
      </button>
      <button
        type="button"
        className="drawing-ctx-btn"
        title="Drawing settings"
        aria-label="Drawing settings"
        aria-pressed={panel === "settings"}
        onClick={() => setPanel((p) => (p === "settings" ? null : "settings"))}
      >
        ⚙
      </button>
      <button
        type="button"
        className="drawing-ctx-btn drawing-ctx-btn--danger"
        title="Delete drawing"
        aria-label="Delete drawing"
        onClick={() => {
          // Remove ONLY the selected drawing (its annotation lives in the same
          // style object, so it goes too). engine.removeSelected() is a no-op
          // with nothing selected and clears the selection — the toolbar then
          // hides itself via the selection effect above.
          engine.removeSelected();
        }}
      >
        🗑
      </button>

      {panel === "text" && (
        <TextEditorPopover
          engine={engine}
          id={selected.id}
          tool={tool}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "settings" && (
        <SettingsPopover
          engine={engine}
          id={selected.id}
          tool={tool}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}


/**
 * Text-editor popover — content, font size, colour, placement, Apply/Cancel.
 * Applies through `engine.setStyle` so it persists via the existing path. Empty
 * text REMOVES the annotation without deleting the drawing. Text is only ever a
 * controlled input value + canvas fillText — never parsed as HTML.
 */
function TextEditorPopover({
  engine,
  id,
  tool,
  onClose,
}: {
  engine: DrawingEngine;
  id: string;
  tool: string;
  onClose: () => void;
}) {
  const drawing = engine.getById(id);
  const initial = normalizeTextStyle(styleRecord(drawing?.style));
  const [text, setText] = useState(initial.text);
  const [size, setSize] = useState(initial.textSize);
  const [color, setColor] = useState(initial.textColor);
  const [placement, setPlacement] = useState<TextPlacement>(
    initial.textPlacement === "auto" ? defaultPlacement(tool) : initial.textPlacement,
  );

  const apply = (): void => {
    const patch = sanitizeTextPatch({ text, textSize: size, textColor: color, textPlacement: placement }, tool);
    patchStyle(engine, id, patch as Record<string, unknown>);
    onClose();
  };

  return (
    <div className="drawing-ctx-panel" role="dialog" aria-label="Text annotation">
      <label className="drawing-ctx-field">
        <span>Text</span>
        <textarea
          value={text}
          maxLength={MAX_TEXT_LENGTH}
          rows={2}
          placeholder="Add a label…"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="drawing-ctx-row">
        <label className="drawing-ctx-field">
          <span>Size</span>
          <input
            type="number"
            min={TEXT_SIZE_MIN}
            max={TEXT_SIZE_MAX}
            value={size}
            onChange={(e) => setSize(clampFontSize(Number(e.target.value)))}
          />
        </label>
        <label className="drawing-ctx-field drawing-ctx-field--color">
          <span>Color</span>
          <input type="color" value={toPickerHex(color)} onChange={(e) => setColor(e.target.value)} />
        </label>
      </div>
      <label className="drawing-ctx-field">
        <span>Placement</span>
        <select value={placement} onChange={(e) => setPlacement(e.target.value as TextPlacement)}>
          {tool === "Rectangle" ? (
            <>
              <option value="center">Inside</option>
              <option value="above">Above</option>
              <option value="below">Below</option>
            </>
          ) : (
            <>
              <option value="above">Above line</option>
              <option value="below">Below line</option>
              <option value="center">On line</option>
            </>
          )}
        </select>
      </label>
      <div className="drawing-ctx-actions">
        <button type="button" className="drawing-ctx-action" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="drawing-ctx-action primary" onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  );
}


/**
 * Settings popover — shape styling through `engine.setStyle`.
 *   Trend line: colour, width, style (solid/dashed).
 *   Rectangle:  border colour, width, style, fill colour, fill opacity.
 * All map to CandleKit's real DrawingStyle fields (fill opacity is baked into
 * the fill colour), so the renderer applies them with no unsupported property.
 */
function SettingsPopover({
  engine,
  id,
  tool,
  onClose,
}: {
  engine: DrawingEngine;
  id: string;
  tool: string;
  onClose: () => void;
}) {
  const drawing = engine.getById(id);
  const style = styleRecord(drawing?.style);
  const isRect = tool === "Rectangle";
  const baseColor = typeof style.color === "string" ? style.color : "#4f8cff";
  const fill = splitColorAlpha(style.fill, "#26a69a");
  const [color, setColor] = useState(toPickerHex(baseColor));
  const [width, setWidth] = useState(typeof style.width === "number" ? style.width : 2);
  const [dashed, setDashed] = useState(Boolean(style.dashed));
  const [fillColor, setFillColor] = useState(toPickerHex(fill.color));
  const [fillOn, setFillOn] = useState(typeof style.fill === "string" && style.fill.length > 0);
  const [opacity, setOpacity] = useState(Math.round(fill.alpha * 100));

  const apply = (): void => {
    const patch: Record<string, unknown> = { color, width, dashed };
    if (isRect) {
      patch.fill = fillOn ? withAlpha(fillColor, opacity / 100) : null;
    }
    patchStyle(engine, id, patch);
    onClose();
  };

  return (
    <div className="drawing-ctx-panel" role="dialog" aria-label="Drawing settings">
      <label className="drawing-ctx-field drawing-ctx-field--color">
        <span>{isRect ? "Border color" : "Line color"}</span>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
      </label>
      <div className="drawing-ctx-row">
        <label className="drawing-ctx-field">
          <span>Width</span>
          <select value={width} onChange={(e) => setWidth(Number(e.target.value))}>
            {LINE_WIDTHS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <label className="drawing-ctx-field drawing-ctx-field--check">
          <span>Dashed</span>
          <input type="checkbox" checked={dashed} onChange={(e) => setDashed(e.target.checked)} />
        </label>
      </div>

      {isRect && (
        <>
          <label className="drawing-ctx-field drawing-ctx-field--check">
            <span>Fill</span>
            <input type="checkbox" checked={fillOn} onChange={(e) => setFillOn(e.target.checked)} />
          </label>
          {fillOn && (
            <div className="drawing-ctx-row">
              <label className="drawing-ctx-field drawing-ctx-field--color">
                <span>Fill color</span>
                <input type="color" value={fillColor} onChange={(e) => setFillColor(e.target.value)} />
              </label>
              <label className="drawing-ctx-field">
                <span>Opacity</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={opacity}
                  onChange={(e) => setOpacity(Math.round(clampOpacity(Number(e.target.value) / 100) * 100))}
                />
              </label>
            </div>
          )}
        </>
      )}

      <div className="drawing-ctx-actions">
        <button type="button" className="drawing-ctx-action" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="drawing-ctx-action primary" onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  );
}
