/**
 * Price-source selection for AURA's built-in overlays (EMA / SMA).
 *
 * Pine's `input.source` concept, reduced to the OHLC-derived series the chart
 * actually has: open / high / low / close / hl2 / hlc3 / ohlc4. The selected
 * source produces the same `{ ts, close }` shape the pure EMA/SMA math
 * (services/ema.ts, services/sma.ts) already consumes, so the indicator
 * engines stay untouched — only the series fed INTO them changes.
 *
 * `effectiveSourceSeries` mirrors `effectiveCloseSeries` (services/ema.ts)
 * exactly — same authoritative-live-candle merge semantics (same bucket →
 * replace, newer → append, older → ignore) — but picks the configured price
 * field instead of hardcoding close.
 */

/** Minimal OHLC bar the source picker reads (structural subset of CandleKit `Bar`). */
export interface PriceSourceBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Authoritative forming candle (epoch-second `time`). */
export interface PriceSourceLive {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Supported price sources — Pine `input.source`'s common OHLC subset. */
export type PriceSource = "open" | "high" | "low" | "close" | "hl2" | "hlc3" | "ohlc4";

/** Canonical order for UI selects. */
export const PRICE_SOURCES: readonly PriceSource[] = [
  "close",
  "open",
  "high",
  "low",
  "hl2",
  "hlc3",
  "ohlc4",
];

/** Default — every existing configuration predates the field. */
export const DEFAULT_PRICE_SOURCE: PriceSource = "close";

/** Human label per source (settings UI). */
export const PRICE_SOURCE_LABEL: Record<PriceSource, string> = {
  close: "Close",
  open: "Open",
  high: "High",
  low: "Low",
  hl2: "HL2 (mid)",
  hlc3: "HLC3 (typical)",
  ohlc4: "OHLC4 (average)",
};

/** Guard for persisted values — unknown shapes fall back to "close". */
export function isPriceSource(v: unknown): v is PriceSource {
  return typeof v === "string" && (PRICE_SOURCES as readonly string[]).includes(v);
}

/** Resolve one bar's source price (expects well-formed OHLC fields). */
export function sourceValue(
  bar: Pick<PriceSourceBar, "open" | "high" | "low" | "close">,
  source: PriceSource,
): number {
  switch (source) {
    case "open":
      return bar.open;
    case "high":
      return bar.high;
    case "low":
      return bar.low;
    case "hl2":
      return (bar.high + bar.low) / 2;
    case "hlc3":
      return (bar.high + bar.low + bar.close) / 3;
    case "ohlc4":
      return (bar.open + bar.high + bar.low + bar.close) / 4;
    default:
      return bar.close;
  }
}

/**
 * Authoritative `{ ts, close }` series for `source` — the candle field the
 * indicator math should average, with the forming candle's SERVER truth
 * merged in exactly like `effectiveCloseSeries`. Bars with non-finite ts or
 * non-finite selected value are skipped defensively; `source` falls back to
 * "close" when invalid (corrupted storage can never break the chart).
 */
export function effectiveSourceSeries(
  bars: readonly PriceSourceBar[],
  live: PriceSourceLive | null,
  bucketSec: number,
  source: unknown,
): { ts: number; close: number }[] {
  const src: PriceSource = isPriceSource(source) ? source : DEFAULT_PRICE_SOURCE;
  const out: { ts: number; close: number }[] = [];
  for (const b of bars) {
    if (!b || !Number.isFinite(b.ts)) continue;
    const v = sourceValue(b, src);
    if (!Number.isFinite(v)) continue;
    out.push({ ts: b.ts, close: v });
  }
  if (!live || !Number.isFinite(live.time) || !(bucketSec > 0)) {
    return out;
  }
  const liveVal = sourceValue(live, src);
  if (!Number.isFinite(liveVal)) return out;
  // Floor the server bucket-start (epoch s) to the timeframe grid (epoch ms).
  const bucketMs = bucketSec * 1000;
  const bucketTs = Math.floor((live.time * 1000) / bucketMs) * bucketMs;
  const last = out.length > 0 ? out[out.length - 1] : null;
  if (!last || bucketTs > last.ts) {
    out.push({ ts: bucketTs, close: liveVal });
  } else if (bucketTs === last.ts) {
    out[out.length - 1] = { ts: bucketTs, close: liveVal };
  }
  // bucketTs < last.ts → stale frame, ignored.
  return out;
}
