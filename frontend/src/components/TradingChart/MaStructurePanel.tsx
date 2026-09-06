import { useEffect, useMemo, useRef } from "react";

import { calculateEMA, effectiveCloseSeries } from "../../services/ema";
import { calculateSMA } from "../../services/sma";
import {
  calculateSlope,
  evaluateMaStructure,
  emptyGapHistory,
  MA_PAIR_KEYS,
  MA_STRUCTURE_EMA_FAST,
  MA_STRUCTURE_EMA_SLOW,
  MA_STRUCTURE_SMA_PERIOD,
  type MaGapHistory,
  type MaSeriesId,
  type MaSlope,
  type MaStructureEvaluation,
  type MaTone,
} from "../../services/movingAverageStructure";
import type { RealtimeCandleMsg } from "../../services/realtime";

/** Structural subset of the chart's bars — the panel consumes VALUES only. */
export interface MaStructureBar {
  readonly ts: number;
  readonly close: number;
}

interface Props {
  /**
   * The chart's bucket-aligned candles. While Replay is active this is ALREADY
   * the cursor slice (TradingChart hands bridges `visibleBars`), so the panel
   * can never classify the future — same anti-look-ahead contract as
   * EmaBridge / SmaBridge.
   */
  bars: readonly MaStructureBar[];
  /**
   * Latest forming candle pushed by the backend (time = bucket start, epoch s).
   * Callers withhold it during Replay (live truth must not leak into a
   * replaying chart).
   */
  liveCandle: RealtimeCandleMsg | null;
  /** Selected timeframe bucket size in seconds (60 = 1m, 180 = 3m). */
  bucketSec: number;
  /** Drives the badge (LIVE vs REPLAY) — the panel itself stays replay-scoped. */
  replayActive?: boolean;
  /**
   * Rendered right-price-scale width (px) measured from the chart. The panel
   * anchors itself LEFT of the price scale (right offset = inset + breathing
   * gap) so the axis labels are never covered. 0 = chart not measured yet →
   * the CSS fallback offset applies.
   */
  rightInset?: number;
  /**
   * Changing this key (instrument / timeframe / replay boundary) resets the
   * gap-trend history, so samples can never leak across streams.
   */
  resetKey?: string;
}

/** "+2.18" / "-1.42" — explicit sign, 2 decimals (point gap convention). */
const fmtSigned = (v: number): string =>
  `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}`;

const lastValue = (points: readonly { value: number }[]): number | null =>
  points.length > 0 ? points[points.length - 1].value : null;

const toneClass = (tone: MaTone | null): string =>
  tone === "bull" ? "bull" : tone === "bear" ? "bear" : tone === "warn" ? "warn" : "none";

const slopeClass = (slope: MaSlope): string =>
  slope === "↗" ? "rising" : slope === "↘" ? "falling" : "flat";

/** Cells of the subtle 10-cell convergence bar (0 = no recent history to show). */
const MA_CONVERGENCE_CELLS = 10;
const convergenceCells = (convergence: number | null): number => {
  if (convergence === null) return 0;
  const ratio = Math.max(0, Math.min(1, convergence));
  return Math.round(ratio * MA_CONVERGENCE_CELLS);
};

/** Global per-MA slope row — the three indicator directions shown ONCE. */
type MaSlopes = Record<MaSeriesId, MaSlope>;

/** Slope of one indicator series (current vs previous point) via the engine's
 *  calculateSlope — the SAME math the engine uses per pair. */
const slopeOfSeries = (points: readonly { value: number }[]): MaSlope =>
  points.length >= 2
    ? calculateSlope(points[points.length - 1].value, points[points.length - 2].value)
    : "--";

/**
 * Trader-facing Moving Average Structure panel (EMA9 • EMA20 • SMA20).
 *
 * Data flow — identical to the indicator bridges, NO new polling:
 *   candles + liveCandle(server truth) → effectiveCloseSeries() →
 *   calculateEMA(9) / calculateEMA(20) / calculateSMA(20) →
 *   evaluateMaStructure() → structure + pairwise gaps + gap trends.
 *
 * The per-tick cadence matches EmaBridge/SmaBridge (recompute on each candle
 * frame; the three O(n) passes over ~10³ closes are negligible next to the
 * chart's own paint), and the gap-trend history advances exactly one sample
 * per CLOSED bucket via the engine's pure fold (persisted in a ref after
 * commit — render stays pure, StrictMode-safe).
 */
export function MaStructurePanel({
  bars,
  liveCandle,
  bucketSec,
  replayActive = false,
  resetKey = "",
  rightInset = 0,
}: Props) {
  /** Gap-trend sample history — persisted between frames, keyed by pair. */
  const historyRef = useRef<MaGapHistory>(emptyGapHistory());
  const resetRef = useRef(resetKey);

  // Pure derivation per candle frame (same cadence as the indicator bridges).
  const { evaluation, slopes } = useMemo<{
    evaluation: MaStructureEvaluation;
    slopes: MaSlopes;
  }>(() => {
    const closes = effectiveCloseSeries(bars, liveCandle, bucketSec);
    const lastTs = closes.length > 0 ? closes[closes.length - 1].ts : null;
    // The SAME series the last values come from are handed to the engine so it
    // can derive per-pair slopes + seed the gap window from loaded history —
    // no extra indicator math anywhere. The global slope row reads the SAME
    // series through the engine's calculateSlope.
    const ema9Series = calculateEMA(closes, MA_STRUCTURE_EMA_FAST);
    const ema20Series = calculateEMA(closes, MA_STRUCTURE_EMA_SLOW);
    const sma20Series = calculateSMA(closes, MA_STRUCTURE_SMA_PERIOD);
    const evaluation = evaluateMaStructure({
      ema9: lastValue(ema9Series),
      ema20: lastValue(ema20Series),
      sma20: lastValue(sma20Series),
      ts: lastTs,
      history: historyRef.current,
      series: { EMA9: ema9Series, EMA20: ema20Series, SMA20: sma20Series },
    });
    return {
      evaluation,
      slopes: {
        EMA9: slopeOfSeries(ema9Series),
        EMA20: slopeOfSeries(ema20Series),
        SMA20: slopeOfSeries(sma20Series),
      },
    };
  }, [bars, liveCandle, bucketSec]);

  // Commit AFTER render (refs may not be written during render). On a stream
  // boundary (instrument / timeframe / replay enter-exit) reset INSTEAD of
  // persisting, so the old stream's samples can never seed the new one.
  useEffect(() => {
    if (resetRef.current !== resetKey) {
      resetRef.current = resetKey;
      historyRef.current = emptyGapHistory();
    } else {
      historyRef.current = evaluation.history;
    }
  }, [evaluation, resetKey]);

  const { snapshot } = evaluation;

  return (
    <div
      className="ma-structure"
      role="status"
      aria-label="Moving Average Structure"
      style={rightInset > 0 ? { right: rightInset + 12 } : undefined}
    >
      <div className="ma-structure-head">
        <span className="ma-structure-title">MOVING AVERAGE STRUCTURE</span>
        <span className={`ma-structure-badge ${replayActive ? "replay" : "live"}`}>
          {replayActive ? "● REPLAY" : "● LIVE"}
        </span>
      </div>
      <div className="ma-structure-sub">EMA9 • EMA20 • SMA20</div>

      <div className="ma-structure-section">
        <div className="ma-structure-2col">
          <div className="ma-structure-col">
            <div className="ma-structure-kicker">CURRENT STRUCTURE</div>
            {snapshot.structureLabel !== null ? (
              <>
                <div className={`ma-structure-state ${snapshot.structureTone ?? "none"}`}>
                  <span className="ma-dot">{snapshot.structureDot}</span>
                  {snapshot.structureLabel}
                </div>
                <div className="ma-structure-order">{snapshot.orderLabel}</div>
              </>
            ) : (
              <div className="ma-structure-state none">— awaiting EMA20 / SMA20…</div>
            )}
          </div>
          <div className="ma-structure-col">
            <div className="ma-structure-kicker">SLOPE</div>
            <div className="ma-structure-slopes ma-structure-slopes--stack">
              {(["EMA9", "EMA20", "SMA20"] as const).map((id) => (
                <span className="ma-structure-slope" key={id} title={`${id} slope`}>
                  {id}
                  <b className={slopeClass(slopes[id])}>{slopes[id]}</b>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="ma-structure-section">
        <div className="ma-structure-kicker">LIVE RELATIONSHIPS</div>
        {/* Key = the FIXED pair identity (MA_PAIR_KEYS[i] === rel.pair when the
            row is real). Never key a pending row by a shared placeholder: on
            the live→replay boundary the engine briefly returns all-null
            relationships, and duplicate "pending" keys made React's reconciler
            orphan the real rows' previous DOM nodes — blank "—" rows stacked
            above the real ones and survived steps/seek/exit until a full page
            reload. Stable per-pair keys keep the list exactly three rows
            through every lifecycle transition. */}
        {snapshot.relationships.map((rel, i) => {
          const filled = convergenceCells(rel?.convergence ?? null);
          return (
            <div className="ma-pair" key={MA_PAIR_KEYS[i]}>
              <div className="ma-pair-name">
                {rel ? `${rel.firstLabel} / ${rel.secondLabel}` : "—"}
              </div>
              <div className={`ma-pair-status ${toneClass(rel?.tone ?? null)}`}>
                <span className="ma-dot">{rel?.dot ?? "·"}</span>
                {rel?.label ?? "—"}
              </div>
              <div className="ma-pair-right">
                <div className="ma-pair-gap">
                  {rel ? `Gap ${fmtSigned(rel.signedGap)} pts` : "Gap —"}
                </div>
                <div className={`ma-pair-trend ${rel?.gapTrend.toLowerCase() ?? "none"}`}>
                  {rel?.gapTrend ?? "—"}
                </div>
              </div>
              {/* Convergence bar — how close to the pair's own recent gap range.
                  Subtle 10-cell glyph, never a probability. */}
              <div className="ma-pair-conv" aria-hidden="true">
                <span className="ma-pair-conv-fill">{"█".repeat(filled)}</span>
                <span className="ma-pair-conv-empty">{"░".repeat(MA_CONVERGENCE_CELLS - filled)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

