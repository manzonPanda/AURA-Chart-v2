import { useEffect } from "react";

import { useChartApi } from "@getcandlekit/charts/react";

import { findChartTheme } from "../../config/chartThemes";

/**
 * Applies the Appearance section's selected theme to the EXISTING chart —
 * no second theme engine, no chart recreation.
 *
 * Every registry entry is a CandleKit `ChartTheme` OVERRIDE (Partial); the
 * library's own `controller.setTheme(override)` resolves it onto its built-in
 * light/dark baseline (`resolveTheme` merges — it never stacks onto the
 * previous custom theme, so `{}` for "Fractal Classic" restores CandleKit's
 * true baseline), restyles the chart/series, and re-broadcasts its "theme"
 * bus event — which the palette bridges (InvertScaleBridge) listen to, so the
 * persisted candle palette re-asserts itself over CandleKit's restyle.
 *
 * Why a bridge? `ChartView`'s `theme` prop applies at mount only. Settings
 * changes must restyle the LIVE chart immediately, so this component reacts
 * to the theme id imperatively via the controller (CandleKit's documented
 * pattern). Keyed on `api` so a recreated chart re-seeds the theme too.
 */
export function ChartThemeBridge({ themeId }: { themeId: string }) {
  const api = useChartApi();

  useEffect(() => {
    const controller = api.controller;
    if (!controller) return;
    try {
      controller.setTheme(findChartTheme(themeId)?.colors ?? {});
    } catch {
      /* chart already torn down */
    }
  }, [api, themeId]);

  // Pure chart-side bridge: nothing rendered into the DOM.
  return null;
}
