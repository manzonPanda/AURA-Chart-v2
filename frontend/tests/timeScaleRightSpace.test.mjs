/**
 * Time-scale right-side future-space contract tests (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * Pins the no-auto-follow contract: the latest REAL candle keeps a positive
 * `rightOffset` of future time to its right, the X axis renders labels into
 * that area, and — critically — the chart NEVER slides right on its own.
 * Auto-follow was removed by request: `shiftVisibleRangeOnNewBar` stays
 * `false` (as in CandleKit's base options, chosen so replay setData never
 * auto-scrolls) so LWC never advances the time scale with appended bars, and
 * the whitespace-replacement refresh is also prevented from nudging the
 * viewport. The user's position always wins; the "Scroll to latest" button is
 * the only way back to the live edge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read a project source file relative to frontend/. */
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");

/** Strip block + line comments so guards evaluate CODE only. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("TradingChart timeScale keeps a positive rightOffset (future space)", () => {
  const code = stripComments(readSrc("src/components/TradingChart/TradingChart.tsx"));
  assert.match(
    code,
    /rightOffset:\s*[1-9]\d*/,
    "timeScale must reserve a positive number of empty bars after the latest candle",
  );
});

test("TradingChart re-enables shiftVisibleRangeOnNewBar so rollovers preserve the right offset", () => {
  const code = stripComments(readSrc("src/components/TradingChart/TradingChart.tsx"));
  assert.match(
    code,
    /shiftVisibleRangeOnNewBar:\s*false/,
    "Auto-follow removed: LWC must never advance the time scale with appended bars (the viewport stays where the user put it)",
  );
});

test("TradingChart never calls fitContent() at runtime (would zero the right offset)", () => {
  const code = stripComments(readSrc("src/components/TradingChart/TradingChart.tsx"));
  assert.ok(
    !code.includes(".fitContent()") && !code.includes("fitContent();"),
    "fitContent() must never be invoked — it would collapse the future space",
  );
});

test("TradingChart keeps the whitespace-replacement shift disabled (auto-follow removed)", () => {
  // LWC gate (lightweight-charts 5.2.1, ChartModel._internal_updateTimeScale):
  //   needShift = isLastSeriesBarVisible
  //     && (!replacedExistingWhitespace || allowShiftVisibleRangeOnWhitespaceReplacement)
  //     && shiftVisibleRangeOnNewBar;
  // WhitespaceBridge's trailing-slot setData() on every live rollover IS a
  // whitespace-replacing update; keeping this native option disabled means
  // even that refresh never nudges the viewport right — the user's position
  // always wins.
  const code = stripComments(readSrc("src/components/TradingChart/TradingChart.tsx"));
  assert.match(
    code,
    /allowShiftVisibleRangeOnWhitespaceReplacement:\s*false/,
    "whitespace-slot refreshes must not re-enable auto-follow motion",
  );
});

test("CandleKit base options force shiftVisibleRangeOnNewBar=false (why the override exists)", () => {
  // The installed CandleKit bundle's baseOptions() — the value TradingChart
  // must override. Tolerant scan: any readable dist chunk may hold it.
  const candidates = [
    "node_modules/@getcandlekit/charts/dist/chunk-PF26Q4NQ.js",
    "node_modules/@getcandlekit/charts/dist/index.js",
  ];
  const src = candidates.map(readSrc).join("\n");
  assert.match(
    src,
    /shiftVisibleRangeOnNewBar:\s*false/,
    "CandleKit base must disable the shift so TradingChart's override is meaningful",
  );
});