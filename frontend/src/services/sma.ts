/**
 * Pure SMA (Simple Moving Average) — framework-free, unit-testable.
 *
 * This module is the SINGLE source of SMA math for AURA Chart, mirroring the
 * existing EMA module (services/ema.ts). It stays independent of React,
 * CandleKit, Lightweight Charts and localStorage so the exact same calculation
 * can later run inside the CandleKit replay engine:
 *
 *   Supabase 1m OHLC → Replay Engine → selected timeframe → calculateSMA → chart
 *
 * Formula (standard SMA, source = candle CLOSE):
 *   SMA_t = mean(close[t - period + 1 .. t])
 *
 * No values are emitted before `period` closes exist — a chart with fewer than
 * `period` candles shows NO SMA line instead of a misleading one.
 *
 * Preconditions: `bars` ordered by ascending `ts` (the chart's candle arrays
 * already guarantee this). Bars with non-finite `ts`/`close` are skipped
 * defensively.
 */

/** Minimal bar input for the SMA math — a structural subset of `Candle`,
 *  CandleKit's `Bar`, and future replay bars (extra fields are ignored). */
export interface SmaSourceBar {
  /** Bucket start, epoch ms. */
  ts: number;
  /** SMA source price (the candle close). */
  close: number;
}

/** One SMA sample: bucket start (epoch ms) + indicator value. */
export interface SmaPoint {
  ts: number;
  value: number;
}

/** Lowest usable period (1 ⇒ SMA degenerates to the close itself). */
export const MIN_SMA_PERIOD = 1;
/** Sanity cap so a typo can't request a multi-thousand-period average. */
export const MAX_SMA_PERIOD = 1000;

/** Strict positive-integer period check (rejects 0, negatives, floats, NaN, ±Infinity). */
export function isValidSmaPeriod(period: unknown): period is number {
  return (
    typeof period === "number" &&
    Number.isInteger(period) &&
    period >= MIN_SMA_PERIOD &&
    period <= MAX_SMA_PERIOD
  );
}

/**
 * Calculate the SMA of `bars`' closes for `period`.
 *
 * Returns ascending `{ ts, value }` pairs starting at bar index `period - 1`
 * (the first bar with a full window). Returns [] when the period is invalid or
 * fewer than `period` valid bars exist (insufficient history ⇒ no misleading
 * values).
 *
 * Sliding-window O(n): the running sum is updated once per bar instead of
 * re-summing the window every step, so thousands of candles stay cheap.
 */
export function calculateSMA(bars: readonly SmaSourceBar[], period: number): SmaPoint[] {
  if (!isValidSmaPeriod(period) || !Array.isArray(bars)) return [];

  const clean: SmaSourceBar[] = [];
  for (const b of bars) {
    if (b && Number.isFinite(b.ts) && Number.isFinite(b.close)) {
      clean.push({ ts: b.ts, close: b.close });
    }
  }
  if (clean.length < period) return [];

  const points: SmaPoint[] = [];
  let sum = 0;
  // Seed the first window (indices 0..period-1).
  for (let i = 0; i < period; i++) sum += clean[i].close;
  points.push({ ts: clean[period - 1].ts, value: sum / period });
  // Slide the window one bar at a time.
  for (let i = period; i < clean.length; i++) {
    sum += clean[i].close - clean[i - period].close;
    points.push({ ts: clean[i].ts, value: sum / period });
  }
  return points;
}