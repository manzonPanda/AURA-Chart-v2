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

/** Fractal line drawings (pane + overlay) sorted by x1. */
export function fractalLines(run) {
  const vis = run?.visuals.find((v) => v.type === "lines");
  return [...(vis?.lines ?? []), ...(vis?.overlayLines ?? [])].sort((a, b) => a.logical1 - b.logical1);
}

/** The UP level at 110 (pivot index 10) — the line under test. */
export function fractalUp110(lines) {
  return lines.find((l) => l.logical1 === 10 && l.price1 === 110);
}