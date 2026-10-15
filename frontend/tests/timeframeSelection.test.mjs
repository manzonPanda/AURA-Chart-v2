/**
 * TIMEFRAME SELECTION — persistence across refresh, live-edge viewport
 * preservation, and scope consistency while a switch is in flight.
 *
 * Two SEPARATE defects are pinned here (they are NOT one bug):
 *
 *  1. REFRESH PERSISTENCE. The selected timeframe was plain React state seeded
 *     from `DEFAULT_TIME_FRAME` and written nowhere, so every refresh fell back
 *     to 3m — for EVERY timeframe, not just 5m. The fix is a dedicated
 *     `aura.timeframe.v1` key (deliberately NOT a ChartSettings field, so
 *     applying a chart template can never change the timeframe).
 *
 *  2. VIEWPORT. Nothing captured the visible range on a timeframe switch, so
 *     replacing the series left the viewport to LWC and it drifted off the
 *     current market position. The fix captures the PRE-switch state and asks
 *     for a ONE-SHOT live-edge re-anchor — never continuous auto-follow.
 *
 * Plus the mid-switch data hazard: `resolution` flips one render before the
 * matching history resolves, so re-aligning the previous timeframe's bars onto
 * the incoming grid fabricated duplicate timestamps (3m → 0,180,360 floored onto
 * the 5m grid gives 0,0,300,300,…).
 *
 * Conventions: node:test + node:assert/strict, pure modules imported directly,
 * and static source-contract assertions for the React wiring (same style as
 * realtimeClosedContract.test.mjs / chartContextMenu.test.mjs).
 *
 * Run: npm --prefix frontend run test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_TIME_FRAME,
  TIMEFRAMES,
  TIMEFRAME_STORAGE_KEY,
  sanitizeTimeFrame,
} from "../src/config/chart.ts";
import { loadTimeFrame, saveTimeFrame } from "../src/services/timeframeSelection.ts";
import {
  isSameHistoryScope,
  planScopeChangeAnchor,
  isAtLatestEdge,
} from "../src/services/historyPagination.ts";
import { alignToBucketStart } from "../src/services/realtimeCore.ts";

/** In-memory Storage double — same shape as the existing tests' helper. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    _map: map,
  };
}

/** Storage that throws on every access (private mode / disabled storage). */
const throwingStorage = {
  getItem() {
    throw new Error("storage disabled");
  },
  setItem() {
    throw new Error("storage disabled");
  },
};

const SRC = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const appSrc = SRC("../src/App.tsx");
const chartSrc = SRC("../src/components/TradingChart/TradingChart.tsx");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

test("key: the timeframe key is its own localStorage key, not a ChartSettings field", () => {
  assert.equal(TIMEFRAME_STORAGE_KEY, "aura.timeframe.v1");
  // The template-coupling hazard the dedicated key avoids.
  const settingsSrc = strip(SRC("../src/config/chartSettings.ts"));
  assert.ok(
    !/historyBucketSec|\btimeframe\b/i.test(settingsSrc),
    "chartSettings.ts must not gain a timeframe field (templates snapshot it wholesale)",
  );
});

test("sanitizer: every registered timeframe is accepted verbatim", () => {
  for (const tf of TIMEFRAMES) {
    assert.equal(sanitizeTimeFrame(tf.key), tf.key, `${tf.key} round-trips`);
  }
  assert.equal(sanitizeTimeFrame("MINUTE_1"), "MINUTE_1");
  assert.equal(sanitizeTimeFrame("MINUTE_3"), "MINUTE_3");
  assert.equal(sanitizeTimeFrame("MINUTE_5"), "MINUTE_5");
});

test("sanitizer: missing/invalid/unknown values fall back to the default", () => {
  const fallback = DEFAULT_TIME_FRAME;
  for (const bad of [
    null,
    undefined,
    "",
    "   ",
    "MINUTE_9",
    "minute_5",
    "5m",
    5,
    true,
    {},
    ["MINUTE_5"],
  ]) {
    assert.equal(sanitizeTimeFrame(bad), fallback, `${JSON.stringify(bad)} → default`);
  }
});

test("load: a missing value falls back to the default", () => {
  assert.equal(loadTimeFrame(memoryStorage()), DEFAULT_TIME_FRAME);
});

test("load: valid 1m, 3m and 5m values are all restored", () => {
  for (const key of ["MINUTE_1", "MINUTE_3", "MINUTE_5"]) {
    const storage = memoryStorage({ [TIMEFRAME_STORAGE_KEY]: key });
    assert.equal(loadTimeFrame(storage), key, `${key} survives a refresh`);
  }
});

test("load: a corrupted stored value falls back safely instead of throwing", () => {
  const storage = memoryStorage({ [TIMEFRAME_STORAGE_KEY]: "MINUTE_42" });
  assert.equal(loadTimeFrame(storage), DEFAULT_TIME_FRAME);
});

test("load: a read failure never crashes — the default applies", () => {
  assert.equal(loadTimeFrame(throwingStorage), DEFAULT_TIME_FRAME);
});

test("save: the selected timeframe is written and is then restored", () => {
  // 1. Select 5m. 2. Refresh. 3. The chart restores 5m.
  const storage = memoryStorage();
  saveTimeFrame("MINUTE_5", storage);
  assert.equal(storage.getItem(TIMEFRAME_STORAGE_KEY), "MINUTE_5");
  assert.equal(loadTimeFrame(storage), "MINUTE_5", "a refresh restores MINUTE_5");
});

test("save: 1m and 3m persist too (the fix is not 5m-specific)", () => {
  for (const key of ["MINUTE_1", "MINUTE_3"]) {
    const storage = memoryStorage();
    saveTimeFrame(key, storage);
    assert.equal(loadTimeFrame(storage), key);
  }
});

test("save: a write failure never crashes — the selection stays session-only", () => {
  assert.doesNotThrow(() => saveTimeFrame("MINUTE_5", throwingStorage));
});

test("save: an unsupported value is never persisted verbatim", () => {
  const storage = memoryStorage();
  saveTimeFrame("MINUTE_99", storage); // untyped caller
  assert.equal(storage.getItem(TIMEFRAME_STORAGE_KEY), DEFAULT_TIME_FRAME);
});

test("App: state is seeded by a lazy initializer and every change persists", () => {
  const app = strip(appSrc);
  // Lazy initializer: the stored pick is in effect for the FIRST history load
  // and the first WS `res=` — a hydration effect would double-fetch.
  assert.match(app, /useState<TimeFrameKey>\(loadTimeFrame\)/);
  // Not the old hardcoded seed that caused the refresh fallback.
  assert.ok(
    !/useState<TimeFrameKey>\(DEFAULT_TIME_FRAME\)/.test(app),
    "the timeframe must no longer be seeded from the bare default",
  );
  // The selector click both persists and sets state.
  assert.match(
    app,
    /const selectTimeframe = useCallback[\s\S]*?saveTimeFrame\(key\);[\s\S]*?setTimeframe\(key\);/,
  );
  assert.match(app, /onClick=\{\(\) => selectTimeframe\(tf\.key\)\}/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. VIEWPORT — live-edge anchoring
// ═══════════════════════════════════════════════════════════════════════════════

const LATEST_SEC = Date.UTC(2026, 8, 1, 12, 0) / 1000; // 12:00:00Z
const atEdge = (from, to) => ({ from: from ?? LATEST_SEC - 3600, to: to ?? LATEST_SEC });
const scrolledBack = () => ({ from: LATEST_SEC - 86400, to: LATEST_SEC - 3600 });

test("viewport: a switch made at the live edge requests a one-time re-anchor", () => {
  assert.equal(
    planScopeChangeAnchor({
      previousBucketSec: 180,
      nextBucketSec: 300,
      range: atEdge(),
      latestSec: LATEST_SEC,
    }),
    true,
  );
  // Tolerated: the right edge may sit within one forming bucket of the last close.
  assert.equal(
    planScopeChangeAnchor({
      previousBucketSec: 180,
      nextBucketSec: 300,
      range: atEdge(LATEST_SEC - 7200, LATEST_SEC - 180),
      latestSec: LATEST_SEC,
    }),
    true,
  );
});

test("viewport: a switch made after scrolling back does NOT force a re-anchor", () => {
  assert.equal(
    planScopeChangeAnchor({
      previousBucketSec: 180,
      nextBucketSec: 300,
      range: scrolledBack(),
      latestSec: LATEST_SEC,
    }),
    false,
    "a user reading history is never yanked to the live edge",
  );
});

test("viewport: an unchanged bucket width is not a scope change", () => {
  // Ordinary data updates (refresh, Load More, an epic re-resolving to the same
  // bucket) must never raise a re-anchor.
  assert.equal(
    planScopeChangeAnchor({
      previousBucketSec: 180,
      nextBucketSec: 180,
      range: atEdge(),
      latestSec: LATEST_SEC,
    }),
    false,
  );
});

test("viewport: no usable data never re-anchors", () => {
  for (const latestSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      planScopeChangeAnchor({
        previousBucketSec: 180,
        nextBucketSec: 300,
        range: atEdge(),
        latestSec,
      }),
      false,
    );
  }
});

test("viewport: the decision stays correct across the 1m/3m/5m pairs", () => {
  for (const [from, to] of [
    [60, 180],
    [180, 60],
    [180, 300],
    [300, 180],
    [60, 300],
  ]) {
    assert.equal(
      planScopeChangeAnchor({
        previousBucketSec: from,
        nextBucketSec: to,
        range: atEdge(),
        latestSec: LATEST_SEC,
      }),
      true,
      `${from}s→${to}s at the edge re-anchors`,
    );
    assert.equal(
      planScopeChangeAnchor({
        previousBucketSec: from,
        nextBucketSec: to,
        range: scrolledBack(),
        latestSec: LATEST_SEC,
      }),
      false,
      `${from}s→${to}s scrolled back does not`,
    );
  }
});

test("viewport: the anchor is timestamp-based, never a logical bar index", () => {
  // Two non-nesting grids: the same wall-clock instant is a different logical
  // index on each, so an index-based restore could not be correct.
  assert.notEqual(Math.floor(LATEST_SEC / 180), Math.floor(LATEST_SEC / 300));
  // The plan reads the range's epoch seconds, exactly like isAtLatestEdge.
  assert.equal(isAtLatestEdge(atEdge(), LATEST_SEC, 180), true);
  assert.equal(isAtLatestEdge(scrolledBack(), LATEST_SEC, 180), false);
});

test("viewport: the pre-switch state is captured before the new dataset is applied", () => {
  const chart = strip(chartSrc);
  // Capture is driven by the bucket-width change and reads the PREVIOUS width.
  assert.match(chart, /prevBucketSecRef\.current;[\s\S]{0,80}?if \(previousBucketSec === bucketSec\) return;/);
  assert.match(
    chart,
    /planScopeChangeAnchor\(\{[\s\S]*?previousBucketSec,[\s\S]*?nextBucketSec: bucketSec,[\s\S]*?range,[\s\S]*?latestSec,/,
  );
});

test("viewport: the re-anchor is consumed exactly once on the new dataset", () => {
  const chart = strip(chartSrc);
  // Cleared BEFORE the call → the action can never repeat.
  assert.match(
    chart,
    /if \(pendingLiveEdgeAnchorRef\?\.current\) \{\s*pendingLiveEdgeAnchorRef\.current = false;[\s\S]*?ts\.scrollToRealTime\(\);[\s\S]*?return;/,
  );
  // It rides the bus-"data" repaint, which only a full setData emits — live
  // ticks/rollovers repaint through updateBar and can never trigger it.
  assert.match(chart, /controller\.bus\.on\("data", applyViewportAfterData\)/);
  // Continuous auto-follow stays removed.
  assert.ok(!/shiftVisibleRangeOnNewBar: true/.test(chart), "no auto-follow re-enabled");
});

test("viewport: Load More History keeps its own exact-window restore", () => {
  const chart = strip(chartSrc);
  // Unchanged path: capture on click, replay the captured range on the prepend.
  assert.match(chart, /const range = chart\?\.timeScale\(\)\.getVisibleRange\(\) \?\? null;/);
  assert.match(chart, /if \(range\) preserveRangeRef\.current = \{ from: range\.from, to: range\.to \};/);
  assert.match(chart, /ts\.setVisibleRange\(captured\);/);
  // The two paths are mutually exclusive: the re-anchor returns before the
  // prepend branch, so a switch can never consume a Load More capture.
  const fn = chart.slice(chart.indexOf("const applyViewportAfterData"));
  assert.ok(
    fn.indexOf("scrollToRealTime") < fn.indexOf("setVisibleRange(captured)"),
    "the re-anchor is evaluated (and returns) before the prepend branch",
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SCOPE CONSISTENCY during the switch
// ═══════════════════════════════════════════════════════════════════════════════

test("scope: a matching grid is in scope; a mismatched grid is not", () => {
  assert.equal(isSameHistoryScope(180, 180), true);
  assert.equal(isSameHistoryScope(300, 300), true);
  assert.equal(isSameHistoryScope(180, 300), false, "3m data under an active 5m");
  assert.equal(isSameHistoryScope(300, 180), false);
  // Untagged (no historyBucketSec prop) keeps the historic behavior.
  assert.equal(isSameHistoryScope(undefined, 180), true);
});

test("scope: the hazard the guard prevents — cross-grid re-alignment duplicates timestamps", () => {
  // Six 3m bars across a 900 s window (lcm of the 180 s and 300 s grids).
  const threeMin = [0, 180, 360, 540, 720, 900].map((s) => s * 1000);
  // Re-aligning them onto the incoming 5m grid collides pairs of bars.
  const misAligned = threeMin.map((ts) => alignToBucketStart(ts, 300));
  assert.deepEqual(misAligned, [0, 0, 300_000, 300_000, 600_000, 900_000], "ms grid");
  assert.equal(
    new Set(misAligned).size < misAligned.length,
    true,
    "duplicate timestamps would be emitted",
  );
  // Left alone (the guard) the dataset is already unique and untouched.
  assert.equal(new Set(threeMin).size, threeMin.length);
  for (const ts of threeMin) assert.equal(alignToBucketStart(ts, 180), ts, "no re-gridding");
});

test("scope: the guard gates BOTH REST-derived series", () => {
  const chart = strip(chartSrc);
  // The display series and the Pine/EMA/SMA bridge series are both frozen, so
  // no mixed-scope row reaches setData and the indicators never see bad input.
  const frozen = chart.match(/if \(!historyScopeCurrent\) return frozen\w+\.current \?\? liveCandles;/g) ?? [];
  assert.equal(frozen.length, 2, "data + bridgeBars are both guarded");
  // Both memos re-arm the freeze from their scope-consistent result.
  assert.equal((chart.match(/frozen\w+\.current = (merged|bridged);/g) ?? []).length, 2);
  // The guard must be DERIVED from the pure helper against the real prop — a
  // hardcoded `true` would satisfy the checks above while silently doing nothing.
  assert.match(
    chart,
    /const historyScopeCurrent = isSameHistoryScope\(historyBucketSec, bucketSec\);/,
  );
});

test("scope: the new dataset becomes visible once its history resolves", () => {
  const app = strip(appSrc);
  // The grid tag and the dataset are committed in the same batch, so the freeze
  // lifts exactly when the matching bars arrive.
  assert.match(app, /setHistoryBucketSec\(resolutionToBucketSec\(timeframe\)\);\s*setCandles\(loaded\);/);
  assert.match(app, /historyBucketSec=\{historyBucketSec\}/);
  // The TIMEFRAME switch never empties the dataset (no empty-chart flash).
  // The only `setCandles([])` is the pre-existing INSTRUMENT switch, which is a
  // deliberate hard data boundary and unrelated to this fix.
  const selectFnBody = app.slice(app.indexOf("const selectTimeframe"), app.indexOf("const selectTimeframe") + 200);
  assert.ok(!/setCandles/.test(selectFnBody), "the timeframe switch never clears the dataset");
  const instrumentFn = app.slice(app.indexOf("const handleInstrumentChange"));
  assert.match(instrumentFn, /setCandles\(\[\]\);/, "the pre-existing instrument reset is unchanged");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SCOPE GUARDS — nothing else was coupled
// ═══════════════════════════════════════════════════════════════════════════════

test("scope: chart templates and EMA-alert timeframes are untouched", () => {
  const app = strip(appSrc);
  // Selecting a chart template must not change the selected timeframe. The
  // handler body is read up to its dependency-array terminator so the window
  // cannot bleed into the neighbouring chartSettings declarations.
  const start = app.indexOf("const selectTimeframe = useCallback");
  const terminator = app.indexOf("}, []);", start);
  const selectFn = app.slice(start, terminator);
  assert.ok(terminator > start, "the useCallback terminator is found");
  assert.ok(
    !/setChartSettings|handleApplyTemplate|template|emaAlert/i.test(selectFn),
    "timeframe selection touches no template or alert state",
  );
  assert.match(selectFn, /saveTimeFrame\(key\);/);
  assert.match(selectFn, /setTimeframe\(key\);/);
  // The EMA Alert toolbar control was removed — no alert wiring remains in App.
  assert.ok(!app.includes("<EmaAlertControl"), "EmaAlertControl must not be rendered");
  assert.ok(!app.includes("emaAlertSettings"), "no alert settings state in App");
});
