import { useMemo } from "react";
import { ChartView } from "@getcandlekit/charts/react";
import type { Candle } from "../../types/candle";
import { createEmaIndicators } from "./indicators";
import { OHLCReadout } from "./OHLCReadout";

interface Props {
  candles: readonly Candle[];
  loading?: boolean;
}

/**
 * Renders the candlestick chart via CandleKit (on top of Lightweight Charts).
 * `candles` are already the normalized `{ ts, open, high, low, close, volume }`
 * shape CandleKit expects, and EMA 20 / EMA 50 are mounted as indicators that
 * recompute automatically whenever new candle data is delivered.
 */
export function TradingChart({ candles, loading = false }: Props) {
  // Stable indicator controller across renders (CandleKit adds EMA 20 + EMA 50).
  const indicators = useMemo(() => createEmaIndicators(), []);

  const data = useMemo(() => candles, [candles]);
  const last = candles[candles.length - 1];

  return (
    <div className="trading-chart">
      <div className="chart-canvas-wrap">
        <ChartView
          data={data}
          seriesType="candlestick"
          theme="dark"
          showVolume
          indicators={indicators}
        />
        {loading && <div className="chart-spinner">…</div>}
      </div>
      <div className="chart-footer">
        <OHLCReadout candle={last} />
      </div>
    </div>
  );
}