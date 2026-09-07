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
  PineMarkerPoint,
  PineRuntimeDiagnostics,
  PineSymbolMeta,
  PineVisual,
} from "./pineEngineTypes.ts";

/** Extraction cap for the imported-script path (mirrors MAX_SCRIPT_SERIES). */
export const PINER_MAX_VISUALS = 8;

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
  return compile(source);
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
  const diagnostics: PineRuntimeDiagnostics = { rendered: [], unsupported: [], hidden: 0 };
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

  const tsAt = (i: number): number => klines[i]!.openTime;

  // ── plots → line / stepline / histogram / area visuals ────────────────────
  let dataVisuals = 0;
  for (const [, p] of engine.outputs.plots) {
    if (dataVisuals >= maxVisuals) break;
    const opts = (p.options ?? {}) as { style?: unknown; linewidth?: unknown; display?: unknown };
    if (opts.display === "none") {
      diagnostics.hidden += 1;
      continue;
    }
    const colors = Array.isArray(p.colors) ? (p.colors as unknown[]) : [];
    let uniform: string | undefined;
    let dynamic = false;
    for (const c of colors) {
      if (typeof c !== "string" || c.length === 0) continue;
      if (uniform === undefined) uniform = c;
      else if (uniform !== c) dynamic = true;
    }
    const points: { ts: number; value: number; color?: string }[] = [];
    for (let i = 0; i < p.data.length && i < klines.length; i++) {
      const v = p.data[i];
      if (typeof v !== "number" || !Number.isFinite(v)) continue; // warmup na rows
      const c = colors[i];
      if (dynamic && typeof c === "string" && c.length > 0) points.push({ ts: tsAt(i), value: v, color: c });
      else points.push({ ts: tsAt(i), value: v });
    }
    if (points.length === 0) continue; // warmup-only plot — nothing to draw
    const lineWidth =
      typeof opts.linewidth === "number" && Number.isInteger(opts.linewidth)
        ? Math.max(1, Math.min(4, opts.linewidth))
        : undefined;
    const color = dynamic ? undefined : uniform;
    const style = typeof opts.style === "string" ? opts.style : "line";
    // Keys follow the title-keyed contract (key = plot title, so
    // persisted plotMeta reconciles across runs); untitled → stable plot:N.
    const plotTitle = typeof p.title === "string" && p.title.length > 0 ? p.title : `plot:${p.id}`;
    const key = plotTitle;
    if (style === "stepline") {
      visuals.push({ type: "line", key, title: plotTitle, ...(color ? { color } : {}), ...(lineWidth ? { lineWidth } : {}), stepLine: true, data: points });
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
      points.push({ ts: tsAt(i), position, shape, ...(color ? { color } : {}), ...(text ? { text } : {}) });
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
    if (typeof price !== "number" || !Number.isFinite(price)) continue;
    const hTitle = typeof (h as { title?: unknown }).title === "string" ? (h as { title: string }).title : "hline";
    visuals.push({ type: "horizontal", key: `hline:${String((h as { id?: unknown }).id)}`, title: hTitle, price, lineStyle: "solid" });
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

