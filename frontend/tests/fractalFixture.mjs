import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FRACTAL_PINE_SOURCE = readFileSync(join(HERE, "..", "src", "components", "Indicators", "fractal.pine"), "utf8");

/** Bars for the deterministic fractal scenario: [high, low, close]. */
const START_TS = 1_704_153_600_000;
export function fractalScenarioBars(H, C) {
  return H.map((h, i) => {
    const c = C[i];
    return {
      ts: START_TS + i * 60_000,
      open: c - 0.5,
      high: h,
      low: Math.min(c - 1, h - 2),
      close: c,
      volume: 1000,
    };
  });
}

/**
 * Canonical UP-fractal tape (n=2): pivot at index 10, level high=110,
 * confirmation at index 12. Closes after the pivot default to 104..109
 * (never reaching 110) so the line must extend the full 5 bars: x1=10→x2=15.
 */
export const FRACTAL_HIGHS = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 109, 108, 107, 106, 105, 104, 103];
export const FRACTAL_CLOSES_NOBREAK = [99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 104, 105, 106, 107, 108, 109, 106];

/** Fractal line drawings (pane + overlay) sorted by x1.
 *
 * NOTE: `fractal.pine` now draws levels as `plot.style_linebr` SERIES with
 * `offset=-n`, NOT `line.new()` drawings, so a modern run carries NO `lines`
 * visual. Kept only for the still-valid generic drawing-extraction tests that
 * build their own hand-crafted `lines`; the fractal-script suites use the
 * series helpers below. */
export function fractalLines(run) {
  const vis = run?.visuals.find((v) => v.type === "lines");
  return [...(vis?.lines ?? []), ...(vis?.overlayLines ?? [])].sort((a, b) => a.logical1 - b.logical1);
}

/** The UP level at 110 (pivot index 10) — the line under test. */
export function fractalUp110(lines) {
  return lines.find((l) => l.logical1 === 10 && l.price1 === 110);
}

// ── plot.style_linebr SERIES helpers (the current fractal rendering model) ────
// A fractal level is a single linebr plot ("Up level 1" / "Down level 1"):
// finite rows carry the pivot's wick price on consecutive bars (offset=-n puts
// the FIRST finite row on the pivot candle); na bars are value-less WHITESPACE
// rows so the line breaks between one level's lifetime and the next.

/** The named linebr series from a run (null when the script didn't emit it). */
export function fractalSeries(run, key) {
  return run?.visuals.find((v) => v.type === "line" && v.key === key && v.breakOnNa) ?? null;
}

/** The UP resistance level series (level 1). */
export const fractalUpSeries = (run) => fractalSeries(run, "Up level 1");

/** The DOWN support level series (level 1). */
export const fractalDnSeries = (run) => fractalSeries(run, "Down level 1");

/** Finite (valued) rows of a series, each tagged with its candle index. */
export function finiteRows(series, bars) {
  return (series?.data ?? [])
    .filter((p) => typeof p.value === "number")
    .map((p) => ({ ...p, idx: bars.findIndex((b) => b.ts === p.ts) }));
}

/** Contiguous runs of finite rows (segments split by whitespace/na rows). */
export function finiteSegments(series) {
  const segs = [];
  let cur = [];
  for (const p of series?.data ?? []) {
    if (typeof p.value === "number") cur.push(p);
    else if (cur.length) {
      segs.push(cur);
      cur = [];
    }
  }
  if (cur.length) segs.push(cur);
  return segs;
}