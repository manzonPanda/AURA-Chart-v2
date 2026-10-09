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
 * second source of truth).
 *
 * TWO VISIBILITY AXES for the built-in overlays:
 *   - `active` — is it in the list at all? `removeIndicator` clears it (the
 *     row disappears, like a Pine removal) and `setIndicatorActive` restores
 *     it with the PRESERVED period/color/width. Re-addables are surfaced by
 *     `listRemovedOverlays` for the Indicators menu.
 *   - `enabled` — listed but hidden (the eye toggle).
 * A still-listed (active) but hidden overlay stays in the legend so its eye
 * state remains visible while configurable (TradingView-style legend).
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
    // `active: false` = the user REMOVED this overlay → it is absent from the
    // list entirely (its period/color/width stay in EmaSettings for re-adding).
    // `active: true, enabled: false` = listed-but-hidden, so the eye state
    // remains visible while configurable (TradingView-style legend).
    if (!cfg || !cfg.active) continue;
    rows.push({
      id: slot.id,
      kind: "ema",
      name: `EMA ${cfg.period}`,
      visible: cfg.enabled,
      color: cfg.color,
    });
  }
  if (sma && sma.active) {
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
    // A REMOVED overlay has no row to eye-toggle; re-add it first.
    if (!cur || !cur.active || cur.enabled === visible) return {};
    return { ema: { ...ema, [id]: { ...cur, enabled: visible } } };
  }
  if (id === "sma") {
    if (!sma || !sma.active || sma.enabled === visible) return {};
    return { sma: { ...sma, enabled: visible } };
  }
  const ind = pine.find((x) => x.id === id);
  if (!ind || ind.enabled === visible) return {};
  return { pine: pine.map((x) => (x.id === id ? { ...x, enabled: visible } : x)) };
}

/**
 * Remove ONE indicator.
 *
 *  - Pine scripts: dropped from the imported list (unchanged — a real removal).
 *  - EMA/SMA built-ins: `active: false`. That makes the overlay disappear from
 *    the active-indicator list entirely — the same visible outcome as a Pine
 *    removal — while `period` / `color` / `width` / `source` are PRESERVED so
 *    {@link setIndicatorActive} can restore the user's exact configuration.
 *    The MA Structure panel is NOT consulted: it computes its own EMA/SMA from
 *    candles and never reads indicator state.
 *
 * Note `enabled` is deliberately left untouched on removal (a hidden overlay
 * re-added stays hidden); only the eye toggle or re-adding flips it.
 */
export function removeIndicator(
  ema: EmaSettings,
  sma: SmaSettings | null | undefined,
  pine: readonly ImportedPineIndicator[],
  id: string,
): ActiveIndicatorPatch {
  if (id === "ema9" || id === "ema20") {
    const cur = ema[id];
    if (!cur || !cur.active) return {};
    return { ema: { ...ema, [id]: { ...cur, active: false } } };
  }
  if (id === "sma") {
    if (!sma || !sma.active) return {};
    return { sma: { ...sma, active: false } };
  }
  if (!pine.some((x) => x.id === id)) return {};
  return { pine: pine.filter((x) => x.id !== id) };
}

/**
 * Re-add / remove a BUILT-IN overlay by toggling `active`.
 *
 * Re-adding restores the PRESERVED configuration (period, color, width,
 * source) rather than resetting it, and makes the overlay visible again —
 * "add this indicator" must visibly add it, or the removal fix would just
 * recreate the original confusion.
 *
 * Pine scripts have no equivalent: removal is final for them (unchanged).
 */
export function setIndicatorActive(
  ema: EmaSettings,
  sma: SmaSettings | null | undefined,
  active: boolean,
  id: string,
): ActiveIndicatorPatch {
  if (id === "ema9" || id === "ema20") {
    const cur = ema[id];
    if (!cur) return {};
    if (cur.active === active && (!active || cur.enabled)) return {};
    return {
      ema: {
        ...ema,
        [id]: active ? { ...cur, active: true, enabled: true } : { ...cur, active: false },
      },
    };
  }
  if (id === "sma") {
    if (!sma) return {};
    if (sma.active === active && (!active || sma.enabled)) return {};
    return { sma: active ? { ...sma, active: true, enabled: true } : { ...sma, active: false } };
  }
  return {}; // Pine indicators are not re-addable
}

/**
 * Built-in overlays the user removed and can restore, with the preserved
 * configuration to display. Powers the Indicators menu's "Overlays" section —
 * the single re-add surface for EMA/SMA (see IndicatorsMenu.tsx).
 */
export interface RemovedOverlay {
  id: string;
  kind: "ema" | "sma";
  /** Display name built from the PRESERVED period, e.g. "EMA 15". */
  name: string;
  color: string;
}

/** Enumerate removed built-in overlays (EMA slots in order, then SMA). */
export function listRemovedOverlays(
  ema: EmaSettings,
  sma: SmaSettings | null | undefined,
): RemovedOverlay[] {
  const out: RemovedOverlay[] = [];
  for (const slot of EMA_SLOTS) {
    const cfg = ema[slot.id];
    if (!cfg || cfg.active) continue;
    out.push({ id: slot.id, kind: "ema", name: `EMA ${cfg.period}`, color: cfg.color });
  }
  if (sma && !sma.active) {
    out.push({ id: "sma", kind: "sma", name: `SMA ${sma.period}`, color: sma.color });
  }
  return out;
}

/**
 * One row of the built-in overlay control list — the SINGLE derivation every
 * overlay UI reads (the MA Structure panel's settings popover uses it).
 *
 * Always returns ALL built-ins (both EMA slots + SMA), each tagged with its
 * two independent axes, so a settings surface can offer an eye for the active
 * ones and an "add" for the removed ones without a second source of truth.
 */
export interface BuiltInOverlayControl extends RemovedOverlay {
  /** Currently DRAWN on the chart (the eye toggle). */
  visible: boolean;
  /** Present in the chart legend at all (false = removed, needs re-adding). */
  active: boolean;
}

/** Built-in overlay rows (EMA slots in slot order, then SMA). */
export function listBuiltInOverlayControls(
  ema: EmaSettings,
  sma: SmaSettings | null | undefined,
): BuiltInOverlayControl[] {
  const out: BuiltInOverlayControl[] = [];
  for (const slot of EMA_SLOTS) {
    const cfg = ema[slot.id];
    if (!cfg) continue;
    out.push({
      id: slot.id,
      kind: "ema",
      name: `EMA ${cfg.period}`,
      color: cfg.color,
      visible: cfg.enabled,
      active: cfg.active,
    });
  }
  if (sma) {
    out.push({
      id: "sma",
      kind: "sma",
      name: `SMA ${sma.period}`,
      color: sma.color,
      visible: sma.enabled,
      active: sma.active,
    });
  }
  return out;
}