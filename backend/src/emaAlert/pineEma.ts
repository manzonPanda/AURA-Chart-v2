/**
 * Server-side Piner EMA adapter — the SAME engine + the SAME Pine Script
 * source the frontend uses for its EMA 9/20 overlays.
 *
 *   frontend: services/pinePinerEngine.ts → PinerPineEngine → Piner ta.ema
 *   backend:  emaAlert/pineEma.ts         → PineEmaSeries   → Piner ta.ema
 *
 * Piner (`@heyphat/piner`) is the sole Pine engine for AURA.
 * This is deliberately NOT a second EMA calculation: `ta.ema` (Pine Script)
 * remains the single source of EMA truth for AURA. The frontend keeps its
 * `services/ema.ts` oracle purely as a regression fallback; the server has
 * no fallback — if the engine fails the alert engine stays inert (never
 * guesses).
 *
 * Piner 0.13.0 notes (verified by the frontend probes + pinePiner tests):
 * the script is compiled ONCE per series life; `inputs` are passed per run
 * keyed by the input TITLE ("Period"); plot rows arrive aligned 1:1 with
 * the feed bars as a plain `number[]` (non-finite = warm-up). Timestamps
 * are zipped positionally from `openTime`.
 */
import { ArrayFeed, compile, Engine, type CompiledScript } from "@heyphat/piner";

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

/** Bucket seconds → Pine `timeframe.period` string ("1", "3"). */
function pineTimeframeStr(bucketSec: number): string {
  if (!Number.isFinite(bucketSec) || bucketSec <= 0) return "1";
  if (bucketSec % 60 === 0) return String(bucketSec / 60);
  return `${bucketSec}S`;
}

export class PineEmaSeries {
  private candles: EmaCandle[] = [];
  private compiled: CompiledScript | null = null;
  private readonly cache = new Map<number, EmaValue[]>();
  private signature = "";

  /** @param bucketSec timeframe bucket in seconds (drives the run identity only). */
  constructor(private readonly bucketSec = 60) {}

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
   * (caches are only cleared then — mirrors the frontend engine's signature
   * guard). Piner has no persistent runtime to rebuild: each compute() runs
   * a fresh deterministic Engine over the current slice.
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
    return true;
  }

  /**
   * Compute (or fetch from cache) the EMA series for `period`, positionally
   * aligned with the candles. Returns null when the series is empty, the
   * compile/run fails, or the plot arrives misaligned (defensive — never
   * guessed values).
   */
  async compute(period: number): Promise<EmaValue[] | null> {
    if (this.candles.length === 0) return null;
    const cached = this.cache.get(period);
    if (cached) return cached;

    // Compile once per series life — the script never changes, and Piner
    // binds `inputs` at RUN time (no per-period recompile).
    if (!this.compiled) {
      try {
        this.compiled = compile(EMA_PINE_SOURCE);
      } catch {
        return null; // engine failure → unavailable, never guessed
      }
    }

    // Piner feed bars: `{ time (epoch ms), open, high, low, close, volume }`.
    const bars = this.candles.map((c) => ({
      time: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    const engine = new Engine(this.compiled, new ArrayFeed(bars), {
      backend: "js",
      inputs: { Period: period },
    });
    try {
      await engine.run({
        symbol: "AURA:EMA-ALERT",
        timeframe: pineTimeframeStr(this.bucketSec),
      });
    } catch {
      return null; // runtime failure → unavailable, never guessed
    }

    // Locate the titled plot ("ema") and read its aligned value rows.
    let data: unknown = null;
    for (const [, p] of engine.outputs.plots) {
      const plot = p as { title?: unknown; data?: unknown };
      if (plot.title === "ema") {
        data = plot.data;
        break;
      }
    }
    if (!Array.isArray(data) || data.length !== this.candles.length) return null;

    const values: EmaValue[] = data.map((v) =>
      typeof v === "number" && Number.isFinite(v) ? v : null,
    );
    this.cache.set(period, values);
    return values;
  }
}
