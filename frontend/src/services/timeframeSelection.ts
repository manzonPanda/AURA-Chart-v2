/**
 * Timeframe selection persistence — PURE helpers (no React, no chart).
 *
 * Mirrors `services/instruments.ts` exactly: the TIMEFRAME registry
 * (`config/chart.ts`, which mirrors the backend registry) is the source of
 * truth, and the browser only persists WHICH entry the user picked.
 *
 * Framework-free and Node-testable, like every other module in services/.
 *
 * Deliberately NOT a ChartSettings field: chart templates snapshot the whole
 * settings object, so a timeframe stored there would let applying a template
 * silently change the selected timeframe.
 */
import {
  DEFAULT_TIME_FRAME,
  TIMEFRAME_STORAGE_KEY,
  sanitizeTimeFrame,
  type TimeFrameKey,
} from "../config/chart.ts";

export { TIMEFRAME_STORAGE_KEY };

/** Storage shape shared with services/instruments.ts (injectable for tests). */
export interface TimeFrameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read the persisted timeframe. Missing, unreadable, corrupted or unregistered
 * values fall back to {@link DEFAULT_TIME_FRAME} — never throw, never leak a key
 * the registry does not contain (same guarded contract as `loadSelectedEpic`).
 */
export function loadTimeFrame(
  storage: TimeFrameStorage = window.localStorage,
): TimeFrameKey {
  try {
    return sanitizeTimeFrame(storage.getItem(TIMEFRAME_STORAGE_KEY));
  } catch {
    // private-mode / disabled storage — the default applies
    return DEFAULT_TIME_FRAME;
  }
}

/**
 * Persist the selected timeframe. The value is sanitized first, so a
 * programmatic caller can never write a key the registry does not contain.
 * Storage failures are swallowed — the selection simply stays session-only.
 */
export function saveTimeFrame(
  timeframe: TimeFrameKey,
  storage: TimeFrameStorage = window.localStorage,
): void {
  try {
    storage.setItem(TIMEFRAME_STORAGE_KEY, sanitizeTimeFrame(timeframe));
  } catch {
    /* storage unavailable — selection stays session-only */
  }
}