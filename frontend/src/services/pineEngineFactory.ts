/**
 * Pine engine factory — the single engine-creation point.
 *
 * Piner is the sole Pine engine (worker-hosted). This factory creates a
 * `PinerWorkerEngine` instance — the app never imports an engine
 * constructor directly.
 */
import { PinerWorkerEngine } from "./pineWorkerClient.ts";
import type { PineScriptEngine } from "./pineEngineTypes.ts";

export function createPineEngine(): PineScriptEngine {
  return new PinerWorkerEngine();
}
