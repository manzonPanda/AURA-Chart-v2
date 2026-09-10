/**
 * Time-scale right-side future-space contract tests (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * Pins the TradingView-style behavior: the latest REAL candle must keep a
 * positive `rightOffset` of empty/future time to its right, the X axis must
 * continue rendering labels into that area, and realtime rollovers must NOT
 * erode the offset one bar at a time.
 *
 * The erosion mechanism is inside Lightweight Charts: when
 * `shiftVisibleRangeOnNewBar` is false (CandleKit's base default, chosen so
 * replay setData never auto-scrolls), LWC compensates each appended bar by
 * DECREMENTING the right offset (TimeScale._internal_update →
 * compensationShift). TradingChart.tsx therefore overrides it back to LWC's
 * native default `true` so the time scale advances with the last bar while
 * preserving the fixed right offset.
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
    /shiftVisibleRangeOnNewBar:\s*true/,
    "LWC must advance the time scale with the last bar instead of eating the right offset per rollover",
  );
});

test("TradingChart never calls fitContent() at runtime (would zero the right offset)", () => {
  const code = stripComments(readSrc("src/components/TradingChart/TradingChart.tsx"));
  assert.ok(
    !code.includes(".fitContent()") && !code.includes("fitContent();"),
    "fitContent() must never be invoked — it would collapse the future space",
  );
});

test("TradingChart allows the shift when an update replaces whitespace slots", () => {
  // LWC gate (lightweight-charts 5.2.1, ChartModel._internal_updateTimeScale):
  //   needShift = isLastSeriesBarVisible
  //     && (!replacedExistingWhitespace || allowShiftVisibleRangeOnWhitespaceReplacement)
  //     && shiftVisibleRangeOnNewBar;
  // WhitespaceBridge's trailing-slot setData() on every live rollover IS a
  // whitespace-replacing update (firstChangedPointIndex === undefined), so
  // without this native option LWC suppresses the shift and eats one bar of
  // right offset per new candle. Must stay `true` in live mode.
  const code = stripComments(readSrc("src/components/TradingChart/TradingChart.tsx"));
  assert.match(
    code,
    /allowShiftVisibleRangeOnWhitespaceReplacement:\s*true/,
    "trailing-slot setData() replaces whitespace each rollover — LWC must still shift or the right offset decays 1 bar/candle",
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