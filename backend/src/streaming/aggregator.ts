import type { ClosedCandle, IngTick, RealtimeCandle } from "./types.js";

/**
 * Aggregates an incoming tick stream into OHLC candles for a single timeframe.
 *
 * Each tick updates the current (forming) candle with
 *   high = max(high, price), low = min(low, price), close = latest price.
 * When the tick's bucket advances to a new timeframe boundary, a new candle is
 * opened at that bucket. `time` = bucket START in epoch seconds — the convention
 * consumed by `series.update()` on the frontend (Lightweight Charts).
 *
 * DIAGNOSTICS (temporary): every candle also carries the per-bucket tick count,
 * the first/last tick timestamps and the UNROUNDED price OHLC (`priceRaw`), so
 * we can compare our live construction against IG's server-side candles.
 */
export class CandleAggregator {
  private current?: RealtimeCandle;
  /** Last closed candle + its bucket statistics (diagnostics). */
  private lastClosed?: ClosedCandle;
  /** Cumulated ticks seen by this aggregator (LTE cheap). */
  private startedAt = 0;
  /** Per-bucket stats while the current candle is forming. */
  private tickCount = 0;
  private firstTickMs = 0;
  private lastTickMs = 0;
  /** Unrounded (priceRaw) OHLC — diagnostics only, NOT the chart values. */
  private rawOpen = NaN;
  private rawHigh = NaN;
  private rawLow = NaN;
  private rawClose = NaN;

  constructor(
    readonly bucketSec: number,
    readonly timeframe: string,
  ) {}

  onTick(tick: IngTick): void {
    const bucket = this.bucketOf(tick.tsMs);
    const price = Number.isFinite(tick.price) ? tick.price : 0;
    const volume = Number.isFinite(tick.volume) && tick.volume > 0 ? tick.volume : 0;
    const raw = Number.isFinite(tick.priceRaw) ? tick.priceRaw : price;

    if (!this.current || this.current.time !== bucket) {
      // New bucket (or first tick): open a fresh candle. The OLD bucket is
      // closed into the diagnostics record FIRST so callers can read it.
      this.closeCurrent();
      if (!this.startedAt) this.startedAt = Date.now();
      this.current = {
        time: bucket,
        open: price,
        high: price,
        low: price,
        close: price,
      };
      if (volume > 0) this.current.volume = volume;
      this.tickCount = 1;
      this.firstTickMs = tick.tsMs;
      this.lastTickMs = tick.tsMs;
      this.rawOpen = raw;
      this.rawHigh = raw;
      this.rawLow = raw;
      this.rawClose = raw;
      return;
    }

    const c = this.current;
    if (price > c.high) c.high = price;
    if (price < c.low) c.low = price;
    c.close = price;
    if (volume > 0) c.volume = (c.volume ?? 0) + volume;
    this.tickCount += 1;
    this.lastTickMs = tick.tsMs;
    if (raw > this.rawHigh) this.rawHigh = raw;
    if (raw < this.rawLow) this.rawLow = raw;
    this.rawClose = raw;
  }

  /** Move the current candle into the closed-candle record (rollover only). */
  private closeCurrent(): void {
    if (!this.current) return;
    this.lastClosed = {
      ...this.current,
      tickCount: this.tickCount,
      firstTickMs: this.firstTickMs,
      lastTickMs: this.lastTickMs,
      ...(Number.isFinite(this.rawOpen)
        ? { rawOpen: this.rawOpen, rawHigh: this.rawHigh, rawLow: this.rawLow, rawClose: this.rawClose }
        : {}),
    };
  }

  /** True when the last tick started a brand new bucket (candle could close). */
  hasCandle(): boolean {
    return this.current !== undefined;
  }

  getCandle(): RealtimeCandle | undefined {
    return this.current === undefined ? undefined : { ...this.current };
  }

  /** The most recently closed candle (undefined until the first rollover). */
  getClosedCandle(): ClosedCandle | undefined {
    return this.lastClosed === undefined ? undefined : { ...this.lastClosed };
  }

  /** Per-bucket stats of the currently-forming candle. */
  getCurrentStats(): { tickCount: number; firstTickMs: number; lastTickMs: number } {
    return { tickCount: this.tickCount, firstTickMs: this.firstTickMs, lastTickMs: this.lastTickMs };
  }

  bucketOf(epochMs: number): number {
    const bucket = Math.floor(epochMs / 1000 / this.bucketSec) * this.bucketSec;
    return bucket;
  }
}

/**
 * Maintains one {@link CandleAggregator} per timeframe. Every incoming IG tick
 * fans out to each timeframe so whichever resolution a client picks is
 * already being aggregated server-side.
 */
export class CandleAggregatorSet {
  private readonly aggs: CandleAggregator[];

  constructor(agos: { timeframe: string; bucketSec: number }[]) {
    this.aggs = agos.map((a) => new CandleAggregator(a.bucketSec, a.timeframe));
  }

  onTick(tick: IngTick): void {
    for (const agg of this.aggs) agg.onTick(tick);
  }

  getCandleFor(bucketSec: number): RealtimeCandle | undefined {
    const agg = this.aggs.find((a) => a.bucketSec === bucketSec);
    return agg?.getCandle();
  }

  getClosedCandleFor(bucketSec: number): ClosedCandle | undefined {
    const agg = this.aggs.find((a) => a.bucketSec === bucketSec);
    return agg?.getClosedCandle();
  }

  getCurrentStatsFor(
    bucketSec: number,
  ): { tickCount: number; firstTickMs: number; lastTickMs: number } | undefined {
    const agg = this.aggs.find((a) => a.bucketSec === bucketSec);
    return agg?.getCurrentStats();
  }
}