/**
 * Pine engine boundary — the ONLY surface React/App code depends on.
 *
 * Piner is the sole Pine engine (worker-hosted, services/pinePinerEngine.ts).
 * Piner specifics (compile/run/visual mapping) live behind this contract —
 * React components never import `@heyphat/piner` directly.
 */
import type { PineCandle } from "./pineSeries.ts";
import type { PineLabelDrawing, PineLineDrawing, PineBoxDrawing } from "./pineDrawings.ts";
import type { PineIndicatorSpec, PineInputBinding } from "./pineIndicators.ts";

// ── Type re-exports (canonical homes preserved) ──────────────────────────────
export type { PineCandle };
export type { PineIndicatorSpec, PineInputBinding };

// ── Candle / point models ────────────────────────────────────────────────────

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
  /** Display title reported by the runtime. */
  title: string;
  points: PinePoint[];
  /** Script-declared linewidth when statically declared (undefined = default). */
  linewidth?: number;
  /** Uniform color when every point shares one (hex); per-point colors otherwise. */
  color?: string;
}

// ── Normalized AURA visual outputs ──────────────────────────────────────────

/** Visual kinds AURA can currently render for imported Pine scripts. */
export type PineVisualType =
  | "line"
  | "histogram"
  | "area"
  | "horizontal"
  | "marker"
  | "labels"
  | "lines"
  | "boxes";

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
 * One normalized renderable output extracted from a Pine run. `key` matches
 * the plot key so plot metadata (persisted) can be reconciled with
 * fresh runtime results.
 */
export type PineVisual =
  | {
      type: "line";
      key: string;
      title: string;
      color?: string;
      lineWidth?: number;
      /** Stepped rendering (LWC `LineType.WithSteps`). */
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
  | { type: "marker"; key: string; title: string; data: PineMarkerPoint[] }
  | {
      /** Pine `label.new()` drawings (see services/pineDrawings.ts). */
      type: "labels";
      key: string;
      title: string;
      /** Labels painted on the indicator's own pane. */
      labels: PineLabelDrawing[];
      /** `force_overlay=true` labels — always pinned to the main price pane. */
      overlayLabels: PineLabelDrawing[];
    }
  | {
      /** Pine `line.new()` drawings (same drawing-object architecture as labels). */
      type: "lines";
      key: string;
      title: string;
      lines: PineLineDrawing[];
      overlayLines: PineLineDrawing[];
    }
  | {
      /** Pine `box.new()` drawings (same drawing-object architecture as labels). */
      type: "boxes";
      key: string;
      title: string;
      boxes: PineBoxDrawing[];
      overlayBoxes: PineBoxDrawing[];
    };

/** Real compile/execution stage boundaries — surfaced to the import progress UI. */
export type PineEngineStage = "compiling" | "executing" | "extracting";

/** What one engine run produced / could NOT produce (runtime half of the import diagnostics). */
export interface PineRuntimeDiagnostics {
  rendered: { key: string; title: string; type: PineVisualType }[];
  /** Detected-but-unrenderable outputs (circles/cross styles, drawings, …). */
  unsupported: { kind: string; count: number }[];
  /** Plots the script itself hides via `display=display.none`. */
  hidden: number;
}

// ── Ad-hoc script spec ──────────────────────────────────────────────────────

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

// ── syminfo (symbol metadata) ────────────────────────────────────────────────

/**
 * AURA-side symbol metadata. Built from the active instrument's registry entry.
 * Passed to the engine for `syminfo.*` resolution.
 */
export interface PineSymbolMeta {
  /** The active instrument EPIC (TradingView `syminfo.tickerid` analogue). */
  tickerid: string;
  /** Quoting precision in decimal places (DAX 1, Spot Gold 2) → mintick = 10^-decimals. */
  decimals?: number;
  /** Quote currency when the registry carries it. */
  currency?: string;
  /** Exchange timezone (IANA) from the instrument calendar; "UTC" when absent. */
  timezone?: string;
}

/** Tolerance that absorbs rounding from the engine's precision. */
export const PINE_EQUIVALENCE_TOL = 5e-9;

// ── Symbol info builder ─────────────────────────────────────────────────────

import {
  estimateMintickFromCandles,
  mintickFromDecimals,
  MINTICK_DATA_FLOOR,
} from "./pineMintick.ts";

/**
 * Build the full symbol-info object the engine assigns to `syminfo`.
 * mintick precedence: instrument `decimals` → candle-data estimate →
 * documented degenerate floor (services/pineMintick.ts).
 * Never a global 0.01.
 */
export function buildPineSymbolInfo(
  meta: PineSymbolMeta | null | undefined,
  klines: readonly PineCandle[],
): Record<string, unknown> {
  const mintick =
    meta?.decimals !== undefined && meta?.decimals !== null
      ? mintickFromDecimals(meta.decimals)
      : (estimateMintickFromCandles(klines) ?? MINTICK_DATA_FLOOR);
  return {
    tickerid: meta?.tickerid ?? "",
    ticker: meta?.tickerid ?? "",
    main_tickerid: meta?.tickerid ?? "",
    current_contract: meta?.tickerid ?? "",
    root: "",
    prefix: "",
    isin: "",
    type: "",
    description: "",
    sector: "",
    industry: "",
    country: "",
    basecurrency: "",
    currency: meta?.currency ?? "",
    timezone: meta?.timezone ?? "UTC",
    session: "",
    expiration_date: NaN,
    mintick,
    minmove: 1,
    pricescale: Math.round(1 / mintick),
    pointvalue: 1,
    mincontract: 1,
    volumetype: "",
    employees: 0,
    shareholders: 0,
    shares_outstanding_float: 0,
    shares_outstanding_total: 0,
  };
}

// ── Engine interface ────────────────────────────────────────────────────────

export interface PineVisualRun {
  visuals: PineVisual[];
  diagnostics: PineRuntimeDiagnostics;
}

export interface PineScriptEngine {
  setCandles(
    bars: readonly PineBar[],
    liveCandle: PineLiveCandle | null,
    bucketSec: number,
    symbol?: PineSymbolMeta | null,
  ): void;

  compute(indicatorId: string, params?: Record<string, unknown>): Promise<PinePoint[] | null>;

  computeScript(
    spec: PineScriptSpec,
    params?: Record<string, unknown>,
    onError?: (message: string) => void,
    onContext?: (info: { overlay?: boolean; title?: string }) => void,
  ): Promise<Map<string, PineSeries> | null>;

  computeScriptVisuals(
    spec: PineScriptSpec,
    params?: Record<string, unknown>,
    onError?: (message: string) => void,
    onContext?: (info: { overlay?: boolean; title?: string }) => void,
    onStage?: (stage: PineEngineStage) => void,
  ): Promise<PineVisualRun | null>;

  dispose(): void;
}
