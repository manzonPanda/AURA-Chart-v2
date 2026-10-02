import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { calculateEMA, effectiveCloseSeries } from "../../services/ema";
import {
  loadMaStructureVisible,
  saveMaStructureVisible,
  toggleMaStructureVisible,
} from "../../services/maStructureVisibility";
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
 * Keep the panel's own buttons from reaching the chart underneath: the panel
 * is `pointer-events: none`, so without this the chart would still see the
 * press through its own document-level listeners and could pan or begin a
 * replay candle-pick. `stopPropagation` only — never `preventDefault`, so
 * focus, click and touch activation behave natively.
 * (Same pattern as ActiveIndicatorsOverlay's control buttons.)
 */
const stopChartPointer = (e: { stopPropagation: () => void }): void => {
  e.stopPropagation();
};

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
 *
 * VISIBILITY — a UI-only toggle owned entirely by this component. The header
 * carries a compact eye (hide) button; hidden, the panel stops rendering its
 * contents and leaves a small eye-off restore control in the same spot. It is
 * NOT an indicator switch: EMA9 / EMA20 / SMA20 keep drawing on the chart,
 * MA alerts keep firing and the live feed keeps streaming, because none of
 * them are reachable from here. Preference key:
 * `aura.ma.structure.visibility.v1` (see services/maStructureVisibility.ts).
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

  /**
   * Panel VISIBILITY — presentation only, never data.
   *
   * Deliberately LOCAL state (not lifted into App, not a ChartSettings
   * field): this panel is a single self-contained overlay, so flipping one
   * `useState` re-renders nothing else. There is no path from this toggle to
   * a candle reload, timeframe change, viewport move, live-edge re-anchor,
   * indicator recalculation or websocket reconnect — the bars / liveCandle /
   * bucketSec it receives are untouched, and the derivation below is a
   * `useMemo` whose deps are unchanged, so it is not even recomputed.
   *
   * The lazy initialiser reads the guarded preference ONCE (missing,
   * corrupted or storage-denied → visible). The effect below persists only a
   * real change, so merely loading the page never writes to storage.
   */
  const [visible, setVisible] = useState<boolean>(loadMaStructureVisible);
  /** Last value handed to storage — lets the effect skip the first commit. */
  const persistedVisibleRef = useRef<boolean>(visible);

  const toggleVisible = useCallback((): void => {
    // Updater is PURE (no side effects) → StrictMode double-invoke safe.
    setVisible((prev) => toggleMaStructureVisible(prev));
  }, []);

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

  // Persist ONLY a genuine change (the first commit is a no-op), so loading
  // the page never writes storage. Guarded write: a storage failure leaves
  // the preference session-only and never breaks the panel.
  useEffect(() => {
    if (persistedVisibleRef.current === visible) return;
    persistedVisibleRef.current = visible;
    saveMaStructureVisible(visible);
  }, [visible]);

  // HIDDEN: stop RENDERING the contents entirely (not a transparent panel) and
  // leave only the compact eye-off restore control at the panel's own anchor
  // point. Every hook above has already run, so the hook order is identical in
  // both states and a toggle is a pure re-render. `pointer-events` is
  // inherited as `none` from `.ma-structure`, so the button re-enables events
  // for itself alone and never swallows a chart drag, price-axis hit or
  // replay candle-pick outside its few pixels.
  if (!visible) {
    return (
      <div
        className="ma-structure ma-structure--collapsed"
        style={rightInset > 0 ? { right: rightInset + 12 } : undefined}
      >
        <button
          type="button"
          className="ma-structure-restore"
          aria-label="Show Moving Average Structure"
          title="Show Moving Average Structure"
          aria-pressed={false}
          onPointerDown={stopChartPointer}
          onDoubleClick={stopChartPointer}
          onClick={(e) => {
            e.stopPropagation();
            toggleVisible();
          }}
        >
          <EyeOffIcon />
          <span className="ma-structure-restore-label" aria-hidden="true">
            MA
          </span>
        </button>
      </div>
    );
  }

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
        <span className="ma-structure-head-right">
          <span className={`ma-structure-badge ${replayActive ? "replay" : "live"}`}>
            {replayActive ? "● REPLAY" : "● LIVE"}
          </span>
          {/* Compact eye = "hide". A native <button> (keyboard + touch work
              for free), visually secondary to the title, and it stops the
              chart's pointer handlers so a click here never pans, scrolls or
              starts a replay candle-pick. */}
          <button
            type="button"
            className="ma-structure-toggle"
            aria-label="Hide Moving Average Structure"
            title="Hide Moving Average Structure"
            aria-pressed={true}
            onPointerDown={stopChartPointer}
            onDoubleClick={stopChartPointer}
            onClick={(e) => {
              e.stopPropagation();
              toggleVisible();
            }}
          >
            <EyeIcon />
          </button>
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

/** 12x12 inline SVG visibility glyphs — `currentColor`, no external assets.
 *  Deliberately the SAME two paths ActiveIndicatorsOverlay uses for the
 *  indicator legend's eye / eye-off buttons, so the chart has exactly one
 *  visibility iconography. `aria-hidden`: the accessible name comes from the
 *  host <button>'s aria-label / title. */
function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M1 1l22 22" />
    </svg>
  );
}
