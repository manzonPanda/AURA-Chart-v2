/**
 * Upper-left chart legend of the ACTIVE indicators — a compact
 * TradingView-style control overlay anchored INSIDE the chart plot area
 * (sibling of ChartView in `.chart-canvas-wrap`, so it repositions with the
 * chart, never with the page).
 *
 * Every row mirrors the EXISTING indicator state: name, visibility
 * (eye), settings (gear → the existing Indicators menu, expanded at that
 * indicator) and delete. No duplicate state is created — actions translate
 * straight into the same emaSettings / smaSettings / importedPine slices the
 * Indicators menu edits, so the menu and the legend can never disagree.
 *
 * UX: the normal state shows ONLY the names (lightweight chart legend).
 * Hovering a row reveals that row's eye/gear/trash controls in place —
 * the control area is width-reserved in CSS so the name never shifts.
 */
import { useMemo } from "react";

import type { EmaSettings } from "../../config/emaSettings";
import type { SmaSettings } from "../../config/smaSettings";
import type { ImportedPineIndicator } from "../../services/pineImport";
import {
  buildActiveIndicatorList,
  removeIndicator,
  setIndicatorVisible,
  type ActiveIndicatorPatch,
} from "../../services/activeIndicators";

interface Props {
  /** Existing App-owned indicator state (single source of truth). */
  emaSettings: EmaSettings;
  smaSettings: SmaSettings | null | undefined;
  imported: readonly ImportedPineIndicator[];
  /** Existing App setters — the SAME handlers the Indicators menu uses. */
  onEmaChange: (next: EmaSettings) => void;
  onSmaChange: (next: SmaSettings) => void;
  /** Imported Pine indicator list setter. */
  onPineChange: (next: ImportedPineIndicator[]) => void;
  /** Opens the existing Indicators settings UI at a specific indicator
   *  (canonical id from the legend row: ema9 / ema20 / sma / Pine id). */
  onOpenSettings: (id: string) => void;
}

export function ActiveIndicatorsOverlay({
  emaSettings,
  smaSettings,
  imported,
  onEmaChange,
  onSmaChange,
  onPineChange,
  onOpenSettings,
}: Props) {
  const rows = useMemo(
    () => buildActiveIndicatorList(emaSettings, smaSettings, imported),
    [emaSettings, smaSettings, imported],
  );

  // Nothing configured → no overlay (the legend only ever reflects state).
  if (rows.length === 0) return null;

  const apply = (patch: ActiveIndicatorPatch): void => {
    if (patch.ema) onEmaChange(patch.ema);
    if (patch.sma) onSmaChange(patch.sma);
    if (patch.pine) onPineChange(patch.pine);
  };

  return (
    <div className="active-indicators" aria-label="Active indicators">
      {rows.map((row) => (
        <div
          className={`active-indicators-row${row.visible ? "" : " is-hidden"}`}
          key={row.id}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {/* Indicator name + color swatch */}
          <span className="active-indicators-swatch" style={{ background: row.color }} aria-hidden="true" />
          <span className="active-indicators-name" title={row.name}>
            {row.name}
          </span>

          <span className="active-indicators-ctl" role="group" aria-label={`Controls for ${row.name}`}>
            <button
              type="button"
              className="active-indicators-btn"
              aria-label={row.visible ? `Hide ${row.name}` : `Show ${row.name}`}
              title="Show/Hide"
              onClick={(e) => {
                e.stopPropagation();
                apply(setIndicatorVisible(emaSettings, smaSettings, imported, row.id, !row.visible));
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {row.visible ? <EyeIcon /> : <EyeOffIcon />}
            </button>
            <button
              type="button"
              className="active-indicators-btn"
              aria-label={`Settings for ${row.name}`}
              title="Settings"
              onClick={(e) => {
                e.stopPropagation();
                onOpenSettings(row.id);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <GearIcon />
            </button>
            <button
              type="button"
              className="active-indicators-btn active-indicators-btn--rm"
              aria-label={`Remove ${row.name}`}
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                apply(removeIndicator(emaSettings, smaSettings, imported, row.id));
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <TrashIcon />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

/** 12x12 inline SVG icons — `currentColor`, no external assets. */
function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0 1.51-1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
