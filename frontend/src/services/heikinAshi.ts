/**
 * Heikin Ashi candle calculation — pure, framework-free, unit-testable.
 *
 * Heikin Ashi transforms standard OHLC candles into a smoothed representation
 * that filters noise and highlights trends. The transformation is applied as a
 * PRESENTATION-LAYER ONLY operation — the original market OHLC data is never
 * modified and remains available for indicators, overlays, and trading logic.
 *
 * Formulas:
 *   HA Close = (Open + High + Low + Close) / 4
 *   HA Open (first) = (Open + Close) / 2
 *   HA Open (subsequent) = (Prev HA Open + Prev HA Close) / 2
 *   HA High = max(High, HA Open, HA Close)
 *   HA Low = min(Low, HA Open, HA Close)
 *
 * Calculation proceeds chronologically from oldest to newest candle.
 * The first candle's HA Open uses its own original Open/Close.
 */

import type { Candle } from "../types/candle";

/** Heikin Ashi candle shape (same as Candle but with transformed values). */
export interface HeikinAshiCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * The HA predecessor pair — the {open, close} of the Heikin Ashi candle that
 * precedes the candle being transformed. `null` means "chain start" (the
 * first-candle (O+C)/2 seed applies).
 */
export interface HeikinAshiPair {
  open: number;
  close: number;
}

/**
 * Transform ONE candle against a known predecessor pair — the single-bar
 * primitive every Heikin Ashi path shares (the batch calculator below and the
 * live paint boundary in TradingChart's LiveBarBridge), so the formula exists
 * in exactly ONE place.
 *
 *   HA Close = (Open + High + Low + Close) / 4
 *   HA Open  = prev ? (prev.open + prev.close) / 2 : (Open + Close) / 2
 *   HA High  = max(High, HA Open, HA Close)
 *   HA Low   = min(Low, HA Open, HA Close)
 *
 * Pure: never mutates the input candle. Invariant holds for ANY predecessor:
 * HA Open ≤ HA High and HA Close ≥ HA Low (both lie between min(O,C) and
 * max(O,C), and O/C are within [Low, High] for any real candle).
 */
export function heikinAshiBar(candle: Candle, prev: HeikinAshiPair | null): HeikinAshiCandle {
  const haClose = (candle.open + candle.high + candle.low + candle.close) / 4;
  const haOpen = prev
    ? (prev.open + prev.close) / 2
    : (candle.open + candle.close) / 2;
  return {
    ts: candle.ts,
    open: haOpen,
    high: Math.max(candle.high, haOpen, haClose),
    low: Math.min(candle.low, haOpen, haClose),
    close: haClose,
    ...(candle.volume !== undefined && Number.isFinite(candle.volume) ? { volume: candle.volume } : {}),
  };
}

/**
 * Transform an array of standard OHLC candles into Heikin Ashi candles.
 *
 * Always receives ORIGINAL market OHLC (never already-transformed candles) —
 * the chart recomputes the full chain from the oldest available candle
 * whenever the loaded history changes (initial load, "Load More" prepend,
 * live-ledger growth), so recursive opens can never accumulate drift or be
 * derived from synthetic values.
 *
 * @param candles - Array of standard candles in CHRONOLOGICAL ORDER (oldest first)
 * @returns Array of Heikin Ashi candles in the same order
 */
export function calculateHeikinAshi(candles: readonly Candle[]): HeikinAshiCandle[] {
  if (!Array.isArray(candles) || candles.length === 0) {
    return [];
  }

  const result: HeikinAshiCandle[] = [];
  let prev: HeikinAshiPair | null = null;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Skip invalid candles defensively (same convention as ema.ts / sma.ts).
    if (
      !candle ||
      !Number.isFinite(candle.ts) ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close)
    ) {
      continue;
    }

    const ha = heikinAshiBar(candle, prev);
    result.push(ha);
    // The pair advances only on VALID candles, so a skipped candle can never
    // poison the recursive chain, and the first VALID candle always gets the
    // (Open + Close) / 2 seed.
    prev = { open: ha.open, close: ha.close };
  }

  return result;
}

/**
 * Update the latest Heikin Ashi candle when the forming candle updates.
 *
 * The forming candle's HA values are provisional (recomputed from ORIGINAL
 * OHLC on every update) and become final when the bucket closes. When the
 * forming bucket already sits at the tail (appended by a previous tick), its
 * PREVIOUS pair is the candle BEFORE it — never its own values, which would
 * make repeated same-bucket updates drift.
 *
 * @param haCandles - Existing Heikin Ashi candles (chronological, all closed)
 * @param formingCandle - Current forming standard candle (may be partial)
 * @returns Updated Heikin Ashi array with provisional last candle
 */
export function updateFormingHeikinAshi(
  haCandles: readonly HeikinAshiCandle[],
  formingCandle: Candle | null
): HeikinAshiCandle[] {
  if (!formingCandle) return [...haCandles];

  const result = [...haCandles];
  const replacesTail =
    result.length > 0 && result[result.length - 1].ts === formingCandle.ts;
  const prevIndex = (replacesTail ? result.length : result.length + 1) - 2;
  const prevCandle = prevIndex >= 0 ? result[prevIndex] : null;
  const prev: HeikinAshiPair | null = prevCandle
    ? { open: prevCandle.open, close: prevCandle.close }
    : null;

  const formingHA = heikinAshiBar(formingCandle, prev);

  // Replace or append the forming candle
  if (replacesTail) {
    result[result.length - 1] = formingHA;
  } else {
    result.push(formingHA);
  }

  return result;
}

/** Candle type enum for UI and persistence. */
export type CandleType = "candles" | "heikin-ashi";

/** Default candle type (preserves current experience). */
export const DEFAULT_CANDLE_TYPE: CandleType = "candles";

/** localStorage key for candle type persistence. */
export const CANDLE_TYPE_STORAGE_KEY = "aura.candleType.v1";

/** Valid candle type values. */
export const VALID_CANDLE_TYPES: readonly CandleType[] = ["candles", "heikin-ashi"];

/** Human-readable labels for candle types. */
export const CANDLE_TYPE_LABELS: Record<CandleType, string> = {
  candles: "Candles",
  "heikin-ashi": "Heikin Ashi",
};

/**
 * Validate a stored candle type value.
 * Unknown, non-string, or corrupted values fall back to DEFAULT_CANDLE_TYPE.
 */
export function sanitizeCandleType(raw: unknown): CandleType {
  return typeof raw === "string" && VALID_CANDLE_TYPES.includes(raw as CandleType)
    ? (raw as CandleType)
    : DEFAULT_CANDLE_TYPE;
}

/**
 * Load persisted candle type from storage.
 * Falls back to DEFAULT_CANDLE_TYPE if missing, unreadable, or invalid.
 */
export function loadCandleType(
  storage: { getItem(key: string): string | null } = window.localStorage
): CandleType {
  try {
    return sanitizeCandleType(storage.getItem(CANDLE_TYPE_STORAGE_KEY));
  } catch {
    return DEFAULT_CANDLE_TYPE;
  }
}

/**
 * Persist the selected candle type.
 * Storage failures are swallowed — selection stays session-only.
 */
export function saveCandleType(
  candleType: CandleType,
  storage: { setItem(key: string, value: string): void } = window.localStorage
): void {
  try {
    storage.setItem(CANDLE_TYPE_STORAGE_KEY, sanitizeCandleType(candleType));
  } catch {
    // storage unavailable — selection stays session-only
  }
}