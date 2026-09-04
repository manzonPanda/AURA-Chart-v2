/**
 * EMA Reversal Alert — settings model + sanitizer (PURE, I/O-free).
 *
 * Single source of truth for the alert configuration shape shared by the
 * backend engine, the REST routes and the JSON settings file. The module is
 * deliberately import-free so it is trivially unit-testable and can never
 * drag runtime dependencies into the state-machine tests.
 *
 * Session semantics:
 *   - `sessionTimezone` is a fixed IANA zone (America/New_York) — the session
 *     math is DST-safe by construction and never uses a fixed UTC offset.
 *   - `sessionStart` / `sessionEnd` are wall-clock "HH:MM" (24h) strings in
 *     that zone, e.g. "09:30" / "16:00".
 *
 * The backend is the runtime source of truth (REST GET/POST + JSON file);
 * the frontend mirrors this shape for display only.
 */

/** IANA zone the session window is quoted in (fixed by the feature spec). */
export const EMA_ALERT_SESSION_TIMEZONE = "America/New_York" as const;

/** Allowed confirmation candle counts. */
export type ConfirmationCandles = 1 | 2 | 3 | 4 | 5;

export const CONFIRMATION_CANDLE_CHOICES: readonly ConfirmationCandles[] = [1, 2, 3, 4, 5];
export const DEFAULT_CONFIRMATION_CANDLES: ConfirmationCandles = 2;

/** Alert timeframes — each detector runs independently (config-driven). */
export const EMA_ALERT_TIMEFRAMES = ["MINUTE_1", "MINUTE_3"] as const;
export type EmaAlertTimeframe = (typeof EMA_ALERT_TIMEFRAMES)[number];
export type EmaAlertTimeframeList = EmaAlertTimeframe[];

/** Default: BOTH detectors active regardless of the viewed chart timeframe. */
export const DEFAULT_ALERT_TIMEFRAMES: EmaAlertTimeframeList = [...EMA_ALERT_TIMEFRAMES];

/** Cooldown bounds (minutes). 0 disables the secondary safety delay. */
export const MIN_COOLDOWN_MINUTES = 0;
export const MAX_COOLDOWN_MINUTES = 720;
export const DEFAULT_COOLDOWN_MINUTES = 30;

/** Default session window — NY cash equities 09:30–16:00. */
export const DEFAULT_SESSION_START = "09:30";
export const DEFAULT_SESSION_END = "16:00";

export interface EmaAlertSettings {
  /** Master switch — when false the engine never emits notifications. */
  enabled: boolean;
  /** Timeframes whose independent detectors are active (MINUTE_1, MINUTE_3). */
  alertTimeframes: EmaAlertTimeframeList;
  /** CLOSED candles the new EMA relationship must hold (1–5). */
  confirmationCandles: ConfirmationCandles;
  /** Emit confirmed bullish reversals. */
  bullishEnabled: boolean;
  /** Emit confirmed bearish reversals. */
  bearishEnabled: boolean;
  /** Fixed IANA zone (never a fixed UTC offset). */
  sessionTimezone: typeof EMA_ALERT_SESSION_TIMEZONE;
  /** NY wall-clock session open, "HH:MM" 24h. */
  sessionStart: string;
  /** NY wall-clock session close, "HH:MM" 24h. */
  sessionEnd: string;
  /** Secondary duplicate-safety window in minutes (per timeframe, per direction). */
  cooldownMinutes: number;
}

/** Fresh defaults (also the corrupted-storage fallback). */
export function defaultEmaAlertSettings(): EmaAlertSettings {
  return {
    enabled: false,
    alertTimeframes: [...DEFAULT_ALERT_TIMEFRAMES],
    confirmationCandles: DEFAULT_CONFIRMATION_CANDLES,
    bullishEnabled: true,
    bearishEnabled: true,
    sessionTimezone: EMA_ALERT_SESSION_TIMEZONE,
    sessionStart: DEFAULT_SESSION_START,
    sessionEnd: DEFAULT_SESSION_END,
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
  };
}

/** Strict "HH:MM" 24-hour wall-clock check ("09:30" ok, "9:30" not). */
export function isValidHHMM(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function sanitizeConfirmation(raw: unknown): ConfirmationCandles {
  return (CONFIRMATION_CANDLE_CHOICES as readonly number[]).includes(raw as number)
    ? (raw as ConfirmationCandles)
    : DEFAULT_CONFIRMATION_CANDLES;
}

function sanitizeCooldown(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_COOLDOWN_MINUTES;
  return Math.min(MAX_COOLDOWN_MINUTES, Math.max(MIN_COOLDOWN_MINUTES, Math.round(raw)));
}

/**
 * Validate arbitrary (possibly corrupted / partially-written) settings data
 * into an always-usable object. Unknown shapes fall back PER FIELD to the
 * defaults, so a corrupted JSON file can never break the alert engine.
 */
export function sanitizeEmaAlertSettings(raw: unknown): EmaAlertSettings {
  const out = defaultEmaAlertSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  out.alertTimeframes = sanitizeAlertTimeframes(r.alertTimeframes);
  out.confirmationCandles = sanitizeConfirmation(r.confirmationCandles);
  if (typeof r.bullishEnabled === "boolean") out.bullishEnabled = r.bullishEnabled;
  if (typeof r.bearishEnabled === "boolean") out.bearishEnabled = r.bearishEnabled;
  // sessionTimezone is fixed by the spec — a stored value can only confirm it.
  if (r.sessionTimezone === EMA_ALERT_SESSION_TIMEZONE) out.sessionTimezone = r.sessionTimezone;
  if (isValidHHMM(r.sessionStart)) out.sessionStart = r.sessionStart;
  if (isValidHHMM(r.sessionEnd)) out.sessionEnd = r.sessionEnd;
  out.cooldownMinutes = sanitizeCooldown(r.cooldownMinutes);
  return out;
}

/**
 * Timeframe selection: keep only known timeframe keys, dedupe, preserve order.
 * An explicit empty array is VALID (user unchecked every timeframe); a missing
 * / non-array value falls back to both defaults.
 */
function sanitizeAlertTimeframes(raw: unknown): EmaAlertTimeframeList {
  if (!Array.isArray(raw)) return [...DEFAULT_ALERT_TIMEFRAMES];
  const known = new Set<string>(EMA_ALERT_TIMEFRAMES);
  const out: EmaAlertTimeframe[] = [];
  for (const t of raw) {
    if ((typeof t === "string" && known.has(t)) && !out.includes(t as EmaAlertTimeframe)) {
      out.push(t as EmaAlertTimeframe);
    }
  }
  return out;
}
