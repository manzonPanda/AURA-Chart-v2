/**
 * AURA Candle Replay — pure core (framework-free, unit-testable).
 *
 * Replay is a FRONTEND-ONLY chart simulation. It never touches Supabase, the
 * backend `/api/candles/db` history, or the loaded candle dataset. The replay
 * engine is CandleKit's own `ReplayController` (created via
 * `createReplayController`); this module only adapts the ALREADY-LOADED
 * historical dataset into CandleKit's `ReplayDataSource` contract so the
 * engine can play it back WITHOUT any additional network/API requests.
 *
 * ── Data roles ─────────────────────────────────────────────────────────────
 *   SOURCE    `readonly Bar[]` passed into `buildReplayManifest` — the same
 *             bucket-aligned array the ChartView renders. Never mutated.
 *   VISIBLE   `ReplayController.getBarsUpToCursor(symbol, interval)` — the
 *             bars ≤ the replay cursor (the "as-if real-time" window).
 *   CURSOR    `ReplayState.cursor.ts` — the replay playback position; the
 *             single source of truth for the engine's deterministic clock.
 *
 * ── Why an in-memory day source ─────────────────────────────────────────────
 * CandleKit's replay engine caches per calendar day and walks neighbouring
 * days, but AURA loads a contiguous range from the DB. We partition the
 * loaded array by UTC date so `fetchDay`/`listDates{Before,After}` resolve
 * from memory. `prefetchBackwardDays` is sized to the dataset so the whole
 * set is "prefetched" at load, and `cacheDays` is sized so nothing is ever
 * LRU-evicted — the engine sees the complete dataset, zero I/O.
 */

import {
  dateOf,
  type Bar,
  type IntervalCode,
  type ReplayDataSource,
  type ReplayEngineOptions,
  type ReplayManifest,
  type ReplaySeriesSpec,
  type SymbolId,
} from "@getcandlekit/charts";

/** Opaque engine cache-key the replay chart uses for the single series. */
export const REPLAY_SYMBOL: SymbolId = "aura";

/**
 * Distinct UTC calendar dates (`YYYY-MM-DD`) covered by the dataset, ascending.
 * `dateOf` is CandleKit's own helper, so the partition matches the engine's
 * cache-key convention exactly.
 */
export function partitionDates(bars: readonly Bar[]): string[] {
  const set = new Set<string>();
  for (const b of bars) {
    if (!b || !Number.isFinite(b.ts)) continue;
    set.add(dateOf(b.ts));
  }
  return [...set].sort();
}

/** Bars belonging to one calendar date, ascending (a copy — never aliases the input). */
export function barsOnDate(bars: readonly Bar[], date: string): Bar[] {
  return bars
    .filter((b) => b && Number.isFinite(b.ts) && dateOf(b.ts) === date)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Adapter that satisfies CandleKit's `ReplayDataSource` entirely from the
 * already-loaded historical array. Every method resolves from memory — no
 * fetch, no Supabase, nothing remote.
 */
export interface MemoryReplaySource {
  source: ReplayDataSource;
  /** Distinct calendar dates, ascending (see {@link partitionDates}). */
  dates: string[];
}

export function createMemoryReplaySource(bars: readonly Bar[]): MemoryReplaySource {
  const dates = partitionDates(bars);
  const source: ReplayDataSource = {
    async fetchDay(_symbol: SymbolId, _interval: IntervalCode, date: string): Promise<Bar[]> {
      return barsOnDate(bars, date);
    },
    async listDatesBefore(
      _symbol: SymbolId,
      _interval: IntervalCode,
      date: string,
      n: number,
    ): Promise<string[]> {
      const idx = dates.indexOf(date);
      if (idx <= 0 || n <= 0) return [];
      return dates
        .slice(0, idx)
        .reverse()
        .slice(0, n);
    },
    async listDatesAfter(
      _symbol: SymbolId,
      _interval: IntervalCode,
      date: string,
      n: number,
    ): Promise<string[]> {
      const idx = dates.indexOf(date);
      if (idx < 0 || idx >= dates.length - 1 || n <= 0) return [];
      return dates.slice(idx + 1).slice(0, n);
    },
  };
  return { source, dates };
}

/**
 * Replay-engine options sized so the entire loaded dataset is kept in cache:
 *  - `prefetchBackwardDays = dates.length` → the engine walks back from the
 *    start date at `load()` and caches every prior day (all in-memory).
 *  - `cacheDays = dates.length + 8` → the LRU can never evict a cached day.
 *  - `prefetchForwardOnTailPct = 0` → the engine eagerly caches the NEXT day
 *    on every advance so playback never stalls at a day boundary.
 */
export function replayEngineOptions(dates: readonly string[]): ReplayEngineOptions {
  return {
    cacheDays: Math.max(2, dates.length + 8),
    prefetchBackwardDays: dates.length,
    prefetchForwardOnTailPct: 0,
  };
}

export interface BuildReplayManifestInput {
  id: string;
  series?: ReplaySeriesSpec;
  symbol: SymbolId;
  interval: IntervalCode;
  bars: readonly Bar[];
  /** The replay start — the bar at this ts is the LAST visible bar on entry. */
  startTs: number;
}

/**
 * Build a `ReplayManifest` over the loaded dataset. `startTs` becomes the
 * engine's initial cursor (and therefore the last bar that is visible when
 * Replay Mode begins). The full dataset stays available in the source — the
 * engine never deletes it — so exit restores the chart from memory.
 */
export function buildReplayManifest(input: BuildReplayManifestInput): {
  manifest: ReplayManifest;
  dates: string[];
} {
  const { source, dates } = createMemoryReplaySource(input.bars);
  const last = input.bars.length > 0 ? input.bars[input.bars.length - 1] : null;
  const endTs = last && last.ts >= input.startTs ? last.ts : input.startTs;
  const series: ReplaySeriesSpec = input.series ?? { symbol: input.symbol, interval: input.interval };
  return {
    manifest: {
      id: input.id,
      series: [series],
      start: input.startTs,
      end: endTs,
      source,
    },
    dates,
  };
}

/**
 * Index of the bar at-or-before `cursorTs` (binary search). Returns -1 when
 * the cursor precedes the dataset. Used to map the engine's cursor bar back
 * to the source `Candle` for the OHLC readout without walking the array.
 */
export function findReplayIndex(bars: readonly Bar[], cursorTs: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].ts <= cursorTs) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}