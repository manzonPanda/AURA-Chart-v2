/**
 * Piner core — the pure, worker-safe adapter between the @heyphat/piner engine
 * and AURA's `PineVisual` rendering model.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Architecture (docs/pine-migration.md):
 *
 *   compiled cache → Engine(new ArrayFeed(bars)).run(opts)
 *                  → outputs (plots / markers / hlines) + drawings
 *                  → THIS module maps them into AURA's `PineVisual[]` — so
 *                    PineBridge's LWC renderer, primitives and replay/history
 *                    behavior are unchanged.
 *
 * Everything here is pure data-in/data-out (no DOM, no React) so it runs
 * identically in a Web Worker, in Node tests, and in the in-thread fallback.
 *
 * Verified Piner 0.13.0 semantics (probes tests/probe-piner*.mjs):
 *   • `time` builtin + `xloc.bar_time` anchors are epoch MILLISECONDS.
 *   • Plot rows: `data: number[]` aligned to feed bars; per-bar `colors[]`
 *     (TV hex #RRGGBBAA, empty when the plot has no color); options carry
 *     `style` ("stepline"|"histogram"|"area"|"columns", unprefixed) and
 *     `linewidth`.
 *   • Markers: one series per plotshape/plotchar with per-bar rows — null
 *     when off, `{ color, text }` overrides when on; series carries
 *     kind/location/glyph.
 *   • hlines: `{ id, price, title }` only — color/linestyle are NOT exposed
 *     in 0.13.0 (documented limitation → AURA renderer defaults).
 *   • Drawings: live `DrawObject[]` `{ id, type: "label"|"line"|"box", props }`
 *     with TV-hex colors, unprefixed style enums ("label_down", "dashed"),
 *     `force_overlay`, and deletes already filtered. Props omit fields left
 *     at their Pine defaults — the pineDrawings normalizers apply exactly
 *     those defaults.
 *   • `run()` is deterministic over the feed slice → replay/history safety is
 *     inherited from the slice AURA hands the engine (no future bars).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { compile, Engine, ArrayFeed } from "@heyphat/piner";

import { resolveMintickForRun } from "./pineMintick.ts";
import { normalizeSourceInputs } from "./pineSourceInputs.ts";
import {
  extractBoxDrawings,
  extractLabelDrawings,
  extractLineDrawings,
  PINE_SHAPE_TO_MARKER,
  pineMarkerPosition,
  type PineBoxDrawing,
  type PineLabelBar,
  type PineLabelDrawing,
  type PineLineDrawing,
} from "./pineDrawings.ts";
import type { PineCandle } from "./pineSeries.ts";
// TYPE-ONLY imports from the engine types module — these are engine-neutral
// contracts shared with the engine boundary module (pineEngineTypes.ts) —
// type-only, erased at build time, so the worker bundle stays engine-only.
import type {
  PineFillPoint,
  PineLinePoint,
  PineMarkerPoint,
  PinePoint,
  PineRuntimeDiagnostics,
  PineSymbolMeta,
  PineVisual,
  PineVisualType,
} from "./pineEngineTypes.ts";

/** Extraction cap for the imported-script path (mirrors MAX_SCRIPT_SERIES). */
// The default visual budget. Piner 0.13.0 exposes the aggregate `outputs.plots`
// map in declaration order, and AURA's bridge consumes it via this bounded loop.
// `fractal_SMA.pine` is a merged script that declares SMA + Bollinger plots AND
// twelve Up / twelve Down fractal line-br plots per side, so the budget must
// cover all of them simultaneously or the fractal levels are silently dropped by
// the bounded loop below. The two EMA plots added to that script brought the
// declared footprint (30 plots + the trailing Bollinger fill) to 31, so the
// budget was raised from 30 to 32 — a power-of-two margin that also matches the
// sibling `MAX_PLOT_SERIES_PER_INDICATOR` / `MAX_PINE_INPUTS` / `MAX_STYLE_KEYS`
// caps so the two budgets stay in agreement and nothing is dropped between the
// engine and the persisted indicator. This is a deliberate, explicit increase
// tied to a measured script footprint — NOT a blind global raise: the constant
// stays private and is only ever consulted through `maxVisuals` in this module.
export const PINER_MAX_VISUALS = 32;

/**
 * Sentinel-magnitude guard for script-produced PLOT values.
 *
 * ROOT CAUSE (AURA price-scale explosion, the TV ±11-billion class): the right
 * price scale's auto-fit unions every visible series' data range. Audited
 * contributors — candles, EMA/SMA, the marker/hline carrier (candle closes) —
 * are legit; Pine DRAWINGS (lines/boxes/labels, killzones/macros) render via
 * canvas primitives with no `autoscaleInfo`, hlines → LWC custom price lines
 * and plotshape/plotchar markers are excluded by Lightweight Charts, and
 * `display=display.none` plots never reach a series. The ONE script-controlled
 * autoscale input is therefore the plot-series values below — finite-checked
 * but, before this guard, magnitude-unchecked.
 *
 * AURA runs Piner, whose warmup/na semantics differ from TradingView's runtime,
 * so a script carrying the ±1e10 sentinel class (as this script family
 * demonstrably did) can still emit huge FINITE values where TV emits `na` —
 * and a single such value dominates the union, compressing candles to a
 * hairline. |v| ≤ 1e9 sits four-plus orders above any legitimate instrument
 * price (Gold ~4.4e3, DAX ~2.4e4, BTC ~1.2e5) and far below the ±1e9+ sentinel
 * class, so autoscaling stays fully dynamic below the ceiling while
 * sentinel-class values are dropped exactly like the warmup `na` rows beside
 * which this guard lives. NOT a fixed price range — the envelope of candles +
 * legitimate indicators is untouched.
 */
export const PINE_VALUE_SANITY_LIMIT = 1e9;

/** The opaque compiled-script handle Piner returns from `compile()`. */
export type PinerCompiled = ReturnType<typeof compile>;

/** Bucket size (seconds) → Pine `timeframe.period` string ("1", "3", "45S"). */
export function pineTimeframeStr(bucketSec: number): string {
  if (!Number.isFinite(bucketSec) || bucketSec <= 0) return "1";
  if (bucketSec < 60) return `${bucketSec}S`;
  if (bucketSec % 60 === 0) return `${bucketSec / 60}`;
  return `${bucketSec}S`;
}

/** Compile a Pine source with Piner. Throws on syntax/semantic errors. */
export function pinerCompile(source: string): PinerCompiled {
  // Normalize the generic `input(<ohlc-series>)` source form to the explicit
  // `input.source(<ohlc-series>)` form BEFORE compiling, so Piner classifies it
  // as a source (not a float) and resolves price-source overrides at runtime.
  // See pineSourceInputs.ts for the full root cause. Metadata-only callers get
  // the same normalization (compileImportedPine applies it too), so the Inputs
  // tab's control type and the executed math always agree.
  return compile(normalizeSourceInputs(source));
}

/** Extract `input.*` titles from a compiled script (binding keys). */
export function pinerInputTitles(compiled: PinerCompiled): string[] {
  const inputs = (compiled.metadata as { inputs?: unknown }).inputs;
  if (!Array.isArray(inputs)) return [];
  const titles: string[] = [];
  for (const i of inputs) {
    const key = (i as { key?: unknown } | null)?.key;
    if (typeof key === "string" && key.length > 0) titles.push(key);
  }
  return titles;
}

/**
 * Run one compiled script over the authoritative candle slice and map the
 * results into AURA's `PineVisual[]` + diagnostics — the visual contract
 * PineBridge renders.
 *
 * `onStage` reports the REAL boundaries around the run/extract split. No
 * timers, no fake percentages.
 */
export async function pinerRunVisuals(args: {
  compiled: PinerCompiled;
  klines: readonly PineCandle[];
  /** Resolved params keyed by INPUT TITLE (the facade re-keys via bindings). */
  inputs?: Record<string, unknown>;
  symbol?: PineSymbolMeta | null;
  bucketSec: number;
  onStage?: (stage: "executing" | "extracting") => void;
  maxVisuals?: number;
}): Promise<{
  visuals: PineVisual[];
  diagnostics: PineRuntimeDiagnostics;
  overlay: boolean;
  title: string;
  runMs: number;
}> {
  const { compiled, klines, inputs, symbol, bucketSec, onStage } = args;
  const maxVisuals = args.maxVisuals ?? PINER_MAX_VISUALS;
  const visuals: PineVisual[] = [];
  // `declared` = every output the script declares (plots/hlines/fills), even
  // ones that produce no finite values in THIS window. It drives the Style tab
  // (via the persisted plotMeta) so a conditional / warmup-only output still
  // exposes its style controls — see PineRuntimeDiagnostics.declared.
  const declaredKeys = new Set<string>();
  const diagnostics: PineRuntimeDiagnostics = { rendered: [], declared: [], unsupported: [], hidden: 0 };
  const unsupportedFor = (kind: string): void => {
    const found = diagnostics.unsupported.find((u) => u.kind === kind);
    if (found) found.count += 1;
    else diagnostics.unsupported.push({ kind, count: 1 });
  };
  const meta = compiled.metadata as { overlay?: boolean; title?: string } | undefined;
  const overlay = !!meta?.overlay;
  const title = String(meta?.title ?? "");
  if (klines.length === 0) {
    return { visuals, diagnostics, overlay, title, runMs: 0 };
  }

  // Piner feed bars: `{ time (epoch ms), open, high, low, close, volume }`.
  const bars = klines.map((k) => ({
    time: k.openTime,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
  }));
  const engine = new Engine(compiled, new ArrayFeed(bars), {
    backend: "js",
    ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
  });
  onStage?.("executing");
  const t0 = performance.now();
  // `run()` is ASYNC in Piner 0.13.0 — outputs populate only after it settles.
  await engine.run({
    symbol: symbol?.tickerid?.length ? symbol.tickerid : "AURA:SYNTH",
    timeframe: pineTimeframeStr(bucketSec),
    mintick: resolveMintickForRun(symbol, klines),
  });
  const runMs = performance.now() - t0;
  onStage?.("extracting");

  // ── ts resolution ─────────────────────────────────────────────────────────
  // Piner stores a plot's value at the bar that COMPUTES it (`data[i]`, indexed
  // by computation bar). Pine's `offset=n` then DRAWS that value at display bar
  // `i + n` (offset=-n shifts the series left, i.e. earlier in time). AURA feeds
  // Lightweight Charts, which requires STRICTLY ASCENDING, UNIQUE timestamps —
  // so a value whose display bar falls outside `[0, klines.length)` must be
  // DROPPED (it is shifted off the edge), never clamped onto a neighbour bar
  // (clamping collides several source bars onto one timestamp and LWC silently
  // refuses the whole series). Returns -1 when the display bar is off-range.
  const displayIndex = (i: number, plotOffset = 0): number => {
    const d = i + plotOffset;
    return d >= 0 && d < klines.length ? d : -1;
  };

  // ── plots → line / stepline / histogram / area visuals ────────────────────
  let dataVisuals = 0;
  for (const [, p] of engine.outputs.plots) {
    if (dataVisuals >= maxVisuals) break;
    const opts = (p.options ?? {}) as { style?: unknown; linewidth?: unknown; display?: unknown; offset?: unknown };
    const plotOffset = typeof opts.offset === "number" ? opts.offset : 0;
    const colors = Array.isArray(p.colors) ? (p.colors as unknown[]) : [];
    let uniform: string | undefined;
    let dynamic = false;
    for (const c of colors) {
      if (typeof c !== "string" || c.length === 0) continue;
      if (uniform === undefined) uniform = c;
      else if (uniform !== c) dynamic = true;
    }
    // Style is resolved BEFORE the rows so `style_linebr` can preserve its na
    // bars. Piner 0.13.0 encodes Pine `na` as `NaN` in `data[]` (probe:
    // tests/probe-linebr.mjs) — indistinguishable from a sentinel value, which
    // is why every style historically DROPPED them and the gap silently closed.
    const style = typeof opts.style === "string" ? opts.style : "line";
    const breaksOnNa = style === "linebr";
    const lineWidth =
      typeof opts.linewidth === "number" && Number.isInteger(opts.linewidth)
        ? Math.max(1, Math.min(4, opts.linewidth))
        : undefined;
    const color = dynamic ? undefined : uniform;
    // Keys follow the title-keyed contract (key = plot title, so
    // persisted plotMeta reconciles across runs); untitled → stable plot:N.
    const plotTitle = typeof p.title === "string" && p.title.length > 0 ? p.title : `plot:${p.id}`;
    const key = plotTitle;
    // ── DECLARED (Style tab) capture ────────────────────────────────────────
    // Recorded BEFORE the display=none / valued===0 drops below, so a
    // conditionally-plotted or warmup-only output still exposes its style
    // controls — the SMA/Bollinger bands + their fill in fractal_SMA.pine, or a
    // fractal level that hasn't triggered in the current window. Only styles
    // that map to a renderable visual type are declared; circles / cross stay
    // in `unsupported`. Deduped by key so an untitled plot:N never collides.
    const declaredType: PineVisualType | undefined =
      style === "stepline" || style === "linebr" || style === "line" ? "line"
      : style === "histogram" || style === "columns" ? "histogram"
      : style === "area" ? "area"
      : undefined;
    if (declaredType && !declaredKeys.has(key)) {
      declaredKeys.add(key);
      diagnostics.declared.push({ key, title: plotTitle, type: declaredType, ...(color ? { color } : {}), ...(lineWidth ? { lineWidth } : {}) });
    }
    if (opts.display === "none") {
      diagnostics.hidden += 1;
      continue;
    }
    // `points` = today's behaviour for EVERY current style (na dropped, so a
    // gap collapses). `breaks` additionally keeps each na bar as a value-less
    // WHITESPACE row and is used ONLY by style_linebr. Building both keeps the
    // other five styles provably unchanged.
    const points: PinePoint[] = [];
    const breaks: PineLinePoint[] = [];
    let valued = 0;
    for (let i = 0; i < p.data.length && i < klines.length; i++) {
      const v = p.data[i];
      const c = colors[i];
      const perBarColor = dynamic && typeof c === "string" && c.length > 0 ? c : undefined;
      // Resolve the DISPLAY bar for this computation index under the plot offset.
      // Off-edge values (shifted past either end by `offset`) are dropped, not
      // clamped — see `displayIndex` above. Without this, an offset plot piles
      // several source values onto one timestamp and LWC refuses the series.
      const di = displayIndex(i, plotOffset);
      if (di < 0) continue;
      const rowTs = klines[di]!.openTime;
      // Warmup na rows AND sentinel-magnitude values (±1e10-class) are both
      // dropped here — see PINE_VALUE_SANITY_LIMIT for the autoscale rationale.
      if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= PINE_VALUE_SANITY_LIMIT) {
        const row: PinePoint = { ts: rowTs, value: v, ...(perBarColor ? { color: perBarColor } : {}) };
        points.push(row);
        breaks.push(row);
        valued += 1;
        continue;
      }
      if (breaksOnNa) {
        // Pine `plot.style_linebr`: KEEP the bar as a value-less WHITESPACE
        // row. Lightweight Charts renders no line across it, so bar i-1 is
        // never connected to bar i+1 — the real Pine line-break semantics.
        breaks.push({ ts: rowTs, ...(perBarColor ? { color: perBarColor } : {}) });
      }
    }
    if (valued === 0) continue; // warmup-only / all-na plot — nothing to draw
    if (style === "stepline") {
      visuals.push({ type: "line", key, title: plotTitle, ...(color ? { color } : {}), ...(lineWidth ? { lineWidth } : {}), stepLine: true, data: points });
    } else if (breaksOnNa) {
      // Pine `plot.style_linebr` — a plain LWC line whose na bars are REAL
      // whitespace rows, so the renderer breaks the line instead of joining
      // across the gap. Deliberately NOT folded into the `style` arm below:
      // aliasing it to style_line would silence the diagnostic while
      // producing visually incorrect Pine behaviour. Everything else about the
      // plot (key/title/color/lineWidth/visibility/offset) is untouched.
      visuals.push({ type: "line", key, title: plotTitle, ...(color ? { color } : {}), ...(lineWidth ? { lineWidth } : {}), stepLine: false, breakOnNa: true, data: breaks });
    } else if (style === "histogram" || style === "columns") {
      visuals.push({ type: "histogram", key, title: plotTitle, ...(color ? { color } : {}), data: points });
    } else if (style === "area") {
      visuals.push({ type: "area", key, title: plotTitle, ...(color ? { color } : {}), ...(lineWidth ? { lineWidth } : {}), data: points });
    } else if (style === "line") {
      visuals.push({ type: "line", key, title: plotTitle, ...(color ? { color } : {}), ...(lineWidth ? { lineWidth } : {}), stepLine: false, data: points });
    } else {
      // plot.style_circles / cross / anything new — never faked.
      unsupportedFor(`plot style "${style}"`);
      continue;
    }
    dataVisuals += 1;
  }

  // ── plotshape / plotchar markers ──────────────────────────────────────────
  for (const [, m] of engine.outputs.markers) {
    const kind = (m as { kind?: unknown }).kind;
    const location = (m as { location?: unknown }).location;
    const glyph = (m as { glyph?: unknown }).glyph;
    const position = pineMarkerPosition(location);
    const shape: PineMarkerPoint["shape"] =
      kind === "char" ? "circle" : PINE_SHAPE_TO_MARKER[typeof glyph === "string" ? glyph : ""] ?? "circle";
    const rows = Array.isArray((m as { data?: unknown }).data) ? (m as { data: unknown[] }).data : [];
    const points: PineMarkerPoint[] = [];
    for (let i = 0; i < rows.length && i < klines.length; i++) {
      const row = rows[i];
      if (row === null || row === undefined) continue;
      const r = row as { color?: unknown; text?: unknown };
      const color = typeof r.color === "string" && r.color.length > 0 ? r.color : undefined;
      const text = typeof r.text === "string" && r.text.length > 0 ? r.text.slice(0, 24) : undefined;
      points.push({ ts: klines[i]!.openTime, position, shape, ...(color ? { color } : {}), ...(text ? { text } : {}) });
    }
    if (points.length > 0) {
      // Title-keyed contract (see plots above); untitled → stable marker:N.
      const mTitle = typeof (m as { title?: unknown }).title === "string" && (m as { title: string }).title.length > 0
        ? (m as { title: string }).title
        : `marker:${String((m as { id?: unknown }).id)}`;
      visuals.push({ type: "marker", key: mTitle, title: mTitle, data: points });
    }
  }

  // ── hlines ─────────────────────────────────────────────────────────────────
  // Piner 0.13.0 exposes only { id, price, title } — color/linestyle/linewidth
  // are not in the output IR (documented limitation): the renderer's defaults
  // apply instead of a wrong guess.
  for (const [, h] of engine.outputs.hlines) {
    const price = (h as { price?: unknown }).price;
    const hTitle = typeof (h as { title?: unknown }).title === "string" ? (h as { title: string }).title : "hline";
    const key = `hline:${String((h as { id?: unknown }).id)}`;
    // ── DECLARED (Style tab) capture ────────────────────────────────────────
    // Before the finite-price drop, so a declared hline always exposes its
    // colour/width/style controls even if a run produced no finite price.
    if (!declaredKeys.has(key)) {
      declaredKeys.add(key);
      diagnostics.declared.push({ key, title: hTitle, type: "horizontal" });
    }
    if (typeof price !== "number" || !Number.isFinite(price)) continue;
    visuals.push({ type: "horizontal", key, title: hTitle, price, lineStyle: "solid" });
  }

  // ── fills ──────────────────────────────────────────────────────────────────
  // Pine `fill(plot1, plot2, …)` shades the region between two boundaries. The
  // engine's `FillRegion` IR stores `plot1`/`plot2` as the RETURNED HANDLE of
  // each boundary: a plot id (plot() returns its id) when the boundary is a
  // plot, or the literal constant when it is `fill(p, 1.2345)` (a constant
  // price edge). We resolve each against the `plots` map — a hit is a plot
  // boundary (use its per-bar data, honouring that plot's `offset`), a miss is
  // a constant. Per-bar colors come straight from `fill.colors[]`. A boundary
  // that is na at a bar (warmup) leaves that side undefined so the renderer
  // breaks the fill exactly where the script has no data (no phantom fill).
  // Gradient fills (top_value/bottom_value) are NOT populated by Piner 0.13.0's
  // extraction path (`gradient` is undefined there) — reported as unsupported
  // rather than approximated.
  const plotDataById = new Map<number, { data: readonly unknown[]; offset: number }>();
  for (const [pid, p] of engine.outputs.plots) {
    const popts = (p.options ?? {}) as { offset?: unknown };
    plotDataById.set(pid, {
      data: Array.isArray(p.data) ? p.data : [],
      offset: typeof popts.offset === "number" ? popts.offset : 0,
    });
  }
  const resolveBoundary = (
    handle: number,
    bar: number,
  ): number | undefined => {
    const plot = plotDataById.get(handle);
    if (plot) {
      // Plot boundary: read the value at this bar under the plot's own offset.
      const di = displayIndex(bar, plot.offset);
      if (di < 0) return undefined;
      const v = plot.data[di];
      if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= PINE_VALUE_SANITY_LIMIT) return v;
      return undefined;
    }
    // Constant boundary (literal price): present at every bar.
    if (typeof handle === "number" && Number.isFinite(handle)) return handle;
    return undefined;
  };
  for (const [, f] of engine.outputs.fills) {
    const fr = f as { id?: unknown; plot1?: unknown; plot2?: unknown; title?: unknown; color?: unknown; colors?: unknown; gradient?: unknown };
    const p1 = fr.plot1;
    const p2 = fr.plot2;
    if (typeof p1 !== "number" || typeof p2 !== "number" || !Number.isFinite(p1) || !Number.isFinite(p2)) {
      unsupportedFor("fill() boundary");
      continue;
    }
    if (fr.gradient !== undefined && fr.gradient !== null) {
      unsupportedFor("fill() gradient");
      continue;
    }
    // At least one boundary must resolve to a real plot (a pure constant/constant
    // fill would be a degenerate full-height band — skip, never fake it).
    if (!plotDataById.has(p1) && !plotDataById.has(p2)) continue;
    const fillColors = Array.isArray(fr.colors) ? (fr.colors as unknown[]) : [];
    const staticColor = typeof fr.color === "string" && fr.color.length > 0 ? fr.color : undefined;
    const fTitle = typeof fr.title === "string" && fr.title.length > 0 ? fr.title : `fill:${String(fr.id)}`;
    const key = `fill:${String(fr.id)}`;
    // ── DECLARED (Style tab) capture ────────────────────────────────────────
    // Before the valued===0 drop, so a warmup-only fill (the Bollinger Bands
    // Background Fill in fractal_SMA.pine before enough history loads) still
    // exposes its colour/opacity controls. Deduped by key.
    if (!declaredKeys.has(key)) {
      declaredKeys.add(key);
      diagnostics.declared.push({ key, title: fTitle, type: "fill", ...(staticColor ? { color: staticColor } : {}) });
    }
    const points: PineFillPoint[] = [];
    let valued = 0;
    for (let i = 0; i < klines.length; i++) {
      const top = resolveBoundary(p1, i);
      const bottom = resolveBoundary(p2, i);
      if (top === undefined || bottom === undefined) {
        // Gap row: no fill here — the renderer must not bridge across it.
        points.push({ ts: klines[i]!.openTime });
        continue;
      }
      const c = fillColors[i];
      const perBar = typeof c === "string" && c.length > 0 ? c : staticColor;
      points.push({ ts: klines[i]!.openTime, top, bottom, ...(perBar ? { color: perBar } : {}) });
      valued += 1;
    }
    if (valued === 0) continue; // warmup-only / all-na fill — nothing to draw
    visuals.push({ type: "fill", key, title: fTitle, ...(staticColor ? { color: staticColor } : {}), data: points });
  }

  // ── drawings → the shared pineDrawings normalizers ─────────────────────────
  // Piner props use the SAME field names as the drawing snapshots the
  // normalizers already parse; the only delta is the unprefixed style enum
  // ("label_down" vs "style_label_down"), remapped below.
  const kbars: PineLabelBar[] = klines.map((k) => ({ openTime: k.openTime, high: k.high, low: k.low }));
  const prefixStyle = (s: unknown): unknown =>
    typeof s === "string" && !s.startsWith("style_") ? `style_${s}` : s;
  const labelSnapshots: Record<string, unknown>[] = [];
  const lineSnapshots: Record<string, unknown>[] = [];
  const boxSnapshots: Record<string, unknown>[] = [];
  for (const d of engine.drawings as Array<{ id?: unknown; type?: unknown; props?: unknown }>) {
    if (d === null || typeof d !== "object" || d.props === null || typeof d.props !== "object") continue;
    const snap: Record<string, unknown> = { id: d.id, ...(d.props as Record<string, unknown>) };
    snap.style = prefixStyle(snap.style);
    snap.border_style = prefixStyle(snap.border_style);
    if (d.type === "label") labelSnapshots.push(snap);
    else if (d.type === "line") lineSnapshots.push(snap);
    else if (d.type === "box") boxSnapshots.push(snap);
    else unsupportedFor(`${String(d.type)} drawings`);
  }
  const mergeUnsupported = (unsupported: { kind: string; count: number }[]): void => {
    for (const u of unsupported) {
      const found = diagnostics.unsupported.find((x) => x.kind === u.kind);
      if (found) found.count += u.count;
      else diagnostics.unsupported.push({ kind: u.kind, count: u.count });
    }
  };
  const paneLabels: PineLabelDrawing[] = [];
  const overlayLabels: PineLabelDrawing[] = [];
  const { labels, unsupported: labelUnsupported } = extractLabelDrawings([{ value: labelSnapshots }], kbars);
  mergeUnsupported(labelUnsupported);
  for (const lbl of labels) (lbl.forceOverlay ? overlayLabels : paneLabels).push(lbl);
  const paneLines: PineLineDrawing[] = [];
  const overlayLines: PineLineDrawing[] = [];
  const { lines, unsupported: lineUnsupported } = extractLineDrawings([{ value: lineSnapshots }], kbars);
  mergeUnsupported(lineUnsupported);
  for (const ln of lines) (ln.forceOverlay ? overlayLines : paneLines).push(ln);
  const paneBoxes: PineBoxDrawing[] = [];
  const overlayBoxes: PineBoxDrawing[] = [];
  const { boxes, unsupported: boxUnsupported } = extractBoxDrawings([{ value: boxSnapshots }], kbars);
  mergeUnsupported(boxUnsupported);
  for (const bx of boxes) (bx.forceOverlay ? overlayBoxes : paneBoxes).push(bx);

  if (paneLabels.length > 0 || overlayLabels.length > 0) {
    visuals.push({ type: "labels", key: "labels", title: "Label drawings", labels: paneLabels, overlayLabels });
  }
  if (paneLines.length > 0 || overlayLines.length > 0) {
    visuals.push({ type: "lines", key: "lines", title: "Line drawings", lines: paneLines, overlayLines });
  }
  if (paneBoxes.length > 0 || overlayBoxes.length > 0) {
    visuals.push({ type: "boxes", key: "boxes", title: "Box drawings", boxes: paneBoxes, overlayBoxes });
  }

  for (const v of visuals) diagnostics.rendered.push({ key: v.key, title: v.title, type: v.type });
  return { visuals, diagnostics, overlay, title, runMs };
}

