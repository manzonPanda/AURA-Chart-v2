/**
 * @file PineTS indicator engine — a generic, framework-free adapter between
 * AURA's candle model and LuxAlgo's PineTS Pine Script® runtime.
 *
 * ── LICENSE ──────────────────────────────────────────────────────────────
 * PineTS (`pinets`) is dual-licensed: **AGPL-3.0-only** (free for personal /
 * research / internal use) and a paid **Commercial License** from LuxAlgo.
 * See `THIRD-PARTY-NOTICES.md`. AURA's intended use is personal/internal; the
 * AGPL copyleft only triggers if AURA is DISTRIBUTED to others or offered as a
 * network service (SaaS) — in that case AURA's full source must be released
 * under AGPL-3.0 OR a LuxAlgo commercial license must be purchased. This
 * integration is written as a normal client-side dependency — it neither
 * bypasses, obfuscates, nor works around any AGPL requirement.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Data flow (authoritative server truth ONLY — never the rAF "glide" close):
 *
 *   Supabase 1m/3m candles ─┐
 *   RealtimeCandleMsg (WS) ├→ effectiveCloseSeries() ─→ authoritative closes
 *                          ↓
 *                   PineIndicatorEngine.setCandles(bars, live, bucketSec)
 *                          ↓
 *               new PineTS(klines)  +  cached compiled Indicator  (ta.ema)
 *                          ↓
 *                    PinePoint[] { ts(ms), value }  ──→  EmaBridge → LWC LineSeries
 *
 * For 3m the caller passes the SELECTED timeframe's `bars`, so the 3m EMA is
 * calculated from 3m candles directly — never from the 1m EMA.
 *
 * Why this is cheap enough for a live chart:
 *  - the PineScript `Indicator` is compiled (transpiled) ONCE per distinct
 *    parameter set (EMA 9 and EMA 20 = two compiled instances, cached for the
 *    engine's life). PineTS bakes `input.*` values into the transpiled
 *    artifact at prepare() time, so a period switch maps to the other cached
 *    compiled instance — a per-frame run NEVER re-transpiles;
 *  - a PineTS runtime instance is rebuilt only when the authoritative candle
 *    series changes (signature guard); identical/rAF frames short-circuit;
 *  - results are memoized by (indicator, params, data-signature).
 *
 * Measured: ~9–12 ms a full recompute over 500 bars (two EMAs ~20 ms), against
 * AURA's pure `ema.ts` oracle at < 5e-9 — see tests/pineEquivalence.test.mjs.
 */
import { PineTS, Indicator } from "pinets";

// NOTE: local imports use explicit `.ts` extensions. The rest of `src/` is
// extensionless (resolved by Vite/tsc), but this module is imported through by
// AURA's Node-native `--experimental-strip-types` test runner, whose ESM
// resolver does NOT synthesize `.ts` for extensionless specifiers. Explicit
// extensions are accepted by both `tsc -b` (allowImportingTsExtensions) and the
// Vite build, so the production bundle and the tests stay green.
import {
  effectiveCloseSeries,
  type EmaSourceBar,
} from "./ema.ts";
import {
  PINE_INDICATORS,
  type PineIndicatorSpec,
  type PineInputBinding,
} from "./pineIndicators.ts";

export type { PineIndicatorSpec, PineInputBinding };

/** Minimal candle shape the engine consumes (a structural subtype of CandleKit `Bar`). */
export interface PineBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Authoritative forming candle arriving from the backend (epoch-second `time`). */
export interface PineLiveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** One engine-produced point — structurally identical to `EmaPoint` in ema.ts. */
export interface PinePoint {
  ts: number;
  value: number;
}

/** A PineScript-compatible candle — the Kline shape PineTS expects for an array source. */
interface PineCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/** Tolerance that absorbs PineTS's 10-decimal `context.precision` rounding. */
export const PINE_EQUIVALENCE_TOL = 5e-9;

type PineParams = Record<string, unknown>;

interface CompiledIndicator {
  spec: PineIndicatorSpec;
  indicator: Indicator;
}

/** A Pine `input.*()` binding resolved to its runtime `varId`. */
interface ResolvedInput {
  varId: string;
  title: string;
  paramKey: string;
}

/**
 * Build the authoritative, full-OHLCV candle series for PineTS from the
 * chart's closed bars + the forming WS candle, REUSING `effectiveCloseSeries`
 * so the close stream feeding `ta.ema` is byte-for-byte identical to ema.ts.
 *
 * Only the **close** drives an EMA; open/high/low/volume are carried so the
 * engine is generic enough for future OHLC-dependent indicators (atr, etc.)
 * without re-architecting the data path.
 */
function buildAuthoritativeSeries(
  bars: readonly PineBar[],
  live: PineLiveCandle | null,
  bucketSec: number,
): PineCandle[] {
  const bucketMs = bucketSec * 1000;
  const closes = effectiveCloseSeries(
    bars as readonly EmaSourceBar[],
    live ? { time: live.time, close: live.close } : null,
    bucketSec,
  );
  const byTs = new Map<number, PineBar>();
  for (const b of bars) byTs.set(b.ts, b);
  const liveBucketTs = live ? Math.floor((live.time * 1000) / bucketMs) * bucketMs : null;

  const out: PineCandle[] = [];
  for (const m of closes) {
    const bar = byTs.get(m.ts);
    if (live && liveBucketTs === m.ts) {
      out.push({ openTime: m.ts, open: live.open, high: live.high, low: live.low, close: m.close, volume: live.volume ?? 0, closeTime: m.ts + bucketMs });
    } else if (bar) {
      out.push({ openTime: bar.ts, open: bar.open, high: bar.high, low: bar.low, close: m.close, volume: bar.volume ?? 0, closeTime: bar.ts + bucketMs });
    } else {
      out.push({ openTime: m.ts, open: m.close, high: m.close, low: m.close, close: m.close, volume: 0, closeTime: m.ts + bucketMs });
    }
  }
  return out;
}

/**
 * Compact, exact fingerprint of the authoritative close stream. A cache hit
 * whenever the series is unchanged — so the engine never re-runs PineTS for a
 * stale/rAF frame that didn't move the authoritative close.
 *
 * FNV-1a over the precise `"ts,close"` text of every candle (no float
 * truncation) plus length and end-points, so a collision is practically
 * impossible.
 */
function dataSignature(series: readonly PineCandle[]): string {
  let h = 2166111748;
  for (let i = 0; i < series.length; i++) {
    const c = series[i];
    const s = `${c.openTime},${c.close}`;
    for (let j = 0; j < s.length; j++) {
      h = Math.imul(h ^ s.charCodeAt(j), 16777619);
    }
  }
  const first = series[0];
  const last = series[series.length - 1];
  return (
    `${series.length}|` +
    `f=${first?.openTime ?? 0}:${first?.close ?? 0}|` +
    `l=${last?.openTime ?? 0}:${last?.close ?? 0}|` +
    `h=${(h >>> 0).toString(36)}`
  );
}

function paramsSignature(params: PineParams): string {
  return JSON.stringify(params ?? {});
}

function resolveInputMeta(indicator: Indicator, bindings: PineInputBinding[]): ResolvedInput[] {
  const meta = (indicator.getInputsMeta() as Array<{ varId?: string; title?: string }>) ?? [];
  return bindings.map((b) => {
    const m = meta.find((x) => x.title === b.title);
    return { varId: m?.varId ?? b.title, title: b.title, paramKey: b.paramKey };
  });
}

/**
 * Read back one plot series from a PineTS context, stripping warmup `na()`
 * rows (PineTS emits `null`/`NaN` for history bars before the first seed).
 * Returns points aligned to candle `openTime` (epoch ms).
 */
function extractPoints(ctx: { plots?: Record<string, { data?: any[] }> } | undefined, plotKey: string): PinePoint[] {
  const data = ctx?.plots?.[plotKey]?.data;
  if (!Array.isArray(data)) return [];
  const out: PinePoint[] = [];
  for (const d of data) {
    const v = d?.value;
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push({ ts: d.time, value: v });
    }
  }
  return out;
}

/**
 * Generic adapter over the PineTS runtime.
 *
 * Lifetime: one engine per indicator context, held for the chart's life
 * (see EmaBridge). Per-(indicator, params) `Indicator` objects (compiled Pine
 * Script) are cached and REUSED across runs — a period switch maps to the
 * other cached compiled instance, it does NOT re-transpile. A `PineTS` runtime
 * instance is rebuilt only when
 * the authoritative candle series genuinely changes; results are memoized by
 * (indicator, params, data-signature), so identical inputs never re-run.
 */
export class PineIndicatorEngine {
  private pine: PineTS | null = null;
  private klines: PineCandle[] = [];
  private dataSig: string | null = null;
  private readonly compiled = new Map<string, CompiledIndicator>();
  private readonly resultCache = new Map<string, PinePoint[]>();
  private warned = false;

  /**
   * Feed the engine its current authoritative candle series. `bars`,
   * `liveCandle` and `bucketSec` come straight from the chart truth path; the
   * rAF glide is never involved. No-op when the series is unchanged.
   */
  setCandles(
    bars: readonly PineBar[],
    liveCandle: PineLiveCandle | null,
    bucketSec: number,
  ): void {
    const klines = buildAuthoritativeSeries(bars, liveCandle, bucketSec);
    const sig = dataSignature(klines);
    if (sig === this.dataSig && this.pine !== null) {
      // Authoritative close stream unchanged — keep the existing PineTS instance
      // and all cached results (guards against rAF/stale/redundant re-renders).
      this.klines = klines;
      return;
    }
    this.klines = klines;
    this.dataSig = sig;
    // New runtime over the new series. Compiled `Indicator`s are reused across
    // instances — only the runtime data view changes here.
    this.pine = new PineTS(this.klines as unknown as PineCandle[], undefined, undefined);
    this.resultCache.clear();
  }

  /**
   * Compute one indicator/parameters combination.
   *
   * Returns `{ts, value}` points with warmup rows stripped. Returns `null` for
   * insufficient history or engine failure so the caller can fall back to the
   * ema.ts oracle.
   */
  async compute(indicatorId: string, params: PineParams = {}): Promise<PinePoint[] | null> {
    const spec = PINE_INDICATORS[indicatorId];
    if (!spec) {
      this.warn(`unknown indicator "${indicatorId}"`);
      return null;
    }
    // No data yet — insufficient history (mirrors ema.ts returning []).
    if (this.pine === null || this.klines.length === 0 || this.dataSig === null) {
      return null;
    }

    const cacheKey = `${indicatorId}|${this.dataSig}|${paramsSignature(params)}`;
    const cached = this.resultCache.get(cacheKey);
    if (cached) return cached;

    const compiled = this.getCompiled(spec, params);

    let ctx: { plots?: Record<string, { data?: unknown[] }> } | undefined;
    try {
      ctx = (await this.pine.run(compiled.indicator, this.klines.length)) as any;
    } catch (e: any) {
      this.warn(`PineTS run failed for "${indicatorId}": ${e?.message ?? e}`);
      return null;
    }

    const pts = extractPoints(ctx, spec.plotKey);
    this.resultCache.set(cacheKey, pts);
    return pts;
  }

  /**
   * Lazily compile + cache a PineScript `Indicator` per (indicator, params)
   * combination. PineTS bakes `input.*` overrides into the transpiled
   * artifact at `prepare()` time, so parameters are bound BEFORE the first
   * transpile — after which the artifact is immutable. Each distinct
   * parameter set therefore transpiles exactly once per engine and is reused
   * forever (a period switch flips to the other cached instance; per-frame
   * runs never re-transpile).
   */
  private getCompiled(spec: PineIndicatorSpec, params: PineParams): CompiledIndicator {
    // Keyed by the full params signature: a param the script does not bind
    // (e.g. a future color param handled by the renderer) would produce a
    // second, identical compiled instance — wasteful but always CORRECT.
    const key = `${spec.id}|${paramsSignature(params)}`;
    let c = this.compiled.get(key);
    if (!c) {
      const indicator = new Indicator(spec.source);
      for (const m of resolveInputMeta(indicator, spec.bindings)) {
        const value = params[m.paramKey];
        if (value === undefined) continue;
        try {
          // `.input` is a frozen proxy keyed by varId; individual key writes
          // register the override PineTS bakes in at prepare() time.
          (indicator.input as Record<string, unknown>)[m.varId] = value;
        } catch {
          /* unknown/frozen input — PineScript defval is used */
        }
      }
      indicator.prepare(); // idempotent transpile — bakes the bound inputs
      c = { spec, indicator };
      this.compiled.set(key, c);
    }
    return c;
  }

  private warn(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[PineIndicatorEngine] ${msg}`);
  }

  /** Release runtime + cached artifacts. Safe to call on chart teardown. */
  dispose(): void {
    this.compiled.clear();
    this.resultCache.clear();
    this.pine = null;
    this.klines = [];
    this.dataSig = null;
  }
}


