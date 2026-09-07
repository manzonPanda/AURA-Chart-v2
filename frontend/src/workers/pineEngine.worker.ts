/**
 * Pine engine worker — hosts the Piner core OFF the main thread.
 *
 * Protocol (structured-clone friendly; no functions cross the boundary):
 *   → { kind, id, ...request }          one pending request per id
 *   ← { kind: "stage", id, stage }      real progress boundaries (executing/…)
 *   ← { kind: "result", id, ok, value } final result (or raw error message)
 *
 * Determinism/replay: every run receives the full visible candle slice; the
 * worker keeps NO state between runs beyond the compiled-script cache, so
 * replay/history/timeframe switches can never leak future bars.
 *
 * UI responsiveness: compile + execute + visual extraction all happen here —
 * the main thread only serializes JSON-shaped messages (83k scripts included).
 */
import { PinerPineEngine } from "../services/pinePinerEngine.ts";
import type { PineBar, PineLiveCandle, PineScriptSpec, PineSymbolMeta } from "../services/pineEngineTypes.ts";

type PineWorkerRequest =
  | { kind: "setCandles"; id: number; bars: readonly PineBar[]; live: PineLiveCandle | null; bucketSec: number; symbol: PineSymbolMeta | null }
  | { kind: "compute"; id: number; indicatorId: string; params: Record<string, unknown> }
  | { kind: "computeScript"; id: number; spec: PineScriptSpec; params: Record<string, unknown> }
  | { kind: "computeScriptVisuals"; id: number; spec: PineScriptSpec; params: Record<string, unknown> }
  | { kind: "dispose"; id: number };

const post = (msg: unknown): void => {
  (self as unknown as Worker).postMessage(msg);
};

const engine = new PinerPineEngine();

self.onmessage = (ev: MessageEvent<PineWorkerRequest>): void => {
  const req = ev.data;
  if (!req || typeof req !== "object" || typeof (req as { id?: unknown }).id !== "number") return;
  const id = req.id;
  try {
    switch (req.kind) {
      case "setCandles": {
        engine.setCandles(req.bars, req.live, req.bucketSec, req.symbol);
        post({ kind: "result", id, ok: true, value: undefined });
        break;
      }
      case "compute": {
        engine
          .compute(req.indicatorId, req.params)
          .then((value) => post({ kind: "result", id, ok: true, value }))
          .catch((e: unknown) => post({ kind: "result", id, ok: false, error: e instanceof Error ? e.message : String(e) }));
        break;
      }
      case "computeScript": {
        engine
          .computeScript(req.spec, req.params)
          .then((value) => post({ kind: "result", id, ok: true, value: value ? [...value.entries()] : null }))
          .catch((e: unknown) => post({ kind: "result", id, ok: false, error: e instanceof Error ? e.message : String(e) }));
        break;
      }
      case "computeScriptVisuals": {
        engine
          .computeScriptVisuals(
            req.spec,
            req.params,
            undefined,
            undefined,
            (stage) => post({ kind: "stage", id, stage }),
          )
          .then((value) => post({ kind: "result", id, ok: true, value }))
          .catch((e: unknown) => post({ kind: "result", id, ok: false, error: e instanceof Error ? e.message : String(e) }));
        break;
      }
      case "dispose": {
        engine.dispose();
        post({ kind: "result", id, ok: true, value: undefined });
        break;
      }
      default:
        post({ kind: "result", id, ok: false, error: `unknown request kind` });
    }
  } catch (e) {
    post({ kind: "result", id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
