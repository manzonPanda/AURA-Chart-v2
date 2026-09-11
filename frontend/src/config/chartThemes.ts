/**
 * Chart theme registry — the Appearance section's theme cards.
 *
 * NO duplicate theme engine: every entry is a CandleKit `ChartTheme`
 * OVERRIDE (Partial). AURA's rendering stays CandleKit's own — the library's
 * `resolveTheme` merges the override onto its built-in light/dark baseline,
 * and `controller.setTheme(override)` applies it (CandleKit restyles the
 * chart + re-broadcasts its "theme" bus event, which InvertScaleBridge /
 * CandleStyleBridge listen to for palette re-assertion).
 *
 * The registry ids are the user-facing names shown on the Appearance cards.
 * "Fractal Classic" is AURA's baseline — the exact palette the chart has
 * always rendered (CandleKit dark + #26a69a/#ef5350 candles).
 */
import type { ChartTheme } from "@getcandlekit/charts";

export type ChartThemeDef = {
  /** User-facing name (card label + `settings.appearance.theme` value). */
  id: string;
  /** True when the override brightens the chart background (card badge). */
  light: boolean;
  /** Resolved by CandleKit `resolveTheme` onto its light/dark baseline. */
  colors: Partial<ChartTheme>;
};

/** AURA baseline — CandleKit's dark chart, untouched (candles #26a69a/#ef5350). */
const FRACTAL_CLASSIC: ChartThemeDef = {
  id: "Fractal Classic",
  light: false,
  colors: {},
};

/** Registry — consumed by the Appearance cards; ids persist in settings. */
export const CHART_THEMES: readonly ChartThemeDef[] = [
  FRACTAL_CLASSIC,
  { id: "Solarized", light: false, colors: { mode: "dark", background: "#002b36", text: "#93a1a1", grid: "#073642", axis: "#586e75", up: "#859900", down: "#dc322f", line: "#b58900" } },
  { id: "Dracula", light: false, colors: { mode: "dark", background: "#282a36", text: "#f8f8f2", grid: "#21222c", axis: "#6272a4", up: "#50fa7b", down: "#ff5555", line: "#bd93f9" } },
  { id: "Nord", light: false, colors: { mode: "dark", background: "#2e3440", text: "#eceff4", grid: "#3b4252", axis: "#d8dee9", up: "#a3be8c", down: "#bf616a", line: "#88c0d0" } },
  { id: "Gruvbox", light: false, colors: { mode: "dark", background: "#282828", text: "#ebdbb2", grid: "#3c3836", axis: "#a89984", up: "#b8bb26", down: "#fb4934", line: "#fe8019" } },
  { id: "Monokai", light: false, colors: { mode: "dark", background: "#272822", text: "#f8f8f2", grid: "#3e3d32", axis: "#75715e", up: "#a6e22e", down: "#f92672", line: "#66d9ef" } },
  { id: "One", light: false, colors: { mode: "dark", background: "#282c34", text: "#abb2bf", grid: "#21252b", axis: "#5c6370", up: "#98c379", down: "#e06c75", line: "#61afef" } },
  { id: "Tokyo Night", light: false, colors: { mode: "dark", background: "#1a1b26", text: "#a9b1d6", grid: "#16161e", axis: "#565f89", up: "#9ece6a", down: "#f7768e", line: "#7aa2f7" } },
  { id: "Catppuccin", light: false, colors: { mode: "dark", background: "#1e1e2e", text: "#cdd6f4", grid: "#181825", axis: "#6c7086", up: "#a6e3a1", down: "#f38ba8", line: "#89b4fa" } },
  { id: "GitHub", light: true, colors: { mode: "light", background: "#ffffff", text: "#24292f", grid: "#eaeef2", axis: "#57606a", up: "#1a7f37", down: "#cf222e", line: "#0969da" } },
  { id: "Monochrome", light: false, colors: { mode: "dark", background: "#111111", text: "#e0e0e0", grid: "#1c1c1c", axis: "#666666", up: "#e0e0e0", down: "#707070", line: "#bbbbbb" } },
  { id: "Rose Pine", light: false, colors: { mode: "dark", background: "#191724", text: "#e0def4", grid: "#1f1d2e", axis: "#908caa", up: "#9ccfd8", down: "#eb6f92", line: "#c4a7e7" } },
];

/** Registry lookup by id (settings store the id; corrupt ids fall back). */
export function findChartTheme(id: string): ChartThemeDef | undefined {
  return CHART_THEMES.find((t) => t.id === id);
}

/** Resolved id guard — falls back to the AURA baseline for unknown ids. */
export function effectiveThemeId(id: string): string {
  return findChartTheme(id) ? id : FRACTAL_CLASSIC.id;
}
