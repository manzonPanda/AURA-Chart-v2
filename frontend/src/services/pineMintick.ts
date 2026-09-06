/**
 * Shared mintick (tick-size) resolution for Pine engines.
 *
 * Single source of truth for how AURA derives `syminfo.mintick`-style metadata —
 * consumed by BOTH the retained PineTS path (pineEngine.ts) and the Piner path
 * (pinePinerCore.ts), so the two engines can never disagree about the active
 * instrument's tick grid. Pure + framework-free (worker-safe, Node-testable).
 */

function clampDecimals(decimals: number): number {
  return typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 8
    ? decimals
    : 0;
}

/** Tick size implied by an instrument's quoting precision (0–8 decimals). */
export function mintickFromDecimals(decimals: number): number {
  return 10 ** -clampDecimals(decimals);
}

/**
 * Data-derived mintick fallback (mirrors PineTS's own FMPProvider heuristic and
 * TradingView grid semantics): the smallest observed price delta, snapped DOWN
 * onto the standard tick grid {1, 2, 2.5, 5} × 10^n. Returns `null` when the
 * candles carry no usable delta at all (degenerate flat data) — the caller owns
 * the terminal fallback.
 */
export function estimateMintickFromCandles(
  klines: readonly { open: number; high: number; low: number; close: number }[],
): number | null {
  let min = Infinity;
  const consider = (d: number): void => {
    if (Number.isFinite(d) && d > 0 && d < min) min = d;
  };
  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    if (!k) continue;
    consider(Math.abs(k.close - k.open));
    consider(Math.abs(k.high - k.low));
    const prev = klines[i - 1];
    if (prev) consider(Math.abs(k.close - prev.close));
  }
  if (!Number.isFinite(min)) return null;
  const exp = Math.floor(Math.log10(min));
  const base = 10 ** exp;
  const mantissa = min / base;
  const grid = mantissa >= 5 ? 5 : mantissa >= 2.5 ? 2.5 : mantissa >= 2 ? 2 : 1;
  return grid * base;
}

/** Terminal fallback for degenerate flat data (no decimals, no usable deltas). */
export const MINTICK_DATA_FLOOR = 0.0001;

/**
 * Resolve the mintick for a run from an instrument's quoting precision first,
 * then the candle data, then the documented degenerate floor. Never a global
 * 0.01 — matches the precedent set by buildPineSymbolInfo (PineTS).
 */
export function resolveMintickForRun(
  symbol: { decimals?: number } | null | undefined,
  klines: readonly { open: number; high: number; low: number; close: number }[],
): number {
  if (symbol?.decimals !== undefined && symbol?.decimals !== null) {
    return mintickFromDecimals(symbol.decimals);
  }
  return estimateMintickFromCandles(klines) ?? MINTICK_DATA_FLOOR;
}