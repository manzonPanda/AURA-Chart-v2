/**
 * Pine indicator STYLE overrides — the presentation layer of the indicator
 * settings modal's Style tab (TradingView-style: style is applied at RENDER
 * time, never by editing the script or the engine).
 *
 * One Pine plot (`plotMeta` key) can be overridden with:
 *   - `visible`    — uncheck to hide the plot (renderer skips painting it);
 *   - `color`      — uniform color replacing the script's base color (per-bar
 *                    script colors are stripped so the override is complete);
 *   - `lineWidth`  — 1–4, replacing the script's `linewidth=`.
 *
 * Pure data-in/data-out (no DOM, no engine): safe for workers, Node tests and
 * the browser. Storage lives on the ImportedPineIndicator record (`style`),
 * sanitized on load by `sanitizeStyleOverrides` — a corrupted localStorage
 * entry can never break rendering.
 */

/** One plot's style overrides. Absent fields fall back to the script. */
export interface PinePlotStyleOverride {
  visible?: boolean;
  color?: string;
  lineWidth?: number;
}

/** Overrides keyed by the plot's stable key (`plotMeta[].key` / visual key). */
export type PineStyleOverrides = Record<string, PinePlotStyleOverride>;

/** Line widths the modal offers (matches the EMA/SMA Width select). */
export const PINE_PLOT_WIDTHS: readonly number[] = [1, 2, 3, 4];

/** Max overridden plots kept (mirrors MAX_PLOT_SERIES_PER_INDICATOR's world). */
const MAX_STYLE_KEYS = 32;

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Validate arbitrary (possibly corrupted) stored overrides into a clean map.
 * Unknown shapes drop per-field; a key with no usable fields is omitted, so
 * the sanitized record only ever carries MEANINGFUL overrides.
 */
export function sanitizeStyleOverrides(raw: unknown): PineStyleOverrides {
  const out: PineStyleOverrides = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0 || key.length > 120 || key.startsWith("__")) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const o: PinePlotStyleOverride = {};
    if (typeof v.visible === "boolean" && !v.visible) o.visible = false;
    if (typeof v.color === "string") {
      const c = v.color.trim();
      if (HEX_COLOR_RE.test(c)) o.color = c.toLowerCase();
    }
    if (typeof v.lineWidth === "number" && Number.isInteger(v.lineWidth)) {
      o.lineWidth = Math.max(1, Math.min(4, v.lineWidth));
    }
    if (o.visible !== undefined || o.color !== undefined || o.lineWidth !== undefined) {
      out[key] = o;
    }
    if (Object.keys(out).length >= MAX_STYLE_KEYS) break;
  }
  return out;
}

/** True when the override changes nothing (all fields unset/identity). */
export function isDefaultPlotStyle(o: PinePlotStyleOverride | undefined): boolean {
  if (!o) return true;
  // visible: true is the identity (plots are visible unless overridden off).
  return (o.visible === undefined || o.visible === true) && o.color === undefined && o.lineWidth === undefined;
}
