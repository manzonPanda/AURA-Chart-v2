/**
 * Contextual drawing-toolbar geometry — pure, DOM-free helpers.
 *
 * Kept out of the React component (same pattern as contextMenu.ts) so the
 * positioning contract is unit-testable with Node's type-stripping runner.
 * These helpers see pixel numbers and a projected anchor — never chart data.
 */

/** A point in the chart container's coordinate space (px from top-left). */
export interface Pt {
  x: number;
  y: number;
}

/** Rendered toolbar size (px). */
export interface Size {
  width: number;
  height: number;
}

/**
 * Offset (px) placed between the selected drawing's anchor and the toolbar, so
 * the toolbar floats just clear of the shape instead of on top of it.
 */
export const TOOLBAR_OFFSET = 10;

/**
 * Choose the anchor point for the contextual toolbar from a drawing's PROJECTED
 * screen anchors (already converted through the live chart scales). We use the
 * LAST anchor (the drawing's "end" handle) by default: for a trend line that is
 * its far endpoint, for a rectangle its second corner — a stable, meaningful
 * point that does not sit under the shape's centre. Falls back to the first
 * anchor for single-point tools. Returns null when there are no anchors.
 */
export function toolbarAnchorPoint(anchors: readonly Pt[]): Pt | null {
  if (anchors.length === 0) return null;
  const last = anchors[anchors.length - 1];
  if (!last) return null;
  return { x: last.x, y: last.y };
}

/**
 * The toolbar's desired top-left, BEFORE clamping: just down-right of the
 * anchor so it reads as attached to the drawing's endpoint. The caller clamps
 * this into the container (reusing clampMenuPosition) so it never leaves the
 * visible chart area or covers the drawing's body.
 */
export function desiredToolbarPosition(anchor: Pt, offset = TOOLBAR_OFFSET): Pt {
  return { x: anchor.x + offset, y: anchor.y + offset };
}
