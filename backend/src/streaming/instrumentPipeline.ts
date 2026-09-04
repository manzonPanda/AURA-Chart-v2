/**
 * Per-instrument realtime state + tick pipeline (PURE — deliberately imports
 * NO ws / lightstreamer so the unit-test runner can load this module without
 * the lightstreamer-client package keeping the event loop alive — the same
 * constraint that keeps other suites off RealtimeService).
 *
 * Phase 1 multi-instrument: EVERY instrument gets its own InstrumentUnit —
 * its own CandleAggregatorSet, forming-candle state, tick counter, last
 * price, per-timeframe bucket tracking, rollover detection and first-anchor
 * diagnostics. A tick is routed to EXACTLY ONE unit (the IgStreamClient
 * instance is bound to one EPIC: CHART:<epic>:TICK), so a Gold tick can
 * never enter DAX aggregation state or vice versa.
 *
 * The time source stays bucketing-consistent across instruments (the same
 * epoch 60 s grid), but the STATE is fully isolated per unit — independent
 * is NOT achieved by mixing; it is achieved by per-instance aggregation.
 */
import { CandleAggregatorSet } from "./aggregator.js";
import { TIMEFRAME_BUCKET_SEC, isPersistedTimeframe } from "./timeframes.js";
import type { ClosedCandle, IngTick, RealtimeCandle } from "./types.js";

/** All per-instrument state that must NEVER be shared across EPICs. */
export interface InstrumentUnit {
  /** Raw IG EPIC — also the ohlc_candles.instrument identity. */
  epic: string;
  /** Human label (UI/push) — from the Phase 0 instrument registry. */
  label: string;
  /** Quoting precision in decimals — DAX 1, Spot Gold 2. Never DAX-copied. */
  decimals: number;
  aggregators: CandleAggregatorSet;
  ticksReceived: number;
  lastPrice: number | null;
  /** Server-clock epoch ms of the last REAL IG tick (0 = none ever). */
  lastTickAt: number;
  /** Previous bucket start per timeframe — rollover detection source. */
  lastBucketSec: Map<string, number>;
  /** One-shot first-anchor diagnostic per timeframe. */
  loggedFirstAnchor: Set<string>;
}

export function createInstrumentUnit(epic: string, label: string, decimals: number): InstrumentUnit {
  return {
    epic,
    label,
    decimals,
    aggregators: new CandleAggregatorSet(
      Object.entries(TIMEFRAME_BUCKET_SEC).map(([timeframe, bucketSec]) => ({ timeframe, bucketSec })),
    ),
    ticksReceived: 0,
    lastPrice: null,
    lastTickAt: 0,
    lastBucketSec: new Map(),
    loggedFirstAnchor: new Set(),
  };
}

/** One timeframe's post-tick result (forming candle, closed candle, anchor diag). */
export interface BucketResult {
  timeframe: string;
  bucketSec: number;
  /** Forming candle right after this tick (undefined only before any tick). */
  forming: RealtimeCandle | undefined;
  /** The candle that JUST closed on this tick (rollover), if any. */
  closed: ClosedCandle | undefined;
  /** One-shot first-anchor diagnostic payload when the first bucket is seen. */
  firstAnchor: { firstTickMs: number; ticksInBucket: number; open: number } | null;
}

/**
 * Feed one tick into ONE instrument unit. Returns per-timeframe results so the
 * caller can log diagnostics, persist closed candles and fan out WS frames —
 * all WITHOUT touching any other instrument's state. The first tick of a
 * stream never closes anything (prevBucket===0 just anchors the bucket).
 */
export function processInstrumentTick(unit: InstrumentUnit, tick: IngTick): BucketResult[] {
  // Per-instrument bookkeeping — nothing here is shared across units.
  unit.ticksReceived += 1;
  unit.lastPrice = tick.price;
  unit.lastTickAt = Date.now();
  unit.aggregators.onTick(tick);

  const results: BucketResult[] = [];
  for (const [timeframe, bucketSec] of Object.entries(TIMEFRAME_BUCKET_SEC)) {
    const candle = unit.aggregators.getCandleFor(bucketSec);
    const forming = candle ? { ...candle } : undefined;
    let closed: ClosedCandle | undefined;
    let firstAnchor: BucketResult["firstAnchor"] = null;

    if (!unit.loggedFirstAnchor.has(timeframe)) {
      const stats = unit.aggregators.getCurrentStatsFor(bucketSec);
      if (stats && stats.firstTickMs > 0 && forming) {
        unit.loggedFirstAnchor.add(timeframe);
        firstAnchor = { firstTickMs: stats.firstTickMs, ticksInBucket: stats.tickCount, open: forming.open };
      }
    }

    const prevBucket = unit.lastBucketSec.get(timeframe) ?? 0;
    if (prevBucket === 0 && forming) unit.lastBucketSec.set(timeframe, forming.time);
    if (forming && forming.time > (unit.lastBucketSec.get(timeframe) ?? 0)) {
      // A bucket just CLOSED — the aggregator holds it as its last-closed record.
      closed = unit.aggregators.getClosedCandleFor(bucketSec);
      unit.lastBucketSec.set(timeframe, forming.time);
    } else if (forming && forming.time < (unit.lastBucketSec.get(timeframe) ?? 0)) {
      unit.lastBucketSec.set(timeframe, forming.time); // stream reset / stale tick safety
    }

    results.push({ timeframe, bucketSec, forming, closed, firstAnchor });
  }
  return results;
}

/** Structural WS-client shape (matches RealtimeService.WsClient). */
export interface CandleClientLike {
  alive: boolean;
  epic: string;
  bucketSec: number;
}

/** Routing rule: a WS client receives a candle frame ONLY for its own EPIC. */
export function clientWantsCandle(client: CandleClientLike, unitEpic: string, bucketSec: number): boolean {
  return client.alive && client.epic === unitEpic && client.bucketSec === bucketSec;
}

/**
 * Persistence identity for a closed candle — the instrument's EPIC when the
 * timeframe is the canonical persisted frame (MINUTE_1), null otherwise
 * (MINUTE_3 is a live in-memory overlay, never written — unchanged).
 */
export function persistenceInstrumentFor(timeframe: string, unit: InstrumentUnit): string | null {
  return isPersistedTimeframe(timeframe) ? unit.epic : null;
}