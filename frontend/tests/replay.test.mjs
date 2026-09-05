/**
 * Unit + integration tests for the Candle Replay feature.
 *
 * Two layers are covered:
 *  1. The pure AURA core (services/replay.ts): the in-memory day source,
 *     manifest builder, engine option sizing and the cursor binary search.
 *  2. The REAL CandleKit ReplayController driven through the exact wiring
 *     TradingChart uses (subscribe → getBarsUpToCursor → chartApi.setData),
 *     against a recording fake of the ChartController. This is the official
 *     examples/replay pattern: one uniform setData paint path for entry,
 *     forward playback, backward steps and seeks.
 *
 * Runs with Node's type stripping:  npm --prefix frontend run test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createReplayController, dateOf } from "@getcandlekit/charts";

import {
  REPLAY_SYMBOL,
  buildReplayManifest,
  createMemoryReplaySource,
  partitionDates,
  barsOnDate,
  findReplayIndex,
  replayEngineOptions,
} from "../src/services/replay.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeBars(count, startMs = 1_700_000_000_000) {
  return Array.from({ length: count }, (_, i) => ({
    ts: startMs + i * 60_000,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 100 + i,
    volume: 1000 + i,
  }));
}

/** Deep snapshot (for immutability assertions). */
function snapshot(arr) {
  return arr.map((b) => ({ ...b }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Recording fake of the slice of ChartViewApi the replay paint loop uses. */
function makeFakeChartApi() {
  const calls = [];
  return {
    calls,
    controller: {
      setData(bars) {
        calls.push({ bars, length: bars.length });
      },
    },
  };
}

/**
 * EXACT mirror of TradingChart's session effect (the CandleKit examples/replay
 * pattern): subscribe once, on every ready state paint getBarsUpToCursor()
 * via chartApi.controller.setData, then load the manifest. Returns the fake
 * api so tests can assert the single-painter invariant.
 */
function wireReplayLikeTradingChart(manifest, dates, { speed } = {}) {
  const api = makeFakeChartApi();
  const rc = createReplayController(replayEngineOptions(dates));
  const unsub = rc.subscribe((s) => {
    if (s.status !== "ready") return;
    api.controller.setData(rc.getBarsUpToCursor(REPLAY_SYMBOL, manifest.series[0].interval));
  });
  const loadPromise = rc.load(manifest);
  return loadPromise.then(() => {
    if (speed != null) rc.setSpeed(speed);
    return { rc, api, unsub };
  });
}

// ── Pure core: day partition + in-memory source ───────────────────────────────

test("partitionDates returns ascending distinct UTC dates from bars", () => {
  const bars = makeBars(50);
  const dates = partitionDates(bars);
  assert.equal(dates.length, 1);
  assert.equal(dates[0], dateOf(bars[0].ts));
});

test("partitionDates handles multiple days", () => {
  const bars = Array.from({ length: 96 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 15 * 60_000,
    open: 100, high: 105, low: 95, close: 100,
  }));
  const dates = partitionDates(bars);
  assert.ok(dates.length >= 2);
  assert.deepEqual(dates, [...new Set(dates)].sort());
});

test("barsOnDate returns only bars on that date, sorted ascending", () => {
  const bars = Array.from({ length: 96 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 15 * 60_000,
    open: 100, high: 105, low: 95, close: 100,
  }));
  const dates = partitionDates(bars);
  const day0 = barsOnDate(bars, dates[0]);
  assert.ok(day0.length > 0);
  for (const b of day0) assert.equal(dateOf(b.ts), dates[0]);
  for (let i = 1; i < day0.length; i++) assert.ok(day0[i].ts >= day0[i - 1].ts);
  assert.equal(bars.length, 96);
});

test("createMemoryReplaySource resolves everything from memory", async () => {
  const bars = makeBars(20);
  const { source, dates } = createMemoryReplaySource(bars);
  assert.equal(dates.length, 1);
  const fetched = await source.fetchDay(REPLAY_SYMBOL, "1m", dates[0]);
  assert.equal(fetched.length, 20);
  for (const fb of fetched) assert.ok(bars.some((b) => b.ts === fb.ts));
  assert.deepEqual(await source.listDatesBefore(REPLAY_SYMBOL, "1m", dates[0], 3), []);
  assert.deepEqual(await source.listDatesAfter(REPLAY_SYMBOL, "1m", dates[0], 3), []);
});

test("listDatesBefore/listDatesAfter walk neighbouring days correctly", async () => {
  const bars = Array.from({ length: 192 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 15 * 60_000,
    open: 100, high: 105, low: 95, close: 100,
  }));
  const { source, dates } = createMemoryReplaySource(bars);
  assert.ok(dates.length >= 2);
  const mid = dates[1];
  const before = await source.listDatesBefore(REPLAY_SYMBOL, "1m", mid, 2);
  assert.equal(before.length, Math.min(2, dates.indexOf(mid)));
  assert.equal(before[0], dates[0]); // nearest-first ordering
  const after = await source.listDatesAfter(REPLAY_SYMBOL, "1m", mid, 2);
  const idx = dates.indexOf(mid);
  assert.equal(after.length, Math.min(2, dates.length - idx - 1));
  assert.equal(after[0], dates[idx + 1]);
});

test("replayEngineOptions sizes cache so no loaded day can be LRU-evicted", () => {
  const bars = Array.from({ length: 192 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 15 * 60_000,
    open: 100, high: 105, low: 95, close: 100,
  }));
  const dates = partitionDates(bars);
  const opts = replayEngineOptions(dates);
  assert.ok(opts.cacheDays >= dates.length + 2);
  assert.equal(opts.prefetchBackwardDays, dates.length);
  assert.equal(opts.prefetchForwardOnTailPct, 0);
});

test("REPLAY_SYMBOL is the opaque engine cache key", () => {
  assert.equal(REPLAY_SYMBOL, "aura");
});

test("findReplayIndex finds the bar at-or-before cursorTs", () => {
  const bars = makeBars(10);
  assert.equal(findReplayIndex(bars, bars[3].ts), 3);
});

test("findReplayIndex: -1 before dataset, floor between bars, last after dataset", () => {
  const bars = makeBars(10);
  assert.equal(findReplayIndex(bars, bars[0].ts - 1), -1);
  assert.equal(findReplayIndex(bars, bars[3].ts + 30_000), 3);
  assert.equal(findReplayIndex(bars, bars[9].ts + 9999), 9);
});

test("buildReplayManifest wraps the loaded dataset (start/end/source)", () => {
  const bars = makeBars(30);
  const startTs = bars[10].ts;
  const { manifest, dates } = buildReplayManifest({
    id: "t", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs,
  });
  assert.equal(manifest.id, "t");
  assert.equal(manifest.start, startTs);
  assert.equal(manifest.end, bars[bars.length - 1].ts);
  assert.deepEqual(manifest.series, [{ symbol: REPLAY_SYMBOL, interval: "1m" }]);
  assert.equal(typeof manifest.source.fetchDay, "function");
  assert.ok(dates.length > 0);
});

test("buildReplayManifest end falls back to startTs when nothing is after it", () => {
  const bars = makeBars(5);
  const { manifest } = buildReplayManifest({
    id: "e", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[4].ts,
  });
  assert.equal(manifest.end, bars[4].ts);
});

// ── Flow contract: the exact TradingChart wiring (examples/replay pattern) ────

test("flow: entry paints ONLY bars up to the cursor (future hidden)", async () => {
  const bars = makeBars(30);
  const original = snapshot(bars);
  const { manifest, dates } = buildReplayManifest({
    id: "f-entry", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[10].ts,
  });
  const { rc, api, unsub } = await wireReplayLikeTradingChart(manifest, dates);
  assert.equal(api.calls.length, 1, "exactly one paint after load");
  assert.equal(api.calls[0].length, 11); // bars[0..10]
  assert.equal(api.calls[0].bars[10].ts, bars[10].ts);
  assert.deepEqual(bars, original);
  unsub();
  rc.unload();
});

test("flow: play grows the paint per tick; pause stops it", async () => {
  const bars = makeBars(20);
  const { manifest, dates } = buildReplayManifest({
    id: "f-play", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[5].ts,
  });
  const { rc, api, unsub } = await wireReplayLikeTradingChart(manifest, dates, { speed: 8 });
  rc.play();
  await wait(1200);
  rc.pause();
  const afterPlay = api.calls.length;
  assert.ok(afterPlay >= 3, `expected several paints, got ${afterPlay}`);
  const lastPaint = api.calls[afterPlay - 1];
  assert.ok(lastPaint.length > 6, "playback advanced the visible slice");
  assert.equal(lastPaint.bars[lastPaint.length - 1].ts, rc.getState().cursor.ts);
  await wait(300);
  assert.equal(api.calls.length, afterPlay, "paused ⇒ no further paints");
  // Single-painter invariant: every paint is an EXACT PREFIX of the dataset —
  // the chart never shows anything but candles[0..cursor].
  for (const c of api.calls) {
    for (let i = 0; i < c.bars.length; i++) {
      assert.equal(c.bars[i].ts, bars[i].ts);
    }
  }
  unsub();
  rc.unload();
});

test("flow: backward step SHRINKS the paint (setData removes candles)", async () => {
  const bars = makeBars(20);
  const { manifest, dates } = buildReplayManifest({
    id: "f-back", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[5].ts,
  });
  const { rc, api, unsub } = await wireReplayLikeTradingChart(manifest, dates);
  assert.equal(api.calls[0].length, 6);
  rc.step(1);
  assert.equal(api.calls.at(-1).length, 7);
  rc.step(-1);
  assert.equal(api.calls.at(-1).length, 6, "setData repainted the shorter slice");
  rc.step(-1);
  assert.equal(api.calls.at(-1).length, 5);
  unsub();
  rc.unload();
});

test("flow: seek backward shrinks; seek forward repaints the skipped bars", async () => {
  const bars = makeBars(30);
  const { manifest, dates } = buildReplayManifest({
    id: "f-seek", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[10].ts,
  });
  const { rc, api, unsub } = await wireReplayLikeTradingChart(manifest, dates);
  assert.equal(api.calls.at(-1).length, 11);
  rc.seek(bars[4].ts);
  await wait(100); // seek() resolves after ensureDayCached
  assert.equal(api.calls.at(-1).length, 5);
  rc.seek(bars[20].ts);
  await wait(100);
  assert.equal(api.calls.at(-1).length, 21, "forward seek repaints the whole skipped span");
  unsub();
  rc.unload();
});

test("flow: end-of-data auto-pauses and stops scheduling", async () => {
  const bars = makeBars(5);
  const { manifest, dates } = buildReplayManifest({
    id: "f-eod", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[2].ts,
  });
  const { rc, api, unsub } = await wireReplayLikeTradingChart(manifest, dates, { speed: 8 });
  rc.play();
  await wait(2500);
  assert.equal(rc.getState().playing, false, "auto-paused at the last bar");
  assert.equal(api.calls.at(-1).length, 5);
  assert.equal(rc.getState().cursor.ts, bars[4].ts);
  const n = api.calls.length;
  await wait(300);
  assert.equal(api.calls.length, n, "no paints after end-of-data");
  unsub();
  rc.unload();
});

test("flow: repeated play/pause toggles never duplicate the paint loop", async () => {
  const bars = makeBars(20);
  const { manifest, dates } = buildReplayManifest({
    id: "f-toggle", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[5].ts,
  });
  const { rc, api, unsub } = await wireReplayLikeTradingChart(manifest, dates, { speed: 2 });
  for (let i = 0; i < 5; i++) {
    rc.play();
    rc.pause();
  }
  assert.equal(rc.getState().playing, false);
  await wait(300);
  const n = api.calls.length;
  await wait(300);
  assert.equal(api.calls.length, n, "no ticking after final pause");
  unsub();
  rc.unload();
});

test("flow: exit (unsub + unload) leaves the source untouched for restore", async () => {
  const bars = makeBars(30);
  const original = snapshot(bars);
  const { manifest, dates } = buildReplayManifest({
    id: "f-exit", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[10].ts,
  });
  const { rc, api, unsub } = await wireReplayLikeTradingChart(manifest, dates, { speed: 8 });
  rc.play();
  await wait(1500);
  rc.pause();
  unsub();
  rc.unload();
  assert.equal(rc.getState().status, "idle");
  assert.deepEqual(bars, original, "source dataset never mutated");
  assert.ok(api.calls.at(-1).length > 11, "session had progressed before exit");
});

// ── Engine behavior the UI relies on ──────────────────────────────────────────

test("speed is applied after load and clamped by the engine", async () => {
  const bars = makeBars(10);
  const { manifest, dates } = buildReplayManifest({
    id: "speed", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[2].ts,
  });
  const rc = createReplayController(replayEngineOptions(dates));
  await rc.load(manifest);
  rc.setSpeed(4);
  assert.equal(rc.getState().speed, 4);
  rc.setSpeed(1000); // above max → clamped, no crash
  assert.ok(rc.getState().speed <= 64);
  rc.setSpeed(0.001); // below min → clamped, no crash
  assert.ok(rc.getState().speed >= 0.1);
  rc.unload();
});

test("ensureSeries supports multi-timeframe replay", async () => {
  const bars = makeBars(15);
  const { manifest, dates } = buildReplayManifest({
    id: "multi", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[5].ts,
  });
  const rc = createReplayController(replayEngineOptions(dates));
  await rc.load(manifest);
  await rc.ensureSeries(REPLAY_SYMBOL, "5m");
  assert.equal(rc.getState().status, "ready");
  rc.unload();
});

test("onBar fires per forward step with the revealed bar", async () => {
  const bars = makeBars(20);
  const { manifest, dates } = buildReplayManifest({
    id: "onbar", symbol: REPLAY_SYMBOL, interval: "1m", bars, startTs: bars[5].ts,
  });
  const rc = createReplayController(replayEngineOptions(dates));
  await rc.load(manifest);
  const events = [];
  const off = rc.onBar((e) => events.push(e));
  rc.step(1);
  assert.equal(events.length, 1);
  assert.equal(events[0].bar.ts, bars[6].ts);
  assert.equal(events[0].symbol, REPLAY_SYMBOL);
  assert.equal(events[0].interval, "1m");
  off();
  rc.unload();
});



