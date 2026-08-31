/**
 * Pine Script indicator definitions for the PineTS engine.
 *
 * GENERIC DESIGN (NOT EMA-specific): every indicator is just a registry entry
 * here — Pine Script v6 source + the metadata the engine needs to (a) bind
 * config onto `input.*()` calls and (b) read back which `plot()` series to
 * extract. Adding a future indicator is a one-entry change:
 *
 *   ta.sma  →  plot(ta.sma(close, len), "sma", …)
 *   ta.rsi  →  plot(ta.rsi(close, len), "rsi", …)
 *   ta.macd →  plot(macd-line, "macd"); plot(signal, "signal"); plot(hist, "hist")
 *   ta.atr  →  plot(ta.atr(len), "atr", …)
 *   ta.crossover/crossunder →  plotshape(style=…, …)  /  two plots + cross()
 *   plot / plotshape / hline  →  just plot them; the engine reads `plotKey`
 *
 * Only `ema` is wired in this phase; the engine itself knows nothing about EMA.
 *
 * PineScript source convention used by AURA indicators:
 *   //@version=6
 *   indicator("<AURA name>", overlay = true)
 *   length = input.int(<default>, "<Title>", minval = 1)   // configurable param
 *   plot(<expr>, "<plotKey>", ...)                           // engine reads plotKey
 * Every configurable parameter is an `input.*()` call so the engine can bind
 * it onto a compiled `Indicator` (see `PineIndicatorEngine`) exactly once per
 * parameter set — PineTS bakes inputs at transpile time, and each compiled
 * instance is then cached and reused for every subsequent run.
 */

/** Maps a Pine `input.*()` title to a key on the caller's params object. */
export interface PineInputBinding {
  /** Title as declared in the Pine `input.*()` call (the stable identifier). */
  title: string;
  /** Key on the params object whose value feeds this input. */
  paramKey: string;
}

export interface PineIndicatorSpec {
  /** Stable key the engine/UI address indicators by. */
  id: string;
  /** Human-readable label. */
  label: string;
  /**
   * Pine Script v6 source. MUST declare `indicator(...)` and a `plot(..., "<plotKey>")`
   * whose title equals `plotKey` below.
   */
  source: string;
  /** The `plot()` title whose series the engine extracts from `ctx.plots`. */
  plotKey: string;
  /** input.* bindings; engine sets `indicator.input[varId] = params[paramKey]`. */
  bindings: PineInputBinding[];
}

/**
 * EMA — the only Phase 1 indicator. The period is an `input.int("Period")` so
 * each configured period (9, 20, any custom value) compiles exactly once into
 * its own cached PineTS `Indicator`; Pine Script (`ta.ema`) is the source of
 * truth here — `services/ema.ts` is kept ONLY as the regression-test oracle.
 */
export const EMA_PINE_SOURCE = `//@version=6
indicator("AURA EMA", overlay = true)
length = input.int(9, "Period", minval = 1)
basis = ta.ema(close, length)
plot(basis, "ema", color = color.orange, linewidth = 2)`;

/**
 * Registry of engine-managed indicators.
 * To add another indicator, push a new entry below that points at its own Pine
 * source + plot title + input bindings — no engine change required.
 */
export const PINE_INDICATORS: Record<string, PineIndicatorSpec> = {
  ema: {
    id: "ema",
    label: "EMA",
    source: EMA_PINE_SOURCE,
    plotKey: "ema",
    bindings: [{ title: "Period", paramKey: "period" }],
  },
};
