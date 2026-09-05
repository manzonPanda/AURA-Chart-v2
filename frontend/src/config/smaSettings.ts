/**
 * SMA overlay configuration — frontend-only, persisted in localStorage.
 *
 * Architecture contract (mirrors emaSettings.ts exactly):
 *   - Supabase stores ONLY canonical 1m OHLC candles (3m is derived on read).
 *   - SMA VALUES are calculated client-side from the selected timeframe's
 *     candle series (services/sma.ts) and are NEVER stored anywhere.
 *   - SMA CONFIGURATION (enabled / period / color / width) lives in the
 *     browser via localStorage (`aura.sma.settings`), validated on load so a
 *     corrupted entry falls back to the defaults instead of breaking the chart.
 *
 * Deliberately exactly one SMA line (any single period from the fixed menu) —
 * not a generic n-slot indicator system.
 */

import { isValidSmaPeriod } from "../services/sma.ts";

export interface SmaConfig {
  enabled: boolean;
  /** Positive integer — constrained to the SMA_PERIODS menu. */
  period: number;
  /** Hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). */
  color: string;
  /** Lightweight Charts LineWidth domain (1–4). */
  width: number;
}

export type SmaSettings = SmaConfig;

/**
 * The fixed SMA period menu — the user picks ONE of these. Adding another
 * common period later is a one-line change here.
 */
export const SMA_PERIODS: readonly number[] = [9, 20, 50, 100, 200];

/** localStorage key — configuration ONLY, never calculated SMA data. */
export const SMA_STORAGE_KEY = "aura.sma.settings";

/** LWC LineWidth domain (`type LineWidth = 1 | 2 | 3 | 4`). */
export const MIN_LINE_WIDTH = 1;
export const MAX_LINE_WIDTH = 4;

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` — valid for LWC + color picker. */
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Default SMA styling — a violet line distinct from EMA's amber (9)/sky (20),
 * so all three read clearly together.
 */
export const DEFAULT_SMA_SETTINGS: SmaSettings = {
  enabled: true,
  period: 20,
  color: "#a78bfa",
  width: 2,
};

/** Fresh default settings (also the corrupted-storage fallback). */
export function defaultSmaSettings(): SmaSettings {
  return { ...DEFAULT_SMA_SETTINGS };
}

function sanitizeSmaConfig(raw: unknown, fallback: SmaConfig): SmaConfig {
  const out: SmaConfig = { ...fallback };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (isValidSmaPeriod(r.period)) out.period = r.period;
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
 * settings. Unknown shapes fall back PER FIELD to the defaults, so a corrupted
 * localStorage entry can never break the chart.
 */
export function sanitizeSmaSettings(raw: unknown): SmaSettings {
  return sanitizeSmaConfig(raw, defaultSmaSettings());
}

/** localStorage → settings (guarded: missing/private-mode/corrupted → defaults). */
export function loadSmaSettings(): SmaSettings {
  try {
    const raw = window.localStorage?.getItem(SMA_STORAGE_KEY);
    if (!raw) return defaultSmaSettings();
    return sanitizeSmaSettings(JSON.parse(raw));
  } catch {
    return defaultSmaSettings();
  }
}

/** settings → localStorage (guarded: storage errors are non-fatal, session-only). */
export function saveSmaSettings(settings: SmaSettings): void {
  try {
    window.localStorage?.setItem(SMA_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable — settings stay session-only */
  }
}

/** `#abc` → `#aabbcc`; drops alpha so <input type="color"> always gets `#rrggbb`. */
export function hexToRrggbbSma(color: string): string {
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