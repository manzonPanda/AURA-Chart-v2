/**
 * Per-instrument realtime state + tick pipeline (PURE — deliberately imports
 * NO ws / streaming so the unit-test runner can load this module without
 * the streaming websocket layer keeping the event loop alive — the same
 * constraint that keeps other suites off RealtimeService).
 *
 * Phase 1 multi-instrument: EVERY instrument gets its own InstrumentUnit —
 * its own CandleAggregatorSet, forming-candle state, tick counter, last
 * price, per-timeframe bucket tracking, rollover detection and first-anchor
 * diagnostics. A tick is routed to EXACTLY ONE unit (the CapitalStreamClient
 * instance is bound to one symbol: "GOLD"), so a Gold tick can
 * never enter another instrument's aggregation state or vice versa.
 *
 * The time source stays bucketing-consistent across instruments (the same
 * epoch 60 s grid), but the STATE is fully isolated per unit — independent
 * is NOT achieved by mixing; it is achieved by per-instance aggregation.
 */
import { CandleAggregatorSet } from "./aggregator.js";
import { TIMEFRAME_BUCKET_SEC, bucketOf, isPersistedTimeframe } from "./timeframes.js";
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
  /**
   * Bucket start (epoch SECONDS) of the LATEST authoritatively CLOSED candle
   * per timeframe — the quote-immutability ledger.
   *
   * Once an authoritative candle closes, that bucket is FINAL: a late quote
   * whose bucket is at-or-before it must never mutate it again (Capital's
   * marketData quotes and its OHLC frames are independent deliveries, so a
   * quote can legitimately arrive AFTER the OHLC candle it belongs to).
   * ADDITIONAL to — never a replacement for — the `bucket < authoritativeTime`
   * gate from 6dd0927: that gate rejects buckets older than the authoritative
   * FORMING candle (it fixed the 3M freeze); this ledger rejects buckets that
   * are already closed. 0 = nothing closed yet.
   */
  lastClosedSec: Map<string, number>;
  /** One-shot first-anchor diagnostic per timeframe. */
  loggedFirstAnchor: Set<string>;
  /**
   * Quote-driven LIVE-DISPLAY forming candle per timeframe — the smooth
   * intrabar overlay built from Capital marketData quote mids. STRICTLY
   * display state: NEVER persisted, never read by persistClosedCandle, and
   * re-synced to the authoritative aggregator candle on every OHLC tick
   * (syncDisplayFromAggregator — authoritative OHLC truth always wins).
   */
  liveDisplay: Map<string, RealtimeCandle>;
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
    lastClosedSec: new Map(),
    loggedFirstAnchor: new Set(),
    liveDisplay: new Map(),
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
      // IMMUTABILITY LEDGER: this bucket is now final — quotes at-or-before it
      // are dropped for chart display from here on (see processInstrumentQuote).
      if (closed) unit.lastClosedSec.set(timeframe, closed.time);
      unit.lastBucketSec.set(timeframe, forming.time);
    } else if (forming && forming.time < (unit.lastBucketSec.get(timeframe) ?? 0)) {
      unit.lastBucketSec.set(timeframe, forming.time); // stream reset / stale tick safety
    }

    results.push({ timeframe, bucketSec, forming, closed, firstAnchor });
  }
  return results;
}

/** One timeframe's post-QUOTE result (live display candle, undefined = no change). */
export interface QuoteResult {
  timeframe: string;
  bucketSec: number;
  /**
   * The quote-updated LIVE DISPLAY candle for this timeframe. Undefined when
   * the quote produced no display change (stale bucket, duplicate mid, no new
   * extreme) — no WS frame is relayed for it.
   */
  display: RealtimeCandle | undefined;
}

/**
 * Feed one QUOTE-derived mid (Capital marketData stream) into ONE instrument
 * unit's LIVE DISPLAY overlay. This is the smooth intrabar path:
 *
 *   quote mid → same-bucket merge (open immutable, high=max, low=min,
 *               close=latest genuine mid) → WS relay → series.update()
 *
 * ISOLATION CONTRACTS (deliberate, tested):
 *   - NEVER touches `unit.aggregators` — the authoritative OHLC state and the
 *     ONLY persistence source stays exclusively OHLC-frame-driven;
 *   - never creates a bucket older than the authoritative forming candle
 *     (quotes can neither backdate, duplicate, nor pre-open a candle); a
 *     same-bucket quote merges into the existing display overlay instead;
 *   - never creates a bucket newer than the quote's own (sanitized) timestamp
 *     allows — future timestamps are clamped upstream (capitalStream);
 *   - a quote whose mid and extremes change nothing relays nothing
 *     (duplicate/unchanged quotes never produce a redundant frame).
 */
export function processInstrumentQuote(unit: InstrumentUnit, quote: IngTick): QuoteResult[] {
  const results: QuoteResult[] = [];
  for (const [timeframe, bucketSec] of Object.entries(TIMEFRAME_BUCKET_SEC)) {
    const bucket = bucketOf(quote.tsMs, bucketSec);
    // IMMUTABILITY GATE (additional protection — the 6dd0927 `bucket <
    // authoritativeTime` gate below stays intact): a bucket that has already
    // received its AUTHORITATIVE CLOSED candle is immutable. A late quote for
    // it is dropped for chart display, because the persisted Capital OHLC is
    // the only truth for a closed candle. The NEXT forming bucket is always
    // `lastClosedSec + bucketSec` → strictly greater, so it still receives
    // quotes (the 3M smooth-display path is preserved).
    const lastClosedSec = unit.lastClosedSec.get(timeframe) ?? 0;
    if (bucket <= lastClosedSec) {
      results.push({ timeframe, bucketSec, display: undefined });
      continue;
    }
    const authoritativeTime = unit.aggregators.getCandleFor(bucketSec)?.time ?? 0;
    if (bucket < authoritativeTime) {
      // STRICT stale bucket only — older than the authoritative forming candle.
      // A quote whose bucket EQUALS the authoritative forming candle (the normal
      // case for MINUTE_3: the 1M OHLC pair opens the 3M forming candle ~2 min
      // before the bucket ends, so nearly every quote maps to the same 3M
      // bucket) must still extend the live display — open stays the OHLC
      // truth's open (syncDisplayFromAggregator re-asserts it after every
      // authoritative tick), high/low/close merge per the live-OHLC contract.
      // Quotes for an OLDER bucket cannot backdate or re-open a rolled bucket.
      results.push({ timeframe, bucketSec, display: undefined });
      continue;
    }
    const prev = unit.liveDisplay.get(timeframe);
    if (prev && prev.time > bucket) {
      // Display already on a NEWER bucket — this quote is out of order.
      results.push({ timeframe, bucketSec, display: undefined });
      continue;
    }
    if (prev && prev.time === bucket) {
      const high = Math.max(prev.high, quote.price);
      const low = Math.min(prev.low, quote.price);
      if (prev.close === quote.price && prev.high === high && prev.low === low) {
        results.push({ timeframe, bucketSec, display: undefined });
        continue;
      }
      unit.liveDisplay.set(timeframe, {
        time: prev.time,
        open: prev.open, // immutable — the bucket's first genuine quote mid
        high,
        low,
        close: quote.price,
      });
    } else {
      // First quote of a NEW bucket: the live display leads the authoritative
      // candle (whose pair arrives at the bucket's END) until truth replaces it.
      unit.liveDisplay.set(timeframe, {
        time: bucket,
        open: quote.price,
        high: quote.price,
        low: quote.price,
        close: quote.price,
      });
    }
    results.push({ timeframe, bucketSec, display: { ...(unit.liveDisplay.get(timeframe) as RealtimeCandle) } });
  }
  return results;
}

/**
 * OHLC-TRUTH SYNC — run after EVERY authoritative OHLC tick. Wherever the
 * authoritative aggregator holds a forming candle for a timeframe, the quote
 * display overlay for that bucket is REPLACED by it (authoritative OHLC always
 * wins over any temporary quote-derived display state — including its open).
 * An overlay on a NEWER bucket (quotes already forming the next minute while
 * Capital's OHLC delivery lags one bucket) is deliberately left alone.
 */
export function syncDisplayFromAggregator(unit: InstrumentUnit): void {
  for (const [timeframe, bucketSec] of Object.entries(TIMEFRAME_BUCKET_SEC)) {
    const authoritative = unit.aggregators.getCandleFor(bucketSec);
    if (!authoritative) continue;
    const display = unit.liveDisplay.get(timeframe);
    if (!display || display.time <= authoritative.time) {
      unit.liveDisplay.set(timeframe, { ...authoritative });
    }
  }
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