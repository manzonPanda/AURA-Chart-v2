/**
 * Pine engine boundary — the ONLY surface React/App code depends on.
 *
 * Both backends implement this interface:
 *   • PineTS  → `PineIndicatorEngine` (services/pineEngine.ts, retained)
 *   • Piner   → `PinerPineEngine`    (services/pinePinerEngine.ts, default)
 *
 * Piner specifics (compile/run/visual mapping) live behind this contract —
 * React components never import `@heyphat/piner` (migration rule §5.1 in
 * docs/pine-migration.md).
 */
import type {
  PineBar,
  PineLiveCandle,
  PinePoint,
  PineRuntimeDiagnostics,
  PineScriptSpec,
  PineSeries,
  PineSymbolMeta,
  PineVisual,
} from "./pineEngine.ts";

/** Real compile/execution stages — re-exported so every engine surface shares one union. */
import type { PineEngineStage } from "./pineEngine.ts";
export type { PineEngineStage };

export interface PineVisualRun {
  visuals: PineVisual[];
  diagnostics: PineRuntimeDiagnostics;
}

export interface PineScriptEngine {
  /**
   * Feed the authoritative candle slice (closed bars + forming WS candle).
   * `symbol` carries the active instrument metadata for `syminfo.*`.
   */
  setCandles(
    bars: readonly PineBar[],
    liveCandle: PineLiveCandle | null,
    bucketSec: number,
    symbol?: PineSymbolMeta | null,
  ): void;

  /** Built-in registry indicator (EMA 9/20 shim used by EmaBridge). */
  compute(indicatorId: string, params?: Record<string, unknown>): Promise<PinePoint[] | null>;

  /** Line-only extraction path (retained for import-pipeline compatibility). */
  computeScript(
    spec: PineScriptSpec,
    params?: Record<string, unknown>,
    onError?: (message: string) => void,
    onContext?: (info: { overlay?: boolean; title?: string }) => void,
  ): Promise<Map<string, PineSeries> | null>;

  /** Full visual extraction (plots + markers + drawings) — imported-script path. */
  computeScriptVisuals(
    spec: PineScriptSpec,
    params?: Record<string, unknown>,
    onError?: (message: string) => void,
    onContext?: (info: { overlay?: boolean; title?: string }) => void,
    onStage?: (stage: PineEngineStage) => void,
  ): Promise<PineVisualRun | null>;

  /** Release caches/compiled artifacts. Safe to call on teardown. */
  dispose(): void;
}
