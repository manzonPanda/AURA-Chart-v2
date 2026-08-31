/**
 * Pure EMA (Exponential Moving Average) — framework-free, unit-testable.
 *
 * This module is the SINGLE source of EMA math for AURA Chart. It stays
 * independent of React, CandleKit, Lightweight Charts and localStorage so the
 * exact same calculation can later run inside the CandleKit replay engine:
 *
 *   Supabase 1m OHLC → Replay Engine → selected timeframe → calculateEMA → chart
 *
 * Formula (standard EMA, source = candle CLOSE):
 *   multiplier = 2 / (period + 1)
 *   EMA_today  = Price_today × multiplier + EMA_previous × (1 − multiplier)
 *
 * Initialization (ONE consistent approach for every period): the seed is the
 * SIMPLE MOVING AVERAGE of the first `period` closes, stamped at bar index
 * `period − 1` — the same convention TradingView uses. No values are emitted
 * before `period` closes exist, so a chart with fewer than `period` candles
 * shows NO EMA line instead of a misleading one.
 *
 * Preconditions: `bars` ordered by ascending `ts` (the chart's candle arrays
 * already guarantee this). Bars with non-finite `ts`/`close` are skipped
 * defensively; the seed uses the first `period` VALID closes.
 */

/** Minimal bar input for the EMA math — a structural subset of `Candle`,
 *  CandleKit's `Bar`, and future replay bars (extra fields are ignored). */
export interface EmaSourceBar {
  /** Bucket start, epoch ms. */
  ts: number;
  /** EMA source price (the candle close). */
  close: number;
}

/** One EMA sample: bucket start (epoch ms) + indicator value. */
export interface EmaPoint {
  ts: number;
  value: number;
}

/** Lowest usable period (1 ⇒ EMA degenerates to the close itself). */
export const MIN_EMA_PERIOD = 1;
/** Sanity cap so a typo can't request a multi-thousand-period average. */
export const MAX_EMA_PERIOD = 500;

/** Strict positive-integer period check (rejects 0, negatives, floats, NaN, ±Infinity). */
export function isValidEmaPeriod(period: unknown): period is number {
  return (
    typeof period === "number" &&
    Number.isInteger(period) &&
    period >= MIN_EMA_PERIOD &&
    period <= MAX_EMA_PERIOD
  );
}

/**
 * Calculate the EMA of `bars`' closes for `period`.
 *
 * Returns ascending `{ ts, value }` pairs starting at the SMA seed bar
 * (index `period − 1`). Returns [] when the period is invalid or fewer than
 * `period` valid bars exist (insufficient history ⇒ no misleading values).
 */
export function calculateEMA(bars: readonly EmaSourceBar[], period: number): EmaPoint[] {
  if (!isValidEmaPeriod(period) || !Array.isArray(bars)) return [];

  const clean: EmaSourceBar[] = [];
  for (const b of bars) {
    if (b && Number.isFinite(b.ts) && Number.isFinite(b.close)) {
      clean.push({ ts: b.ts, close: b.close });
    }
  }
  if (clean.length < period) return [];

  const multiplier = 2 / (period + 1);

  // Seed: SMA of the first `period` closes, stamped at that bar's ts.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += clean[i].close;
  let ema = sum / period;

  const points: EmaPoint[] = [{ ts: clean[period - 1].ts, value: ema }];
  for (let i = period; i < clean.length; i++) {
    ema = clean[i].close * multiplier + ema * (1 - multiplier);
    points.push({ ts: clean[i].ts, value: ema });
  }
  return points;
}

/**
 * Merge the chart's bar list with the forming candle's SERVER TRUTH.
 *
 *  - same bucket   → the WS snapshot REPLACES the last close (CandleKit's
 *                    equal-ts REPLACE semantics — the server frame is a full,
 *                    self-contained snapshot of the forming bucket);
 *  - newer bucket  → appended (bucket rollover);
 *  - older bucket  → ignored (stale/out-of-order frame).
 *
 * This is the AUTHORITATIVE candle state the EMA must track — never the
 * rAF-animated close — so background-tab throttling and the cosmetic glide can
 * never skew an EMA value (the previous doji-bug class stays impossible).
 */
export function effectiveCloseSeries(
  bars: readonly EmaSourceBar[],
  live: { time: number; close: number } | null,
  bucketSec: number,
): EmaSourceBar[] {
  const out: EmaSourceBar[] = [];
  for (const b of bars) {
    if (b && Number.isFinite(b.ts) && Number.isFinite(b.close)) {
      out.push({ ts: b.ts, close: b.close });
    }
  }
  if (!live || !Number.isFinite(live.close) || !Number.isFinite(live.time) || !(bucketSec > 0)) {
    return out;
  }
  // Floor the server bucket-start (epoch s) to the timeframe grid (epoch ms).
  const bucketMs = bucketSec * 1000;
  const bucketTs = Math.floor((live.time * 1000) / bucketMs) * bucketMs;
  const last = out.length > 0 ? out[out.length - 1] : null;
  if (!last || bucketTs > last.ts) {
    out.push({ ts: bucketTs, close: live.close });
  } else if (bucketTs === last.ts) {
    out[out.length - 1] = { ts: bucketTs, close: live.close };
  }
  // bucketTs < last.ts → stale frame, ignored.
  return out;
}
