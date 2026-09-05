import { useEffect } from "react";

import { useChartApi } from "@getcandlekit/charts/react";
import type { IChartApi } from "lightweight-charts";

interface Props {
  /**
   * Visual price-scale inversion — a pure, immediate viewport transform.
   * Applied through Lightweight Charts' NATIVE `invertScale` price-scale
   * option on the main right scale (the scale the candles + overlapping
   * indicators share), which keeps them perfectly aligned and requires NO
   * data transformation, reload, or refetch.
   */
  invertScale: boolean;
}

/**
 * Applies the "Invert Scale" setting to the chart's main price scale.
 *
 * Why a bridge component? CandleKit's `ChartController` owns the Lightweight
 * Charts instance for the ChartView's whole lifetime and `setData`/`updateBar`
 * never touch price-scale options, so a single call here is both immediate and
 * durable. Keyed on `api` (re-applies if the chart is ever recreated) and the
 * setting itself (re-applies on every toggle).
 *
 * Only the pane-0 `right` scale is touched:
 *   - candles, EMA overlays and pane-0 Pine overlays all share it → invert
 *     together, staying logically attached to the same prices;
 *   - indicators rendered in their OWN separate pane (pane > 0) have their own
 *     scales and are deliberately left alone.
 */
export function InvertScaleBridge({ invertScale }: Props) {
  const api = useChartApi();

  useEffect(() => {
    const chart: IChartApi = api.controller.getChart();
    try {
      chart.priceScale("right").applyOptions({ invertScale });
    } catch {
      /* older/edge LWC build without invertScale — noop keeps chart usable */
    }
  }, [api, invertScale]);

  // Pure chart-side bridge: nothing rendered into the DOM.
  return null;
}