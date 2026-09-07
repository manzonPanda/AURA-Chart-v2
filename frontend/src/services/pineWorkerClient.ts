/**
 * Worker-transported Piner engine — the `PineScriptEngine` the app uses.
 *
 * Spawns `workers/pineEngine.worker.ts` (Piner compile+execute+extraction off
 * the main thread) and mirrors the engine API across the message channel with
 * per-request ids and stage forwarding. If the Worker is unavailable (Node
 * tests, older browsers, worker boot failure) it transparently falls back to
 * the in-thread `PinerPineEngine` — same engine code, same determinism.
 *
 * Stale-run protection: every response carries its request id and unknown/
 * superseded ids are ignored by design; the underlying facade additionally
 * serializes per-script so the newest chart-state request always lands last.
 */
import { PinerPineEngine } from "./pinePinerEngine.ts";
import type { PineBar, PineLiveCandle, PinePoint, PineScriptSpec, PineSeries, PineSymbolMeta } from "./pineEngineTypes.ts";
import type { PineEngineStage, PineScriptEngine, PineVisualRun } from "./pineEngineTypes.ts";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onStage?: (stage: PineEngineStage) => void;
}

/** Callbacks a request can stream back — all re-attached verbatim on the in-thread fallback. */
interface RequestHooks {
  onError?: (message: string) => void;
  onContext?: (info: { overlay?: boolean; title?: string }) => void;
  onStage?: (stage: PineEngineStage) => void;
}

type WorkerLike = {
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
  terminate: () => void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

function spawnWorker(): WorkerLike | null {
  try {
    const w = new Worker(new URL("../workers/pineEngine.worker.ts", import.meta.url), { type: "module" });
    return w as unknown as WorkerLike;
  } catch {
    return null; // Node tests / environments without Worker support
  }
}

export class PinerWorkerEngine implements PineScriptEngine {
  private worker: WorkerLike | null = null;
  /** In-thread fallback (also the deterministic test/Node path). */
  private fallback: PinerPineEngine | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private bootFailed = false;
  /** Last candle slice — replayed to the in-thread fallback after a worker crash. */
  private lastCandles: { bars: readonly PineBar[]; live: PineLiveCandle | null; bucketSec: number; symbol: PineSymbolMeta | null } | null = null;

  /** Lazily create the worker on first use. */
  private ensureWorker(): WorkerLike | null {
    if (this.bootFailed) return null;
    if (this.worker) return this.worker;
    const w = spawnWorker();
    if (!w) {
      this.bootFailed = true;
      return null;
    }
    w.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { kind?: string; id?: number; ok?: boolean; value?: unknown; error?: string; stage?: string };
      if (!msg || typeof msg.id !== "number") return;
      const p = this.pending.get(msg.id);
      if (!p) return; // stale/unknown response — ignored by design
      if (msg.kind === "stage") {
        p.onStage?.((msg.stage ?? "") as PineEngineStage);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error ?? "Pine worker failure"));
    };
    w.onerror = () => {
      // Worker died (bundle/OOM) — fail pending, route future calls in-thread.
      this.bootFailed = true;
      for (const [, p] of this.pending) p.reject(new Error("Pine worker crashed — falling back in-thread"));
      this.pending.clear();
      this.terminateWorker();
    };
    this.worker = w;
    return w;
  }

  private terminateWorker(): void {
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
  }

  private request<T>(msg: Record<string, unknown>, hooks?: RequestHooks): Promise<T> {
    const w = this.ensureWorker();
    if (!w) return this.callFallbackInThread<T>(msg, hooks);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onStage: hooks?.onStage });
      try {
        w.postMessage({ ...msg, id });
      } catch {
        // Non-cloneable payload or dead port — run this request in-thread.
        this.pending.delete(id);
        this.bootFailed = true;
        this.terminateWorker();
        void this.callFallbackInThread<T>(msg, hooks).then(resolve, reject);
      }
    });
  }

  private async callFallbackInThread<T>(msg: Record<string, unknown>, hooks?: RequestHooks): Promise<T> {
    const engine = (this.fallback ??= new PinerPineEngine());
    // If the worker died after setCandles, the fallback never saw the slice —
    // replay the last known candles first (the engine's sig guard makes this a
    // no-op when it is already current).
    if (msg.kind !== "setCandles" && this.lastCandles) {
      engine.setCandles(this.lastCandles.bars, this.lastCandles.live, this.lastCandles.bucketSec, this.lastCandles.symbol);
    }
    switch (msg.kind) {
      case "setCandles":
        engine.setCandles(
          msg.bars as readonly PineBar[],
          (msg.live ?? null) as PineLiveCandle | null,
          msg.bucketSec as number,
          (msg.symbol ?? null) as PineSymbolMeta | null,
        );
        return undefined as T;
      case "compute":
        return engine.compute(msg.indicatorId as string, (msg.params ?? {}) as Record<string, unknown>) as Promise<T>;
      case "computeScript":
        return engine.computeScript(
          msg.spec as PineScriptSpec,
          (msg.params ?? {}) as Record<string, unknown>,
          hooks?.onError,
        ) as Promise<T>;
      case "computeScriptVisuals":
        return engine.computeScriptVisuals(
          msg.spec as PineScriptSpec,
          (msg.params ?? {}) as Record<string, unknown>,
          hooks?.onError,
          hooks?.onContext,
          hooks?.onStage,
        ) as Promise<T>;
      case "dispose":
        engine.dispose();
        return undefined as T;
      default:
        throw new Error("unknown request kind");
    }
  }

  setCandles(
    bars: readonly PineBar[],
    liveCandle: PineLiveCandle | null,
    bucketSec: number,
    symbol: PineSymbolMeta | null = null,
  ): void {
    // Synchronous API — mirror to the worker without awaiting; the fallback
    // path applies immediately so nothing awaits it.
    this.lastCandles = { bars, live: liveCandle, bucketSec, symbol };
    const w = this.ensureWorker();
    if (!w) {
      (this.fallback ??= new PinerPineEngine()).setCandles(bars, liveCandle, bucketSec, symbol);
      return;
    }
    const id = this.nextId++;
    try {
      w.postMessage({ kind: "setCandles", id, bars: [...bars], live: liveCandle, bucketSec, symbol });
    } catch {
      this.bootFailed = true;
      this.terminateWorker();
      (this.fallback ??= new PinerPineEngine()).setCandles(bars, liveCandle, bucketSec, symbol);
    }
  }

  compute(indicatorId: string, params: Record<string, unknown> = {}): Promise<PinePoint[] | null> {
    return this.request<PinePoint[] | null>({ kind: "compute", indicatorId, params });
  }

  async computeScript(
    spec: PineScriptSpec,
    params: Record<string, unknown> = {},
    onError?: (message: string) => void,
    _onContext?: (info: { overlay?: boolean; title?: string }) => void,
  ): Promise<Map<string, PineSeries> | null> {
    try {
      const raw = await this.request<unknown>({ kind: "computeScript", spec, params }, { onError });
      if (raw === null || raw === undefined) return null;
      return new Map(raw as [string, PineSeries][]);
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async computeScriptVisuals(
    spec: PineScriptSpec,
    params: Record<string, unknown> = {},
    onError?: (message: string) => void,
    _onContext?: (info: { overlay?: boolean; title?: string }) => void,
    onStage?: (stage: PineEngineStage) => void,
  ): Promise<PineVisualRun | null> {
    try {
      return await this.request<PineVisualRun | null>({ kind: "computeScriptVisuals", spec, params }, { onError, onStage });
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  dispose(): void {
    const w = this.worker;
    if (w) {
      const id = this.nextId++;
      try {
        w.postMessage({ kind: "dispose", id });
      } catch {
        /* worker gone */
      }
      // Terminate immediately — the worker's compiled cache is rebuilt lazily
      // on next use (transpile-once per engine lifetime).
      this.terminateWorker();
    }
    this.fallback?.dispose();
    this.pending.clear();
  }
}
