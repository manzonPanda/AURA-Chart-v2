import { useEffect, useRef, useState } from "react";

import {
  EMA_SLOTS,
  hexToRrggbb,
  type EmaSlotId,
  type EmaSettings,
} from "../../config/emaSettings";
import { MAX_EMA_PERIOD, MIN_EMA_PERIOD } from "../../services/ema";

interface Props {
  settings: EmaSettings;
  onChange: (next: EmaSettings) => void;
}

const WIDTHS = [1, 2, 3, 4] as const;

/** Return settings with one slot patched (immutable update). */
function patchSlot(
  settings: EmaSettings,
  id: EmaSlotId,
  patch: Partial<EmaSettings[EmaSlotId]>,
): EmaSettings {
  return { ...settings, [id]: { ...settings[id], ...patch } };
}

/**
 * Compact, trading-chart-style indicator control for the topbar — exactly the
 * two fixed EMA slots (no generic indicator system). The configuration state
 * lives in App (localStorage-persisted via emaSettings.ts).
 */
export function IndicatorsMenu({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<EmaSlotId | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const anyEnabled = EMA_SLOTS.some((slot) => settings[slot.id].enabled);

  return (
    <div className="indicators" ref={rootRef}>
      <button
        type="button"
        className={`indicators-btn${anyEnabled ? " active" : ""}`}
        aria-expanded={open}
        aria-haspopup="true"
        title="Indicator overlays (EMA)"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="indicators-glyph" aria-hidden="true">ƒx</span>
        Indicators
      </button>
      {open && (
        <div className="indicators-pop" aria-label="Indicator settings">
          {EMA_SLOTS.map((slot) => {
            const cfg = settings[slot.id];
            const isExpanded = expanded === slot.id;
            return (
              <div className={`ind-slot${isExpanded ? " expanded" : ""}`} key={slot.id}>
                <div className="ind-row">
                  <label className="ind-toggle" title={`${slot.label} overlay`}>
                    <input
                      type="checkbox"
                      checked={cfg.enabled}
                      onChange={(e) => onChange(patchSlot(settings, slot.id, { enabled: e.target.checked }))}
                    />
                    <span className="ind-swatch" style={{ background: cfg.color }} aria-hidden="true" />
                    {/* Name follows the configured period (e.g. "EMA 12"). */}
                    <span className="ind-name">EMA {cfg.period}</span>
                  </label>
                  <button
                    type="button"
                    className="ind-gear"
                    aria-label={`Configure ${slot.label}`}
                    aria-expanded={isExpanded}
                    onClick={() => setExpanded(isExpanded ? null : slot.id)}
                  >
                    {isExpanded ? "▾" : "▸"}
                  </button>
                </div>
                {isExpanded && (
                  <div className="ind-config">
                    <label className="ind-field">
                      <span>Period</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={MIN_EMA_PERIOD}
                        max={MAX_EMA_PERIOD}
                        step={1}
                        value={cfg.period}
                        onChange={(e) => {
                          // Commit ONLY valid positive integers — 0, negatives,
                          // floats, NaN and empty input are ignored (the
                          // controlled value keeps the last valid period).
                          const n = Math.floor(Number(e.target.value));
                          if (
                            e.target.value !== "" &&
                            Number.isFinite(n) &&
                            n >= MIN_EMA_PERIOD &&
                            n <= MAX_EMA_PERIOD
                          ) {
                            onChange(patchSlot(settings, slot.id, { period: n }));
                          }
                        }}
                      />
                    </label>
                    <label className="ind-field">
                      <span>Color</span>
                      <input
                        type="color"
                        value={hexToRrggbb(cfg.color)}
                        onChange={(e) => onChange(patchSlot(settings, slot.id, { color: e.target.value }))}
                      />
                    </label>
                    <label className="ind-field">
                      <span>Width</span>
                      <select
                        value={cfg.width}
                        onChange={(e) => onChange(patchSlot(settings, slot.id, { width: Number(e.target.value) }))}
                      >
                        {WIDTHS.map((w) => (
                          <option key={w} value={w}>
                            {w}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="ind-field ind-enabled">
                      <span>Enabled</span>
                      <input
                        type="checkbox"
                        checked={cfg.enabled}
                        onChange={(e) => onChange(patchSlot(settings, slot.id, { enabled: e.target.checked }))}
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
