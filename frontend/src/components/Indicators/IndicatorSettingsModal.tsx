/**
 * Indicator Settings modal — the ⚙ entry point from the chart's
 * ActiveIndicatorsOverlay (the single settings surface for the EMA slots,
 * SMA, and imported Pine indicators).
 *
 * Exactly TWO tabs:
 *   Inputs — the indicator's computation inputs (Length / Source for EMA/SMA;
 *            the script's input.* editors for imported Pine indicators).
 *   Style  — visual properties only (Color / Width — exactly what the LWC
 *            LineSeries pipeline supports end-to-end; nothing fake).
 *
 * Draft semantics: the modal edits a CLONE of the target's configuration and
 * commits on Apply only — Cancel, ×, backdrop and Escape all discard. No
 * duplicate indicator state: Apply routes into the SAME App-owned slices
 * (emaSettings / smaSettings / importedPine) every other surface edits.
 */
import { useEffect, useState } from "react";

import { MAX_EMA_PERIOD, MIN_EMA_PERIOD } from "../../services/ema";
import {
  PRICE_SOURCES,
  PRICE_SOURCE_LABEL,
  type PriceSource,
} from "../../services/priceSource";
import { SMA_PERIODS, type SmaConfig } from "../../config/smaSettings";
import type { EmaConfig, EmaSlotId } from "../../config/emaSettings";
import {
  isEditableInputType,
  type ImportedPineIndicator,
  type PineInputMetaSnapshot,
  type PineRunStatus,
} from "../../services/pineImport";

/** Which indicator the modal edits — built from the EXISTING App state. */
export type SettingsTarget =
  | { kind: "ema"; slotId: EmaSlotId; label: string; config: EmaConfig }
  | { kind: "sma"; label: string; config: SmaConfig }
  | {
      kind: "pine";
      id: string;
      indicator: ImportedPineIndicator;
      status?: PineRunStatus | null;
    };

/** What Apply commits — App routes it into the existing state slices. */
export type SettingsApply =
  | { kind: "ema"; slotId: EmaSlotId; config: EmaConfig }
  | { kind: "sma"; config: SmaConfig }
  | { kind: "pine"; id: string; inputs: Record<string, unknown> };

interface Props {
  target: SettingsTarget;
  onApply: (next: SettingsApply) => void;
  onCancel: () => void;
}

const WIDTHS = [1, 2, 3, 4] as const;

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

/** One imported-Pine input editor, driven by the compile-time metadata. */
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
 * The modal. Keyed by App (`key={kind:id}`) so switching indicators remounts
 * with a FRESH draft — never a stale clone of the previous target.
 */
export function IndicatorSettingsModal({ target, onApply, onCancel }: Props) {
  const [tab, setTab] = useState<"inputs" | "style">("inputs");
  const [emaDraft, setEmaDraft] = useState<EmaConfig | null>(() =>
    target.kind === "ema" ? { ...target.config } : null,
  );
  const [smaDraft, setSmaDraft] = useState<SmaConfig | null>(() =>
    target.kind === "sma" ? { ...target.config } : null,
  );
  const [pineInputs, setPineInputs] = useState<Record<string, unknown> | null>(() =>
    target.kind === "pine" ? { ...target.indicator.inputs } : null,
  );

  // Escape = Cancel (discard draft).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const isPine = target.kind === "pine";
  const label = isPine ? target.indicator.name : target.label;

  /** Patch the active EMA/SMA draft (identical field names by design). */
  const patchCfg = (p: Partial<Pick<EmaConfig, "period" | "source" | "color" | "width">>): void => {
    if (target.kind === "ema" && emaDraft) setEmaDraft({ ...emaDraft, ...p });
    else if (target.kind === "sma" && smaDraft) setSmaDraft({ ...smaDraft, ...p });
  };
  const activeCfg: Partial<EmaConfig> | null =
    target.kind === "ema" ? emaDraft : target.kind === "sma" ? smaDraft : null;

  const apply = (): void => {
    if (target.kind === "ema" && emaDraft) onApply({ kind: "ema", slotId: target.slotId, config: emaDraft });
    else if (target.kind === "sma" && smaDraft) onApply({ kind: "sma", config: smaDraft });
    else if (target.kind === "pine" && pineInputs) onApply({ kind: "pine", id: target.id, inputs: pineInputs });
  };

  return (
    <div
      className="pine-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="iset-modal" role="dialog" aria-modal="true" aria-label={`Indicator Settings — ${label}`}>
        <div className="iset-head">
          <h3>Indicator Settings</h3>
          <button type="button" className="iset-close" aria-label="Close (discard changes)" title="Close" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="iset-name">{label}</div>

        <div className="iset-tabs" role="tablist" aria-label="Settings sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "inputs"}
            className={`iset-tab${tab === "inputs" ? " active" : ""}`}
            onClick={() => setTab("inputs")}
          >
            Inputs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "style"}
            className={`iset-tab${tab === "style" ? " active" : ""}`}
            onClick={() => setTab("style")}
          >
            Style
          </button>
        </div>

        <div className="iset-body">
          {/* __BODY__ */}
          {tab === "inputs" && !isPine && activeCfg && (
            <>
              {target.kind === "ema" ? (
                <label className="ind-field">
                  <span>Length</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={MIN_EMA_PERIOD}
                    max={MAX_EMA_PERIOD}
                    step={1}
                    value={activeCfg.period ?? 9}
                    onChange={(e) => {
                      // Commit ONLY valid positive integers — the controlled
                      // value keeps the last valid period otherwise.
                      const n = Math.floor(Number(e.target.value));
                      if (e.target.value !== "" && isValidEmaPeriod(n)) patchCfg({ period: n });
                    }}
                  />
                </label>
              ) : (
                <label className="ind-field">
                  <span>Length</span>
                  <select
                    value={activeCfg.period ?? 20}
                    onChange={(e) => patchCfg({ period: Number(e.target.value) })}
                  >
                    {SMA_PERIODS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="ind-field">
                <span>Source</span>
                <select
                  value={activeCfg.source ?? "close"}
                  onChange={(e) => patchCfg({ source: e.target.value as PriceSource })}
                >
                  {PRICE_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {PRICE_SOURCE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {tab === "inputs" && isPine && (
            <>
              {target.status && !target.status.ok && (
                <div className="iset-note warn" role="status">
                  ⚠ {target.status.message ?? "Runtime error"} — the indicator is not drawing.
                </div>
              )}
              {target.indicator.inputMeta.length === 0 ? (
                <div className="iset-note">This script declares no configurable inputs.</div>
              ) : (
                target.indicator.inputMeta.map((m) => (
                  <PineInputField
                    key={m.varId}
                    meta={m}
                    value={pineInputs?.[m.varId]}
                    onValue={(v) => setPineInputs((prev) => ({ ...(prev ?? {}), [m.varId]: v }))}
                  />
                ))
              )}
            </>
          )}

          {/* __STYLE__ */}
          {tab === "style" && !isPine && activeCfg && (
            <>
              <label className="ind-field">
                <span>Color</span>
                <input
                  type="color"
                  value={toPickerHex(activeCfg.color)}
                  onChange={(e) => patchCfg({ color: e.target.value })}
                />
              </label>
              <label className="ind-field">
                <span>Width</span>
                <select
                  value={activeCfg.width ?? 2}
                  onChange={(e) => patchCfg({ width: Number(e.target.value) })}
                >
                  {WIDTHS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {tab === "style" && isPine && (
            <div className="iset-note">
              Line colors and styles are defined by the Pine script itself.
              {(() => {
                const colored = target.indicator.plotMeta.filter((p) => p.color);
                if (colored.length === 0) return null;
                return (
                  <span className="iset-swatches">
                    {colored.map((p) => (
                      <span key={`${p.type}:${p.key}`} className="iset-swatch" title={p.title ?? p.key}>
                        <span className="iset-swatch-dot" style={{ background: p.color }} aria-hidden="true" />
                        {p.title ?? p.key}
                      </span>
                    ))}
                  </span>
                );
              })()}
            </div>
          )}
        </div>

        <div className="iset-foot">
          <button type="button" className="iset-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="iset-btn primary" onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/** Strict EMA period check for the Length input (mirrors services/ema.ts). */
function isValidEmaPeriod(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_EMA_PERIOD && n <= MAX_EMA_PERIOD;
}