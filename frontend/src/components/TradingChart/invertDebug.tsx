/**
 * ⚠ TEMPORARY DIAGNOSTIC PROBE — debug-gated, trivially removable.
 *
 * Enabled ONLY by `?debugInvert` in the URL or `localStorage["aura.debug.invert"] = "1"`.
 * With the flag absent this module renders nothing and costs nothing — no
 * production behavior changes. To remove later: delete this file plus the
 * single `<InvertDebugProbe … />` line in TradingChart.tsx and the gated
 * `?invert=` seeding in App.tsx.
 *
 * Purpose: settle WHY candle colors look wrong with Invert Scale ON by
 * instrumenting the LIVE chart instead of theorizing. For the last handful of
 * HISTORICAL bars (the forming bar is excluded — its rAF glide paints a
 * cosmetic close) it records, per bar:
 *   - OHLC + direction (close vs open) and the EXPECTED color, computed from
 *     the main series' ACTUAL `options()` (upColor/downColor) — the exact
 *     inputs Lightweight Charts' own colorer uses;
 *   - the ACTUAL geometry: `priceToCoordinate(open/close/high/low)` and
 *     `timeToCoordinate(ts)` — whether OFF vs ON flips vertical ordering
 *     (it should) while x stays put;
 *   - the ACTUAL pixel: a 5×5 sample of every chart canvas's BACKING STORE at
 *     the body's center (mid-way between openY and closeY) — the color LWC
 *     really painted, before any CSS — with the dominant non-transparent hex.
 *     Canvas pixels + screenshot comparison also rules a CSS filter in/out
 *     (pixels correct + screen wrong ⇒ post-canvas override).
 * It also dumps the full series color options, the right price-scale options
 * (invertScale/autoScale/mode/margins), canvas count + DPRs, and a build
 * marker — the probe's <pre> existing in the DOM at all proves the served
 * bundle is fresh (no stale dev-server cache).
 *
 * Output: one <pre> overlay inside the chart wrap + matching console.info
 * lines, so `--headless --dump-dom` captures the report for automated runs.
 */
import { useEffect, useState } from "react";
import type {
  CandlestickSeriesOptions,
  IChartApi,
  UTCTimestamp,
} from "lightweight-charts";

import { useChartApi } from "@getcandlekit/charts/react";

import { effectiveBullish } from "./candleColors";

/** Bump when editing the probe — its presence in a capture proves freshness. */
export const DEBUG_INVERT_VERSION = "invert-debug-v1";

export function debugInvertEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).has("debugInvert")) return true;
    return window.localStorage.getItem("aura.debug.invert") === "1";
  } catch {
    return false;
  }
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseColor(s: string | undefined): Rgb | null {
  if (!s) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const hex = ({ r, g, b }: Rgb): string =>
  `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;

const near = (a: Rgb, b: Rgb): boolean =>
  Math.abs(a.r - b.r) <= 2 && Math.abs(a.g - b.g) <= 2 && Math.abs(a.b - b.b) <= 2;

interface CanvasLayer {
  canvas: HTMLCanvasElement;
  dpr: number;
}

/** Dominant non-transparent color in a 5×5 patch (CSS px coords) across all canvases. */
function dominantBodyColor(layers: CanvasLayer[], xCss: number, yCss: number): string | null {
  const counts = new Map<string, number>();
  for (const { canvas, dpr } of layers) {
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    const px = Math.round(xCss * dpr);
    const py = Math.round(yCss * dpr);
    try {
      const img = ctx.getImageData(px - 2, py - 2, 5, 5);
      for (let i = 0; i < img.data.length; i += 4) {
        if (img.data[i + 3] < 200) continue; // transparent bg / antialiased fringe
        const key = hex({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] });
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } catch {
      /* canvas not readable — skip layer */
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

interface ProbeRow {
  ts: string;
  o: number;
  h: number;
  l: number;
  c: number;
  dir: "bull" | "bear" | "doji";
  eff: "bull" | "bear";
  expected: string;
  actualPixel: string | null;
  match: string;
  x: number | null;
  yO: number | null;
  yC: number | null;
  yH: number | null;
  yL: number | null;
}

const manila = (ms: number): string =>
  new Date(ms).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

function buildReport(api: ReturnType<typeof useChartApi>, invertScale: boolean): string {
  const controller = api.controller;
  const chart: IChartApi = controller.getChart();
  const series = controller.getSeries();
  const so = series.options() as CandlestickSeriesOptions;
  const ps = chart.priceScale("right").options();
  const theme = controller.getTheme();
  const bars = controller.getBars();

  // AURA semantics check: the series options must hold the EFFECTIVE palette
  // (swapped while inverted, theme-normal otherwise).
  const swapOk =
    so.upColor?.toLowerCase() === (invertScale ? theme.down : theme.up).toLowerCase() &&
    so.downColor?.toLowerCase() === (invertScale ? theme.up : theme.down).toLowerCase();

  const layers: CanvasLayer[] = Array.from(
    document.querySelectorAll<HTMLCanvasElement>(".chart-canvas-wrap canvas"),
  ).map((canvas) => ({ canvas, dpr: canvas.width / Math.max(1, canvas.clientWidth) }));

  // Historical bars within the visible viewport, evenly spaced across it —
  // covers the FAR LEFT of the chart too (the last-8 sampling missed it).
  // The forming bar is excluded (rAF glide paints a cosmetic close).
  const visible: Array<{ bar: (typeof bars)[number]; x: number }> = [];
  for (let i = 0; i < bars.length - 1; i++) {
    const x = chart.timeScale().timeToCoordinate((bars[i].ts / 1000) as UTCTimestamp);
    if (x != null) visible.push({ bar: bars[i], x });
  }
  const step = Math.max(1, Math.floor(visible.length / 16));
  const sample = visible.filter((_, i) => i % step === 0).slice(0, 16);
  const rows: ProbeRow[] = sample.map(({ bar: b, x }) => {
    const dir = b.close > b.open ? "bull" : b.close < b.open ? "bear" : "doji";
    // AURA expected color: the RENDERED direction (swapped while inverted)
    // mapped through the TRUE theme bull/bear colors.
    const effUp = effectiveBullish(b.close, b.open, invertScale);
    const eff = effUp ? "bull" : "bear";
    const expected = hex(parseColor(effUp ? theme.up : theme.down) ?? { r: 0, g: 0, b: 0 });
    const yO = series.priceToCoordinate(b.open);
    const yC = series.priceToCoordinate(b.close);
    const yH = series.priceToCoordinate(b.high);
    const yL = series.priceToCoordinate(b.low);
    const actual = yO != null && yC != null ? dominantBodyColor(layers, x, (yO + yC) / 2) : null;
    const actualRgb = actual ? parseColor(actual) : null;
    const expectedRgb = parseColor(expected);
    const match =
      actualRgb && expectedRgb ? (near(actualRgb, expectedRgb) ? "MATCH" : "MISMATCH") : "n/a";
    const r1 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10) / 10);
    return {
      ts: manila(b.ts),
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      dir,
      eff,
      expected,
      actualPixel: actual,
      match,
      x: r1(x),
      yO: r1(yO),
      yC: r1(yC),
      yH: r1(yH),
      yL: r1(yL),
    };
  });

  const seriesColors = {
    upColor: so.upColor,
    downColor: so.downColor,
    borderUpColor: so.borderUpColor,
    borderDownColor: so.borderDownColor,
    wickUpColor: so.wickUpColor,
    wickDownColor: so.wickDownColor,
  };

  const lines: string[] = [];
  lines.push(`[INVERT-DEBUG ${DEBUG_INVERT_VERSION}] invertScale prop=${invertScale}`);
  lines.push(
    `priceScale("right").options(): invertScale=${String(ps.invertScale)} autoScale=${String(ps.autoScale)} mode=${String(ps.mode)} margins=${JSON.stringify(ps.scaleMargins)}`,
  );
  lines.push(`main series colors: ${JSON.stringify(seriesColors)}`);
  lines.push(
    `AURA swap check: series options hold the ${swapOk ? "CORRECT" : "WRONG"} palette for invertScale=${invertScale}`,
  );
  lines.push(`canvases: ${layers.length} (dpr: ${layers.map((l) => Math.round(l.dpr * 100) / 100).join(", ")})`);
  lines.push(`bars total: ${bars.length} — sampled (historical): ${rows.length}`);
  lines.push("ts | O | H | L | C | dir | eff | expected | actualPixel | match | x | yO | yC | yH | yL");
  for (const r of rows) {
    lines.push(
      `${r.ts} | ${r.o} | ${r.h} | ${r.l} | ${r.c} | ${r.dir} | ${r.eff} | ${r.expected} | ${r.actualPixel ?? "offscreen"} | ${r.match} | ${r.x} | ${r.yO} | ${r.yC} | ${r.yH} | ${r.yL}`,
    );
  }
  const bull = rows.find((r) => r.match !== "n/a" && r.dir === "bull");
  const bear = rows.find((r) => r.match !== "n/a" && r.dir === "bear");
  const geom = (r: ProbeRow): string =>
    r.yC != null && r.yO != null && r.yC > r.yO
      ? "close LOWER on screen (inverted geometry)"
      : "close HIGHER on screen (normal geometry)";
  if (bull)
    lines.push(
      `CRITICAL bull: yO=${bull.yO} yC=${bull.yC} → ${geom(bull)}; eff=${bull.eff} pixel=${bull.actualPixel} expected=${bull.expected} → ${bull.match}`,
    );
  if (bear)
    lines.push(
      `CRITICAL bear: yO=${bear.yO} yC=${bear.yC} → ${geom(bear)}; eff=${bear.eff} pixel=${bear.actualPixel} expected=${bear.expected} → ${bear.match}`,
    );
  const mismatched = rows.filter((r) => r.match === "MISMATCH").length;
  lines.push(
    `RESULT: ${
      mismatched === 0 && swapOk
        ? "ALL SAMPLED BODY PIXELS MATCH AURA'S EFFECTIVE (INVERT-AWARE) COLOR SEMANTICS"
        : `${mismatched} MISMATCH(ES)${swapOk ? "" : " + WRONG OPTIONS PALETTE"} — investigate`
    }`,
  );
  return lines.join("\n");
}

export function InvertDebugProbe({ invertScale }: { invertScale: boolean }) {
  const api = useChartApi();
  const [report, setReport] = useState<string | null>(null);

  useEffect(() => {
    if (!debugInvertEnabled()) return;
    let cancelled = false;
    const timers: number[] = [];
    const dump = (delayMs: number): void => {
      const id = window.setTimeout(() => {
        if (cancelled) return;
        try {
          const text = buildReport(api, invertScale);
          // eslint-disable-next-line no-console
          console.info(text);
          setReport(text);
        } catch (e) {
          setReport(`[INVERT-DEBUG] probe error: ${String(e)}`);
        }
      }, delayMs);
      timers.push(id);
    };
    const offData = api.controller.bus.on("data", () => dump(1200));
    dump(60); // immediate post-toggle view (geometry applies before data events)
    dump(6000); // settle fallback in case no data event fires while sampling
    return () => {
      cancelled = true;
      offData();
      for (const id of timers) window.clearTimeout(id);
    };
  }, [api, invertScale]);

  if (!debugInvertEnabled() || !report) return null;
  return (
    <pre
      aria-label="Invert Scale debug report"
      style={{
        position: "absolute",
        left: 8,
        bottom: 8,
        zIndex: 50,
        maxWidth: "78vw",
        maxHeight: "46vh",
        overflow: "auto",
        margin: 0,
        padding: "8px 10px",
        fontSize: 11,
        lineHeight: 1.35,
        background: "rgba(4,10,16,0.92)",
        color: "#c9f7ff",
        border: "1px solid #2b4a5a",
        borderRadius: 6,
        fontFamily: "ui-monospace, Consolas, monospace",
        whiteSpace: "pre",
      }}
    >
      {report}
    </pre>
  );
}



