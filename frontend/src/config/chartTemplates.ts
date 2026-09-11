/**
 * Chart templates — the Settings workflow's save/apply surface.
 *
 * ONE source of truth per concept:
 *   - The BUILT-IN "Default" template is a frozen CODE CONSTANT (never
 *     localStorage, never user-mutable) — it always exists, survives a cleared
 *     storage, and `deleteTemplate`/`sanitizeTemplates` structurally refuse
 *     to remove or shadow it.
 *   - USER templates live under `aura.chart.templates.v1` (versioned), store a
 *     COMPLETE sanitized `ChartSettings` snapshot, and are frontend-only for
 *     now (Supabase sync is deliberately out of scope).
 *   - `allTemplates` = [built-in Default, ...saved users] — consumers never
 *     concatenate the lists themselves, so the built-in can't be lost.
 *   - Storage is injectable so unit tests can run without a `window`.
 */
import {
  CHART_TEMPLATES_STORAGE_KEY,
  DEFAULT_TEMPLATE_ID,
  sanitizeChartSettings,
  type ChartSettings,
} from "./chartSettings.ts";

/**
 * Public template-API re-exports: template consumers (the Settings modal,
 * tests) import these FROM HERE. The definitions stay in chartSettings.ts —
 * one source of truth, no duplicated key/id constants.
 */
export { CHART_TEMPLATES_STORAGE_KEY, DEFAULT_TEMPLATE_ID };

export const DEFAULT_TEMPLATE_NAME = "Default";

export interface ChartTemplate {
  /** Stable unique id. The built-in Default's id is `default` (reserved). */
  id: string;
  /** User-facing name (duplicates are blocked at the UI save flow). */
  name: string;
  /** Creation time (ms). 0 for the built-in constant. */
  createdAt: number;
  /** Last update time (ms). 0 for the built-in constant. */
  updatedAt: number;
  /** Complete chart-configuration snapshot applied on template load. */
  settings: ChartSettings;
}

/**
 * The BUILT-IN Default template — AURA's default chart configuration. Frozen:
 * no code path mutates it. It is NOT part of the user-template storage; it is
 * prepended by `allTemplates` at read time.
 */
export const BUILT_IN_DEFAULT_TEMPLATE: Readonly<ChartTemplate> = Object.freeze({
  id: DEFAULT_TEMPLATE_ID,
  name: DEFAULT_TEMPLATE_NAME,
  createdAt: 0,
  updatedAt: 0,
  settings: sanitizeChartSettings(null),
});

/** Always-sanitized resolution of a template's settings (corrupt-safe). */
export function templateSettings(template: ChartTemplate | null | undefined): ChartSettings {
  return sanitizeChartSettings(template?.settings ?? null);
}

/** Mint a collision-resistant user-template id (crypto when available). */
export function makeTemplateId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return `tpl-${c.randomUUID()}`;
  } catch {
    /* fall through to Math.random */
  }
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Storage → user templates (guarded: missing/corrupted → []). The built-in
 * Default is structurally ABSENT from storage — any shadow entry is stripped.
 */
export function loadChartTemplates(
  storage: { getItem(key: string): string | null } = window.localStorage,
): ChartTemplate[] {
  try {
    const raw = storage.getItem(CHART_TEMPLATES_STORAGE_KEY);
    if (!raw) return [];
    return sanitizeTemplates(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** User templates → storage (guarded; shadows of the built-in are stripped). */
export function saveChartTemplates(
  templates: readonly ChartTemplate[],
  storage: { setItem(key: string, value: string): void } = window.localStorage,
): void {
  try {
    storage.setItem(CHART_TEMPLATES_STORAGE_KEY, JSON.stringify(sanitizeTemplates(templates)));
  } catch {
    /* storage unavailable — templates stay session-only */
  }
}

/** Validate arbitrary (possibly corrupted) stored templates; junk dropped. */
export function sanitizeTemplates(raw: unknown): ChartTemplate[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const out: ChartTemplate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : makeTemplateId();
    // The built-in Default can NEVER live in (or be shadowed by) storage.
    if (id === DEFAULT_TEMPLATE_ID) continue;
    const name = typeof r.name === "string" && r.name.trim()
      ? r.name.trim().slice(0, 64)
      : "Untitled";
    const created = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) && r.createdAt > 0
      ? r.createdAt
      : now;
    const updated = typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) && r.updatedAt >= created
      ? r.updatedAt
      : created;
    out.push({ id, name, createdAt: created, updatedAt: updated, settings: sanitizeChartSettings(r.settings) });
  }
  return out;
}

// ── Template operations (pure — consumed by App + the Settings modal) ─────────

/**
 * The complete template list: built-in Default FIRST, then the user templates.
 * The single concatenation point — the built-in can never be dropped.
 */
export function allTemplates(saved: readonly ChartTemplate[]): ChartTemplate[] {
  return [BUILT_IN_DEFAULT_TEMPLATE as ChartTemplate, ...saved];
}

/** Find a template by id across saved users + the built-in Default. */
export function findTemplate(
  saved: readonly ChartTemplate[],
  id: string,
): ChartTemplate | undefined {
  return allTemplates(saved).find((t) => t.id === id);
}

/**
 * The template a settings object currently points at (falls back to the
 * built-in Default when the id is unknown — e.g. a deleted user template).
 */
export function activeTemplate(saved: readonly ChartTemplate[], settings: ChartSettings): ChartTemplate {
  return findTemplate(saved, settings.activeTemplateId) ?? (BUILT_IN_DEFAULT_TEMPLATE as ChartTemplate);
}

/** Is the currently-active template the built-in Default? (Default is never
 * user-updatable — App's "Save current template" is gated on this.) */
export function isActiveTemplateDefault(settings: ChartSettings): boolean {
  return settings.activeTemplateId === DEFAULT_TEMPLATE_ID;
}

/**
 * Canonical form for name-uniqueness checks: trimmed, lowercased, with
 * internal whitespace runs collapsed to single spaces — so "Gold  Session"
 * (double space) collides with "Gold Session" instead of silently coexisting.
 */
function canonicalTemplateName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Does a user template with this name already exist? (case/whitespace
 * insensitive — duplicates are blocked at the save flow, never overwritten.) */
export function templateNameExists(saved: readonly ChartTemplate[], name: string): boolean {
  const wanted = canonicalTemplateName(name);
  return saved.some((t) => canonicalTemplateName(t.name) === wanted);
}

/** Create a user template from the current settings snapshot (sanitized). */
export function createTemplate(name: string, settings: ChartSettings, now = Date.now()): ChartTemplate {
  return {
    id: makeTemplateId(),
    name: name.trim().slice(0, 64),
    createdAt: now,
    updatedAt: now,
    settings: sanitizeChartSettings(settings),
  };
}

/** Replace-by-id or prepend a user template (immutably; built-in untouched). */
export function upsertTemplate(
  saved: readonly ChartTemplate[],
  template: ChartTemplate,
): ChartTemplate[] {
  if (template.id === DEFAULT_TEMPLATE_ID) return [...saved]; // built-in: never stored
  const idx = saved.findIndex((t) => t.id === template.id);
  if (idx === -1) return [template, ...saved];
  return saved.map((t) => (t.id === template.id ? template : t));
}

/**
 * Delete a user template by id — the built-in Default is structurally
 * undeletable (its id can never match a stored user entry, and it isn't in
 * the list anyway; the guard also makes the intent explicit for consumers).
 */
export function deleteTemplate(
  saved: readonly ChartTemplate[],
  id: string,
): ChartTemplate[] {
  if (id === DEFAULT_TEMPLATE_ID) return [...saved];
  return saved.filter((t) => t.id !== id);
}

/** Is the current settings object DIRTY vs the template it points at?
 * The template id is pinned to the CURRENT one on the template side, so only
 * the configuration content (theme, candles, invert) drives the verdict. */
export function isTemplateDirty(
  template: ChartTemplate,
  settings: ChartSettings,
  equal: (a: ChartSettings, b: ChartSettings) => boolean,
): boolean {
  return !equal(settings, { ...templateSettings(template), activeTemplateId: settings.activeTemplateId });
}
