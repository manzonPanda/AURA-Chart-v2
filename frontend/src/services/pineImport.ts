/**
 * Imported Pine Script indicators — validation, persistence and safety limits.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * "Pine Script powered by PineTS, with AURA-supported features."
 *
 * AURA is NOT a TradingView/Pine Script clone. User scripts are executed by
 * the existing PineTS engine (`services/pineEngine.ts`) — the sandboxed
 * compilation/runtime boundary. This module NEVER eval()s user code: it only
 * inspects metadata reported by PineTS (`getInputsMeta`,
 * `getDeclarationType`), validates statically, persists configuration and
 * maps engine failures to human-readable messages (stack traces stay in the
 * console, never in the UI).
 *
 * Scope (phase 1): INDICATORS ONLY — `indicator()` declarations, `plot()`
 * lines. Strategies, order execution, alerts and webhooks are future phases.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Storage: versioned localStorage envelope (`aura.pine.indicators`). Market
 * data never lives here — only the script source + settings. Supabase is
 * untouched.
 */
import { Indicator } from "pinets";

import {
  PineIndicatorEngine,
  type PineBar,
  type PineLiveCandle,
  type PineRuntimeDiagnostics,
  type PineVisual,
  type PineVisualType,
} from "./pineEngine.ts";

// ── Limits (robustness — one bad import must never hurt the chart) ─────────

/** Maximum accepted Pine source length (chars). TradingView scripts are rarely > 8k. */
export const MAX_PINE_SOURCE_LENGTH = 20_000;
/** Maximum number of imported indicators kept in localStorage + rendered. */
export const MAX_IMPORTED_INDICATORS = 10;
/** Maximum line plots rendered per imported indicator (rest are ignored). */
export const MAX_PLOT_SERIES_PER_INDICATOR = 8;
/** Maximum input widgets per imported indicator (sanity cap). */
export const MAX_PINE_INPUTS = 32;

// ── Storage ─────────────────────────────────────────────────────────────────

/** localStorage key — Pine source + settings ONLY (never calculated data). */
export const PINE_STORAGE_KEY = "aura.pine.indicators";
/** Versioned envelope so future migrations are possible. */
export const PINE_STORAGE_VERSION = 2;

// ── Types ───────────────────────────────────────────────────────────────────

/** Snapshot of one `input.*()` declaration (from PineTS `getInputsMeta`). */
export interface PineInputMetaSnapshot {
  /** Canonical override key (the Pine variable name). */
  varId: string;
  /** Display title from the `input.*()` call (falls back to varId). */
  title: string;
  type: string;
  defval: unknown;
  minval?: number;
  maxval?: number;
  step?: number;
  /** Enum choices for `input.string(..., options=[...])`. */
  options?: string[];
}

/** Snapshot of one renderable output discovered at compile time. */
export interface PinePlotMetaSnapshot {
  /** `ctx.plots` key (plot title, or "#N" for untitled plots). */
  key: string;
  /** Display title. */
  title: string;
  /** Normalized visual kind (drives series creation in PineBridge). */
  type: PineVisualType;
  /** Script-declared linewidth (1–4 after clamp). */
  linewidth?: number;
  /** Uniform script color when every point shares one (hex). */
  color?: string;
}

/**
 * Full import diagnostics — WHAT the script uses vs what AURA renders.
 * Persisted with the indicator so the UI can always explain the difference
 * ("Compiled successfully, but …") instead of a bare "Nothing to render".
 */
export interface PineImportDiagnostics {
  /** Static source scan: construct → occurrence count (plot/hline/plotshape/…). */
  staticCounts: Record<string, number>;
  /** Outputs AURA actually renders (from the compile-time PineTS run). */
  rendered: { key: string; title: string; type: PineVisualType }[];
  /** Detected-but-unrenderable outputs (drawings, exotic styles, …). */
  unsupported: { kind: string; count: number }[];
  /** Plots hidden by the script itself (`display=display.none`). */
  hidden: number;
}

/**
 * One imported Pine indicator. Persisted verbatim (sanitized) in localStorage.
 */
export interface ImportedPineIndicator {
  id: string;
  name: string;
  /** Raw Pine Script source (v5/v6, `indicator()` declaration). */
  source: string;
  enabled: boolean;
  /** `indicator(..., overlay=true)` → main price pane; false → own LWC pane. */
  overlay: boolean;
  /** Current input values keyed by varId (user-editable via the menu). */
  inputs: Record<string, unknown>;
  /** Input metadata snapshot captured at compile time (drives the settings UI). */
  inputMeta: PineInputMetaSnapshot[];
  /** Plot metadata snapshot captured at compile time (drives series creation). */
  plotMeta: PinePlotMetaSnapshot[];
  /** Import-time diagnostics (what the script uses vs what AURA renders). */
  diagnostics?: PineImportDiagnostics;
  createdAt: number;
}

/** Runtime status of one imported indicator on the chart (session-only). */
export interface PineRunStatus {
  ok: boolean;
  /** Human-readable message when `ok` is false (no stack traces). */
  message?: string;
}

export type PineImportIssueKind =
  | "too-large"
  | "version"
  | "declaration"
  | "strategy"
  | "unsupported"
  | "syntax"
  | "run"
  | "plot"
  | "limit";

export interface PineImportIssue {
  kind: PineImportIssueKind;
  /** UI-safe message (raw errors are logged to the console instead). */
  message: string;
}

export interface PineImportOutcome {
  ok: boolean;
  issue?: PineImportIssue;
  /** Non-fatal compat notes (e.g. missing //@version). */
  warning?: string;
  indicator?: ImportedPineIndicator;
}

/** Minimal storage interface (injectable for tests; defaults to localStorage). */
export interface PineStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

// ── Static source inspection (NO code execution) ───────────────────────────

const VERSION_RE = /^[ \t]*\/\/[ \t]*@version[ \t]*=[ \t]*(\d+)/m;
const DECLARATION_RE = /(^|\n)[ \t]*(?:indicator|study)[ \t]*\(/;
const STRATEGY_DECL_RE = /(^|\n)[ \t]*strategy[ \t]*\(/;
const STRATEGY_MEMBER_RE = /\bstrategy[ \t]*\./;
const REQUEST_MEMBER_RE = /\brequest[ \t]*\./;
const OVERLAY_TRUE_RE = /\boverlay[ \t]*=[ \t]*true\b/i;
const TITLE_RE = /(?:indicator|study)[ \t]*\([ \t]*"([^"]{1,120})"/;

/**
 * Regex fallback for the declared `overlay` flag. ONLY used when the runtime
 * cannot report it — scripts without a `//@version` comment lose their
 * declaration args inside PineTS (verified quirk, see README).
 */
export function staticOverlayHint(source: string): boolean {
  return OVERLAY_TRUE_RE.test(source);
}

/** Best-effort script title from the `indicator("Title", ...)` string literal. */
export function guessPineTitle(source: string): string | null {
  const m = TITLE_RE.exec(source);
  return m ? m[1] : null;
}

// ── Static visual-construct scan (import diagnostics "Detected" section) ────

/** Visual constructs AURA's import diagnostics report (label → display name). */
const SCAN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["plot()", /\bplot\s*\(/g],
  ["hline()", /\bhline\s*\(/g],
  ["plotshape()", /\bplotshape\s*\(/g],
  ["plotchar()", /\bplotchar\s*\(/g],
  ["label.new", /\blabel\s*\.\s*new\s*\(/g],
  ["bgcolor()", /\bbgcolor\s*\(/g],
  ["fill()", /\bfill\s*\(/g],
  ["table.new", /\btable\s*\.\s*new\s*\(/g],
];

/**
 * Cheap static scan of the Pine source for visual constructs — powers the
 * "Detected" section of the import diagnostics. Comments and string literals
 * are stripped first so a title like "plot()" doesn't inflate the counts.
 * Purely informational; the authoritative supported/unsupported split comes
 * from the PineTS runtime run.
 */
export function staticScanCounts(source: string): Record<string, number> {
  const counts: Record<string, number> = {};
  if (typeof source !== "string" || source.length === 0) return counts;
  const stripped = source
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/\/\/[^\n]*/g, "");
  for (const [label, re] of SCAN_PATTERNS) {
    const n = stripped.match(re)?.length ?? 0;
    if (n > 0) counts[label] = n;
  }
  return counts;
}

/**
 * Static validation — rejects non-indicators, old versions, oversized sources
 * and known-unsupported namespaces BEFORE anything is transpiled.
 */
export function staticValidateSource(source: string): PineImportIssue | null {
  if (typeof source !== "string" || source.trim().length === 0) {
    return { kind: "syntax", message: "The script is empty — paste a Pine Script indicator first." };
  }
  if (source.length > MAX_PINE_SOURCE_LENGTH) {
    return {
      kind: "too-large",
      message: `Script is ${source.length.toLocaleString()} characters — the limit is ${MAX_PINE_SOURCE_LENGTH.toLocaleString()}.`,
    };
  }
  if (STRATEGY_DECL_RE.test(source)) {
    return {
      kind: "strategy",
      message:
        "This script uses strategy() functionality. AURA imports chart indicators only — strategies are a future phase.",
    };
  }
  const version = VERSION_RE.exec(source);
  if (version) {
    const v = Number(version[1]);
    if (!Number.isInteger(v) || v < 5) {
      return {
        kind: "version",
        message: `Unsupported Pine Script version ${version[1]} — AURA supports Pine v5/v6 (via PineTS).`,
      };
    }
  }
  if (!DECLARATION_RE.test(source)) {
    return {
      kind: "declaration",
      message:
        'No indicator() declaration found. AURA imports indicators — the script must start with something like:\nindicator("My Indicator", overlay=true)',
    };
  }
  if (STRATEGY_MEMBER_RE.test(source)) {
    return {
      kind: "unsupported",
      message:
        "This script calls strategy.* functions (orders/positions). Strategy execution is not supported by AURA yet.",
    };
  }
  if (REQUEST_MEMBER_RE.test(source)) {
    return {
      kind: "unsupported",
      message:
        "This script calls request.* functions (external data). External market-data requests are not supported by AURA.",
    };
  }
  return null;
}

/**
 * Map a raw PineTS failure to a UI-safe message. Stack traces are NEVER
 * returned — they stay in the console (callers log them).
 */
export function friendlyPineError(raw: string): string {
  const msg = String(raw ?? "Unknown Pine Script error").trim();
  // Transpile errors: "Failed to transpile Pine Script version 6: Unexpected token EOF '' at 3:16"
  const transpile = /^Failed to transpile [^:]*:\s*/i.exec(msg);
  if (transpile) {
    return `Pine syntax error: ${msg.slice(transpile[0].length)}`;
  }
  // Runtime unknown function: "ta.someFunction is not a function"
  const notAFunction = /^([a-zA-Z_][\w.]*\.[a-zA-Z_]\w*) is not a function$/.exec(msg);
  if (notAFunction) {
    return `Unknown function: ${notAFunction[1]} — it is not available in PineTS.`;
  }
  // Version banner passes through verbatim (already user-friendly).
  if (/Unsupported Pine Script version/i.test(msg)) return msg;
  // Everything else: first line only, no stack.
  return msg.split("\n")[0].slice(0, 300);
}

// ── Input metadata + value sanitization ────────────────────────────────────

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const EDITABLE_INPUT_TYPES = new Set(["int", "float", "bool", "string", "color"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clamp(n: number, min?: number, max?: number): number {
  if (typeof min === "number" && Number.isFinite(min)) n = Math.max(min, n);
  if (typeof max === "number" && Number.isFinite(max)) n = Math.min(max, n);
  return n;
}

/** Sanitize one raw `getInputsMeta()` entry into a persistable snapshot. */
export function sanitizeInputMeta(raw: unknown): PineInputMetaSnapshot | null {
  if (!isPlainObject(raw)) return null;
  const varId = typeof raw.varId === "string" && raw.varId.length > 0 ? raw.varId : null;
  if (!varId) return null;
  const type = typeof raw.type === "string" ? raw.type : "string";
  const defval =
    typeof raw.defval === "number" || typeof raw.defval === "boolean" || typeof raw.defval === "string"
      ? raw.defval
      : null;
  const meta: PineInputMetaSnapshot = {
    varId,
    title: typeof raw.title === "string" && raw.title.trim().length > 0 ? raw.title : varId,
    type,
    defval,
  };
  if (typeof raw.minval === "number" && Number.isFinite(raw.minval)) meta.minval = raw.minval;
  if (typeof raw.maxval === "number" && Number.isFinite(raw.maxval)) meta.maxval = raw.maxval;
  if (typeof raw.step === "number" && Number.isFinite(raw.step) && raw.step > 0) meta.step = raw.step;
  if (Array.isArray(raw.options)) {
    const opts = raw.options.filter((o): o is string => typeof o === "string").slice(0, 32);
    if (opts.length > 0) meta.options = opts;
  }
  return meta;
}

/**
 * Validate a stored/user-edited input value against its metadata. Corrupted
 * values fall back to the script default — a bad localStorage entry can never
 * break compilation (PineTS enforces minval/maxval on writes as a second wall).
 */
export function sanitizeInputValue(meta: PineInputMetaSnapshot, raw: unknown): unknown {
  const fallback = meta.defval;
  switch (meta.type) {
    case "int": {
      if (typeof raw === "number" && Number.isInteger(raw)) return clamp(raw, meta.minval, meta.maxval);
      return fallback;
    }
    case "float": {
      if (typeof raw === "number" && Number.isFinite(raw)) return clamp(raw, meta.minval, meta.maxval);
      return fallback;
    }
    case "bool":
      return typeof raw === "boolean" ? raw : fallback;
    case "string": {
      if (typeof raw !== "string") return fallback;
      if (meta.options && !meta.options.includes(raw)) return fallback;
      return raw.slice(0, 200);
    }
    case "color": {
      if (typeof raw === "string" && HEX_COLOR_RE.test(raw.trim())) return raw.trim().toLowerCase();
      return fallback;
    }
    default:
      // source / session / symbol / … are displayed read-only in v1.
      return fallback;
  }
}

/** Can the settings UI edit this input type? */
export function isEditableInputType(type: string): boolean {
  return EDITABLE_INPUT_TYPES.has(type);
}

// ── Record sanitization (localStorage can contain anything) ────────────────

const VISUAL_TYPES: ReadonlySet<string> = new Set(["line", "histogram", "area", "horizontal", "marker"]);

function sanitizePlotMeta(raw: unknown): PinePlotMetaSnapshot | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.key !== "string" || raw.key.length === 0 || raw.key.startsWith("__")) return null;
  const meta: PinePlotMetaSnapshot = {
    key: raw.key.slice(0, 120),
    title: typeof raw.title === "string" && raw.title.length > 0 ? raw.title.slice(0, 120) : raw.key,
    // v1 envelopes predate the type field — they contained plain lines only.
    type: typeof raw.type === "string" && VISUAL_TYPES.has(raw.type) ? (raw.type as PineVisualType) : "line",
  };
  if (typeof raw.linewidth === "number" && Number.isInteger(raw.linewidth)) {
    meta.linewidth = clamp(raw.linewidth, 1, 4);
  }
  if (typeof raw.color === "string" && HEX_COLOR_RE.test(raw.color)) meta.color = raw.color.toLowerCase();
  return meta;
}

/** Best-effort sanitization of persisted import diagnostics (v1 records lack them). */
function sanitizeDiagnostics(raw: unknown): PineImportDiagnostics | null {
  if (!isPlainObject(raw)) return null;
  const staticCounts: Record<string, number> = {};
  if (isPlainObject(raw.staticCounts)) {
    for (const [k, v] of Object.entries(raw.staticCounts)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) staticCounts[k.slice(0, 40)] = Math.floor(v);
    }
  }
  const rendered = Array.isArray(raw.rendered)
    ? raw.rendered
        .map((r) => {
          if (!isPlainObject(r) || typeof r.key !== "string") return null;
          return {
            key: r.key.slice(0, 120),
            title: typeof r.title === "string" ? r.title.slice(0, 120) : r.key,
            type: typeof r.type === "string" && VISUAL_TYPES.has(r.type) ? (r.type as PineVisualType) : ("line" as PineVisualType),
          };
        })
        .filter((r): r is { key: string; title: string; type: PineVisualType } => r !== null)
        .slice(0, MAX_PLOT_SERIES_PER_INDICATOR)
    : [];
  const unsupported = Array.isArray(raw.unsupported)
    ? raw.unsupported
        .map((u) => {
          if (!isPlainObject(u) || typeof u.kind !== "string") return null;
          return { kind: u.kind.slice(0, 80), count: typeof u.count === "number" && Number.isFinite(u.count) ? Math.max(0, Math.floor(u.count)) : 1 };
        })
        .filter((u): u is { kind: string; count: number } => u !== null)
        .slice(0, 16)
    : [];
  return {
    staticCounts,
    rendered,
    unsupported,
    hidden: typeof raw.hidden === "number" && Number.isFinite(raw.hidden) ? Math.max(0, Math.floor(raw.hidden)) : 0,
  };
}

/** Validate one stored imported indicator. Returns null for records to DROP. */
export function sanitizeImportedIndicator(raw: unknown): ImportedPineIndicator | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.source !== "string" || raw.source.length === 0) return null;
  if (raw.source.length > MAX_PINE_SOURCE_LENGTH) return null; // oversized → drop
  const inputMeta: PineInputMetaSnapshot[] = Array.isArray(raw.inputMeta)
    ? raw.inputMeta.map(sanitizeInputMeta).filter((m): m is PineInputMetaSnapshot => m !== null).slice(0, MAX_PINE_INPUTS)
    : [];
  const inputs: Record<string, unknown> = {};
  for (const m of inputMeta) {
    inputs[m.varId] = sanitizeInputValue(m, isPlainObject(raw.inputs) ? raw.inputs[m.varId] : undefined);
  }
  const plotMeta = Array.isArray(raw.plotMeta)
    ? raw.plotMeta.map(sanitizePlotMeta).filter((m): m is PinePlotMetaSnapshot => m !== null).slice(0, MAX_PLOT_SERIES_PER_INDICATOR)
    : [];
  const diagnostics = sanitizeDiagnostics(raw.diagnostics);
  return {
    id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id.slice(0, 64) : newImportedPineId(),
    name:
      typeof raw.name === "string" && raw.name.trim().length > 0
        ? raw.name.trim().slice(0, 80)
        : guessPineTitle(raw.source) ?? "Imported indicator",
    source: raw.source,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    overlay: typeof raw.overlay === "boolean" ? raw.overlay : staticOverlayHint(raw.source),
    inputs,
    inputMeta,
    plotMeta,
    ...(diagnostics ? { diagnostics } : {}),
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}

/** Validate a whole stored list: drops corrupt records, caps the count. */
export function sanitizeImportedList(raw: unknown): ImportedPineIndicator[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportedPineIndicator[] = [];
  for (const item of raw) {
    const ind = sanitizeImportedIndicator(item);
    if (ind) out.push(ind);
    if (out.length >= MAX_IMPORTED_INDICATORS) break;
  }
  return out;
}

/** Snapshot one runtime visual into a persistable plot-meta record. */
function plotMetaFromVisual(v: PineVisual): PinePlotMetaSnapshot {
  const meta: PinePlotMetaSnapshot = { key: v.key, title: v.title, type: v.type };
  if (v.type === "line" || v.type === "area" || v.type === "horizontal") {
    if (typeof v.lineWidth === "number") meta.linewidth = v.lineWidth;
  }
  if (v.type !== "marker" && typeof v.color === "string") meta.color = v.color;
  return meta;
}

// ── localStorage load/save (guarded, injectable for tests) ─────────────────

function defaultStorage(): PineStorageLike | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Fresh unique id for a new import. */
export function newImportedPineId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `pine-${crypto.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  return `pine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** localStorage → imported indicators (missing/corrupted/wrong-version → []). */
export function loadImportedPineIndicators(
  storage: PineStorageLike | null = defaultStorage(),
): ImportedPineIndicator[] {
  try {
    const raw = storage?.getItem(PINE_STORAGE_KEY) ?? null;
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return [];
    // v1 records predate typed plotMeta — sanitizePlotMeta defaults their
    // type to "line" (v1 rendered lines only), so they migrate losslessly.
    // Unknown FUTURE versions still start fresh.
    if (parsed.version !== PINE_STORAGE_VERSION && parsed.version !== 1) return [];
    return sanitizeImportedList(parsed.indicators);
  } catch (e) {
    console.warn("[pineImport] corrupted localStorage entry — starting fresh", e);
    return [];
  }
}

/** Imported indicators → localStorage (guarded write; storage errors are non-fatal). */
export function saveImportedPineIndicators(
  indicators: readonly ImportedPineIndicator[],
  storage: PineStorageLike | null = defaultStorage(),
): void {
  try {
    const payload = {
      version: PINE_STORAGE_VERSION,
      indicators: sanitizeImportedList(indicators).map((ind) => ({ ...ind })),
    };
    storage?.setItem(PINE_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("[pineImport] could not persist imported indicators (session-only)", e);
  }
}

// ── Compile: run the script against the CURRENT chart candles ──────────────

export interface CompileImportedPineArgs {
  name?: string;
  source: string;
  /** The chart's current authoritative candles (selected timeframe). */
  bars: readonly PineBar[];
  /** The forming WS candle (authoritative truth), if any. */
  liveCandle?: PineLiveCandle | null;
  /** Selected timeframe bucket size in seconds (60 = 1m, 180 = 3m). */
  bucketSec: number;
}

/**
 * Full import pipeline for the "Compile" button:
 *
 *   static checks → PineTS transpile (syntax errors with line:col) →
 *   run against the current AURA candles → extract plots + inputs →
 *   ImportedPineIndicator record.
 *
 * Never throws. Raw failures are logged to the console; the outcome carries a
 * UI-safe issue instead.
 */
export async function compileImportedPine(args: CompileImportedPineArgs): Promise<PineImportOutcome> {
  const { source, bars, liveCandle = null, bucketSec } = args;

  // 1. Static checks (size / version / declaration / strategy / request.*).
  const staticIssue = staticValidateSource(source);
  if (staticIssue) return { ok: false, issue: staticIssue };
  const hasVersion = VERSION_RE.test(source);
  let warning = hasVersion ? undefined : "No //@version declared — AURA assumes Pine v5/v6 semantics.";

  // 2. Transpile-only check: syntax errors surface here with line:column.
  let inputs: PineInputMetaSnapshot[] = [];
  try {
    const probe = new Indicator(source);
    probe.prepare();
    inputs = (probe.getInputsMeta() as unknown[])
      .map(sanitizeInputMeta)
      .filter((m): m is PineInputMetaSnapshot => m !== null)
      .slice(0, MAX_PINE_INPUTS);
  } catch (e) {
    console.error("[pineImport] transpile failed:", e);
    return {
      ok: false,
      issue: { kind: "syntax", message: friendlyPineError(e instanceof Error ? e.message : String(e)) },
    };
  }

  // 3. Run against the current candles and extract every RENDERABLE visual
  //    (lines, histograms, areas, hlines, plotshape/plotchar markers) plus a
  //    runtime report of what the script uses but AURA cannot render.
  const visuals: PineVisual[] = [];
  let runtimeDiagnostics: PineRuntimeDiagnostics | null = null;
  let runtimeOverlay: boolean | null = null;
  if (bars.length > 0) {
    const engine = new PineIndicatorEngine();
    try {
      engine.setCandles(bars, liveCandle, bucketSec);
      let runError: string | null = null;
      const run = await engine.computeScriptVisuals(
        {
          id: "pine-import-preview",
          source,
          bindings: inputs.map((m) => ({ title: m.title, paramKey: m.varId })),
        },
        {},
        (raw) => {
          runError = raw;
        },
        (info) => {
          if (typeof info?.overlay === "boolean") runtimeOverlay = info.overlay;
        },
      );
      if (run === null) {
        console.error(`[pineImport] PineTS run failed: ${runError}`);
        return {
          ok: false,
          issue: { kind: "run", message: friendlyPineError(runError ?? "Pine Script execution failed") },
        };
      }
      visuals.push(...run.visuals);
      runtimeDiagnostics = run.diagnostics;
    } finally {
      engine.dispose();
    }
  }

  const truncated = visuals.length > MAX_PLOT_SERIES_PER_INDICATOR;
  const diagnostics: PineImportDiagnostics = {
    staticCounts: staticScanCounts(source),
    rendered: (runtimeDiagnostics?.rendered ?? []).slice(0, MAX_PLOT_SERIES_PER_INDICATOR),
    unsupported: runtimeDiagnostics?.unsupported ?? [],
    hidden: runtimeDiagnostics?.hidden ?? 0,
  };

  // A script that compiles but exposes nothing AURA can render STILL imports —
  // the diagnostics panel and the menu chip explain exactly why nothing draws.
  // A valid script must never surface as a bare "Nothing to render" failure.
  const notes: string[] = [];
  if (warning) notes.push(warning);
  if (visuals.length === 0) {
    notes.push("Compiled successfully, but AURA could not render any supported visual outputs — see the diagnostics.");
  } else if (truncated) {
    notes.push(`Only the first ${MAX_PLOT_SERIES_PER_INDICATOR} outputs are rendered.`);
  }
  warning = notes.length > 0 ? notes.join(" ") : undefined;
  const overlay = runtimeOverlay ?? staticOverlayHint(source);
  const name = (args.name ?? "").trim().slice(0, 80) || guessPineTitle(source) || "Imported indicator";

  const inputs0: Record<string, unknown> = {};
  for (const m of inputs) inputs0[m.varId] = sanitizeInputValue(m, undefined);

  return {
    ok: true,
    warning,
    indicator: {
      id: newImportedPineId(),
      name,
      source,
      enabled: true,
      overlay,
      inputs: inputs0,
      inputMeta: inputs,
      plotMeta: visuals.slice(0, MAX_PLOT_SERIES_PER_INDICATOR).map(plotMetaFromVisual),
      diagnostics,
      createdAt: Date.now(),
    },
  };
}
