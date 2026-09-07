/**
 * The ƒx Indicators header button — ADD / IMPORT only.
 *
 * Per the indicator UX split:
 *   ƒx Indicators  → opens the Pine Script import flow (PineImportModal)
 *   Chart legend   → manage active indicators (show/hide/remove)
 *   ⚙ (legend)     → Indicator Settings modal (Inputs / Style)
 *
 * The old EMA/SMA configuration sections and the imported-indicator list were
 * removed from this surface — the upper-left ActiveIndicatorsOverlay and the
 * IndicatorSettingsModal own all management/configuration now. The import
 * flow itself is REUSED unchanged (no duplicate pipeline).
 */
import { useState } from "react";

import {
  MAX_IMPORTED_INDICATORS,
  type ImportedPineIndicator,
  type PineCompileStage,
  type PineImportOutcome,
} from "../../services/pineImport";
import { PineImportModal } from "./PineImportModal";

interface Props {
  /** Current imported-indicator count (enforces the import limit on the button). */
  importedCount: number;
  /** Full compile pipeline against the current chart candles (App-owned). */
  onCompile: (
    name: string,
    source: string,
    onStage?: (stage: PineCompileStage) => void,
  ) => Promise<PineImportOutcome>;
  /** Confirm-import AFTER the user reviews the diagnostics panel. */
  onImportConfirm: (indicator: ImportedPineIndicator) => void;
}

export function IndicatorsMenu({ importedCount, onCompile, onImportConfirm }: Props) {
  const [importOpen, setImportOpen] = useState(false);
  const atLimit = importedCount >= MAX_IMPORTED_INDICATORS;

  return (
    <div className="indicators">
      <button
        type="button"
        className="indicators-btn"
        aria-haspopup="dialog"
        title={
          atLimit
            ? `Import limit reached — at most ${MAX_IMPORTED_INDICATORS} imported indicators`
            : "Import a Pine Script indicator (compiled by the Piner engine)"
        }
        onClick={() => setImportOpen(true)}
        disabled={atLimit}
      >
        <span className="indicators-glyph" aria-hidden="true">ƒx</span>
        Indicators
      </button>
      {importOpen && (
        <PineImportModal
          onCompile={onCompile}
          onImportConfirm={onImportConfirm}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  );
}

