/**
 * Pine drawing-object adapter — the reusable bridge between PineTS's internal
 * drawing collectors and AURA's chart renderer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Why this module exists
 *
 * PineTS 0.9.33 implements Pine drawings as a FIRST-CLASS object registry:
 * every `label.new()` creates a stable `LabelObject` (`id`, x, y, text, xloc,
 * yloc, color, style, textcolor, size, textalign, …) and the whole lifecycle —
 * `label.set_text/set_color/set_xy/set_x/set_y/set_style/set_size/delete/copy`
 * — mutates that object in place. Deleted objects are filtered by PineTS and
 * the LIVE state is synced into internal `ctx.plots` collectors:
 *
 *   `__labels__`          → one row `{time, value: LabelSnapshot[]}` holding
 *                           every live label's `toPlotData()` snapshot
 *   `__labels_overlay__`  → the same, for `force_overlay=true` labels
 *                           (drawings a separate-pane script pins to the main pane)
 *
 * This module is the adapter half of the pipeline:
 *
 *   Pine execution → PineTS drawing registry (collectors)
 *                  → pineDrawings.ts (THIS — normalize into semantic anchors)
 *                  → PineVisual ("labels")
 *                  → pineLabelPrimitive.ts (LWC v5 canvas renderer)
 *
 * Label is the first supported drawing primitive; `line`/`box`/`shape` can be
 * added later as additional extractors on the same model (semantic chart-space
 * anchors, explicit unsupported reporting, no per-script special-casing).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * POSITIONING CONTRACT (zoom/scroll/history/replay-safe by construction):
 * the stored anchor is ALWAYS chart-space — `timeMs` + `price` — never screen
 * pixels. Bar-index anchors additionally keep `logical` (the raw Pine bar
 * index) so the renderer can pin to the exact bar slot via LWC's logical
 * coordinate API; the time+price pair is the portable truth that survives
 * history prepends (bar indexes shift, timestamps do not).
 *
 * NOT rendered here — pure data + pure helpers only (Node-testable, no DOM,
 * no lightweight-charts import).
 */

// ── Normalized label model ───────────────────────────────────────────────────

/** Normalized Pine label style (PineTS `style_*` constants minus the prefix). */
export type PineLabelStyleName =
  | "label_up"
  | "label_down"
  | "label_left"
  | "label_right"
  | "label_center"
  | "label_lower_left"
  | "label_lower_right"
  | "label_upper_left"
  | "label_upper_right"
  | "none";

/** Normalized Pine label size (`size.*` constants). */
export type PineLabelSizeName = "tiny" | "small" | "normal" | "large" | "huge";

/** Pine `text.align_*`. */
export type PineLabelAlign = "left" | "center" | "right";

export type PineLabelXloc = "bar_index" | "bar_time";
export type PineLabelYloc = "price" | "abovebar" | "belowbar";

/**
 * One semantic label drawing. Produced once per PineTS run from the
 * `__labels__` collector; the renderer positions it per frame from the
 * chart-space anchors. `id` is PineTS's stable per-object id, so repeated
 * runs of the same script over unchanged data produce identical objects.
 */
export interface PineLabelDrawing {
  /** Stable PineTS object id — one `label.new()` = one id. */
  id: number;
  /** X anchor in epoch ms (bar_index → candle openTime; future index → extrapolated; bar_time → raw ms). */
  timeMs: number;
  /**
   * Raw bar-index anchor for `xloc.bar_index` labels (exact logical-bar
   * rendering, including indexes beyond the last bar). `null` for
   * `xloc.bar_time` labels (timeMs alone positions them).
   */
  logical: number | null;
  /** Y anchor price: yloc.price → the passed y; abovebar/belowbar → anchor-bar high/low. */
  price: number;
  /** Label text (Pine `str` — may be empty). */
  text: string;
  xloc: PineLabelXloc;
  yloc: PineLabelYloc;
  /** Balloon fill — PineTS hex (`#RRGGBB` / `#RRGGBBAA`); `""` → renderer default. */
  color: string;
  /** Text fill — PineTS hex; `""` → renderer default. */
  textcolor: string;
  style: PineLabelStyleName;
  size: PineLabelSizeName;
    textalign: PineLabelAlign;
  /** `force_overlay=true` → rendered on the main chart pane (candle series), not this indicator's pane. */
  forceOverlay: boolean;
}

/** Bar slice the adapter needs to resolve anchors (subset of the PineTS klines). */
export interface PineLabelBar {
  openTime: number;
  high: number;
  low: number;
}

/** One explicitly-reported non-renderable label parameter group. */
export interface PineDrawingUnsupported {
  /** Human-readable kind, e.g. `label.new yloc "weird"` — surfaced in the import diagnostics. */
  kind: string;
  count: number;
}

/** Result of normalizing one collector's rows. */
export interface LabelExtractResult {
  labels: PineLabelDrawing[];
  /** Parameters AURA could not honor — reported, never silently ignored. */
  unsupported: PineDrawingUnsupported[];
}

// ── Normalization tables & renderer-facing constants ────────────────────────

/** PineTS abbreviations for the Pine positioning enums (verified 0.9.33). */
const XLOC_ALIASES: Record<string, PineLabelXloc> = {
  bi: "bar_index",
  bar_index: "bar_index",
  bt: "bar_time",
  bar_time: "bar_time",
};

const YLOC_ALIASES: Record<string, PineLabelYloc> = {
  pr: "price",
  price: "price",
  ab: "abovebar",
  abovebar: "abovebar",
  bl: "belowbar",
  belowbar: "belowbar",
};

const STYLE_NAMES: ReadonlySet<string> = new Set([
  "style_label_up",
  "style_label_down",
  "style_label_left",
  "style_label_right",
  "style_label_center",
  "style_label_lower_left",
  "style_label_lower_right",
  "style_label_upper_left",
  "style_label_upper_right",
  "style_none",
]);

/** Pine's label.new default (v5/v6): style_label_down — used for unknown styles. */
export const PINE_DEFAULT_LABEL_STYLE: PineLabelStyleName = "label_down";
/** Pine's label.new default size. */
export const PINE_DEFAULT_LABEL_SIZE: PineLabelSizeName = "normal";
/** Pine's label.new default balloon color (color.blue in TradingView's palette). */
export const PINE_DEFAULT_LABEL_COLOR = "#2962FF";

const SIZE_NAMES: ReadonlySet<string> = new Set(["tiny", "small", "normal", "large", "huge"]);
const ALIGN_ALIASES: Record<string, PineLabelAlign> = {
  center: "center",
  left: "left",
  right: "right",
};

/**
 * Renderer-facing geometry per style: which side of the anchor the balloon
 * occupies and where the pointer sits. `none` draws text only. Shared by the
 * canvas primitive and pinned by unit tests.
 */
export const LABEL_POINTER: Record<
  PineLabelStyleName,
  "up" | "down" | "left" | "right" | "lower_left" | "lower_right" | "upper_left" | "upper_right" | "none"
> = {
  label_up: "up",
  label_down: "down",
  label_left: "left",
  label_right: "right",
  label_center: "none",
  label_lower_left: "lower_left",
  label_lower_right: "lower_right",
  label_upper_left: "upper_left",
  label_upper_right: "upper_right",
  none: "none",
};

/**
 * AURA dark-UI font/padding scale per Pine size — deliberately close to
 * TradingView's visual weight without claiming pixel parity.
 */
export const LABEL_SIZE_PX: Record<PineLabelSizeName, { font: number; padX: number; padY: number; tip: number }> = {
  tiny: { font: 9, padX: 5, padY: 3, tip: 4 },
  small: { font: 10.5, padX: 6, padY: 3.5, tip: 5 },
  normal: { font: 12, padX: 7, padY: 4, tip: 6 },
  large: { font: 15, padX: 8, padY: 5, tip: 7 },
  huge: { font: 19, padX: 10, padY: 6, tip: 8 },
};

// ── Anchor resolution ────────────────────────────────────────────────────────

/**
 * Map a Pine bar_index to the corresponding candle openTime.
 * Indexes inside the series map to `klines[i].openTime`; indexes beyond the
 * last bar (labels drawn into the future) and before the first bar are
 * extrapolated with the series' own bucket spacing — the same approximation
 * Lightweight Charts itself uses to place future slots.
 */
export function barIndexToTimeMs(index: number, klines: readonly PineLabelBar[]): number {
  const n = klines.length;
  if (n === 0) return 0;
  const last = klines[n - 1]!;
  if (index >= 0 && index < n) return klines[index]!.openTime;
  const bucketMs = n >= 2 ? Math.max(0, last.openTime - klines[n - 2]!.openTime) : 60_000;
  return index >= n ? last.openTime + (index - (n - 1)) * bucketMs : klines[0]!.openTime + index * bucketMs;
}

/** Nearest bar index at-or-before the given timestamp (binary search; -1 when before the first bar). */
export function barIndexForTime(timeMs: number, klines: readonly PineLabelBar[]): number {
  let lo = 0;
  let hi = klines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (klines[mid]!.openTime <= timeMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Resolve the label's yloc to a concrete anchor price.
 * `price` → the passed y; `abovebar`/`belowbar` → the anchor bar's high/low
 * (the bar the label is pinned to, not the bar that created it). When the
 * anchor bar is outside the series (future/past placement) the passed y is
 * the only sane fallback — scripts pass the bar's high/low themselves.
 */
export function resolveLabelPrice(
  yloc: PineLabelYloc,
  y: number,
  anchorIndex: number,
  klines: readonly PineLabelBar[],
): number {
  if (yloc === "abovebar") {
    const bar = anchorIndex >= 0 && anchorIndex < klines.length ? klines[anchorIndex] : undefined;
    return bar ? bar.high : y;
  }
  if (yloc === "belowbar") {
    const bar = anchorIndex >= 0 && anchorIndex < klines.length ? klines[anchorIndex] : undefined;
    return bar ? bar.low : y;
  }
  return y;
}

// ── Collector normalization ──────────────────────────────────────────────────

interface LabelSnapshotLike {
  id?: unknown;
  x?: unknown;
  y?: unknown;
  text?: unknown;
  xloc?: unknown;
  yloc?: unknown;
  color?: unknown;
  textcolor?: unknown;
  style?: unknown;
  size?: unknown;
  textalign?: unknown;
  force_overlay?: unknown;
}

function asFinite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asHexColor(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function bumpUnsupported(unsupported: PineDrawingUnsupported[], kind: string): void {
  const found = unsupported.find((u) => u.kind === kind);
  if (found) found.count += 1;
  else unsupported.push({ kind, count: 1 });
}

/**
 * Normalize one PineTS label snapshot. Returns `null` (after recording the
 * reason) when the label cannot be positioned faithfully — unknown xloc/yloc
 * would place the drawing at a WRONG location, and AURA never renders a
 * drawing at a location that changes its meaning.
 */
function normalizeLabel(
  raw: LabelSnapshotLike,
  klines: readonly PineLabelBar[],
  unsupported: PineDrawingUnsupported[],
): PineLabelDrawing | null {
  const x = asFinite(raw.x);
  const y = asFinite(raw.y);
  const xlocRaw = typeof raw.xloc === "string" ? raw.xloc : "";
  const ylocRaw = typeof raw.yloc === "string" ? raw.yloc : "";
  const xloc = XLOC_ALIASES[xlocRaw];
  const yloc = YLOC_ALIASES[ylocRaw];

  if (x === null || y === null) {
    bumpUnsupported(unsupported, 'label.new anchor "na"');
    return null;
  }
  if (!xloc) {
    bumpUnsupported(unsupported, `label.new xloc "${xlocRaw.slice(0, 24)}"`);
    return null;
  }
  if (!yloc) {
    bumpUnsupported(unsupported, `label.new yloc "${ylocRaw.slice(0, 24)}"`);
    return null;
  }

  // Style: unknown values fall back to Pine's documented default (reported).
  let style = PINE_DEFAULT_LABEL_STYLE;
  const styleRaw = typeof raw.style === "string" && raw.style.length > 0 ? raw.style : "style_label_down";
  if (STYLE_NAMES.has(styleRaw)) {
    style = (styleRaw === "style_none" ? "none" : styleRaw.replace(/^style_/, "")) as PineLabelStyleName;
  } else {
    bumpUnsupported(unsupported, `label.new style "${styleRaw.slice(0, 24)}"`);
  }

  // Size: unknown values fall back to Pine's documented default (reported).
  let size = PINE_DEFAULT_LABEL_SIZE;
  const sizeRaw = typeof raw.size === "string" && raw.size.length > 0 ? raw.size : "normal";
  if (SIZE_NAMES.has(sizeRaw)) {
    size = sizeRaw as PineLabelSizeName;
  } else {
    bumpUnsupported(unsupported, `label.new size "${sizeRaw.slice(0, 24)}"`);
  }

  const alignRaw = typeof raw.textalign === "string" ? raw.textalign : "center";
  const textalign = ALIGN_ALIASES[alignRaw] ?? "center";

  const logical = xloc === "bar_index" ? Math.trunc(x) : null;
  // For yloc.abovebar/belowbar the anchor bar is the label's pinned bar.
  const anchorIndex = xloc === "bar_index" ? Math.trunc(x) : barIndexForTime(x, klines);

  return {
    id: typeof raw.id === "number" && Number.isFinite(raw.id) ? raw.id : -1,
    // xloc.bar_time x is the Pine v6 `time` builtin — epoch MILLISECONDS in
    // PineTS 0.9.33 (verified by probe: equals the candle openTime in ms).
    timeMs: xloc === "bar_index" ? barIndexToTimeMs(Math.trunc(x), klines) : x,
    logical,
    price: resolveLabelPrice(yloc, y, anchorIndex, klines),
    text: typeof raw.text === "string" ? raw.text : "",
    xloc,
    yloc,
    color: asHexColor(raw.color),
    textcolor: asHexColor(raw.textcolor),
    style,
    size,
    textalign,
    forceOverlay: typeof raw.force_overlay === "boolean" ? raw.force_overlay : false,
  };
}

/**
 * Extract the label drawings from one PineTS run.
 *
 * @param rows the `data` array of `__labels__` / `__labels_overlay__` — one
 *        or more rows whose `value` is the live label snapshot array (PineTS
 *        currently syncs a single row carrying ALL live labels; per-bar rows
 *        are handled defensively).
 * @param klines the authoritative candle series of the SAME run (bar_index ↔
 *        openTime mapping + OHLC for yloc.abovebar/belowbar).
 */
export function extractLabelDrawings(rows: unknown, klines: readonly PineLabelBar[]): LabelExtractResult {
  const labels: PineLabelDrawing[] = [];
  const unsupported: PineDrawingUnsupported[] = [];
  if (!Array.isArray(rows) || klines.length === 0) return { labels, unsupported };
  const seen = new Set<number>();
  for (const row of rows) {
    const value = (row as { value?: unknown } | null)?.value;
    if (!Array.isArray(value)) continue;
    for (const raw of value) {
      if (raw === null || typeof raw !== "object") continue;
      const normalized = normalizeLabel(raw as LabelSnapshotLike, klines, unsupported);
      if (normalized && !seen.has(normalized.id)) {
        seen.add(normalized.id);
        labels.push(normalized);
      }
    }
  }
  return { labels, unsupported };
}

// ── Balloon geometry (pure — unit-testable, no canvas) ──────────────────────

/** Pre-computed balloon + pointer geometry in pixels (top-left origin, Y down). */
export interface LabelLayout {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Pointer triangle tip (sits ON the anchor point). */
  tipX: number;
  tipY: number;
  /** Pointer triangle base corners (on the balloon edge). */
  base1X: number;
  base1Y: number;
  base2X: number;
  base2Y: number;
  hasPointer: boolean;
}

/**
 * Lay out one label's balloon around an anchor point for the current viewport.
 * `textW`/`textH` come from the canvas context at draw time (measureText);
 * everything else is derived from the label's style + the AURA dark-UI size
 * table. Pure function: the renderer only draws what this returns.
 */
export function labelLayout(
  label: Pick<PineLabelDrawing, "style" | "size">,
  ax: number,
  ay: number,
  textW: number,
  textH: number,
): LabelLayout {
  const cfg = LABEL_SIZE_PX[label.size];
  const w = Math.max(textW + 2 * cfg.padX, 18);
  const h = textH + 2 * cfg.padY;
  const tip = cfg.tip;
  const dir = LABEL_POINTER[label.style];

  // Default: balloon centered on the anchor, no pointer (style_center / none).
  let left = ax - w / 2;
  let top = ay - h / 2;
  let right = ax + w / 2;
  let bottom = ay + h / 2;
  let tipX = ax;
  let tipY = ay;
  let base1X = ax;
  let base1Y = ay;
  let base2X = ax;
  let base2Y = ay;
  let hasPointer = true;

  switch (dir) {
    case "up":
      // Balloon ABOVE the anchor; pointer tip at anchor, base on balloon bottom.
      bottom = ay - tip;
      top = bottom - h;
      left = ax - w / 2;
      right = ax + w / 2;
      base1X = ax - tip;
      base1Y = bottom;
      base2X = ax + tip;
      base2Y = bottom;
      break;
    case "down":
      // Balloon BELOW the anchor; pointer tip at anchor, base on balloon top.
      top = ay + tip;
      bottom = top + h;
      left = ax - w / 2;
      right = ax + w / 2;
      base1X = ax - tip;
      base1Y = top;
      base2X = ax + tip;
      base2Y = top;
      break;
    case "left":
      // Balloon LEFT of the anchor; pointer tip at anchor, base on balloon right.
      right = ax - tip;
      left = right - w;
      top = ay - h / 2;
      bottom = ay + h / 2;
      base1X = right;
      base1Y = ay - tip;
      base2X = right;
      base2Y = ay + tip;
      break;
    case "right":
      left = ax + tip;
      right = left + w;
      top = ay - h / 2;
      bottom = ay + h / 2;
      base1X = left;
      base1Y = ay - tip;
      base2X = left;
      base2Y = ay + tip;
      break;
    case "lower_left":
      // Balloon down-left of the anchor; pointer from its top-right corner.
      right = ax - tip;
      left = right - w;
      top = ay + tip;
      bottom = top + h;
      base1X = right;
      base1Y = top + tip / 2;
      base2X = right - tip / 2;
      base2Y = top;
      break;
    case "lower_right":
      left = ax + tip;
      right = left + w;
      top = ay + tip;
      bottom = top + h;
      base1X = left;
      base1Y = top + tip / 2;
      base2X = left + tip / 2;
      base2Y = top;
      break;
    case "upper_left":
      right = ax - tip;
      left = right - w;
      bottom = ay - tip;
      top = bottom - h;
      base1X = right;
      base1Y = bottom - tip / 2;
      base2X = right - tip / 2;
      base2Y = bottom;
      break;
    case "upper_right":
      left = ax + tip;
      right = left + w;
      bottom = ay - tip;
      top = bottom - h;
      base1X = left;
      base1Y = bottom - tip / 2;
      base2X = left + tip / 2;
      base2Y = bottom;
      break;
    case "none":
    default:
      hasPointer = false;
      break;
  }

  return {
    left,
    top,
    right,
    bottom,
    tipX,
    tipY,
    base1X,
    base1Y,
    base2X,
    base2Y,
    hasPointer,
  };
}
// ── Color conversion (PineTS hex → canvas-compatible) ───────────────────────

/**
 * Convert a PineTS hex color (`#RGB`, `#RRGGBB`, `#RRGGBBAA`) to a canvas
 * `fillStyle` string. The 8-digit form (transparency) is expanded to
 * `rgba(...)` — the DOM canvas API does not accept `#RRGGBBAA`. Returns
 * `fallback` for empty/invalid input.
 */
export function pineHexToRgba(hex: string, fallback: string): string {
  if (typeof hex !== "string" || hex.length === 0) return fallback;
  const m = /^#([0-9a-f]{3})([0-9a-f])?([0-9a-f])?$/i.exec(hex);
  if (m) {
    // #RGB(A) — expand each nibble.
    const r = m[1]![0]! + m[1]![0]!;
    const g = m[1]![1]! + m[1]![1]!;
    const b = m[1]![2]! + m[1]![2]!;
    const a = (m[2] ?? "f") + (m[3] ?? "f");
    return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${Math.round((parseInt(a, 16) / 255) * 1000) / 1000})`;
  }
  const full = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!full) return fallback;
  if (!full[2]) return hex.toLowerCase(); // #RRGGBB is valid canvas syntax
  const r = parseInt(full[1]!.slice(0, 2), 16);
  const g = parseInt(full[1]!.slice(2, 4), 16);
  const b = parseInt(full[1]!.slice(4, 6), 16);
  const alpha = Math.round((parseInt(full[2], 16) / 255) * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}