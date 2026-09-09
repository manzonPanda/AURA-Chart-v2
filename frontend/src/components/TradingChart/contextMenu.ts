/**
 * Chart context-menu geometry — pure, DOM-free helpers.
 *
 * Kept out of the component so the positioning contract is unit-testable with
 * Node's type-stripping runner (npm --prefix frontend run test). The menu is
 * presentation-only UI: these helpers see pixel numbers, never chart data.
 */

/** A point in the chart container's coordinate space (px from top-left). */
export interface MenuPoint {
  x: number;
  y: number;
}

/** Rendered menu size (px). */
export interface MenuSize {
  width: number;
  height: number;
}

/**
 * Minimum gap (px) kept between the menu and the container edges. Small on
 * purpose — TradingView-style menus hug the cursor — but never 0, so the menu
 * border stays visible against the chart frame.
 */
export const CONTEXT_MENU_MARGIN = 4;

/**
 * Clamp an anchored menu position so the ENTIRE menu stays inside the chart
 * container:
 *   - the anchor is the raw cursor position (container-relative);
 *   - if the menu would overflow the right/bottom edge, it is shifted back so
 *     its right/bottom edge sits `margin` px inside the container (i.e. it
 *     flips to the left/above the cursor);
 *   - if the cursor sits at/behind the origin, the menu is nudged to `margin`;
 *   - if the container is SMALLER than the menu (tiny panes), the menu is
 *     pinned at `margin` — best-effort inside, overflow is unavoidable.
 */
export function clampMenuPosition(
  anchor: MenuPoint,
  menu: MenuSize,
  container: MenuSize,
  margin: number = CONTEXT_MENU_MARGIN,
): MenuPoint {
  const maxX = Math.max(margin, container.width - margin - menu.width);
  const maxY = Math.max(margin, container.height - margin - menu.height);
  return {
    x: Math.min(Math.max(anchor.x, margin), maxX),
    y: Math.min(Math.max(anchor.y, margin), maxY),
  };
}
