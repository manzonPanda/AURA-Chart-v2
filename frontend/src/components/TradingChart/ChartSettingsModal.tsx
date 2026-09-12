/**
 * Chart Settings modal — TradingView-style, opened from the chart's
 * right-click context menu ("Settings").
 *
 * Sections (left nav): Appearance, Symbol, Status line, Scales and lines,
 * Canvas, Events. Appearance + Symbol are functional:
 *
 *   Appearance — THEME cards (the config/chartThemes.ts registry, applied
 *   through CandleKit's own setTheme pipeline via ThemeBridge) + MY TEMPLATES
 *   cards (config/chartTemplates.ts). A THEME changes the visual theme only;
 *   a TEMPLATE restores the complete saved ChartSettings snapshot. They are
 *   deliberately distinct visual groups.
 *
 *   Symbol — the CANDLES block (Body/Borders/Wick toggles + bull/bear
 *   pickers), applied to the EXISTING candlestick series via
 *   CandleStyleBridge's options-level derivation.
 *
 * The remaining sections are honest placeholders ("Configuration coming
 * soon") — no fake controls.
 *
 * Single source of truth: the modal edits App-owned settings via
 * `onChange(next)` (pure spread updates — every change persists + dirties
 * through App's own state/persistence) and reads templates via props.
 * Live semantics: theme + symbol changes apply IMMEDIATELY to the chart
 * (TradingView parity) — the modal never holds its own draft. The Save
 * workflow is the template layer (Save current / Save as new), never a
 * settings commit.
 */
import { useEffect, useState } from "react";

import {
  DEFAULT_TEMPLATE_ID,
  type CandleSettings,
  type ChartSettings,
} from "../../config/chartSettings";
import {
  CHART_THEMES,
  effectiveThemeId,
  type ChartThemeDef,
} from "../../config/chartThemes";
import {
  allTemplates,
  type ChartTemplate,
} from "../../config/chartTemplates";
import { HISTORY_HORIZONS } from "../../config/chart.ts";

/** Which section the left nav selects. */
type SectionId =
  | "appearance"
  | "symbol"
  | "statusline"
  | "scaleslines"
  | "canvas"
  | "history"
  | "events";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "symbol", label: "Symbol" },
  { id: "statusline", label: "Status line" },
  { id: "scaleslines", label: "Scales and lines" },
  { id: "canvas", label: "Canvas" },
  { id: "history", label: "History" },
  { id: "events", label: "Events" },
];

interface Props {
  settings: ChartSettings;
  /** Saved user templates (the built-in Default is prepended by the modal). */
  templates: readonly ChartTemplate[];
  /** The currently-active template (built-in Default resolves too). */
  activeTemplate: ChartTemplate;
  /** True when settings differ from the active template's snapshot. */
  dirty: boolean;
  /** Every change (theme pick, candle toggle/color, …) routes into App state. */
  onChange: (next: ChartSettings) => void;
  /** Load a template's complete settings snapshot (App resolves + activates). */
  onApplyTemplate: (id: string) => { ok: boolean; error?: string };
  /** "Save current template" — App refuses while the built-in Default is active. */
  onSaveCurrent: () => { ok: boolean; error?: string };
  /** "Save as new template" — App mints, persists and ACTIVATES the template. */
  onSaveAs: (name: string) => { ok: boolean; error?: string };
  /** Delete a USER template — App structurally refuses the built-in Default. */
  onDeleteTemplate: (id: string) => { ok: boolean; error?: string };
  /** Close (×, backdrop, Escape). */
  onClose: () => void;
}

/** A clean placeholder for a not-yet-configured section — no fake controls. */
function ComingSoon({ label }: { label: string }) {
  return (
    <div className="iset-group">
      <div className="iset-group-title">{label}</div>
      <p className="iset-note">Configuration coming soon</p>
    </div>
  );
}

/**
 * One theme card — a mini chart preview drawn from the theme's OWN palette
 * (background, grid, bull/bear candles), so cards read as real previews.
 */
function ThemeCard({
  def,
  selected,
  onSelect,
}: {
  def: ChartThemeDef;
  selected: boolean;
  onSelect: () => void;
}) {
  const c = def.colors;
  const bg = c.background ?? (def.light ? "#ffffff" : "#131722");
  const grid = c.grid ?? (def.light ? "#e0e3eb" : "#1c2030");
  const up = c.up ?? "#26a69a";
  const down = c.down ?? "#ef5350";
  return (
    <button
      type="button"
      className="cset-card"
      data-selected={selected || undefined}
      onClick={onSelect}
      title={def.id}
      aria-pressed={selected}
    >
      <span className="cset-card-preview" style={{ background: bg }}>
        <span className="cset-card-grid" style={{ background: `linear-gradient(${grid} 1px, transparent 1px)` }} />
        <span className="cset-card-candles" aria-hidden="true">
          <i style={{ background: up }} />
          <i style={{ background: down }} />
          <i style={{ background: up }} />
        </span>
      </span>
      <span className="cset-card-label">
        {def.id}
        {selected && <span className="cset-card-check" aria-hidden="true">✓</span>}
      </span>
    </button>
  );
}

/** One template card — visually distinct from a theme (badge + delete). */
function TemplateCard({
  template,
  selected,
  dirty,
  onSelect,
  onDelete,
}: {
  template: ChartTemplate;
  selected: boolean;
  dirty: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="cset-card cset-card--template" data-selected={selected || undefined}>
      <button type="button" className="cset-card-template-btn" onClick={onSelect} aria-pressed={selected}>
        <span className="cset-card-preview cset-card-preview--template">
          <span className="cset-card-template-badge" aria-hidden="true">▦</span>
        </span>
        <span className="cset-card-label">
          {template.name}
          {dirty && <span className="cset-dirty-mark" title="Modified since this template was loaded"> *</span>}
          {selected && <span className="cset-card-check" aria-hidden="true">✓</span>}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          className="cset-card-delete"
          title={`Delete template "${template.name}"`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** One Candles row: enabled checkbox + bull picker + bear picker. */
function CandleRow({
  label,
  enabled,
  upColor,
  downColor,
  onEnabled,
  onUp,
  onDown,
}: {
  label: string;
  enabled: boolean;
  upColor: string;
  downColor: string;
  onEnabled: (v: boolean) => void;
  onUp: (v: string) => void;
  onDown: (v: string) => void;
}) {
  return (
    <div className="cset-candle-row" data-disabled={!enabled || undefined}>
      <label className="cset-candle-check">
        <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
        <span>{label}</span>
      </label>
      <input
        type="color"
        className="cset-color"
        aria-label={`${label} bullish color`}
        value={upColor}
        onChange={(e) => onUp(e.target.value)}
      />
      <input
        type="color"
        className="cset-color"
        aria-label={`${label} bearish color`}
        value={downColor}
        onChange={(e) => onDown(e.target.value)}
      />
    </div>
  );
}

/**
 * The Chart Settings modal — one source of truth (App-owned `settings`), live
 * semantics (every change applies immediately + persists through App), and
 * the template layer for saving/loading complete configurations.
 */
export function ChartSettingsModal({
  settings,
  templates,
  activeTemplate,
  dirty,
  onChange,
  onApplyTemplate,
  onSaveCurrent,
  onSaveAs,
  onDeleteTemplate,
  onClose,
}: Props) {
  const [section, setSection] = useState<SectionId>("appearance");
  /** Open "Save as new template" dialog (name + explicit duplicate error). */
  const [saveDialog, setSaveDialog] = useState<{ name: string; error: string | null } | null>(null);
  /** Footer error line for failed apply/delete/save actions. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** Footer Save menu open (Save current / Save as new). */
  const [saveMenu, setSaveMenu] = useState(false);

  // Escape: cancel the name dialog first, then close the modal (× parity).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (saveDialog) setSaveDialog(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveDialog, onClose]);

  const candles = settings.symbol.candles;
  const resolvedThemeId = effectiveThemeId(settings.appearance.theme);
  const templateList = allTemplates(templates);

  /** Patch the Symbol/candle slice (pure spread — App persists + dirties). */
  const patchCandles = (patch: Partial<CandleSettings>): void => {
    onChange({ ...settings, symbol: { candles: { ...candles, ...patch } } });
  };

  const submitSaveAs = (): void => {
    const name = saveDialog?.name ?? "";
    const trimmed = name.trim();
    if (!trimmed) {
      setSaveDialog({ name, error: "Enter a template name" });
      return;
    }
    const res = onSaveAs(trimmed);
    if (!res.ok) {
      setSaveDialog({ name, error: res.error ?? "Could not save the template" });
      return;
    }
    setSaveDialog(null);
    setActionError(null);
  };

  const runAction = (res: { ok: boolean; error?: string }): void => {
    setActionError(res.ok ? null : res.error ?? "Action failed");
  };

  return (
    <div
      className="cset-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cset-modal" role="dialog" aria-modal="true" aria-label="Chart settings">
        <div className="cset-head">
          <h3>Settings</h3>
          <button type="button" className="cset-close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="cset-columns">
          <nav className="cset-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="cset-nav-item"
                data-active={section === s.id || undefined}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="cset-body">
            {section === "appearance" && (
              <>
                <div className="iset-group">
                  <div className="iset-group-title">Theme</div>
                  <div className="cset-card-grid">
                    {CHART_THEMES.map((def) => (
                      <ThemeCard
                        key={def.id}
                        def={def}
                        selected={def.id === resolvedThemeId}
                        onSelect={() => onChange({ ...settings, appearance: { theme: def.id } })}
                      />
                    ))}
                  </div>
                </div>
                <div className="iset-group">
                  <div className="iset-group-title">My templates</div>
                  <div className="cset-card-grid">
                    {templateList.map((t) => (
                      <TemplateCard
                        key={t.id}
                        template={t}
                        selected={activeTemplate.id === t.id}
                        dirty={dirty && activeTemplate.id === t.id}
                        onSelect={() => runAction(onApplyTemplate(t.id))}
                        onDelete={
                          t.id === DEFAULT_TEMPLATE_ID
                            ? undefined
                            : () => runAction(onDeleteTemplate(t.id))
                        }
                      />
                    ))}
                  </div>
                  <p className="iset-note">
                    A theme changes the visual theme only. A template restores the complete
                    saved chart configuration.
                  </p>
                </div>
              </>
            )}
            {section === "symbol" && (
              <div className="iset-group">
                <div className="iset-group-title">Candles</div>
                <CandleRow
                  label="Body"
                  enabled={candles.body}
                  upColor={candles.upColor}
                  downColor={candles.downColor}
                  onEnabled={(v) => patchCandles({ body: v })}
                  onUp={(v) => patchCandles({ upColor: v })}
                  onDown={(v) => patchCandles({ downColor: v })}
                />
                <CandleRow
                  label="Borders"
                  enabled={candles.borders}
                  upColor={candles.upColor}
                  downColor={candles.downColor}
                  onEnabled={(v) => patchCandles({ borders: v })}
                  onUp={(v) => patchCandles({ upColor: v })}
                  onDown={(v) => patchCandles({ downColor: v })}
                />
                <CandleRow
                  label="Wick"
                  enabled={candles.wick}
                  upColor={candles.upColor}
                  downColor={candles.downColor}
                  onEnabled={(v) => patchCandles({ wick: v })}
                  onUp={(v) => patchCandles({ upColor: v })}
                  onDown={(v) => patchCandles({ downColor: v })}
                />
                <p className="iset-note">
                  The bullish (left) and bearish (right) colors apply to bodies, borders and
                  wicks together; unchecking an element hides it on the chart.
                </p>
              </div>
            )}

            {section === "history" && (
              <div className="iset-group">
                <div className="iset-group-title">Historical context</div>
                <div className="cset-card-grid">
                  {HISTORY_HORIZONS.map((h) => (
                    <button
                      key={h.key}
                      type="button"
                      className="cset-card"
                      data-selected={settings.historyHorizon === h.key || undefined}
                      onClick={() => onChange({ ...settings, historyHorizon: h.key })}
                      aria-pressed={settings.historyHorizon === h.key}
                    >
                      <span className="cset-card-label">{h.label}</span>
                      {settings.historyHorizon === h.key && (
                        <span className="cset-card-check" aria-hidden="true">✓</span>
                      )}
                    </button>
                  ))}
                </div>
                <p className="iset-note">
                  How much trading history the chart loads initially — calendar-aware, so DAX,
                  Gold and Silver sessions are measured with their OWN calendars. Load More always
                  continues further back in the fixed page size.
                </p>
              </div>
            )}
            {section === "statusline" && <ComingSoon label="Status line" />}
            {section === "scaleslines" && <ComingSoon label="Scales and lines" />}
            {section === "canvas" && <ComingSoon label="Canvas" />}
            {section === "events" && <ComingSoon label="Events" />}
          </div>
        </div>

        <div className="cset-foot">
          <span className="cset-active-template">
            Active template: <strong>{activeTemplate.name}</strong>
            {dirty && (
              <span className="cset-dirty-mark" title="Modified since this template was loaded">
                {" "}*
              </span>
            )}
          </span>
          {actionError && <span className="cset-error">{actionError}</span>}
          <div className="cset-foot-actions">
            <div className="cset-save-wrap">
              <button type="button" className="iset-btn" onClick={() => setSaveMenu((v) => !v)}>
                Save
              </button>
              {saveMenu && (
                <div className="cset-save-menu" role="menu" aria-label="Save template">
                  <button
                    type="button"
                    role="menuitem"
                    className="cset-save-menu-item"
                    onClick={() => {
                      setSaveMenu(false);
                      runAction(onSaveCurrent());
                    }}
                  >
                    Save current template
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="cset-save-menu-item"
                    onClick={() => {
                      setSaveMenu(false);
                      setSaveDialog({ name: "", error: null });
                    }}
                  >
                    Save as new template
                  </button>
                </div>
              )}
            </div>
            <button type="button" className="iset-btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>

        {saveDialog && (
          <div
            className="cset-save-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSaveDialog(null);
            }}
          >
            <div className="cset-save-dialog" role="dialog" aria-modal="true" aria-label="Save template">
              <div className="iset-group-title">Save template</div>
              <label className="cset-save-name">
                <span>Name</span>
                <input
                  autoFocus
                  type="text"
                  value={saveDialog.name}
                  placeholder="NY Killzone Setup"
                  onChange={(e) => setSaveDialog({ name: e.target.value, error: null })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitSaveAs();
                  }}
                />
              </label>
              {saveDialog.error && <p className="cset-error">{saveDialog.error}</p>}
              <div className="cset-save-actions">
                <button type="button" className="iset-btn" onClick={() => setSaveDialog(null)}>
                  Cancel
                </button>
                <button type="button" className="iset-btn primary" onClick={submitSaveAs}>
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
