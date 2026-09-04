/**
 * EMA Reversal Alert pipeline (PURE — detector + gates + cooldown).
 *
 * Composes the {@link EmaReversalDetector} with the configuration gates and
 * the per-direction cooldown. This module is the unit-test surface for the
 * alert rules: the real engine only adds I/O (PineTS EMA values in, Web Push
 * + WS broadcast out).
 *
 * Gate order for a CONFIRMED reversal:
 *   1. session — already enforced by the detector (out-of-session candles
 *      never confirm; they cancel pending lifecycles instead)
 *   2. settings.enabled — defensive re-check (the engine skips feeding the
 *      pipeline while disabled)
 *   3. direction enabled (bullishEnabled / bearishEnabled) — the confirmed
 *      lifecycle is still consumed (no replay later)
 *   4. per-direction cooldown — the lifecycle is consumed; the next alert of
 *      that direction requires both a NEW crossover and an expired cooldown
 *
 * The clock is injectable so cooldown behavior is deterministically testable.
 */
import type { EmaRelation, ReversalDirection } from "./reversalDetector.js";
import { EmaReversalDetector } from "./reversalDetector.js";
import { isClosedCandleInSession } from "./nySession.js";
import type { EmaAlertSettings } from "./emaAlertConfig.js";

/** One CLOSED candle's alert-relevant data (EMA values from the PineTS run). */
export interface ClosedSignal {
  /** Bucket START (epoch seconds) of the closed candle. */
  bucketSec: number;
  ema9: number;
  ema20: number;
  /** The candle's closing price (for the notification content). */
  price: number;
}

/** Why a CONFIRMED reversal produced no notification. */
export type SuppressionReason = "disabled" | "direction-disabled" | "cooldown";

export interface PendingInfo {
  direction: ReversalDirection;
  confirmations: number;
  needed: number;
}

export interface ConfirmedAlert {
  direction: ReversalDirection;
  /** Bucket start (epoch s) of the confirming candle. */
  bucketSec: number;
  /** Close instant of the confirming candle (epoch ms). */
  closeMs: number;
  price: number;
}

export interface AlertPipelineOutcome {
  /** Relationship on this candle (null while EMA values are unavailable). */
  relationship: EmaRelation | null;
  /** Live pending state for the UI ("EMA bullish confirmation 1/2"). */
  pending: PendingInfo | null;
  /** Non-null → emit a phone notification (all gates passed). */
  alert: ConfirmedAlert | null;
  /** Non-null → a confirmed reversal was consumed without notification. */
  suppressed: SuppressionReason | null;
  /** EMA values of this candle (engine status surface). */
  ema9: number;
  ema20: number;
}

export interface AlertClock {
  now(): number;
}

export class EmaAlertPipeline {
  private detector: EmaReversalDetector;
  /** Per-direction last-notification epoch ms (persisted by the engine). */
  private readonly lastAlertAt: { bullish: number; bearish: number } = { bullish: 0, bearish: 0 };

  constructor(
    private readonly settingsAccessor: () => EmaAlertSettings,
    private readonly clock: AlertClock = { now: () => Date.now() },
  ) {
    this.detector = new EmaReversalDetector(settingsAccessor().confirmationCandles);
  }

  /** Per-direction cooldown timestamps — the engine persists/restores these. */
  getLastAlertAt(): { bullish: number; bearish: number } {
    return { ...this.lastAlertAt };
  }

  setLastAlertAt(value: { bullish?: number; bearish?: number }): void {
    if (typeof value.bullish === "number") this.lastAlertAt.bullish = value.bullish;
    if (typeof value.bearish === "number") this.lastAlertAt.bearish = value.bearish;
  }

  /**
   * Re-derive lifecycle state from a historical closed-candle series
   * (warm-up / settings change). Silently replays: never returns alerts and
   * never records cooldown timestamps — only the final pending/established
   * state matters.
   */
  replay(signals: ClosedSignal[], closeMsOf: (bucketSec: number) => number): void {
    const s = this.settingsAccessor();
    this.detector.reset();
    for (const sig of signals) {
      this.feedDetector(sig, closeMsOf(sig.bucketSec), s);
    }
  }

  /** Recreate the detector after a confirmationCandles change, then replay. */
  reconfigure(signals: ClosedSignal[], closeMsOf: (bucketSec: number) => number): void {
    this.detector = new EmaReversalDetector(this.settingsAccessor().confirmationCandles);
    this.replay(signals, closeMsOf);
  }

  /** Detector state snapshot (for the status surface). */
  state() {
    return this.detector.state();
  }

  /** Process ONE newly closed candle through the detector + gates. */
  onClosedCandle(sig: ClosedSignal, closeMs: number): AlertPipelineOutcome {
    const s = this.settingsAccessor();
    const event = this.feedDetector(sig, closeMs, s);
    const relationship = event === null ? null : this.detector.state().lastRelation;

    if (event?.kind !== "confirmed") {
      return {
        relationship,
        pending: this.pendingInfo(s),
        alert: null,
        suppressed: null,
        ema9: sig.ema9,
        ema20: sig.ema20,
      };
    }

    // A reversal confirmed — apply the notification gates in order.
    const direction = event.direction!;
    if (!s.enabled) {
      return this.outcome(relationship, sig, "disabled");
    }
    const directionEnabled = direction === "bullish" ? s.bullishEnabled : s.bearishEnabled;
    if (!directionEnabled) {
      return this.outcome(relationship, sig, "direction-disabled");
    }
    const cooldownMs = s.cooldownMinutes * 60_000;
    const last = this.lastAlertAt[direction];
    const now = this.clock.now();
    if (cooldownMs > 0 && last > 0 && now - last < cooldownMs) {
      return this.outcome(relationship, sig, "cooldown");
    }
    this.lastAlertAt[direction] = now;
    return {
      relationship,
      pending: null,
      alert: { direction, bucketSec: sig.bucketSec, closeMs, price: sig.price },
      suppressed: null,
      ema9: sig.ema9,
      ema20: sig.ema20,
    };
  }

  private outcome(
    relationship: EmaRelation | null,
    sig: ClosedSignal,
    reason: SuppressionReason,
  ): AlertPipelineOutcome {
    return {
      relationship,
      pending: null,
      alert: null,
      suppressed: reason,
      ema9: sig.ema9,
      ema20: sig.ema20,
    };
  }

  private pendingInfo(s: EmaAlertSettings): PendingInfo | null {
    const p = this.detector.state().pending;
    return p ? { direction: p.direction, confirmations: p.confirmations, needed: s.confirmationCandles } : null;
  }

  /** Single detector feed point — session gate lives here. */
  private feedDetector(sig: ClosedSignal, closeMs: number, s: EmaAlertSettings) {
    return this.detector.onClosedCandle({
      bucketSec: sig.bucketSec,
      ema9: sig.ema9,
      ema20: sig.ema20,
      inSession: isClosedCandleInSession(closeMs, s.sessionStart, s.sessionEnd),
    });
  }
}
