/**
 * Piner-backed Pine engine — the DEFAULT implementation of the AURA
 * `PineScriptEngine` boundary (services/pineEngineTypes.ts).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Design notes (docs/pine-migration.md):
 *
 * • Compilation is memoized per source fingerprint — an 83k script transpiles
 *   exactly once per engine lifetime; data slices re-run against the cached
 *   artifact (Piner `Engine` instances are cheap, per-run state holders).
 * • Determinism / replay safety: every run receives the FULL visible candle
 *   slice and executes bar-by-bar over it — identical input ⇒ identical
 *   visuals. No engine state survives between runs, so replay seeking,
 *   history reloads and timeframe switches can never leak future bars.
 * • Stale-run protection: requests for the SAME script are serialized
 *   (per-script promise chain). The newest request always executes last, so
 *   its result is always the one that lands on the chart — a slow older run
 *   can never overwrite newer chart state.
 * • Progress: real stage boundaries only (compiling → executing → extracting)
 *   surfaced through `onStage`; no timers, no fake percentages.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  pinerCompile,
  pinerRunVisuals,
  type PinerCompiled,
} from "./pinePinerCore.ts";
import {
  buildAuthoritativeSeries,
  dataSignature,
  sourceSignature,
  type PineCandle,
} from "./pineSeries.ts";
import type {
  PineBar,
  PineLiveCandle,
  PinePoint,
  PineScriptSpec,
  PineSeries,
  PineSymbolMeta,
} from "./pineEngineTypes.ts";
import type { PineEngineStage, PineScriptEngine, PineVisualRun } from "./pineEngineTypes.ts";
import { PINE_INDICATORS } from "./pineIndicators.ts";

/** Per-script request serialization — newest request wins, never interleaved. */
function runSerial<T>(chain: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chain.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // a failed prior run must not poison the chain
  chain.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export class PinerPineEngine implements PineScriptEngine {
  private klines: PineCandle[] = [];
  private dataSig: string | null = null;
  private symSig: string | null = null;
  private symbol: PineSymbolMeta | null = null;
  private bucketSec = 60;
  /** Compiled artifacts keyed by source fingerprint — transpile once, reuse forever. */
  private readonly compiled = new Map<string, PinerCompiled>();
  private readonly visualsCache = new Map<string, PineVisualRun>();
  private readonly resultCache = new Map<string, PinePoint[]>();
  private readonly scriptCache = new Map<string, Map<string, PineSeries>>();
  private readonly chains = new Map<string, Promise<unknown>>();

  setCandles(
    bars: readonly PineBar[],
    liveCandle: PineLiveCandle | null,
    bucketSec: number,
    symbol: PineSymbolMeta | null = null,
  ): void {
    const klines = buildAuthoritativeSeries(bars, liveCandle, bucketSec);
    const sig = dataSignature(klines);
    const symSig = JSON.stringify(symbol ?? null);
    if (sig === this.dataSig && symSig === this.symSig && this.klines.length > 0) {
      // Unchanged slice + symbol — keep caches (guards redundant rAF frames).
      this.klines = klines;
      return;
    }
    this.klines = klines;
    this.dataSig = sig;
    this.symSig = symSig;
    this.symbol = symbol;
    this.bucketSec = bucketSec;
    this.visualsCache.clear();
    this.resultCache.clear();
    this.scriptCache.clear();
  }

  private cacheKey(spec: PineScriptSpec, params: Record<string, unknown>): string {
    return `${spec.id}|${sourceSignature(spec.source)}|${this.dataSig ?? "-"}|${JSON.stringify(params ?? {})}|${this.symSig ?? "-"}`;
  }

  /** Compile (memoized) — throws the raw Piner error for the caller to map. */
  private getCompiled(spec: PineScriptSpec): PinerCompiled {
    const key = sourceSignature(spec.source);
    let c = this.compiled.get(key);
    if (!c) {
      c = pinerCompile(spec.source);
      this.compiled.set(key, c);
    }
    return c;
  }

  /** Re-key AURA params (keyed by varId) onto Piner's input-title keys. */
  private inputsFor(spec: PineScriptSpec, params: Record<string, unknown>): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const b of spec.bindings ?? []) {
      const v = params[b.paramKey];
      if (v !== undefined) inputs[b.title] = v;
    }
    return inputs;
  }

  async computeScriptVisuals(
    spec: PineScriptSpec,
    params: Record<string, unknown> = {},
    onError?: (message: string) => void,
    onContext?: (info: { overlay?: boolean; title?: string }) => void,
    onStage?: (stage: PineEngineStage) => void,
  ): Promise<PineVisualRun | null> {
    if (this.klines.length === 0 || this.dataSig === null) return null;
    return runSerial(this.chains, spec.id, async (): Promise<PineVisualRun | null> => {
      const key = this.cacheKey(spec, params);
      const cached = this.visualsCache.get(key);
      if (cached) return cached;
      onStage?.("compiling");
      let compiled: PinerCompiled;
      try {
        compiled = this.getCompiled(spec);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[PinerEngine] compile failed for "${spec.id}":`, msg);
        onError?.(msg);
        return null;
      }
      onContext?.({ overlay: !!compiled.metadata?.overlay, title: String(compiled.metadata?.title ?? "") });
      let out: Awaited<ReturnType<typeof pinerRunVisuals>>;
      try {
        out = await pinerRunVisuals({
          compiled,
          klines: this.klines,
          inputs: this.inputsFor(spec, params),
          symbol: this.symbol,
          bucketSec: this.bucketSec,
          onStage,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[PinerEngine] run failed for "${spec.id}":`, e);
        onError?.(msg);
        return null;
      }
      const result: PineVisualRun = { visuals: out.visuals, diagnostics: out.diagnostics };
      this.visualsCache.set(key, result);
      return result;
    });
  }

  /** Line-only extraction path — maps plain `plot()` visuals to PineSeries. */
  async computeScript(
    spec: PineScriptSpec,
    params: Record<string, unknown> = {},
    onError?: (message: string) => void,
    onContext?: (info: { overlay?: boolean; title?: string }) => void,
  ): Promise<Map<string, PineSeries> | null> {
    if (this.klines.length === 0 || this.dataSig === null) return null;
    return runSerial(this.chains, spec.id, async (): Promise<Map<string, PineSeries> | null> => {
      const key = this.cacheKey(spec, params);
      const cached = this.scriptCache.get(key);
      if (cached) return cached;
      let compiled: PinerCompiled;
      try {
        compiled = this.getCompiled(spec);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[PinerEngine] compile failed for "${spec.id}":`, msg);
        onError?.(msg);
        return null;
      }
      onContext?.({ overlay: !!compiled.metadata?.overlay, title: String(compiled.metadata?.title ?? "") });
      let out: Awaited<ReturnType<typeof pinerRunVisuals>>;
      try {
        out = await pinerRunVisuals({
          compiled,
          klines: this.klines,
          inputs: this.inputsFor(spec, params),
          symbol: this.symbol,
          bucketSec: this.bucketSec,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[PinerEngine] run failed for "${spec.id}":`, e);
        onError?.(msg);
        return null;
      }
      // Line-only contract: plain (non-step) lines only.
      const outMap = new Map<string, PineSeries>();
      for (const v of out.visuals) {
        if (outMap.size >= 8) break;
        if (v.type !== "line" || v.stepLine) continue;
        outMap.set(v.key, {
          key: v.key,
          title: v.title,
          points: v.data,
          ...(v.lineWidth ? { linewidth: v.lineWidth } : {}),
          ...(v.color ? { color: v.color } : {}),
        });
      }
      this.scriptCache.set(key, outMap);
      return outMap;
    });
  }

  /** Built-in registry indicator (EMA 9/20 shim) — same visuals path, keyed read. */
  async compute(indicatorId: string, params: Record<string, unknown> = {}): Promise<PinePoint[] | null> {
    const spec = PINE_INDICATORS[indicatorId];
    if (!spec) return null;
    if (this.klines.length === 0 || this.dataSig === null) return null;
    return runSerial(this.chains, spec.id, async (): Promise<PinePoint[] | null> => {
      const key = this.cacheKey(spec, params);
      const cached = this.resultCache.get(key);
      if (cached) return cached;
      let compiled: PinerCompiled;
      try {
        compiled = this.getCompiled(spec);
      } catch {
        return null; // registry sources are static — a failure is a hard bug
      }
      let out: Awaited<ReturnType<typeof pinerRunVisuals>>;
      try {
        out = await pinerRunVisuals({
          compiled,
          klines: this.klines,
          inputs: this.inputsFor(spec, params),
          symbol: this.symbol,
          bucketSec: this.bucketSec,
        });
      } catch {
        return null; // caller falls back to the ema.ts oracle
      }
      // Registry specs name their output plot; fall back to the first line.
      const wanted = spec.plotKey;
      let chosen: PineSeries | null = null;
      for (const v of out.visuals) {
        if (v.type !== "line" || v.stepLine) continue;
        if (v.title === wanted || v.key === wanted) {
          chosen = { key: v.key, title: v.title, points: v.data };
          break;
        }
        chosen ??= { key: v.key, title: v.title, points: v.data };
      }
      const pts = chosen?.points ?? [];
      this.resultCache.set(key, pts);
      return pts;
    });
  }

  dispose(): void {
    this.compiled.clear();
    this.visualsCache.clear();
    this.resultCache.clear();
    this.scriptCache.clear();
    this.chains.clear();
    this.klines = [];
    this.dataSig = null;
    this.symSig = null;
    this.symbol = null;
  }
}
