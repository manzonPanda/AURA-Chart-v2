/**
 * @file PineTS indicator engine — a generic, framework-free adapter between
 * AURA's candle model and LuxAlgo's PineTS Pine Script® runtime.
 *
 * ── LICENSE ──────────────────────────────────────────────────────────────
 * PineTS (`pinets`) is dual-licensed: **AGPL-3.0-only** (free for personal /
 * research / internal use) and a paid **Commercial License** from LuxAlgo.
 * See `THIRD-PARTY-NOTICES.md`. AURA's intended use is personal/internal; the
 * AGPL copyleft only triggers if AURA is DISTRIBUTED to others or offered as a
 * network service (SaaS) — in that case AURA's full source must be released
 * under AGPL-3.0 OR a LuxAlgo commercial license must be purchased. This
 * integration is written as a normal client-side dependency — it neither
 * bypasses, obfuscates, nor works around any AGPL requirement.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Data flow (authoritative server truth ONLY — never the rAF "glide" close):
 *
 *   Supabase 1m/3m candles ─┐
 *   RealtimeCandleMsg (WS) ├→ effectiveCloseSeries() ─→ authoritative closes
 *                          ↓
 *                   PineIndicatorEngine.setCandles(bars, live, bucketSec)
 *                          ↓
 *               new PineTS(klines)  +  cached compiled Indicator  (ta.ema)
 *                          ↓
 *                    PinePoint[] { ts(ms), value }  ──→  EmaBridge → LWC LineSeries
 *
 * For 3m the caller passes the SELECTED timeframe's `bars`, so the 3m EMA is
 * calculated from 3m candles directly — never from the 1m EMA.
 *
 * Why this is cheap enough for a live chart:
 *  - the PineScript `Indicator` is compiled (transpiled) ONCE per distinct
 *    parameter set (EMA 9 and EMA 20 = two compiled instances, cached for the
 *    engine's life). PineTS bakes `input.*` values into the transpiled
 *    artifact at prepare() time, so a period switch maps to the other cached
 *    compiled instance — a per-frame run NEVER re-transpiles;
 *  - a PineTS runtime instance is rebuilt only when the authoritative candle
 *    series changes (signature guard); identical/rAF frames short-circuit;
 *  - results are memoized by (indicator, params, data-signature).
 *
 * Measured: ~9–12 ms a full recompute over 500 bars (two EMAs ~20 ms), against
 * AURA's pure `ema.ts` oracle at < 5e-9 — see tests/pineEquivalence.test.mjs.
 */
import { PineTS, Indicator } from "pinets";

// NOTE: local imports use explicit `.ts` extensions. The rest of `src/` is
// extensionless (resolved by Vite/tsc), but this module is imported through by
// AURA's Node-native `--experimental-strip-types` test runner, whose ESM
// resolver does NOT synthesize `.ts` for extensionless specifiers. Explicit
// extensions are accepted by both `tsc -b` (allowImportingTsExtensions) and the
// Vite build, so the production bundle and the tests stay green.
import {
  effectiveCloseSeries,
  type EmaSourceBar,
} from "./ema.ts";
import {
  PINE_INDICATORS,
  type PineIndicatorSpec,
  type PineInputBinding,
} from "./pineIndicators.ts";

export type { PineIndicatorSpec, PineInputBinding };

/** Minimal candle shape the engine consumes (a structural subtype of CandleKit `Bar`). */
export interface PineBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Authoritative forming candle arriving from the backend (epoch-second `time`). */
export interface PineLiveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** One engine-produced point — structurally identical to `EmaPoint` in ema.ts.
 *  `color` is present only when the script's plot color varies per bar. */
export interface PinePoint {
  ts: number;
  value: number;
  color?: string;
}

/** One extracted plot series (imported-indicator path). */
export interface PineSeries {
  /** `ctx.plots` key (the plot title, or "#N" for untitled plots). */
  key: string;
  /** Display title reported by PineTS. */
  title: string;
  points: PinePoint[];
  /** Script-declared linewidth when statically declared (undefined = default). */
  linewidth?: number;
  /** Uniform color when every point shares one (hex); per-point colors otherwise. */
  color?: string;
}

// ── Normalized AURA visual outputs (imported-script path) ───────────────────
//
// PineTS 0.9.33 exposes far more than plain lines in `ctx.plots` (verified by
// runtime probes — see README "AURA Pine Script Support"):
//
//   plot(x)                          → options {}                      (line)
//   plot(x, style=plot.style_line)   → options { style: "style_line" } (line)
//   plot(x, style=…stepline)         → options { style: "style_stepline" }
//   plot(x, style=…histogram/columns)→ options { style: "style_histogram" | "style_columns" }
//   plot(x, style=…area)             → options { style: "style_area" }
//   hline(price, …)                  → options { style: "hline", color, linestyle, linewidth }
//                                      with CONSTANT {time, value} rows
//   plotshape(cond, …)               → options { style: "shape", shape, location, color, text?, size? }
//                                      with per-bar boolean/numeric `value`
//   plotchar(cond, char="…")         → options { style: "char", char, location, color }
//   label.new / line.new / fill()    → internal `__labels__` / `__lines__` / `__linefills__` …
//                                      collectors whose rows carry drawing arrays
//   display=display.none             → plot options { display: "none" } (data still present)
//
// Every supported construct maps to one normalized `PineVisual`; everything
// else is reported in `PineRuntimeDiagnostics.unsupported` instead of being
// faked or silently dropped.

/** Visual kinds AURA can currently render for imported Pine scripts. */
export type PineVisualType = "line" | "histogram" | "area" | "horizontal" | "marker";

/** LWC-marker domain for Pine shapes/chars. */
export interface PineMarkerPoint {
  ts: number;
  position: "aboveBar" | "belowBar" | "inBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color?: string;
  /** Short label text (plotshape `text=` or plotchar `char=`), ≤ 24 chars. */
  text?: string;
}

/**
 * One normalized renderable output extracted from a PineTS run. `key` matches
 * the `ctx.plots` key so plot metadata (persisted) can be reconciled with
 * fresh runtime results.
 */
export type PineVisual =
  | {
      type: "line";
      key: string;
      title: string;
      color?: string;
      lineWidth?: number;
      /** `plot.style_stepline` → stepped rendering (LWC `LineType.WithSteps`). */
      stepLine: boolean;
      data: PinePoint[];
    }
  | { type: "histogram"; key: string; title: string; color?: string; data: PinePoint[] }
  | { type: "area"; key: string; title: string; color?: string; lineWidth?: number; data: PinePoint[] }
  | {
      type: "horizontal";
      key: string;
      title: string;
      /** Constant hline price. */
      price: number;
      color?: string;
      lineWidth?: number;
      lineStyle: "solid" | "dashed" | "dotted";
    }
  | { type: "marker"; key: string; title: string; data: PineMarkerPoint[] };

/** What one PineTS run produced / could NOT produce (runtime half of the import diagnostics). */
export interface PineRuntimeDiagnostics {
  rendered: { key: string; title: string; type: PineVisualType }[];
  /** Detected-but-unrenderable outputs (circles/cross styles, drawings, …). */
  unsupported: { kind: string; count: number }[];
  /** Plots the script itself hides via `display=display.none`. */
  hidden: number;
}

/** Pine shape ids → LWC marker shapes (unmapped shapes fall back to "circle"). */
const PINE_SHAPE_TO_MARKER: Record<string, PineMarkerPoint["shape"]> = {
  shape_triangleup: "arrowUp",
  shape_triangle_up: "arrowUp",
  shape_triangledown: "arrowDown",
  shape_triangle_down: "arrowDown",
  shape_arrowup: "arrowUp",
  shape_arrow_up: "arrowUp",
  shape_arrowdown: "arrowDown",
  shape_arrow_down: "arrowDown",
  shape_circle: "circle",
  shape_square: "square",
  shape_diamond: "square",
  shape_flag: "square",
  shape_labelup: "square",
  shape_label_up: "square",
  shape_labeldown: "square",
  shape_label_down: "square",
  shape_xcross: "square",
  shape_cross: "square",
};

/** Internal PineTS drawing-collector keys → human-readable unsupported kinds. */
const INTERNAL_PLOT_KIND: Record<string, string> = {
  __labels__: "label.new drawings",
  __lines__: "line.new drawings",
  __boxes__: "box.new drawings",
  __polylines__: "polyline drawings",
  __linefills__: "fill() fills",
  __tables__: "table drawings",
};

/** Ad-hoc indicator spec — the generic entry point for imported Pine scripts. */
export interface PineScriptSpec {
  /** Stable key used in cache identities (imported indicator id). */
  id: string;
  /** Raw Pine Script v5/v6 source. */
  source: string;
  /** `input.*` bindings: input title → key on the params object. */
  bindings: PineInputBinding[];
  /** Extract only these plot keys; omit/empty = extract every plain-line plot. */
  plotKeys?: string[];
}

/** A PineScript-compatible candle — the Kline shape PineTS expects for an array source. */
interface PineCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/** Tolerance that absorbs PineTS's 10-decimal `context.precision` rounding. */
export const PINE_EQUIVALENCE_TOL = 5e-9;

type PineParams = Record<string, unknown>;

interface CompiledIndicator {
  id: string;
  source: string;
  indicator: Indicator;
}

/** Extraction cap for the imported-script path (mirrors MAX_PLOT_SERIES_PER_INDICATOR). */
const MAX_SCRIPT_SERIES = 8;

/** A Pine `input.*()` binding resolved to its runtime `varId`. */
interface ResolvedInput {
  varId: string;
  title: string;
  paramKey: string;
}

/**
 * Build the authoritative, full-OHLCV candle series for PineTS from the
 * chart's closed bars + the forming WS candle, REUSING `effectiveCloseSeries`
 * so the close stream feeding `ta.ema` is byte-for-byte identical to ema.ts.
 *
 * Only the **close** drives an EMA; open/high/low/volume are carried so the
 * engine is generic enough for future OHLC-dependent indicators (atr, etc.)
 * without re-architecting the data path.
 */
function buildAuthoritativeSeries(
  bars: readonly PineBar[],
  live: PineLiveCandle | null,
  bucketSec: number,
): PineCandle[] {
  const bucketMs = bucketSec * 1000;
  const closes = effectiveCloseSeries(
    bars as readonly EmaSourceBar[],
    live ? { time: live.time, close: live.close } : null,
    bucketSec,
  );
  const byTs = new Map<number, PineBar>();
  for (const b of bars) byTs.set(b.ts, b);
  const liveBucketTs = live ? Math.floor((live.time * 1000) / bucketMs) * bucketMs : null;

  const out: PineCandle[] = [];
  for (const m of closes) {
    const bar = byTs.get(m.ts);
    if (live && liveBucketTs === m.ts) {
      out.push({ openTime: m.ts, open: live.open, high: live.high, low: live.low, close: m.close, volume: live.volume ?? 0, closeTime: m.ts + bucketMs });
    } else if (bar) {
      out.push({ openTime: bar.ts, open: bar.open, high: bar.high, low: bar.low, close: m.close, volume: bar.volume ?? 0, closeTime: bar.ts + bucketMs });
    } else {
      out.push({ openTime: m.ts, open: m.close, high: m.close, low: m.close, close: m.close, volume: 0, closeTime: m.ts + bucketMs });
    }
  }
  return out;
}

/**
 * Compact, exact fingerprint of the authoritative close stream. A cache hit
 * whenever the series is unchanged — so the engine never re-runs PineTS for a
 * stale/rAF frame that didn't move the authoritative close.
 *
 * FNV-1a over the precise `"ts,close"` text of every candle (no float
 * truncation) plus length and end-points, so a collision is practically
 * impossible.
 */
function dataSignature(series: readonly PineCandle[]): string {
  let h = 2166111748;
  for (let i = 0; i < series.length; i++) {
    const c = series[i];
    const s = `${c.openTime},${c.close}`;
    for (let j = 0; j < s.length; j++) {
      h = Math.imul(h ^ s.charCodeAt(j), 16777619);
    }
  }
  const first = series[0];
  const last = series[series.length - 1];
  return (
    `${series.length}|` +
    `f=${first?.openTime ?? 0}:${first?.close ?? 0}|` +
    `l=${last?.openTime ?? 0}:${last?.close ?? 0}|` +
    `h=${(h >>> 0).toString(36)}`
  );
}

function paramsSignature(params: PineParams): string {
  return JSON.stringify(params ?? {});
}

/** FNV-1a fingerprint of the source text — distinguishes edited scripts in cache keys. */
function sourceSignature(source: string): string {
  let h = 2166111748;
  for (let i = 0; i < source.length; i++) {
    h = Math.imul(h ^ source.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(36) + ":" + source.length.toString(36);
}

function resolveInputMeta(indicator: Indicator, bindings: PineInputBinding[]): ResolvedInput[] {
  const meta = (indicator.getInputsMeta() as Array<{ varId?: string; title?: string }>) ?? [];
  return bindings.map((b) => {
    const m = meta.find((x) => x.title === b.title);
    return { varId: m?.varId ?? b.title, title: b.title, paramKey: b.paramKey };
  });
}

/** Internal PineTS bookkeeping plots (`__labels__`, `__lines__`, …) — never rendered. */
function isInternalPlotKey(key: string): boolean {
  return key.startsWith("__");
}

/**
 * Read back plot series from a PineTS context, keeping ONLY plain `plot()`
 * lines: internal `__`-prefixed plots and styled non-line plots (plotshape →
 * "shape", hline → "hline", bgcolor → "background", …) are skipped — AURA
 * renders plot() lines only and never fakes the rest.
 *
 * Warmup `na()` rows are stripped (PineTS emits `null`/`NaN` before the first
 * seed). Per-point colors are preserved when the script computes them
 * dynamically; a uniform color collapses into `series.color`.
 * Returns series aligned to candle `openTime` (epoch ms).
 */
function extractSeries(
  ctx: { plots?: Record<string, { title?: string; options?: { style?: unknown; linewidth?: unknown }; data?: unknown[] }> } | undefined,
  plotKeys: readonly string[] | undefined,
  maxSeries: number,
): Map<string, PineSeries> {
  const out = new Map<string, PineSeries>();
  const wanted = plotKeys && plotKeys.length > 0 ? new Set(plotKeys) : null;
  if (!ctx?.plots) return out;
  for (const [key, plot] of Object.entries(ctx.plots)) {
    if (out.size >= maxSeries) break;
    if (isInternalPlotKey(key)) continue;
    if (wanted && !wanted.has(key)) continue;
    // Only plain line plots (style undefined) — documented AURA limitation.
    const style = plot?.options?.style;
    if (style !== undefined && style !== null) continue;
    const data = plot?.data;
    if (!Array.isArray(data)) continue;

    const points: PinePoint[] = [];
    let uniformColor: string | undefined;
    let dynamicColor = false;
    for (const d of data) {
      const v = (d as { value?: unknown; time?: unknown; options?: { color?: unknown } } | null)?.value;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const rawColor = (d as { options?: { color?: unknown } })?.options?.color;
      const color = typeof rawColor === "string" && rawColor.length > 0 ? rawColor : undefined;
      if (color) {
        if (uniformColor === undefined) uniformColor = color;
        else if (uniformColor !== color) dynamicColor = true;
      }
      points.push(dynamicColor ? { ts: (d as { time: number }).time, value: v, color } : { ts: (d as { time: number }).time, value: v });
    }
    if (points.length === 0 && wanted) continue; // requested key produced nothing
    const linewidthRaw = plot?.options?.linewidth;
    out.set(key, {
      key,
      title: typeof plot?.title === "string" && plot.title.length > 0 ? plot.title : key,
      points,
      ...(typeof linewidthRaw === "number" && Number.isInteger(linewidthRaw) ? { linewidth: clampLinewidth(linewidthRaw) } : {}),
      ...(!dynamicColor && uniformColor ? { color: uniformColor } : {}),
    });
  }
  return out;
}

/** LWC LineWidth domain (1–4). */
function clampLinewidth(w: number): number {
  return Math.max(1, Math.min(4, Math.round(w)));
}

/** Raw `ctx.plots` row: `{ title?, time, value, options?: { color? } }`. */
interface RawPlotRow {
  time?: unknown;
  value?: unknown;
  options?: { color?: unknown };
}

/** Raw `ctx.plots` entry options, as observed from PineTS 0.9.33. */
interface RawPlotOptions {
  style?: unknown;
  display?: unknown;
  color?: unknown;
  linewidth?: unknown;
  linestyle?: unknown;
  shape?: unknown;
  location?: unknown;
  text?: unknown;
  char?: unknown;
}

/**
 * Extract finite numeric values + per-point colors from raw plot rows.
 * `dynamic` is true when rows carry VARYING colors — in that case the caller
 * must NOT collapse anything into a uniform color (PineTS also stores the last
 * evaluated ternary color on plot-level `options.color`, which would lie).
 */
function rawRowsToPoints(data: unknown[]): { points: PinePoint[]; uniformColor?: string; dynamic: boolean } {
  const points: PinePoint[] = [];
  let uniformColor: string | undefined;
  let dynamicColor = false;
  for (const d of data as RawPlotRow[]) {
    const v = d?.value;
    if (typeof v !== "number" || !Number.isFinite(v)) continue; // warmup na() rows
    const rawColor = d?.options?.color;
    const color = typeof rawColor === "string" && rawColor.length > 0 ? rawColor : undefined;
    if (color) {
      if (uniformColor === undefined) uniformColor = color;
      else if (uniformColor !== color) dynamicColor = true;
    }
    points.push(dynamicColor ? { ts: d.time as number, value: v, color } : { ts: d.time as number, value: v });
  }
  return { points, uniformColor: dynamicColor ? undefined : uniformColor, dynamic: dynamicColor };
}

/** Map Pine location ids to LWC marker positions. */
function pineLocationToPosition(location: unknown): PineMarkerPoint["position"] {
  if (location === "AboveBar" || location === "abovebar") return "aboveBar";
  if (location === "BelowBar" || location === "belowbar") return "belowBar";
  return "inBar";
}

/** Shared option plumbing for data-driven visuals (line family). */
function lineFamilyColor(opts: RawPlotOptions, uniformColor?: string): { color?: string } | undefined {
  const c = uniformColor ?? (typeof opts.color === "string" && opts.color.length > 0 ? opts.color : undefined);
  return c ? { color: c } : {};
}

function clampOptionLinewidth(opts: RawPlotOptions): number | undefined {
  const w = opts.linewidth;
  return typeof w === "number" && Number.isInteger(w) ? clampLinewidth(w) : undefined;
}

/** Build a line/histogram/area visual from raw rows; null when no finite values. */
function buildDataVisual(
  style: "line" | "stepline" | "histogram" | "area",
  key: string,
  title: string,
  opts: RawPlotOptions,
  data: unknown[],
): PineVisual | null {
  const { points, uniformColor, dynamic } = rawRowsToPoints(data);
  if (points.length === 0) return null;
  // Dynamic per-row colors win; the plot-level options.color of a dynamic
  // plot only holds PineTS's last-evaluated ternary result — never use it.
  const color = dynamic ? undefined : lineFamilyColor(opts, uniformColor)?.color;
  const lineWidth = clampOptionLinewidth(opts);
  if (style === "histogram") {
    return { type: "histogram", key, title, ...(color ? { color } : {}), data: points };
  }
  if (style === "area") {
    return { type: "area", key, title, ...(color ? { color } : {}), ...(lineWidth ? { lineWidth } : {}), data: points };
  }
  return { type: "line", key, title, ...(color ? { color } : {}), ...(lineWidth ? { lineWidth } : {}), stepLine: style === "stepline", data: points };
}

/** Build a horizontal (hline) visual from raw rows; null when no finite price. */
function buildHorizontalVisual(
  key: string,
  title: string,
  opts: RawPlotOptions,
  data: unknown[],
): PineVisual | null {
  let price: number | null = null;
  let rowColor: string | undefined;
  for (const d of data as RawPlotRow[]) {
    const v = d?.value;
    if (typeof v === "number" && Number.isFinite(v)) {
      price = v; // hline rows repeat the constant price — the first wins
      const c = d?.options?.color;
      rowColor = typeof c === "string" && c.length > 0 ? c : undefined;
      break;
    }
  }
  if (price === null) return null;
  const color = lineFamilyColor(opts, rowColor);
  const lineWidth = clampOptionLinewidth(opts);
  const ls = typeof opts.linestyle === "string" ? opts.linestyle : "solid";
  return {
    type: "horizontal",
    key,
    title,
    price,
    ...color,
    ...(lineWidth ? { lineWidth } : {}),
    lineStyle: ls === "dotted" ? "dotted" : ls === "dashed" ? "dashed" : "solid",
  };
}

/** Build a marker visual (plotshape/plotchar) from raw rows; null when no signal bars. */
function buildMarkerVisual(
  key: string,
  title: string,
  opts: RawPlotOptions,
  data: unknown[],
  isChar: boolean,
): PineVisual | null {
  const shape: PineMarkerPoint["shape"] = isChar
    ? "circle"
    : PINE_SHAPE_TO_MARKER[typeof opts.shape === "string" ? opts.shape : ""] ?? "circle";
  const rawText = isChar ? opts.char : opts.text;
  const text = typeof rawText === "string" && rawText.length > 0 ? rawText.slice(0, 24) : undefined;
  const position = pineLocationToPosition(opts.location);
  const points: PineMarkerPoint[] = [];
  for (const d of data as RawPlotRow[]) {
    const v = d?.value;
    // plotshape emits boolean (true → show) or numeric/na; only truthy finite
    // values become markers — false/na bars stay clean.
    const on = v === true || (typeof v === "number" && Number.isFinite(v) && v !== 0);
    if (!on) continue;
    const c = d?.options?.color;
    const rowColor = typeof c === "string" && c.length > 0 ? c : undefined;
    const color = lineFamilyColor(opts, rowColor);
    points.push({ ts: d.time as number, position, shape, ...color, ...(text ? { text } : {}) });
  }
  if (points.length === 0) return null;
  return { type: "marker", key, title, data: points };
}

/**
 * Extract ALL renderable `PineVisual`s from one PineTS context plus runtime
 * diagnostics. Used by the imported-script path (the registry path keeps
 * `extractSeries`/`extractPoints` untouched).
 *
 * Supported → line / stepline / histogram / columns / area / hline /
 * plotshape / plotchar. Explicit `plot.style_line` IS a plain line (an earlier
 * filter incorrectly dropped styled plots — real-world scripts declare
 * styles). `display=display.none` plots are skipped as "hidden" (the author's
 * choice, not an incompatibility). Internal `__`-collectors surface as
 * unsupported kinds ONLY when they actually carry drawings. Nothing valid is
 * ever dropped silently — unrecognized constructs land in
 * `diagnostics.unsupported`.
 */
export function extractVisuals(
  ctx: { plots?: Record<string, { title?: unknown; options?: RawPlotOptions; data?: unknown[] }> } | undefined,
  maxVisuals: number,
): { visuals: PineVisual[]; diagnostics: PineRuntimeDiagnostics } {
  const visuals: PineVisual[] = [];
  const diagnostics: PineRuntimeDiagnostics = { rendered: [], unsupported: [], hidden: 0 };
  const unsupportedFor = (kind: string): void => {
    const found = diagnostics.unsupported.find((u) => u.kind === kind);
    if (found) found.count += 1;
    else diagnostics.unsupported.push({ kind, count: 1 });
  };
  if (!ctx?.plots) return { visuals, diagnostics };

  for (const [key, plot] of Object.entries(ctx.plots)) {
    // Internal drawing collectors — count only when drawings were actually used.
    if (isInternalPlotKey(key)) {
      const rows = Array.isArray(plot?.data) ? plot.data : [];
      let used = 0;
      for (const r of rows as Array<{ value?: unknown } | null>) {
        const v = r?.value;
        if (Array.isArray(v)) used += v.length;
        else if (v !== null && v !== undefined && typeof v !== "boolean") used += 1;
      }
      if (used > 0) unsupportedFor(INTERNAL_PLOT_KIND[key] ?? "drawings");
      continue;
    }
    if (visuals.length >= maxVisuals) break;

    const opts: RawPlotOptions = plot?.options ?? {};
    const data = Array.isArray(plot?.data) ? plot.data : [];
    const title = typeof plot?.title === "string" && plot.title.length > 0 ? plot.title : key;

    // The author explicitly hid this plot — respect it, note it, render nothing.
    if (opts.display === "none") {
      diagnostics.hidden += 1;
      continue;
    }

    const style = typeof opts.style === "string" ? opts.style : undefined;
    let built: PineVisual | null = null;
    switch (style) {
      case undefined:
      case "style_line":
      case "line":
        built = buildDataVisual("line", key, title, opts, data);
        break;
      case "style_stepline":
      case "stepline":
        built = buildDataVisual("stepline", key, title, opts, data);
        break;
      case "style_histogram":
      case "style_columns":
      case "histogram":
      case "columns":
        built = buildDataVisual("histogram", key, title, opts, data);
        break;
      case "style_area":
      case "area":
        built = buildDataVisual("area", key, title, opts, data);
        break;
      case "hline":
        built = buildHorizontalVisual(key, title, opts, data);
        break;
      case "shape":
        built = buildMarkerVisual(key, title, opts, data, false);
        break;
      case "char":
        built = buildMarkerVisual(key, title, opts, data, true);
        break;
      case "background":
        unsupportedFor("bgcolor()");
        break;
      case "label":
      case "table":
      case "linefill":
        // Internal-collector equivalents — counted under their `__` keys instead.
        break;
      default:
        // plot.style_circles / plot.style_cross / anything new — never faked.
        unsupportedFor(`plot style "${style}"`);
        break;
    }
    if (built) visuals.push(built);
  }

  for (const v of visuals) diagnostics.rendered.push({ key: v.key, title: v.title, type: v.type });
  return { visuals, diagnostics };
}

/**
 * Registry-path extraction (single plot key) — the EMA 9/20 compatibility
 * shim. Returns colorless points so the equivalence oracle contract is
 * byte-identical to the pre-import engine.
 */
function extractPoints(ctx: { plots?: Record<string, { data?: unknown[] }> } | undefined, plotKey: string): PinePoint[] {
  const data = ctx?.plots?.[plotKey]?.data;
  if (!Array.isArray(data)) return [];
  const out: PinePoint[] = [];
  for (const d of data) {
    const v = (d as { value?: unknown } | null)?.value;
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push({ ts: (d as { time: number }).time, value: v });
    }
  }
  return out;
}

/**
 * Generic adapter over the PineTS runtime.
 *
 * Lifetime: one engine per indicator context, held for the chart's life
 * (see EmaBridge). Per-(indicator, params) `Indicator` objects (compiled Pine
 * Script) are cached and REUSED across runs — a period switch maps to the
 * other cached compiled instance, it does NOT re-transpile. A `PineTS` runtime
 * instance is rebuilt only when
 * the authoritative candle series genuinely changes; results are memoized by
 * (indicator, params, data-signature), so identical inputs never re-run.
 */
export class PineIndicatorEngine {
  private pine: PineTS | null = null;
  private klines: PineCandle[] = [];
  private dataSig: string | null = null;
  private readonly compiled = new Map<string, CompiledIndicator>();
  private readonly resultCache = new Map<string, PinePoint[]>();
  private readonly scriptCache = new Map<string, Map<string, PineSeries>>();
  private readonly scriptVisualsCache = new Map<string, { visuals: PineVisual[]; diagnostics: PineRuntimeDiagnostics }>();
  private warned = false;

  /**
   * Feed the engine its current authoritative candle series. `bars`,
   * `liveCandle` and `bucketSec` come straight from the chart truth path; the
   * rAF glide is never involved. No-op when the series is unchanged.
   */
  setCandles(
    bars: readonly PineBar[],
    liveCandle: PineLiveCandle | null,
    bucketSec: number,
  ): void {
    const klines = buildAuthoritativeSeries(bars, liveCandle, bucketSec);
    const sig = dataSignature(klines);
    if (sig === this.dataSig && this.pine !== null) {
      // Authoritative close stream unchanged — keep the existing PineTS instance
      // and all cached results (guards against rAF/stale/redundant re-renders).
      this.klines = klines;
      return;
    }
    this.klines = klines;
    this.dataSig = sig;
    // New runtime over the new series. Compiled `Indicator`s are reused across
    // instances — only the runtime data view changes here.
    this.pine = new PineTS(this.klines as unknown as PineCandle[], undefined, undefined);
    this.resultCache.clear();
    this.scriptCache.clear();
    this.scriptVisualsCache.clear();
  }

  /**
   * Compute one REGISTRY indicator/parameters combination (EMA 9/20 built-ins).
   *
   * Returns `{ts, value}` points with warmup rows stripped. Returns `null` for
   * insufficient history or engine failure so the caller can fall back to the
   * ema.ts oracle.
   */
  async compute(indicatorId: string, params: PineParams = {}): Promise<PinePoint[] | null> {
    const spec = PINE_INDICATORS[indicatorId];
    if (!spec) {
      this.warn(`unknown indicator "${indicatorId}"`);
      return null;
    }
    // No data yet — insufficient history (mirrors ema.ts returning []).
    if (this.pine === null || this.klines.length === 0 || this.dataSig === null) {
      return null;
    }

    const cacheKey = `${indicatorId}|${sourceSignature(spec.source)}|${this.dataSig}|${paramsSignature(params)}`;
    const cached = this.resultCache.get(cacheKey);
    if (cached) return cached;

    const compiled = this.getCompiled(spec, params);

    let ctx: { plots?: Record<string, { data?: unknown[] }> } | undefined;
    try {
      ctx = (await this.pine.run(compiled.indicator, this.klines.length)) as any;
    } catch (e: any) {
      this.warn(`PineTS run failed for "${indicatorId}": ${e?.message ?? e}`);
      return null;
    }

    const pts = extractPoints(ctx, spec.plotKey);
    this.resultCache.set(cacheKey, pts);
    return pts;
  }

  /**
   * Compute an AD-HOC script (imported Pine indicator) and extract ALL of its
   * plain-line `plot()` series in ONE runtime pass.
   *
   * Same caching/compilation discipline as `compute` — compiled artifacts are
   * keyed by (id, source fingerprint, params) and results by (…, data
   * signature) — so an unchanged candle stream never re-runs and unchanged
   * inputs never re-transpile.
   *
   * Returns `null` for "no data yet" (not an error) or a run failure. Failures
   * are reported via `onError` with the RAW message (callers map it through
   * friendlyPineError for the UI; stack traces stay in the console).
   * `onContext` reports the resolved `indicator()` declaration info.
   */
  async computeScript(
    spec: PineScriptSpec,
    params: PineParams = {},
    onError?: (message: string) => void,
    onContext?: (info: { overlay?: boolean; title?: string }) => void,
  ): Promise<Map<string, PineSeries> | null> {
    if (this.pine === null || this.klines.length === 0 || this.dataSig === null) {
      return null;
    }

    const cacheKey = `${spec.id}|${sourceSignature(spec.source)}|${this.dataSig}|${paramsSignature(params)}`;
    const cached = this.scriptCache.get(cacheKey);
    if (cached) return cached;

    const compiled = this.getCompiled(spec, params);

    let ctx: any;
    try {
      ctx = await this.pine.run(compiled.indicator, this.klines.length);
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[PineIndicatorEngine] imported script "${spec.id}" failed:`, e);
      onError?.(msg);
      return null;
    }

    try {
      if (onContext && ctx?.indicator) {
        onContext({ overlay: ctx.indicator.overlay, title: ctx.indicator.title });
      }
    } catch {
      /* context info is best-effort only */
    }

    const series = extractSeries(ctx, spec.plotKeys, MAX_SCRIPT_SERIES);
    this.scriptCache.set(cacheKey, series);
    return series;
  }

  /**
   * Compute an AD-HOC script (imported Pine indicator) and extract ALL of its
   * renderable `PineVisual`s (lines, histograms, areas, hlines, plotshape/
   * plotchar markers) in ONE runtime pass — the generalized successor of the
   * line-only `computeScript`, sharing the exact same compilation + caching
   * discipline (compiled artifacts keyed by (id, source, params); results by
   * (…, data signature)). `computeScript` remains for compatibility with the
   * existing line-path callers/tests.
   *
   * Returns `null` for "no data yet" (not an error) or a run failure. Failures
   * are reported via `onError` with the RAW message (callers map it through
   * friendlyPineError for the UI; stack traces stay in the console).
   * `onContext` reports the resolved `indicator()` declaration info.
   */
  async computeScriptVisuals(
    spec: PineScriptSpec,
    params: PineParams = {},
    onError?: (message: string) => void,
    onContext?: (info: { overlay?: boolean; title?: string }) => void,
  ): Promise<{ visuals: PineVisual[]; diagnostics: PineRuntimeDiagnostics } | null> {
    if (this.pine === null || this.klines.length === 0 || this.dataSig === null) {
      return null;
    }

    const cacheKey = `${spec.id}|${sourceSignature(spec.source)}|${this.dataSig}|${paramsSignature(params)}`;
    const cached = this.scriptVisualsCache.get(cacheKey);
    if (cached) return cached;

    const compiled = this.getCompiled(spec, params);

    let ctx: any;
    try {
      ctx = await this.pine.run(compiled.indicator, this.klines.length);
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[PineIndicatorEngine] imported script "${spec.id}" failed:`, e);
      onError?.(msg);
      return null;
    }

    try {
      if (onContext && ctx?.indicator) {
        onContext({ overlay: ctx.indicator.overlay, title: ctx.indicator.title });
      }
    } catch {
      /* context info is best-effort only */
    }

    const result = extractVisuals(ctx, MAX_SCRIPT_SERIES);
    this.scriptVisualsCache.set(cacheKey, result);
    return result;
  }

  /**
   * Lazily compile + cache a PineScript `Indicator` per (id, source, params)
   * combination. PineTS bakes `input.*` overrides into the transpiled
   * artifact at `prepare()` time, so parameters are bound BEFORE the first
   * transpile — after which the artifact is immutable. Each distinct
   * parameter set therefore transpiles exactly once per engine and is reused
   * forever (a period switch flips to the other cached instance; per-frame
   * runs never re-transpile).
   */
  private getCompiled(
    identity: { id: string; source: string; bindings: PineInputBinding[] },
    params: PineParams,
  ): CompiledIndicator {
    // Keyed by id + source fingerprint + params signature: an edited script
    // (same id) maps to a fresh compile instead of a stale artifact.
    const key = `${identity.id}|${sourceSignature(identity.source)}|${paramsSignature(params)}`;
    let c = this.compiled.get(key);
    if (!c) {
      const indicator = new Indicator(identity.source);
      for (const m of resolveInputMeta(indicator, identity.bindings)) {
        const value = params[m.paramKey];
        if (value === undefined) continue;
        try {
          // `.input` is a frozen proxy keyed by varId; individual key writes
          // register the override PineTS bakes in at prepare() time.
          (indicator.input as Record<string, unknown>)[m.varId] = value;
        } catch {
          /* unknown/frozen input — PineScript defval is used */
        }
      }
      indicator.prepare(); // idempotent transpile — bakes the bound inputs
      c = { id: identity.id, source: identity.source, indicator };
      this.compiled.set(key, c);
    }
    return c;
  }

  private warn(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[PineIndicatorEngine] ${msg}`);
  }

  /** Release runtime + cached artifacts. Safe to call on chart teardown. */
  dispose(): void {
    this.compiled.clear();
    this.resultCache.clear();
    this.scriptCache.clear();
    this.scriptVisualsCache.clear();
    this.pine = null;
    this.klines = [];
    this.dataSig = null;
  }
}


