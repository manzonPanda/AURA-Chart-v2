import { useEffect, useRef, useState } from "react";

import {
  EMA_SLOTS,
  type EmaSlotId,
  type EmaSettings,
} from "../../config/emaSettings";
import { MAX_EMA_PERIOD, MIN_EMA_PERIOD } from "../../services/ema";
import {
  MAX_IMPORTED_INDICATORS,
  isEditableInputType,
  type ImportedPineIndicator,
  type PineImportOutcome,
  type PineInputMetaSnapshot,
  type PineRunStatus,
} from "../../services/pineImport";
import { PineImportModal } from "./PineImportModal";

interface Props {
  settings: EmaSettings;
  onChange: (next: EmaSettings) => void;
  /** Imported Pine indicators (localStorage-persisted in App). */
  imported: ImportedPineIndicator[];
  /** Session runtime status per imported indicator id. */
  pineStatuses: Record<string, PineRunStatus>;
  onImportedChange: (next: ImportedPineIndicator[]) => void;
  /** Full compile pipeline against the current chart candles (App-owned). */
  onCompile: (name: string, source: string) => Promise<PineImportOutcome>;
  /** Confirm-import AFTER the user reviews the diagnostics panel. */
  onImportConfirm: (indicator: ImportedPineIndicator) => void;
}

const WIDTHS = [1, 2, 3, 4] as const;

/** Human label per visual type for the imported-indicator summary. */
const VISUAL_LABEL: Record<string, string> = {
  line: "line",
  histogram: "hist",
  area: "area",
  horizontal: "hline",
  marker: "markers",
};

/** "2 lines · 4 markers" style summary (or a no-output notice). */
function plotTypeSummary(plotMeta: ImportedPineIndicator["plotMeta"]): string {
  if (plotMeta.length === 0) return "no renderable outputs";
  const counts = new Map<string, number>();
  for (const p of plotMeta) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => `${n} ${VISUAL_LABEL[t] ?? t}`).join(" · ");
}

/** Return settings with one slot patched (immutable update). */
function patchSlot(
  settings: EmaSettings,
  id: EmaSlotId,
  patch: Partial<EmaSettings[EmaSlotId]>,
): EmaSettings {
  return { ...settings, [id]: { ...settings[id], ...patch } };
}

function clampNum(n: number, min?: number, max?: number): number {
  if (typeof min === "number" && Number.isFinite(min)) n = Math.max(min, n);
  if (typeof max === "number" && Number.isFinite(max)) n = Math.min(max, n);
  return n;
}

/** Any hex (#rgb/#rgba/#rrggbb/#rrggbbaa) → #rrggbb for <input type="color">. */
function toPickerHex(color: unknown): string {
  if (typeof color !== "string") return "#000000";
  const c = color.trim().toLowerCase();
  const m3 = /^#([0-9a-f]{3})$/.exec(c);
  if (m3) {
    const [a, b, d] = m3[1].split("");
    return `#${a}${a}${b}${b}${d}${d}`;
  }
  const m4 = /^#([0-9a-f]{4})$/.exec(c);
  if (m4) {
    const [a, b, d] = m4[1].split("");
    return `#${a}${a}${b}${b}${d}${d}`;
  }
  if (/^#[0-9a-f]{6,8}$/.test(c)) return c.slice(0, 7);
  return "#000000";
}

/** One imported-indicator input editor, driven by the compile-time metadata. */
function PineInputField({
  meta,
  value,
  onValue,
}: {
  meta: PineInputMetaSnapshot;
  value: unknown;
  onValue: (next: unknown) => void;
}) {
  const label = meta.title || meta.varId;
  if (!isEditableInputType(meta.type)) {
    return (
      <label className="ind-field" title={`${meta.type} inputs are read-only in this version`}>
        <span>{label}</span>
        <input type="text" value={String(value ?? "")} readOnly disabled />
      </label>
    );
  }
  switch (meta.type) {
    case "int": {
      const v = typeof value === "number" && Number.isInteger(value) ? value : meta.defval;
      return (
        <label className="ind-field">
          <span>{label}</span>
          <input
            type="number"
            inputMode="numeric"
            step={1}
            min={meta.minval}
            max={meta.maxval}
            value={typeof v === "number" ? v : 0}
            onChange={(e) => {
              // Commit only valid integers — clamped into the script's range.
              const n = Math.floor(Number(e.target.value));
              if (e.target.value !== "" && Number.isFinite(n)) onValue(clampNum(n, meta.minval, meta.maxval));
            }}
          />
        </label>
      );
    }
    case "float": {
      const v = typeof value === "number" && Number.isFinite(value) ? value : meta.defval;
      return (
        <label className="ind-field">
          <span>{label}</span>
          <input
            type="number"
            inputMode="decimal"
            step={meta.step ?? 0.1}
            min={meta.minval}
            max={meta.maxval}
            value={typeof v === "number" ? v : 0}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (e.target.value !== "" && Number.isFinite(n)) onValue(clampNum(n, meta.minval, meta.maxval));
            }}
          />
        </label>
      );
    }
    case "bool":
      return (
        <label className="ind-field ind-enabled">
          <span>{label}</span>
          <input type="checkbox" checked={value === true} onChange={(e) => onValue(e.target.checked)} />
        </label>
      );
    case "color":
      return (
        <label className="ind-field">
          <span>{label}</span>
          <input
            type="color"
            value={toPickerHex(value ?? meta.defval)}
            onChange={(e) => onValue(e.target.value)}
          />
        </label>
      );
    case "string":
      return meta.options ? (
        <label className="ind-field">
          <span>{label}</span>
          <select value={String(value ?? meta.options[0])} onChange={(e) => onValue(e.target.value)}>
            {meta.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="ind-field">
          <span>{label}</span>
          <input
            type="text"
            maxLength={200}
            value={String(value ?? "")}
            onChange={(e) => onValue(e.target.value)}
          />
        </label>
      );
    default:
      return null;
  }
}

/**
 * Compact, trading-chart-style indicator control for the topbar.
 *
 *   Built-in  — the two fixed EMA slots (unchanged, first-class AURA indicators)
 *   Imported  — user Pine Scripts executed by the PineTS engine, with a
 *               "+ Import Pine Script" entry point and per-script input editors
 *
 * Configuration state lives in App (localStorage-persisted via emaSettings.ts
 * and services/pineImport.ts).
 */
export function IndicatorsMenu({ settings, onChange, imported, pineStatuses, onImportedChange, onCompile, onImportConfirm }: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<EmaSlotId | string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
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
                        value={toPickerHex(cfg.color)}
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

          {/* ── Imported Pine indicators ─────────────────────────────────── */}
          {imported.length > 0 && (
            <>
              <div className="ind-divider" role="separator" />
              <div className="ind-section">Imported</div>
              {imported.map((ind) => {
                const isExpanded = expanded === ind.id;
                const status = pineStatuses[ind.id];
                const swatch = ind.plotMeta.find((p) => p.color)?.color ?? "var(--accent)";
                return (
                  <div className={`ind-slot${isExpanded ? " expanded" : ""}`} key={ind.id}>
                    <div className="ind-row">
                      <label className="ind-toggle" title={`${ind.name} (imported Pine Script)`}>
                        <input
                          type="checkbox"
                          checked={ind.enabled}
                          onChange={(e) =>
                            onImportedChange(
                              imported.map((x) => (x.id === ind.id ? { ...x, enabled: e.target.checked } : x)),
                            )
                          }
                        />
                        <span className="ind-swatch" style={{ background: swatch }} aria-hidden="true" />
                        <span className="ind-name">{ind.name}</span>
                      </label>
                      {status && !status.ok && (
                        <span
                          className="pine-chip-err"
                          title={status.message ?? "Runtime error"}
                          aria-label={`${ind.name} runtime error`}
                        >
                          ⚠
                        </span>
                      )}
                      {ind.diagnostics && ind.diagnostics.unsupported.length > 0 && (
                        <span
                          className="pine-chip-compat"
                          title={`Script uses outputs AURA doesn't render yet: ${ind.diagnostics.unsupported
                            .map((u) => `${u.kind} ×${u.count}`)
                            .join(", ")}`}
                          aria-label={`${ind.name} partial compatibility`}
                        >
                          ◆
                        </span>
                      )}
                      {!ind.overlay && (
                        <span className="ind-pane-tag" title="Renders in its own chart pane (overlay=false)">
                          pane
                        </span>
                      )}
                      <button
                        type="button"
                        className="ind-gear"
                        aria-label={`Configure ${ind.name}`}
                        aria-expanded={isExpanded}
                        onClick={() => setExpanded(isExpanded ? null : ind.id)}
                      >
                        {isExpanded ? "▾" : "▸"}
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="ind-config">
                        <div className="ind-meta-note">
                          {plotTypeSummary(ind.plotMeta)}
                          {ind.inputMeta.length > 0 ? ` · ${ind.inputMeta.length} input${ind.inputMeta.length === 1 ? "" : "s"}` : ""}
                          {" · "}
                          {ind.overlay ? "overlay" : "separate pane"}
                        </div>
                        {ind.diagnostics && ind.diagnostics.unsupported.length > 0 && (
                          <div className="ind-meta-note ind-meta-warn">
                            Not rendered:{" "}
                            {ind.diagnostics.unsupported.map((u) => `${u.kind} ×${u.count}`).join(", ")}
                          </div>
                        )}
                        {ind.inputMeta.map((m) => (
                          <PineInputField
                            key={m.varId}
                            meta={m}
                            value={ind.inputs[m.varId]}
                            onValue={(v) =>
                              onImportedChange(
                                imported.map((x) =>
                                  x.id === ind.id ? { ...x, inputs: { ...x.inputs, [m.varId]: v } } : x,
                                ),
                              )
                            }
                          />
                        ))}
                        <button
                          type="button"
                          className="ind-remove"
                          onClick={() => {
                            onImportedChange(imported.filter((x) => x.id !== ind.id));
                            if (expanded === ind.id) setExpanded(null);
                          }}
                        >
                          Remove indicator
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          <div className="ind-divider" role="separator" />
          <button
            type="button"
            className="ind-import-btn"
            onClick={() => setImportOpen(true)}
            disabled={imported.length >= MAX_IMPORTED_INDICATORS}
            title={
              imported.length >= MAX_IMPORTED_INDICATORS
                ? `Limit reached — at most ${MAX_IMPORTED_INDICATORS} imported indicators`
                : "Compile a Pine Script indicator through the PineTS engine"
            }
          >
            + Import Pine Script
          </button>
        </div>
      )}
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

