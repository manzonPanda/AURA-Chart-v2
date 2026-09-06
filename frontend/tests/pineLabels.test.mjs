/**
 * Pine label.new() test suite — the first-class drawing primitive pipeline.
 *
 * Two layers:
 *   1. Pure adapter units (services/pineDrawings.ts) — anchor resolution,
 *      style/size/color normalization, xloc/yloc handling, geometry + color
 *      conversion. No DOM, no lightweight-charts.
 *   2. Engine integration (services/pineEngine.ts) — label.new / set_text /
 *      set_xy / delete through PineTS's drawing-object registry → "labels"
 *      PineVisual, plus replay-scope, Load-More-History re-anchoring and
 *      timeframe isolation.
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PineIndicatorEngine } from "../src/services/pineEngine.ts";
import {
  barIndexForTime,
  barIndexToTimeMs,
  extractLabelDrawings,
  labelLayout,
  LABEL_SIZE_PX,
  pineHexToRgba,
  resolveLabelPrice,
} from "../src/services/pineDrawings.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

function rng(seed = 1) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 100 - 50;
  };
}

function make1m(n, startTs = 1_704_153_600_000, seed = 7) {
  const r = rng(seed);
  let prevClose = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = prevClose + r();
    out.push({
      ts: startTs + i * 60_000,
      open: prevClose,
      high: Math.max(prevClose, c) + 1,
      low: Math.min(prevClose, c) - 1,
      close: c,
      volume: 1000 + i,
    });
    prevClose = c;
  }
  return out;
}

function make3m(n, startTs = 1_704_153_600_000, seed = 11) {
  const r = rng(seed);
  let prevClose = 50;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = prevClose + r();
    const c = o + r();
    out.push({
      ts: startTs + i * 180_000,
      open: o,
      high: Math.max(o, c) + 5,
      low: Math.min(o, c) - 5,
      close: c,
      volume: 800 + i,
    });
    prevClose = c;
  }
  return out;
}

/** Run a script and return the single "labels" visual (or null). */
async function runLabels(script, bars, live = null, bucketSec = 60, params = {}) {
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, live, bucketSec);
  const run = await eng.computeScriptVisuals({ id: "lbl-test", source: script, bindings: [] }, params);
  eng.dispose();
  if (run === null) throw new Error("computeScriptVisuals returned null");
  return run.visuals.find((v) => v.type === "labels") ?? null;
}

const LAST_BAR_LABEL = `//@version=6
indicator("lbl", overlay=true)
if barstate.islast
    label.new(bar_index, high, "X")`;
// ── Pure adapter units ──────────────────────────────────────────────────────

test("labels: barIndexToTimeMs maps in-series, future and past indexes", () => {
  const klines = [
    { openTime: 1704153600000, high: 10, low: 5 },
    { openTime: 1704153660000, high: 11, low: 6 },
    { openTime: 1704153720000, high: 12, low: 7 },
  ];
  assert.equal(barIndexToTimeMs(0, klines), 1704153600000);
  assert.equal(barIndexToTimeMs(2, klines), 1704153720000);
  // Future slots extrapolate with the bucket spacing (60s here).
  assert.equal(barIndexToTimeMs(3, klines), 1704153780000);
  assert.equal(barIndexToTimeMs(5, klines), 1704153900000);
  // Past slots interpolate backwards too.
  assert.equal(barIndexToTimeMs(-1, klines), 1704153540000);
  assert.equal(barIndexForTime(1704153700000, klines), 1, "at-or-before binary search");
  assert.equal(barIndexForTime(1704153000000, klines), -1, "before first bar");
});

test("labels: resolveLabelPrice honors price/abovebar/belowbar against the anchor bar", () => {
  const klines = [
    { openTime: 1704153600000, high: 100, low: 90 },
    { openTime: 1704153660000, high: 101, low: 89 },
  ];
  assert.equal(resolveLabelPrice("price", 42, 1, klines), 42);
  assert.equal(resolveLabelPrice("abovebar", 42, 1, klines), 101, "anchor bar high");
  assert.equal(resolveLabelPrice("belowbar", 42, 1, klines), 89, "anchor bar low");
  // Out-of-series anchor falls back to the passed y.
  assert.equal(resolveLabelPrice("abovebar", 42, 5, klines), 42);
});

test("labels: normalize defaults + unsupported xloc/yloc are reported, never mis-placed", () => {
  const klines = [{ openTime: 1704153600000, high: 10, low: 5 }];
  const ok = `[{"value":[{"id":1,"x":0,"y":10,"xloc":"bi","yloc":"pr","text":"t"}]}]`;
  const { labels } = extractLabelDrawings(JSON.parse(ok), klines);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].id, 1);
  assert.equal(labels[0].logical, 0);
  assert.equal(labels[0].price, 10);
  assert.equal(labels[0].style, "label_down", "Pine default style");
  assert.equal(labels[0].size, "normal", "Pine default size");
  assert.equal(labels[0].textalign, "center");

  const bad = `[{"value":[{"id":2,"x":0,"y":10,"xloc":"weird","yloc":"pr"}]}]`;
  const { labels: none, unsupported } = extractLabelDrawings(JSON.parse(bad), klines);
  assert.equal(none.length, 0, "unknown xloc must never render at a guessed place");
  assert.ok(unsupported.some((u) => u.kind.startsWith("label.new xloc")), "xloc reported");
});

test("labels: duplicate ids are deduped across collector rows", () => {
  const rows = [
    { value: [{ id: 1, x: 0, y: 10, xloc: "bi", yloc: "pr" }] },
    { value: [{ id: 1, x: 0, y: 10, xloc: "bi", yloc: "pr" }] },
  ];
  const klines = [{ openTime: 1704153600000, high: 10, low: 5 }];
  const { labels } = extractLabelDrawings(rows, klines);
  assert.equal(labels.length, 1);
});

test("labels: labelLayout points the balloon toward its anchor per style", () => {
  const cfg = LABEL_SIZE_PX.normal;
  const textW = 40;
  const textH = cfg.font * 1.25;
  // Anchor at (100, 200).
  const up = labelLayout({ style: "label_up", size: "normal" }, 100, 200, textW, textH);
  assert.ok(up.tipX === 100 && up.tipY === 200, "pointer tip sits ON the anchor");
  assert.ok(up.top < 200 && up.bottom === 200 - cfg.tip, "balloon is ABOVE the anchor");
  assert.ok(up.hasPointer);

  const down = labelLayout({ style: "label_down", size: "normal" }, 100, 200, textW, textH);
  assert.ok(down.top === 200 + cfg.tip && down.bottom > 200, "balloon is BELOW the anchor");
  assert.ok(down.tipY === 200, "down label still points at the anchor");

  const left = labelLayout({ style: "label_left", size: "normal" }, 100, 200, textW, textH);
  assert.ok(left.right === 100 - cfg.tip && left.left < 100, "balloon is LEFT of the anchor");

  const none = labelLayout({ style: "none", size: "normal" }, 100, 200, textW, textH);
  assert.equal(none.hasPointer, false, "style_none draws text only");
});

test("labels: pineHexToRgba handles #RGB, #RRGGBB and 8-digit transparency", () => {
  assert.equal(pineHexToRgba("#FF9800", "#000000"), "#ff9800");
  assert.equal(pineHexToRgba("#fff", "#000000"), "rgba(255, 255, 255, 1)");
  assert.equal(pineHexToRgba("#2962FF80", "#000000"), "rgba(41, 98, 255, 0.502)");
  assert.equal(pineHexToRgba("", "#000000"), "#000000", "empty → fallback");
  assert.equal(pineHexToRgba("nope", "#000000"), "#000000", "invalid → fallback");
});
// ── Engine integration: creation / anchoring ────────────────────────────────

test("labels: label.new() creates exactly one drawing object with semantic anchors", async () => {
  const bars = make1m(80);
  const vis = await runLabels(LAST_BAR_LABEL, bars);
  assert.ok(vis, "a labels visual must exist");
  assert.equal(vis.labels.length, 1, "exactly one label");
  assert.equal(vis.overlayLabels.length, 0);
  const lbl = vis.labels[0];
  assert.equal(lbl.logical, bars.length - 1, "bar_index → logical bar slot");
  assert.equal(lbl.timeMs, bars[bars.length - 1].ts, "bar_index → candle openTime");
  assert.equal(lbl.price, bars[bars.length - 1].high, "price anchored to the bar high");
  assert.equal(lbl.xloc, "bar_index");
  assert.equal(lbl.yloc, "price");
  assert.equal(typeof lbl.id, "number", "stable registry id");
});

test("labels: text is carried through", async () => {
  const bars = make1m(40);
  const vis = await runLabels(
    `//@version=6
indicator("t", overlay=true)
if barstate.islast
    label.new(bar_index, high, "SELL SIGNAL")`,
    bars,
  );
  assert.equal(vis.labels[0].text, "SELL SIGNAL");
});

test("labels: colors + textcolor map through PineTS hex", async () => {
  const bars = make1m(40);
  const vis = await runLabels(
    `//@version=6
indicator("c", overlay=true)
if barstate.islast
    label.new(bar_index, high, "X", color=color.orange, textcolor=color.red)`,
    bars,
  );
  assert.equal(vis.labels[0].color.toLowerCase(), "#ff9800");
  assert.equal(vis.labels[0].textcolor.toLowerCase(), "#f23645");
});

test("labels: every common style + textalign survive normalization", async () => {
  const bars = make1m(40);
  const vis = await runLabels(
    `//@version=6
indicator("s", overlay=true)
if barstate.islast
    label.new(bar_index + 0, high, "A", style=label.style_label_up)
    label.new(bar_index + 1, high, "B", style=label.style_label_down)
    label.new(bar_index + 2, high, "C", style=label.style_label_left)
    label.new(bar_index + 3, high, "D", style=label.style_label_right)
    label.new(bar_index + 4, high, "E", style=label.style_label_center)
    label.new(bar_index + 5, high, "F", style=label.style_none, textalign=text.align_left)`,
    bars,
  );
  assert.equal(vis.labels.length, 6);
  assert.equal(vis.labels[0].style, "label_up");
  assert.equal(vis.labels[1].style, "label_down");
  assert.equal(vis.labels[2].style, "label_left");
  assert.equal(vis.labels[3].style, "label_right");
  assert.equal(vis.labels[4].style, "label_center");
  assert.equal(vis.labels[5].style, "none");
  assert.equal(vis.labels[5].textalign, "left");
});

test("labels: sizes tiny→huge survive normalization", async () => {
  const bars = make1m(40);
  const vis = await runLabels(
    `//@version=6
indicator("z", overlay=true)
if barstate.islast
    label.new(bar_index, high, "T", size=size.tiny)
    label.new(bar_index, high + 5, "H", size=size.huge)`,
    bars,
  );
  assert.equal(vis.labels.length, 2);
  assert.equal(vis.labels[0].size, "tiny");
  assert.equal(vis.labels[1].size, "huge");
});

test("labels: xloc.bar_time anchors by the exact candle timestamp (epoch ms, Pine v6 time)", async () => {
  const bars = make1m(40);
  const vis = await runLabels(
    `//@version=6
indicator("bt", overlay=true)
if barstate.islast
    label.new(time, high, "BT", xloc=xloc.bar_time, yloc=yloc.price)`,
    bars,
  );
  const lbl = vis.labels[0];
  assert.equal(lbl.xloc, "bar_time");
  assert.equal(lbl.logical, null, "bar_time labels use the time scale, not a bar index");
  assert.equal(lbl.timeMs, bars[bars.length - 1].ts, "must equal the candle's openTime in ms (regression: ×1000 bug)");
  assert.equal(lbl.price, bars[bars.length - 1].high);
});

test("labels: yloc.abovebar / yloc.belowbar resolve against the pinned bar's high/low", async () => {
  const bars = make1m(60);
  const vis = await runLabels(
    `//@version=6
indicator("yl", overlay=true)
if barstate.islast
    label.new(bar_index - 3, high, "AB", yloc=yloc.abovebar)
    label.new(bar_index - 3, low, "BB", yloc=yloc.belowbar)`,
    bars,
  );
  const target = bars[bars.length - 4];
  const ab = vis.labels.find((l) => l.text === "AB");
  const bb = vis.labels.find((l) => l.text === "BB");
  assert.ok(ab && bb, "both labels present");
  assert.equal(ab.yloc, "abovebar");
  assert.equal(ab.price, target.high, "abovebar → the pinned bar's high");
  assert.equal(bb.yloc, "belowbar");
  assert.equal(bb.price, target.low, "belowbar → the pinned bar's low");
});

test("labels: force_overlay=true splits into overlayLabels (main-pane set)", async () => {
  const bars = make1m(60);
  const vis = await runLabels(
    `//@version=6
indicator("fo", overlay=false)
plot(close, "c")
if barstate.islast
    label.new(bar_index, high, "FOV", force_overlay=true)
    label.new(bar_index, high + 5, "PLAIN")`,
    bars,
  );
  assert.equal(vis.labels.length, 1);
  assert.equal(vis.overlayLabels.length, 1);
  assert.equal(vis.labels[0].text, "PLAIN");
  assert.equal(vis.overlayLabels[0].text, "FOV");
  assert.equal(vis.overlayLabels[0].forceOverlay, true);
});
// ── Engine integration: lifecycle (set_*, delete) ───────────────────────────

test("labels: set_text / set_color / set_textcolor / set_xy / set_size / set_style sync through the registry", async () => {
  const bars = make1m(40);
  const vis = await runLabels(
    `//@version=6
indicator("lc", overlay=true)
if barstate.islast
    lbl = label.new(bar_index, high, "A")
    label.set_text(lbl, "B")
    label.set_color(lbl, color.red)
    label.set_textcolor(lbl, color.green)
    label.set_xy(lbl, bar_index - 3, low)
    label.set_size(lbl, size.large)
    label.set_style(lbl, label.style_label_left)`,
    bars,
  );
  assert.equal(vis.labels.length, 1, "one stable object, mutated in place");
  const lbl = vis.labels[0];
  assert.equal(lbl.text, "B");
  assert.equal(lbl.color.toLowerCase(), "#f23645", "color.red");
  assert.equal(lbl.textcolor.toLowerCase(), "#4caf50", "color.green");
  assert.equal(lbl.logical, bars.length - 4, "set_xy moved the x anchor");
  assert.equal(lbl.price, bars[bars.length - 1].low, "set_xy moved the price anchor (yloc=price uses the passed y directly)");
  assert.equal(lbl.size, "large");
  assert.equal(lbl.style, "label_left");
});

test("labels: label.delete() removes the drawing", async () => {
  const bars = make1m(40);
  const vis = await runLabels(
    `//@version=6
indicator("dl", overlay=true)
if barstate.islast
    kept = label.new(bar_index, high, "KEEP")
    tmp = label.new(bar_index + 2, high + 10, "TMP")
    label.delete(tmp)`,
    bars,
  );
  assert.equal(vis.labels.length, 1, "deleted label is gone");
  assert.equal(vis.labels[0].text, "KEEP");
});

test("labels: multiple labels coexist — distinct ids, none overwritten", async () => {
  const bars = make1m(40);
  const vis = await runLabels(
    `//@version=6
indicator("ml", overlay=true)
if bar_index > 36
    label.new(bar_index, high, "HI" + str.tostring(bar_index))
    label.new(bar_index, low, "LO" + str.tostring(bar_index))`,
    bars,
  );
  assert.equal(vis.labels.length, 6, "bars 37..39 × 2 labels each");
  const ids = new Set(vis.labels.map((l) => l.id));
  assert.equal(ids.size, 6, "stable per-object ids");
  const hi79 = vis.labels.find((l) => l.text === "HI39");
  const lo79 = vis.labels.find((l) => l.text === "LO39");
  assert.ok(hi79 && lo79, "both labels on the last bar exist");
  assert.notEqual(hi79.price, lo79.price, "separate anchors");
});

// ── Replay / history / timeframe ────────────────────────────────────────────

test("labels: replay scope — labels only reflect the cursor slice, never live/past labels", async () => {
  const all = make1m(80);
  // Cursor at bar 30 (replay start) — labels must exist only on bars ≤ 30.
  const slice = all.slice(0, 31);
  const visEarly = await runLabels(LAST_BAR_LABEL, slice);
  assert.equal(visEarly.labels.length, 1);
  assert.equal(visEarly.labels[0].timeMs, slice[slice.length - 1].ts, "anchored to cursor's last bar");
  // Advancing the cursor adds bars — a fresh run re-derives labels on the new last bar.
  const slice2 = all.slice(0, 61);
  const visLater = await runLabels(LAST_BAR_LABEL, slice2);
  assert.equal(visLater.labels[0].timeMs, slice2[slice2.length - 1].ts);
  // No leakage across runs: each run owns exactly its own slice's label.
  assert.notEqual(visEarly.labels[0].id, visLater.labels[0].id);
});

test("labels: Load More History re-anchors bar_index labels to the same physical candle", async () => {
  const short = make1m(80);
  // Prepend 40 OLDER candle bars — the series must END at the same candle that
  // used to be the last visible bar (Load More History never changes it).
  const long = make1m(120, 1_704_153_600_000 - 40 * 60_000);
  const script = `//@version=6
indicator("hist", overlay=true)
if barstate.islast
    label.new(bar_index, high, "LAST")`;
  const before = (await runLabels(script, short)).labels[0];
  const after = (await runLabels(script, long)).labels[0];
  // Same physical candle: the newest bar of the prepended series is the candle
  // that used to be the old last bar.
  assert.equal(after.timeMs, long[long.length - 1].ts);
  assert.equal(after.timeMs, before.timeMs, "the candle identity did not shift");
  assert.equal(after.logical, long.length - 1, "script re-ran over the deeper series");
  assert.equal(after.price, long[long.length - 1].high);
});

test("labels: no leakage across timeframe scopes", async () => {
  const bars1m = make1m(80);
  const bars3m = make3m(40);
  const script = `//@version=6
indicator("tf", overlay=true)
if barstate.islast
    label.new(bar_index, high, "TF")`;
  const oneMinute = (await runLabels(script, bars1m, null, 60)).labels[0];
  const threeMinute = (await runLabels(script, bars3m, null, 180)).labels[0];
  assert.equal(oneMinute.timeMs, bars1m[bars1m.length - 1].ts, "1m scope");
  assert.equal(threeMinute.timeMs, bars3m[bars3m.length - 1].ts, "3m scope");
  assert.notEqual(oneMinute.timeMs, threeMinute.timeMs, "a 1m label must never bleed into 3m");
});