/**
 * EMA overlay configuration — frontend-only, persisted in localStorage.
 *
 * Architecture contract:
 *   - Supabase stores ONLY canonical 1m OHLC candles (3m is derived on read).
 *   - EMA VALUES are calculated client-side from the selected timeframe's
 *     candle series (services/ema.ts) and are NEVER stored anywhere.
 *   - EMA CONFIGURATION (enabled / period / color / width) lives in the
 *     browser via localStorage (`aura.ema.settings`), validated on load so a
 *     corrupted entry falls back to the defaults instead of breaking the chart.
 *
 * Deliberately exactly two fixed slots — not a generic indicator system.
 */

import { isValidEmaPeriod } from "../services/ema.ts";

export type EmaSlotId = "ema9" | "ema20";

/** One configurable EMA slot. */
export interface EmaConfig {
  enabled: boolean;
  /** Positive integer (1–500). */
  period: number;
  /** Hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). */
  color: string;
  /** Lightweight Charts LineWidth domain (1–4). */
  width: number;
}

export type EmaSettings = Record<EmaSlotId, EmaConfig>;

export interface EmaSlot {
  id: EmaSlotId;
  /** Canonical name (the UI shows the live period, e.g. "EMA 12"). */
  label: string;
  defaults: EmaConfig;
}

/** localStorage key — configuration ONLY, never calculated EMA data. */
export const EMA_STORAGE_KEY = "aura.ema.settings";

/** LWC LineWidth domain (`type LineWidth = 1 | 2 | 3 | 4`). */
export const MIN_LINE_WIDTH = 1;
export const MAX_LINE_WIDTH = 4;

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` — valid for LWC + color picker. */
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The two fixed EMA slots with their default trading-chart styling. */
export const EMA_SLOTS: readonly EmaSlot[] = [
  {
    id: "ema9",
    label: "EMA 9",
    // Warm amber — reads clearly against the teal/red candles and the sky accent.
    defaults: { enabled: true, period: 9, color: "#fbbf24", width: 2 },
  },
  {
    id: "ema20",
    label: "EMA 20",
    // The AURA accent blue (--accent) for the slower average.
    defaults: { enabled: true, period: 20, color: "#38bdf8", width: 2 },
  },
];

/** Fresh default settings (also the corrupted-storage fallback). */
export function defaultEmaSettings(): EmaSettings {
  return {
    ema9: { ...EMA_SLOTS[0].defaults },
    ema20: { ...EMA_SLOTS[1].defaults },
  };
}

function sanitizeConfig(raw: unknown, fallback: EmaConfig): EmaConfig {
  const out: EmaConfig = { ...fallback };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (isValidEmaPeriod(r.period)) out.period = r.period;
  if (typeof r.color === "string") {
    const c = r.color.trim();
    if (HEX_COLOR_RE.test(c)) out.color = c.toLowerCase();
  }
  if (
    typeof r.width === "number" &&
    Number.isInteger(r.width) &&
    r.width >= MIN_LINE_WIDTH &&
    r.width <= MAX_LINE_WIDTH
  ) {
    out.width = r.width;
  }
  return out;
}

/**
 * Validate arbitrary (possibly corrupted) stored data into always-usable
 * settings. Unknown shapes fall back PER FIELD to the slot defaults, so a
 * corrupted localStorage entry can never break the chart.
 */
export function sanitizeEmaSettings(raw: unknown): EmaSettings {
  const defaults = defaultEmaSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const r = raw as Record<string, unknown>;
  return {
    ema9: sanitizeConfig(r.ema9, defaults.ema9),
    ema20: sanitizeConfig(r.ema20, defaults.ema20),
  };
}

/** localStorage → settings (guarded: missing/private-mode/corrupted → defaults). */
export function loadEmaSettings(): EmaSettings {
  try {
    const raw = window.localStorage?.getItem(EMA_STORAGE_KEY);
    if (!raw) return defaultEmaSettings();
    return sanitizeEmaSettings(JSON.parse(raw));
  } catch {
    return defaultEmaSettings();
  }
}

/** settings → localStorage (guarded: storage errors are non-fatal, session-only). */
export function saveEmaSettings(settings: EmaSettings): void {
  try {
    window.localStorage?.setItem(EMA_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable — settings stay session-only */
  }
}

/** `#abc` → `#aabbcc`; drops alpha so <input type="color"> always gets `#rrggbb`. */
export function hexToRrggbb(color: string): string {
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
