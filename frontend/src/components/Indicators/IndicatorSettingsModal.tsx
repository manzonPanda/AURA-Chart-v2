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
  isPriceSource,
  type PriceSource,
} from "../../services/priceSource";
import { SMA_PERIODS, type SmaConfig } from "../../config/smaSettings";
import type { EmaConfig, EmaSlotId } from "../../config/emaSettings";
import {
  groupPineInputMeta,
  isEditableInputType,
  sanitizeInputValue,
  type ImportedPineIndicator,
  type PineInputMetaSnapshot,
  type PineRunStatus,
} from "../../services/pineImport";
import {
  isDefaultPlotStyle,
  PINE_PLOT_WIDTHS,
  type PinePlotStyleOverride,
  type PineStyleOverrides,
} from "../../services/pineStyle";

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
  | {
      kind: "pine";
      id: string;
      inputs: Record<string, unknown>;
      /** Style-tab overrides (render-level) — empty object = script styling. */
      style: PineStyleOverrides;
    };

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

/**
 * One imported-Pine input editor, driven by the compile-time metadata.
 * `onValue(null)` removes the override — the script's declared default then
 * applies (used by the source picker's "Default (script)" entry; the engine
 * boundary omits null keys, so the default series is never clobbered).
 */
function PineInputField({
  meta,
  value,
  onValue,
}: {
  meta: PineInputMetaSnapshot;
  value: unknown;
  onValue: (next: unknown | null) => void;
}) {
  const label = meta.title || meta.varId;
  const tooltip = typeof meta.tooltip === "string" && meta.tooltip.length > 0 ? meta.tooltip : undefined;
  if (!isEditableInputType(meta.type)) {
    return (
      <label className="ind-field" title={tooltip ?? `${meta.type} inputs cannot be edited yet`}>
        <span>{label}</span>
        <input
          type="text"
          value={String(value ?? meta.defval ?? "")}
          readOnly
          disabled
          title={`${meta.type} — the Pine engine doesn't support overriding this input kind yet`}
        />
      </label>
    );
  }
  switch (meta.type) {
    case "int": {
      const v = typeof value === "number" && Number.isInteger(value) ? value : meta.defval;
      return (
        <label className="ind-field" title={tooltip}>
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
        <label className="ind-field" title={tooltip}>
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
        <label className="ind-field ind-enabled" title={tooltip}>
          <span>{label}</span>
          <input type="checkbox" checked={value === true} onChange={(e) => onValue(e.target.checked)} />
        </label>
      );
    case "color":
      return (
        <label className="ind-field" title={tooltip}>
          <span>{label}</span>
          <input
            type="color"
            value={toPickerHex(value ?? meta.defval)}
            onChange={(e) => onValue(e.target.value)}
          />
        </label>
      );
    case "source":
      // TradingView-style price-source picker. "" = "Default (script)" — the
      // override key is REMOVED so the script's declared series applies (the
      // engine metadata does not expose the default expression's name).
      return (
        <label className="ind-field" title={tooltip}>
          <span>{label}</span>
          <select
            value={typeof value === "string" && isPriceSource(value) ? value : ""}
            onChange={(e) => onValue(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">Default (script)</option>
            {PRICE_SOURCES.map((s) => (
              <option key={s} value={s}>
                {PRICE_SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      );
    case "string":
      return meta.options ? (
        <label className="ind-field" title={tooltip}>
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
        <label className="ind-field" title={tooltip}>
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
  // Style-tab draft — overrides keyed by plot key (render-level only).
  const [pineStyle, setPineStyle] = useState<PineStyleOverrides | null>(() =>
    target.kind === "pine" ? { ...(target.indicator.style ?? {}) } : null,
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
    else if (target.kind === "pine")
      onApply({ kind: "pine", id: target.id, inputs: pineInputs ?? {}, style: pineStyle ?? {} });
  };

  /** One Pine input edit — `null` removes the override (script default wins). */
  const patchPineInput = (varId: string, next: unknown | null): void => {
    setPineInputs((prev) => {
      const out = { ...(prev ?? {}) };
      if (next === null) delete out[varId];
      else out[varId] = next;
      return out;
    });
  };

  /** One Style-tab edit — identity-valued overrides are pruned immediately. */
  const patchPineStyle = (key: string, patch: Partial<PinePlotStyleOverride>): void => {
    setPineStyle((prev) => {
      const out: PineStyleOverrides = { ...(prev ?? {}) };
      const merged: PinePlotStyleOverride = { ...(out[key] ?? {}), ...patch };
      if (isDefaultPlotStyle(merged)) delete out[key];
      else out[key] = merged;
      return out;
    });
  };

  /** Defaults — restore every input to the script's declared value and drop
      all style overrides (the import-time `inputs0` shape, exactly). */
  const resetPineDefaults = (): void => {
    if (target.kind !== "pine") return;
    const fresh: Record<string, unknown> = {};
    for (const m of target.indicator.inputMeta) {
      const v = sanitizeInputValue(m, undefined);
      if (v !== null && v !== undefined) fresh[m.varId] = v;
    }
    setPineInputs(fresh);
    setPineStyle({});
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
                groupPineInputMeta(target.indicator.inputMeta).map((grp) => (
                  <div className="iset-group" key={grp.group ?? "__ungrouped"}>
                    {grp.group !== null && <div className="iset-group-title">{grp.group}</div>}
                    {grp.items.map((m) => (
                      <PineInputField
                        key={m.varId}
                        meta={m}
                        value={pineInputs?.[m.varId]}
                        onValue={(v) => patchPineInput(m.varId, v)}
                      />
                    ))}
                  </div>
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
            <>
              {target.indicator.plotMeta.length === 0 ? (
                <div className="iset-note">This script exposes no renderable plots to style.</div>
              ) : (
                target.indicator.plotMeta.map((p) => {
                  const o = pineStyle?.[p.key];
                  const visible = o?.visible !== false;
                  // Shown value: explicit override, else the script's own color.
                  const shownColor = o?.color ?? p.color ?? "#38bdf8";
                  const shownWidth = o?.lineWidth ?? p.linewidth ?? 2;
                  return (
                    <div className="iset-plotrow" key={p.key} data-hidden={visible ? undefined : ""}>
                      <input
                        type="checkbox"
                        checked={visible}
                        title={visible ? "Visible — uncheck to hide this plot" : "Hidden — check to show this plot"}
                        aria-label={`${p.title} visibility`}
                        onChange={(e) => patchPineStyle(p.key, { visible: e.target.checked })}
                      />
                      <input
                        type="color"
                        value={toPickerHex(shownColor)}
                        title={`${p.title} color`}
                        aria-label={`${p.title} color`}
                        onChange={(e) => patchPineStyle(p.key, { color: e.target.value })}
                      />
                      <span className="iset-plotname" title={p.key}>
                        {p.title}
                      </span>
                      <select
                        value={shownWidth}
                        title={`${p.title} line width`}
                        aria-label={`${p.title} width`}
                        onChange={(e) => patchPineStyle(p.key, { lineWidth: Number(e.target.value) })}
                      >
                        {PINE_PLOT_WIDTHS.map((w) => (
                          <option key={w} value={w}>
                            {w}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })
              )}
              <div className="iset-note">
                Style overrides apply at render time — the script itself is never modified. Per-bar
                script colors are replaced while overridden; hline/fill styling is not supported yet.
              </div>
            </>
          )}
        </div>

        <div className="iset-foot">
          {isPine && (
            <button
              type="button"
              className="iset-btn"
              onClick={resetPineDefaults}
              title="Restore the script's declared input defaults and clear style overrides"
            >
              Defaults
            </button>
          )}
          <div className="iset-foot-actions">
            <button type="button" className="iset-btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="iset-btn primary" onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Strict EMA period check for the Length input (mirrors services/ema.ts). */
function isValidEmaPeriod(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_EMA_PERIOD && n <= MAX_EMA_PERIOD;
}