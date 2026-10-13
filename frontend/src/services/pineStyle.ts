/**
 * Pine indicator STYLE overrides — the presentation layer of the indicator
 * settings modal's Style tab (TradingView-style: style is applied at RENDER
 * time, never by editing the script or the engine).
 *
 * ONE override record per visual output, keyed by that visual's stable key
 * (`plotMeta[].key` / runtime visual key). The SAME record shape serves every
 * supported visual kind; each kind consumes only the fields meaningful to it:
 *
 *   line / area / histogram / style_linebr plots (`color`/`lineWidth`/…):
 *     - `visible`    — uncheck to hide the plot (renderer skips painting it);
 *     - `color`      — uniform color replacing the script's base color (per-bar
 *                      script colors are stripped so the override is complete);
 *     - `lineWidth`  — 1–4, replacing the script's `linewidth=`;
 *     - `lineStyle`  — solid / dashed / dotted (line + area plots only).
 *   hline() horizontals (`color`/`lineWidth`/`lineStyle`/`visible`):
 *     - `color`      — replaces the horizontal line's color;
 *     - `lineWidth`  — 1–4;
 *     - `lineStyle`  — solid / dashed / dotted;
 *     - `visible`    — uncheck to remove the horizontal line.
 *   fill() regions (`color` + `opacity`):
 *     - `color`      — replaces the fill color (per-bar script fill colors are
 *                      stripped so the override is complete);
 *     - `opacity`    — 0–1 fill alpha.
 *
 * Only fields relevant to the visual's kind are exposed by the UI and applied
 * by the renderer; the rest are inert. Properties not overridden keep their
 * exact script-defined behaviour (absent field ⇒ fall back to the script).
 *
 * Pure data-in/data-out (no DOM, no engine): safe for workers, Node tests and
 * the browser. Storage lives on the ImportedPineIndicator record (`style`),
 * sanitized on load by `sanitizeStyleOverrides` — a corrupted localStorage
 * entry can never break rendering.
 */

/** Line styles a plot/hline override may request. */
export type PineLineStyle = "solid" | "dashed" | "dotted";

/** One visual output's style overrides. Absent fields fall back to the script. */
export interface PinePlotStyleOverride {
  visible?: boolean;
  color?: string;
  lineWidth?: number;
  /** solid / dashed / dotted — meaningful for line/area plots and hline(). */
  lineStyle?: PineLineStyle;
  /** 0–1 fill alpha — meaningful only for fill() regions. */
  opacity?: number;
}

/** Overrides keyed by the visual's stable key (`plotMeta[].key` / visual key). */
export type PineStyleOverrides = Record<string, PinePlotStyleOverride>;

/** Line widths the modal offers (matches the EMA/SMA Width select). */
export const PINE_PLOT_WIDTHS: readonly number[] = [1, 2, 3, 4];

/** Line styles offered for line/area plots and hline() outputs. */
export const PINE_LINE_STYLES: readonly PineLineStyle[] = ["solid", "dashed", "dotted"];

/** Fill opacity presets (percent) offered for fill() regions. */
export const PINE_FILL_OPACITIES: readonly number[] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/** Max overridden visuals kept (mirrors MAX_PLOT_SERIES_PER_INDICATOR's world). */
const MAX_STYLE_KEYS = 32;

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const LINE_STYLES: ReadonlySet<string> = new Set(PINE_LINE_STYLES);

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
    if (typeof v.lineStyle === "string" && LINE_STYLES.has(v.lineStyle)) {
      o.lineStyle = v.lineStyle as PineLineStyle;
    }
    if (typeof v.opacity === "number" && Number.isFinite(v.opacity)) {
      o.opacity = Math.max(0, Math.min(1, v.opacity));
    }
    if (
      o.visible !== undefined ||
      o.color !== undefined ||
      o.lineWidth !== undefined ||
      o.lineStyle !== undefined ||
      o.opacity !== undefined
    ) {
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
  // lineStyle: "solid" is the identity for the default line rendering.
  return (
    (o.visible === undefined || o.visible === true) &&
    o.color === undefined &&
    o.lineWidth === undefined &&
    (o.lineStyle === undefined || o.lineStyle === "solid") &&
    o.opacity === undefined
  );
}
