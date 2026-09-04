/**
 * EMA alert settings + runtime-state persistence (JSON file, NO database).
 *
 * The backend is the runtime source of truth for the alert configuration:
 * detection happens server-side, so a browser-only (localStorage) store could
 * not drive it. A small JSON file under backend/data/ keeps the settings and
 * the per-direction cooldown timestamps across backend restarts without any
 * Supabase migration. All writes are best-effort: a filesystem failure must
 * never break the alert engine or the realtime pipeline.
 *
 * First-run seeding: `EMA_ALERT_ENABLED=on` in backend/.env starts the alert
 * enabled before any UI interaction; afterwards the file wins.
 */
import fs from "node:fs";
import { sanitizeEmaAlertSettings, type EmaAlertSettings } from "./emaAlertConfig.js";
import { writeJsonAtomic } from "./atomicFile.js";

/**
 * Runtime state persisted alongside the settings (cooldown continuity).
 * Cooldown timestamps are stored PER TIMEFRAME (keys "MINUTE_1"/"MINUTE_3")
 * so a 1m alert never suppresses 3m (and vice versa) across restarts.
 */
export interface EmaAlertRuntimeState {
  lastAlertBullishAt: Record<string, number>;
  lastAlertBearishAt: Record<string, number>;
}

export interface EmaAlertStoredState {
  settings: EmaAlertSettings;
  runtime: EmaAlertRuntimeState;
}

export function defaultRuntimeState(): EmaAlertRuntimeState {
  return { lastAlertBullishAt: {}, lastAlertBearishAt: {} };
}

/** Normalize a stored value into a timeframe→timestamp record. Legacy scalar
 *  values (pre-multi-timeframe builds) map onto BOTH timeframes so old data
 *  keeps its meaning after upgrade. */
export function toRuntimeRecord(value: unknown): Record<string, number> {
  if (typeof value === "number") {
    return { MINUTE_1: value, MINUTE_3: value };
  }
  if (value && typeof value === "object") {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  }
  return {};
}

export class EmaAlertSettingsStore {
  constructor(
    private readonly filePath: string,
    /** Seed for the very first run (before any file exists). */
    private readonly firstRunSeed: EmaAlertSettings | null = null,
  ) {}

  /** Load (or initialize) the stored state; corrupted data falls back to defaults. */
  load(): EmaAlertStoredState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { settings?: unknown; runtime?: Record<string, unknown> };
      const runtime = defaultRuntimeState();
      runtime.lastAlertBullishAt = toRuntimeRecord(parsed.runtime?.lastAlertBullishAt);
      runtime.lastAlertBearishAt = toRuntimeRecord(parsed.runtime?.lastAlertBearishAt);
      return { settings: sanitizeEmaAlertSettings(parsed.settings), runtime };
    } catch {
      // Missing/corrupt file → seed (first run) or defaults; persist lazily on
      // the next save() so read-only filesystems never break the engine.
      return {
        settings: this.firstRunSeed ?? sanitizeEmaAlertSettings(undefined),
        runtime: defaultRuntimeState(),
      };
    }
  }

  /** Persist settings + runtime state (atomic write; errors logged, swallowed). */
  save(state: EmaAlertStoredState): void {
    try {
      writeJsonAtomic(this.filePath, state);
    } catch (err) {
      console.log(
        `[EMA ALERT] settings file write failed (continuing in-memory): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
