/**
 * Moving Average Structure PANEL VISIBILITY preference — PURE helpers
 * (no React, no chart, no websocket).
 *
 * This is a PRESENTATION preference ONLY. It decides whether the
 * MaStructurePanel overlay is rendered at all — it never touches EMA9 /
 * EMA20 / SMA20, the chart's indicator bridges (EmaBridge / SmaBridge), MA
 * alerts, candle data, the timeframe registry, the viewport or the realtime
 * feed. Hiding the panel is the same class of change as hiding a legend: the
 * chart keeps calculating and streaming exactly as before.
 *
 * Architecture notes:
 *  - Deliberately NOT a ChartSettings field. `config/chartSettings.ts` is the
 *    chart TEMPLATE state (see `config/chartTemplates.ts` snapshots the whole
 *    settings object), so a panel-visibility flag stored there would let
 *    applying a template silently hide or reveal a panel the user did not
 *    touch. This lives in its own versioned key instead — the same reasoning
 *    `services/timeframeSelection.ts` documents for the timeframe choice.
 *  - Deliberately NOT lifted into App / a new global store: the panel is a
 *    single self-contained overlay, so one `useState` inside it is the
 *    smallest change consistent with the rest of the chart (same shape as
 *    ScrollToLatestButton's local visibility state).
 *  - Persistence uses AURA's OWN guarded-localStorage convention (see
 *    `config/chartSettings.ts` / `services/instruments.ts`): missing,
 *    unreadable, corrupted or storage-denied all fall back to the DEFAULT,
 *    and a failed write is swallowed so the preference simply stays
 *    session-only.
 */

/**
 * Versioned localStorage key for the panel's visibility ONLY. Versioned
 * because the stored value's contract could change; anything unrecognised
 * under it is ignored in favour of the default.
 */
export const MA_STRUCTURE_VISIBILITY_STORAGE_KEY = "aura.ma.structure.visibility.v1";

/**
 * The panel is VISIBLE by default: an existing user (and any first-time
 * visitor) keeps the full Moving Average Structure readout until they opt
 * out. Hidden state is always the explicit choice.
 */
export const MA_STRUCTURE_VISIBLE_BY_DEFAULT = true;

/** Storage surface shared with the other AURA preference modules (injectable
 *  for tests; defaults to `window.localStorage`). */
export interface MaStructureVisibilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Validate an arbitrary (possibly corrupted, legacy or hand-edited) stored
 * value into a usable boolean.
 *
 * Accepts the booleans this module writes — the JSON forms `"true"` /
 * `"false"` — plus bare `true` / `false` and the bare strings, so a value
 * typed by hand in devtools still resolves. Everything else (null, `""`,
 * `"0"`, `"yes"`, `{}`, numbers) falls back to
 * {@link MA_STRUCTURE_VISIBLE_BY_DEFAULT} rather than guessing.
 */
export function sanitizeMaStructureVisible(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return MA_STRUCTURE_VISIBLE_BY_DEFAULT;
  const v = raw.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  // JSON-quoted forms, e.g. a hand-edited `"false"`.
  if (v === '"true"') return true;
  if (v === '"false"') return false;
  return MA_STRUCTURE_VISIBLE_BY_DEFAULT;
}

/**
 * storage → visibility (guarded: missing / unreadable / corrupted /
 * private-mode → the default VISIBLE state).
 */
export function loadMaStructureVisible(
  storage: MaStructureVisibilityStorage = window.localStorage,
): boolean {
  try {
    return sanitizeMaStructureVisible(storage.getItem(MA_STRUCTURE_VISIBILITY_STORAGE_KEY));
  } catch {
    // private mode / disabled storage — the panel simply shows
    return MA_STRUCTURE_VISIBLE_BY_DEFAULT;
  }
}

/**
 * visibility → storage (guarded write: a storage failure is non-fatal, the
 * preference stays session-only and the panel keeps working).
 */
export function saveMaStructureVisible(
  visible: boolean,
  storage: MaStructureVisibilityStorage = window.localStorage,
): void {
  try {
    storage.setItem(
      MA_STRUCTURE_VISIBILITY_STORAGE_KEY,
      JSON.stringify(sanitizeMaStructureVisible(visible)),
    );
  } catch {
    /* storage unavailable — preference stays session-only */
  }
}

/**
 * The toggle transition, extracted so the flip is testable without a
 * renderer: visible ⇒ hide, hidden ⇒ show. Pure, total, never throws.
 */
export function toggleMaStructureVisible(visible: boolean): boolean {
  return !sanitizeMaStructureVisible(visible);
}