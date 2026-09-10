import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampMenuPosition, type MenuPoint } from "./contextMenu";

interface Props {
  /**
   * The chart container (`.chart-canvas-wrap`) that owns the right-click area
   * and is the positioning context for the menu. Structural ref type — the
   * same pattern as ViewportBridge's `preserveRangeRef`.
   */
  containerRef: { current: HTMLDivElement | null };
  /**
   * Current "Invert Scale" state — App's persisted `chartSettings.invertScale`
   * passed down through TradingChart. Reflection ONLY: this component never
   * owns or duplicates the state.
   */
  invertScale: boolean;
  /**
   * Invokes App's EXISTING Invert Scale toggle. No second implementation
   * lives here.
   */
  onToggleInvertScale?: () => void;
  /**
   * Dataset scope (`instrument|timeframe|replay`). Any change — timeframe
   * switch, instrument switch, replay enter/exit — closes the menu so it can
   * never hover stale toggles over a different dataset.
   */
  scopeKey?: string;
}

/**
 * Right-click context menu for the chart plot — a compact, chart-native UI
 * overlay (TradingView-style), mounted inside `.chart-canvas-wrap` so it
 * positions with the chart and sits above every chart overlay.
 *
 * Presentation-only by contract:
 *   - it reflects the EXISTING Invert Scale state handed down from App and
 *     invokes the SAME action — no duplicated state, no second implementation;
 *   - it never touches candle data, Pine, whitespace slots, DATA GAP bands or
 *     replay state (Invert Scale is a pure price-scale transform — valid
 *     during replay too);
 *   - only the `contextmenu` handler calls preventDefault; a left click that
 *     closes the menu still reaches the chart (pan/zoom/crosshair unaffected).
 */
export function ChartContextMenu({
  containerRef,
  invertScale,
  onToggleInvertScale,
  scopeKey = "",
}: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** Raw cursor anchor (container-relative) — kept for re-clamps on resize. */
  const anchorRef = useRef<MenuPoint>({ x: 0, y: 0 });
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPoint>({ x: 0, y: 0 });

  // ── Right-click anywhere in the chart container ─────────────────────────────
  // Native browser menu suppressed; ours (re)opens anchored at the real cursor.
  // Re-right-clicking while open naturally repositions the menu.
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const onContextMenu = (e: MouseEvent): void => {
      // Suppress the browser's native menu; ours opens at the cursor instead.
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      anchorRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      setPos(anchorRef.current);
      setOpen(true);
    };
    host.addEventListener("contextmenu", onContextMenu);
    return () => host.removeEventListener("contextmenu", onContextMenu);
  }, [containerRef]);

  // Dataset scope changed (timeframe / instrument / replay) → close. Never let
  // the menu hover stale toggles over a different dataset.
  useEffect(() => {
    setOpen(false);
  }, [scopeKey]);


  // ── While open: outside-click + Escape close ────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const menu = menuRef.current;
      if (menu && e.target instanceof Node && menu.contains(e.target)) return;
      // NO preventDefault / stopPropagation — a left click that closes the
      // menu must still reach the chart (pan, crosshair, wheel zoom, drag).
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // ── Keep the WHOLE menu inside the chart container ──────────────────────────
  // Measured clamp (rendered size vs container size) applied in a layout
  // effect — it runs before paint, so an overflowing first frame never flashes.
  const clampIntoView = useCallback(() => {
    const host = containerRef.current;
    const menu = menuRef.current;
    if (!host || !menu) return;
    const next = clampMenuPosition(
      anchorRef.current,
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: host.clientWidth, height: host.clientHeight },
    );
    setPos((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
  }, [containerRef]);

  useLayoutEffect(() => {
    if (!open) return;
    clampIntoView();
  }, [open, pos, clampIntoView]);

  // Container resized while open (window drag, devtools…) → re-clamp.
  useEffect(() => {
    if (!open) return;
    const host = containerRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(clampIntoView);
    ro.observe(host);
    return () => ro.disconnect();
  }, [open, containerRef, clampIntoView]);

  // Item selection → invoke the EXISTING action, then close (per contract).
  const pickInvertScale = useCallback(() => {
    onToggleInvertScale?.();
    setOpen(false);
  }, [onToggleInvertScale]);

  if (!open) return null;

  return (
    <div
      className="chart-context-menu"
      role="menu"
      aria-label="Chart context menu"
      ref={menuRef}
      style={{ left: pos.x, top: pos.y }}
    >
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={invertScale}
        className="chart-context-menu-item"
        onClick={pickInvertScale}
      >
        <span>Invert Scale</span>
        <span className="chart-context-menu-check" aria-hidden="true">
          ✓
        </span>
      </button>
    </div>
  );
}
