/**
 * Server-side PineTS EMA adapter — the SAME engine + the SAME Pine Script
 * source the frontend uses for its EMA 9/20 overlays.
 *
 *   frontend: services/pineEngine.ts  →  PineIndicatorEngine  →  pinets ta.ema
 *   backend:  emaAlert/pineEma.ts     →  PineEmaSeries         →  pinets ta.ema
 *
 * This is deliberately NOT a second EMA calculation: `ta.ema` (Pine Script)
 * remains the single source of EMA truth for AURA. The frontend keeps its
 * `services/ema.ts` oracle purely as a regression fallback; the server has no
 * fallback — if PineTS is unavailable the alert engine stays inert (never
 * guesses).
 *
 * Node-build note (verified against pinets 0.9.33): plot rows arrive aligned
 * 1:1 with the klines array and carry `{ title, value, options }` — WITHOUT a
 * `time` field (the browser build includes one). Warm-up rows are non-finite.
 * Timestamps are therefore zipped positionally from `openTime`.
 */
import { PineTS, Indicator } from "pinets";

/**
 * The EMA Pine Script — MUST stay byte-identical to `EMA_PINE_SOURCE` in
 * frontend/src/services/pineIndicators.ts (single shared signal definition;
 * duplicated only because the two packages are separately bundled).
 */
const EMA_PINE_SOURCE = `//@version=6
indicator("AURA EMA", overlay = true)
length = input.int(9, "Period", minval = 1)
basis = ta.ema(close, length)
plot(basis, "ema", color = color.orange, linewidth = 2)`;

/** Minimal closed-candle shape the engine feeds (epoch-ms openTime). */
export interface EmaCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime: number;
  volume: number;
}

/** One aligned EMA series value (null = warm-up/insufficient history). */
export type EmaValue = number | null;

export class PineEmaSeries {
  private pine: PineTS | null = null;
  private candles: EmaCandle[] = [];
  private readonly compiled = new Map<number, Indicator>();
  private readonly cache = new Map<number, EmaValue[]>();
  private signature = "";

  /** Current candle count (engine status surface). */
  get length(): number {
    return this.candles.length;
  }

  /** Stored closed candles (engine replay source). */
  get all(): readonly EmaCandle[] {
    return this.candles;
  }

  /**
   * Replace the candle series. Returns true when the series actually changed
   * (the runtime + caches are only rebuilt then — mirrors the frontend
   * engine's signature guard).
   */
  setCandles(candles: EmaCandle[]): boolean {
    const last = candles[candles.length - 1];
    const prevLast = this.candles[this.candles.length - 1];
    const sig = `${candles.length}|${last?.openTime ?? 0}:${last?.close ?? 0}`;
    const unchanged =
      candles.length === this.candles.length &&
      prevLast !== undefined &&
      prevLast.openTime === (last?.openTime ?? 0) &&
      prevLast.close === (last?.close ?? 0);
    if (unchanged && sig === this.signature) return false;
    this.candles = [...candles];
    this.signature = sig;
    this.cache.clear();
    this.pine = new PineTS(
      this.candles.map((c) => ({
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        closeTime: c.closeTime,
      })),
    );
    return true;
  }

  /**
   * Compute (or fetch from cache) the EMA series for `period`, positionally
   * aligned with the candles. Returns null when the series is empty or the
   * runtime produced a misaligned plot (defensive — never guessed values).
   */
  async compute(period: number): Promise<EmaValue[] | null> {
    if (this.candles.length === 0 || this.pine === null) return null;
    const cached = this.cache.get(period);
    if (cached) return cached;

    let indicator = this.compiled.get(period);
    if (!indicator) {
      indicator = new Indicator(EMA_PINE_SOURCE);
      try {
        (indicator.input as Record<string, unknown>).Period = period;
      } catch {
        /* frozen input — the script default (9) would apply; guarded below */
      }
      indicator.prepare();
      this.compiled.set(period, indicator);
    }

    let ctx: { plots?: Record<string, { data?: unknown[] }> };
    try {
      ctx = (await this.pine.run(indicator, this.candles.length)) as typeof ctx;
    } catch {
      return null; // runtime failure → unavailable, never guessed
    }
    const data = ctx?.plots?.["ema"]?.data;
    if (!Array.isArray(data) || data.length !== this.candles.length) return null;

    const values: EmaValue[] = data.map((row) => {
      const v = (row as { value?: unknown } | null)?.value;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    });
    this.cache.set(period, values);
    return values;
  }
}
