/**
 * Active-indicator legend model — the single derivation of the chart's
 * upper-left indicator list from the EXISTING indicator state slices.
 *
 * Pure + framework-free (no React, no DOM) so it runs identically in the
 * chart overlay and in AURA's Node test runner.
 *
 * This module does NOT own any indicator state — it only reads/patches the
 * existing App-owned slices (emaSettings / smaSettings / importedPine) and
 * returns the minimal immutable change for one action. The ordering matches
 * the Indicators menu: EMA slots → SMA → imported Pine (deterministic, no
 * second source of truth). Hidden indicators stay listed so their eye state
 * remains visible while configurable (TradingView-style legend).
 */
import { EMA_SLOTS, type EmaSettings } from "../config/emaSettings.ts";
import type { SmaSettings } from "../config/smaSettings.ts";
import type { ImportedPineIndicator } from "./pineImport.ts";

/** Canonical list-row id — the same key the Indicators menu uses to expand
 *  settings, so the overlay's gear can open the existing settings panel. */
export type ActiveIndicatorId = string;

/** One row of the upper-left indicator legend. */
export interface ActiveIndicatorRow {
  /** Canonical state/UI key (ema9 | ema20 | sma | Pine id). */
  id: string;
  kind: "ema" | "sma" | "pine";
  /** Display name (e.g. "EMA 12", "SMA 50", the Pine script's name). */
  name: string;
  /** Whether the indicator is currently drawn on the chart. */
  visible: boolean;
  /** Swatch color — mirrors the Indicators menu's per-indicator color. */
  color: string;
}

/** Minimal immutable patch — only the state slice(s) an action touched. */
export interface ActiveIndicatorPatch {
  ema?: EmaSettings;
  sma?: SmaSettings;
  pine?: ImportedPineIndicator[];
}

/** Same swatch logic as the Indicators menu (first colored plot, else accent). */
function pineSwatch(ind: ImportedPineIndicator): string {
  return ind.plotMeta.find((p) => p.color)?.color ?? "var(--accent)";
}

/**
 * Build the ordered legend rows from the existing indicator state.
 * Order: EMA slots (EMA_SLOTS order) → SMA (when configured) → imported
 * Pine scripts (array order).
 */
export function buildActiveIndicatorList(
  ema: EmaSettings,
  sma: SmaSettings | null | undefined,
  pine: readonly ImportedPineIndicator[] = [],
): ActiveIndicatorRow[] {
  const rows: ActiveIndicatorRow[] = [];
  for (const slot of EMA_SLOTS) {
    const cfg = ema[slot.id];
    rows.push({
      id: slot.id,
      kind: "ema",
      name: `EMA ${cfg.period}`,
      visible: cfg.enabled,
      color: cfg.color,
    });
  }
  if (sma) {
    rows.push({
      id: "sma",
      kind: "sma",
      name: `SMA ${sma.period}`,
      visible: sma.enabled,
      color: sma.color,
    });
  }
  for (const ind of pine) {
    rows.push({
      id: ind.id,
      kind: "pine",
      name: ind.name,
      visible: ind.enabled,
      color: pineSwatch(ind),
    });
  }
  return rows;
}

/**
 * Show/hide ONE indicator (eye toggle). Preserves the indicator's entire
 * configuration — only the enabled/visible flag changes, through the SAME
 * state the Indicators menu edits (no duplication, no recreate).
 */
export function setIndicatorVisible(
  ema: EmaSettings,
  sma: SmaSettings | null | undefined,
  pine: readonly ImportedPineIndicator[],
  id: string,
  visible: boolean,
): ActiveIndicatorPatch {
  if (id === "ema9" || id === "ema20") {
    const cur = ema[id];
    if (!cur || cur.enabled === visible) return {};
    return { ema: { ...ema, [id]: { ...cur, enabled: visible } } };
  }
  if (id === "sma") {
    if (!sma || sma.enabled === visible) return {};
    return { sma: { ...sma, enabled: visible } };
  }
  const ind = pine.find((x) => x.id === id);
  if (!ind || ind.enabled === visible) return {};
  return { pine: pine.map((x) => (x.id === id ? { ...x, enabled: visible } : x)) };
}

/**
 * Remove ONE indicator, using the existing removal/disable lifecycle:
 *  - Pine scripts: dropped from the imported list (same as the menu's
 *    "Remove indicator" — the only true removal for them).
 *  - EMA/SMA: AURA's EMA/SMA are intentionally FIXED slots (emaSettings /
 *    smaSettings are static records, no per-instance list), so "delete" =
 *    the indicator's disabled state — the same removal surface the existing
 *    menu exposes. Configuration is preserved (re-enable restores the line).
 */
export function removeIndicator(
  ema: EmaSettings,
  sma: SmaSettings | null | undefined,
  pine: readonly ImportedPineIndicator[],
  id: string,
): ActiveIndicatorPatch {
  if (id === "ema9" || id === "ema20") {
    const cur = ema[id];
    if (!cur || !cur.enabled) return {};
    return { ema: { ...ema, [id]: { ...cur, enabled: false } } };
  }
  if (id === "sma") {
    if (!sma || !sma.enabled) return {};
    return { sma: { ...sma, enabled: false } };
  }
  if (!pine.some((x) => x.id === id)) return {};
  return { pine: pine.filter((x) => x.id !== id) };
}