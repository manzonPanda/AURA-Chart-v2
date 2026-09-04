/**
 * EMA 9/20 reversal state machine (PURE, I/O-free).
 *
 * Consumes CLOSED candles ONLY — one call per candle, strictly advancing
 * bucket times. The forming/live candle can never reach this module: the
 * engine is fed exclusively from the aggregator's rollover path, and this
 * detector additionally ignores any bucket that does not strictly advance
 * (equal or older `bucketSec`), so a replayed or intrabar update can neither
 * create nor advance state (defense in depth — see tests).
 *
 * Signal definition (bullish; bearish is the exact inverse):
 *   1. the previous CLOSED candle had EMA 9 <= EMA 20
 *   2. a CLOSED candle establishes EMA 9 > EMA 20  → pending reversal,
 *      confirmation 1 of N on that same closed (cross) candle
 *   3. each further CLOSED candle that KEEPS EMA 9 > EMA 20 increments the
 *      confirmation counter; at N the reversal is CONFIRMED
 *   4. if the relationship flips (or goes flat) before N, the pending
 *      reversal is CANCELLED
 *
 * Session rule: an out-of-session closed candle cancels any pending reversal,
 * still advances the tracked relationship (so overnight crossovers can never
 * fire stale alerts at the open), and never emits. EMA calculation itself
 * continues outside the session — only alerts are gated.
 *
 * Duplicate protection: while the relationship continuously holds, no new
 * lifecycle can start — the next alert requires a genuine new transition.
 * Strict comparisons: EMA 9 == EMA 20 is "flat", not a bullish/bearish state.
 */

/** Relationship of EMA 9 to EMA 20 on one CLOSED candle. */
export type EmaRelation = "bull" | "bear" | "flat";

export type ReversalDirection = "bullish" | "bearish";

/** Strict relationship classification (equality is flat, never bull/bear). */
export function relationOf(ema9: number, ema20: number): EmaRelation | null {
  if (!Number.isFinite(ema9) || !Number.isFinite(ema20)) return null;
  if (ema9 > ema20) return "bull";
  if (ema9 < ema20) return "bear";
  return "flat";
}

/** A pending reversal awaiting confirmation. */
export interface PendingReversal {
  direction: ReversalDirection;
  /** CLOSED candles that have held the new relationship (cross candle = 1). */
  confirmations: number;
  /** Bucket start (epoch s) of the cross candle. */
  sinceBucketSec: number;
}

export interface DetectorState {
  pending: PendingReversal | null;
  /** Last relationship (in-session or not) — guards re-crosses after flat. */
  lastRelation: EmaRelation | null;
  /** The most recently CONFIRMED direction (null until first confirmation). */
  established: ReversalDirection | null;
  /** Bucket start (epoch s) of the last processed closed candle. */
  lastBucketSec: number;
}

export interface DetectorInput {
  /** Bucket START (epoch seconds) of the CLOSED candle. */
  bucketSec: number;
  ema9: number;
  ema20: number;
  /** Whether this candle's CLOSE instant is inside the NY session. */
  inSession: boolean;
}

export type DetectorEventKind =
  /** Cross candle opened a pending reversal (confirmation 1). */
  | "pending"
  /** A further closed candle advanced the pending confirmation counter. */
  | "pending-progress"
  /** The pending reversal reached the configured confirmation count. */
  | "confirmed"
  /** The pending reversal was cancelled (flip or flat before confirmation). */
  | "cancelled"
  /** Nothing notable (steady state, duplicate-safe). */
  | "steady";

export interface DetectorEvent {
  kind: DetectorEventKind;
  direction?: ReversalDirection;
  confirmations?: number;
  bucketSec: number;
}

export class EmaReversalDetector {
  private pending: PendingReversal | null = null;
  private lastRelation: EmaRelation | null = null;
  private established: ReversalDirection | null = null;
  private lastBucketSec = 0;

  constructor(private confirmationCandles: number) {}

  state(): DetectorState {
    return {
      pending: this.pending ? { ...this.pending } : null,
      lastRelation: this.lastRelation,
      established: this.established,
      lastBucketSec: this.lastBucketSec,
    };
  }

  /** Update the configured confirmation count (settings change). */
  setConfirmationCandles(n: number): void {
    this.confirmationCandles = n;
    // A pending reversal under a changed target keeps its accumulated count;
    // it will confirm at the new threshold or cancel naturally.
  }

  /** Clear all lifecycle state (fresh warm-up / re-derivation). */
  reset(): void {
    this.pending = null;
    this.lastRelation = null;
    this.established = null;
    this.lastBucketSec = 0;
  }

  /**
   * Feed ONE closed candle. Returns the event describing what happened
   * (null only for ignored/duplicate buckets).
   */
  onClosedCandle(input: DetectorInput): DetectorEvent | null {
    const { bucketSec, inSession } = input;
    const rel = relationOf(input.ema9, input.ema20);
    if (rel === null) return null;

    // Defense in depth: only strictly-advancing closed buckets are processed.
    // This rejects duplicate/out-of-order/replayed closes. The forming/live
    // candle is excluded by ARCHITECTURE: the engine is fed exclusively from
    // the aggregator's rollover path (ClosedCandle), never per-tick, so an
    // intrabar update can never reach this module at all.
    if (bucketSec <= this.lastBucketSec) return null;
    this.lastBucketSec = bucketSec;

    // Out-of-session: cancel pending, track relationship, never emit.
    if (!inSession) {
      const hadPending = this.pending !== null;
      this.pending = null;
      this.lastRelation = rel;
      if (rel === "bull") this.established = "bullish";
      else if (rel === "bear") this.established = "bearish";
      return hadPending ? { kind: "cancelled", bucketSec } : { kind: "steady", bucketSec };
    }

    // Flat inside the session: the relationship does not hold — cancel pending.
    if (rel === "flat") {
      const hadPending = this.pending !== null;
      this.pending = null;
      this.lastRelation = rel;
      return hadPending ? { kind: "cancelled", bucketSec } : { kind: "steady", bucketSec };
    }

    const dir: ReversalDirection = rel === "bull" ? "bullish" : "bearish";

    // A genuine NEW transition starts a fresh lifecycle (cross candle counts
    // as confirmation 1). "New" = different from the previous candle's
    // relationship; while the relationship continuously holds, no new
    // lifecycle can start — that is the duplicate protection.
    if (this.pending === null && rel !== this.lastRelation) {
      this.pending = { direction: dir, confirmations: 1, sinceBucketSec: bucketSec };
      this.lastRelation = rel;
      if (this.pending.confirmations >= this.confirmationCandles) {
        return this.confirm(bucketSec);
      }
      return { kind: "pending", direction: dir, confirmations: 1, bucketSec };
    }

    // Pending lifecycle advancing on the SAME relationship.
    if (this.pending && this.pending.direction === dir) {
      this.pending.confirmations += 1;
      if (this.pending.confirmations >= this.confirmationCandles) {
        return this.confirm(bucketSec);
      }
      return { kind: "pending-progress", direction: dir, confirmations: this.pending.confirmations, bucketSec };
    }

    // Pending in the OPPOSITE direction — the relationship has flipped, which
    // cancels the stale lifecycle; the flip candle is itself a genuine new
    // crossover (prev held the old side, this closed candle establishes the
    // new side), so a fresh pending starts at confirmation 1.
    if (this.pending) {
      this.pending = { direction: dir, confirmations: 1, sinceBucketSec: bucketSec };
      this.lastRelation = rel;
      if (this.pending.confirmations >= this.confirmationCandles) {
        return this.confirm(bucketSec);
      }
      return { kind: "pending", direction: dir, confirmations: 1, bucketSec };
    }

    // Steady state: relationship continuously held with no pending lifecycle.
    this.lastRelation = rel;
    return { kind: "steady", bucketSec };
  }

  /** Reachable only in-session (every confirm() caller gates on that). */
  private confirm(bucketSec: number): DetectorEvent {
    const direction = this.pending!.direction;
    this.established = direction;
    this.pending = null;
    return { kind: "confirmed", direction, confirmations: this.confirmationCandles, bucketSec };
  }
}
