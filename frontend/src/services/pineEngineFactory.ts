/**
 * Pine engine factory — the single engine-selection point.
 *
 * `AURA_PINE_ENGINE_BACKEND` is the migration switch from
 * docs/pine-migration.md: `"piner"` (default — worker-hosted Piner) or
 * `"pinets"` (the retained legacy in-thread path, kept for comparison until
 * the removal gate passes). Nothing else in the app imports an engine
 * constructor directly.
 */
import { PineIndicatorEngine } from "./pineEngine.ts";
import { PinerWorkerEngine } from "./pineWorkerClient.ts";
import type { PineScriptEngine } from "./pineEngineTypes.ts";

export type PineEngineBackend = "piner" | "pinets";

/** Migration switch — flip to "pinets" to compare engines side by side. */
export const AURA_PINE_ENGINE_BACKEND: PineEngineBackend = "piner";

export function createPineEngine(): PineScriptEngine {
  if (AURA_PINE_ENGINE_BACKEND === "pinets") return new PineIndicatorEngine();
  return new PinerWorkerEngine();
}
