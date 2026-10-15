/**
 * Drawing annotation + styling helpers — pure, DOM-free, Node-testable.
 *
 * SCOPE: everything the contextual drawing toolbar / text annotation feature
 * needs that is NOT chart-geometry. CandleKit's `DrawingEngine` owns the model
 * (points, selection, lock) and its `DrawingPrimitive` paints the shape geometry
 * (`color`, `width`, `dashed`, `fill`) — but it does NOT paint text, and it has
 * no concept of fill opacity or a text label. AURA adds those on top:
 *
 *   - annotations + the extra style fields live INSIDE the drawing's existing
 *     `style` object (`style.text`, `style.textColor`, …). That is deliberate:
 *     `engine.setStyle(id, patch)` merges them, `engine.export()` JSON round-
 *     trips the whole object, and the backend persists `style` byte-identical in
 *     the `chart_drawings.drawing_data` JSONB column — so annotations and
 *     settings survive refresh/redeploy with NO schema migration and NO second
 *     persistence path. Old records simply lack these keys → safe defaults.
 *
 * This module is the single source of truth for:
 *   - which tools are annotatable (TrendLine, Rectangle),
 *   - normalizing/sanitizing an incoming style (safe defaults + clamps, so a
 *     hostile or legacy payload can never crash the renderer),
 *   - colour/alpha math (fill opacity is baked INTO `style.fill` because
 *     CandleKit assigns `style.fill` straight to the canvas `fillStyle`),
 *   - the pure label-placement math (screen-pixel anchor for a trend-line or
 *     rectangle label), shared by the primitive and unit-tested directly.
 *
 * RENDERING SAFETY: user text is only ever drawn with the canvas `fillText`
 * (DrawingAnnotationPrimitive) or shown through a controlled `<input>`/
 * `<textarea>` value (the editor). It is NEVER parsed as HTML/markdown and
 * NEVER reaches `innerHTML`/`dangerouslySetInnerHTML`.
 */

/** A drawing as AURA reads it — a structural superset of CandleKit's `Drawing`. */
export interface DrawingLike {
  id: string;
  tool: string;
  points: readonly { time: number; price: number }[];
  style?: Record<string, unknown>;
}

/** The annotation + extra style fields AURA layers on top of CandleKit's style. */
export interface DrawingTextStyle {
  /** Annotation content. Empty/absent => no annotation (drawing is kept). */
  text?: string;
  /** Label font size in CSS px. */
  textSize?: number;
  /** Label colour (CSS colour string). */
  textColor?: string;
  /**
   * Label placement relative to the shape. Trend lines: "above" | "below" |
   * "center". Rectangles: "center" (default, inside) | "above" | "below".
   */
  textPlacement?: TextPlacement;
  /** Rectangle fill opacity 0..1 — baked into `style.fill` for rendering. */
  fillOpacity?: number;
}

export type TextPlacement = "auto" | "above" | "below" | "center";

/** Fully-defaulted, sanitized view of a drawing's text/annotation style. */
export interface NormalizedTextStyle {
  text: string;
  textSize: number;
  textColor: string;
  textPlacement: TextPlacement;
  fillOpacity: number;
}

// ── Constants (safe defaults + clamps) ───────────────────────────────────────

/** Tools the contextual toolbar + text annotation support (initially). */
export const ANNOTATABLE_TOOLS: readonly string[] = ["TrendLine", "Rectangle"];

/** Upper bound on annotation length — keeps the JSONB payload + canvas sane. */
export const MAX_TEXT_LENGTH = 200;

export const TEXT_SIZE_MIN = 8;

// ── Tool gating ──────────────────────────────────────────────────────────────

/** Whether a drawing's tool supports annotations + the contextual toolbar. */
export function isAnnotatableTool(tool: unknown): tool is string {
  return typeof tool === "string" && ANNOTATABLE_TOOLS.includes(tool);
}

// ── Numeric / colour clamps ──────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Clamp a font size to the supported band (non-finite => default). */
export function clampFontSize(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : TEXT_SIZE_DEFAULT;
  return Math.round(clamp(v, TEXT_SIZE_MIN, TEXT_SIZE_MAX));
}

/** Clamp an opacity to 0..1 (non-finite => 1 = fully opaque, the legacy look). */
export function clampOpacity(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 1;
  return clamp(v, 0, 1);
}

/** A colour is "safe" if it is a hex or rgb/rgba string; else the default. */
export function clampColor(input: unknown, fallback: string): string {
  if (typeof input !== "string") return fallback;
  const s = input.trim();
  if (HEX_COLOR.test(s) || RGB_COLOR.test(s)) return s;
  return fallback;
}

function clampByte(n: number): number {
  return clamp(Math.round(n), 0, 255);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const num = parseInt(h.slice(0, 6), 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

/**
 * Split a colour into an opaque base colour + an alpha 0..1. Accepts
 * `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`. Anything else falls
 * back to an opaque default — the renderer never sees an invalid colour.
 */
export function splitColorAlpha(input: unknown, fallback = DEFAULT_FILL_COLOR): { color: string; alpha: number } {
  if (typeof input !== "string") return { color: fallback, alpha: 1 };
  const s = input.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 6) return { color: s.toLowerCase(), alpha: 1 };
    if (hex.length === 8) {
      const a = parseInt(hex.slice(6, 8), 16) / 255;
      return { color: `#${hex.slice(0, 6)}`.toLowerCase(), alpha: clampOpacity(a) };
    }
    return { color: fallback, alpha: 1 };
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const parts = m[1].split(",").map((x) => x.trim());
    const r = clampByte(Number(parts[0]));
    const g = clampByte(Number(parts[1]));
    const b = clampByte(Number(parts[2]));
    const a = parts.length > 3 ? clampOpacity(Number(parts[3])) : 1;
    const color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    return { color, alpha: a };
  }
  return { color: fallback, alpha: 1 };
}

/**
 * Produce a canvas-safe colour string with the given alpha baked in. Because
 * CandleKit assigns `style.fill` directly to `fillStyle`, opacity is carried in
 * the string itself (opaque colours stay as plain hex; translucent ones become
 * `rgba(r, g, b, a)`).
 */
export function withAlpha(color: string, alpha: number): string {
  const { color: base } = splitColorAlpha(color, DEFAULT_FILL_COLOR);
  const a = clampOpacity(alpha);
  if (a >= 1) return base;
  const { r, g, b } = hexToRgb(base);
  const rounded = Math.round(a * 100) / 100;
  return `rgba(${r}, ${g}, ${b}, ${rounded})`;
}

export const TEXT_SIZE_MAX = 48;
export const TEXT_SIZE_DEFAULT = 12;

export const DEFAULT_TEXT_COLOR = "#e6edf3";
export const DEFAULT_FILL_COLOR = "#26a69a";

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_COLOR = /^rgba?\(\s*[^)]+\)$/i;


// ── Style normalization ──────────────────────────────────────────────────────

function normalizePlacement(p: unknown, fallback: TextPlacement): TextPlacement {
  return p === "above" || p === "below" || p === "center" || p === "auto" ? p : fallback;
}

/**
 * Read a drawing's `style` into a fully-defaulted, sanitized text/annotation
 * view. Legacy drawings (no annotation keys) come back as "no text, opaque
 * fill, default colour/size" — never an error, never a crash.
 */
export function normalizeTextStyle(style: Record<string, unknown> | undefined): NormalizedTextStyle {
  const s = style ?? {};
  const rawText = typeof s.text === "string" ? s.text : "";
  return {
    text: rawText.slice(0, MAX_TEXT_LENGTH),
    textSize: clampFontSize(s.textSize),
    textColor: clampColor(s.textColor, DEFAULT_TEXT_COLOR),
    textPlacement: normalizePlacement(s.textPlacement, "auto"),
    fillOpacity: clampOpacity(s.fillOpacity),
  };
}

/** The default placement for a tool (trend lines sit above the line). */
export function defaultPlacement(tool: string): TextPlacement {
  return tool === "Rectangle" ? "center" : "above";
}

/**
 * Sanitize a user-entered annotation edit into a `style` patch. `text` may be
 * empty (that REMOVES the annotation without deleting the drawing). Numbers and
 * colours are clamped; the placement is validated against the allowed set.
 */
export function sanitizeTextPatch(
  input: {
    text?: unknown;
    textSize?: unknown;
    textColor?: unknown;
    textPlacement?: unknown;
    fillOpacity?: unknown;
  },
  tool: string,
): DrawingTextStyle {
  const patch: DrawingTextStyle = {};
  if (input.text !== undefined) {
    patch.text = typeof input.text === "string" ? input.text.slice(0, MAX_TEXT_LENGTH) : "";
  }
  if (input.textSize !== undefined) patch.textSize = clampFontSize(input.textSize);
  if (input.textColor !== undefined) patch.textColor = clampColor(input.textColor, DEFAULT_TEXT_COLOR);
  if (input.textPlacement !== undefined) {
    patch.textPlacement = normalizePlacement(input.textPlacement, defaultPlacement(tool));
  }
  if (input.fillOpacity !== undefined) patch.fillOpacity = clampOpacity(input.fillOpacity);
  return patch;
}

// ── Label placement math (pure — screen pixels in, anchor out) ───────────────

/** A screen-space point + the canvas text alignment to draw it with. */
export interface LabelAnchor {
  x: number;
  y: number;
  textAlign: "left" | "center" | "right";
  textBaseline: "top" | "middle" | "bottom";
}

/**
 * Anchor for a trend-line label. Default "above" offsets perpendicular to the
 * line so it never sits on the stroke; "below" flips it; "center" pins the
 * midpoint. `hpr` scales the gap for HiDPI canvases.
 */
export function trendLineLabelAnchor(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  placement: TextPlacement,
  fontSize: number,
  hpr = 1,
): LabelAnchor {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  if (placement === "center") {
    return { x: mx, y: my, textAlign: "center", textBaseline: "middle" };
  }
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit; screen y grows downward, so "above" => negative y offset.
  let nx = -dy / len;
  let ny = dx / len;
  if ((placement === "above" && ny > 0) || (placement === "below" && ny < 0)) {
    nx = -nx;
    ny = -ny;
  }
  const gap = 6 * hpr + (fontSize * hpr) / 2;
  return { x: mx + nx * gap, y: my + ny * gap, textAlign: "center", textBaseline: "middle" };
}

/**
 * Anchor for a rectangle label. "center" (default) centers it inside the box;
 * "above"/"below" sit just outside the top/bottom edge.
 */
export function rectLabelAnchor(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  placement: TextPlacement,
  fontSize: number,
  hpr = 1,
): LabelAnchor {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const cx = (left + right) / 2;
  if (placement === "above") {
    return { x: cx, y: top - 6 * hpr, textAlign: "center", textBaseline: "bottom" };
  }
  if (placement === "below") {
    return { x: cx, y: bottom + 6 * hpr + fontSize * hpr, textAlign: "center", textBaseline: "top" };
  }
  // "center" and "auto" => inside.
  return { x: cx, y: (top + bottom) / 2, textAlign: "center", textBaseline: "middle" };
}

/** Pick the right anchor helper for a tool. Returns null for non-annotatable tools. */
export function labelAnchorForTool(
  tool: string,
  anchors: { x: number; y: number }[],
  placement: TextPlacement,
  fontSize: number,
  hpr = 1,
): LabelAnchor | null {
  if (!isAnnotatableTool(tool)) return null;
  const a = anchors[0];
  const b = anchors[1] ?? anchors[0];
  if (!a) return null;
  if (tool === "Rectangle") {
    return rectLabelAnchor(a.x, a.y, b.x, b.y, placement, fontSize, hpr);
  }
  // TrendLine
  return trendLineLabelAnchor(a.x, a.y, b.x, b.y, placement, fontSize, hpr);
}
