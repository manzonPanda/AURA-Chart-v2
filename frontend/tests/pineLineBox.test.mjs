/**
 * Pine line.new() / box.new() test suite — the drawing-object pipeline
 * (same normalized registry architecture as label.new()).
 *
 * Two layers:
 *   1. Pure adapter units (services/pineDrawings.ts) — anchor resolution,
 *      xloc/extend/style normalization, width clamping, dedupe, explicit
 *      unsupported reporting. No DOM, no lightweight-charts.
 *   2. Engine integration (services/pineEngine.ts) — line.new / box.new /
 *      set_* mutations / delete through PineTS's drawing-object registry →
 *      "lines"/"boxes" PineVisuals, force_overlay routing, and co-existence
 *      with label.new() + plot() in one run.
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PineIndicatorEngine } from "../src/services/pineEngine.ts";
import {
  extractBoxDrawings,
  extractLineDrawings,
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

const KLINES = [
  { openTime: 1_704_153_600_000, high: 110, low: 90 },
  { openTime: 1_704_153_660_000, high: 111, low: 89 },
  { openTime: 1_704_153_720_000, high: 112, low: 88 },
  { openTime: 1_704_153_780_000, high: 113, low: 87 },
];

/** Run a script and return its visuals + diagnostics (or null when failed). */
async function runVisuals(script, bars, live = null, bucketSec = 60, params = {}) {
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, live, bucketSec);
  const run = await eng.computeScriptVisuals({ id: "lb-test", source: script, bindings: [] }, params);
  eng.dispose();
  if (run === null) throw new Error("computeScriptVisuals returned null");
  return run;
}

const LAST_BAR_LINE = `//@version=6
indicator("ln", overlay=true)
if barstate.islast
    line.new(bar_index - 5, low, bar_index, high, color=color.green, width=2, style=line.style_dashed)`;

const LAST_BAR_BOX = `//@version=6
indicator("bx", overlay=true)
if barstate.islast
    box.new(bar_index - 10, high, bar_index, low, border_color=color.orange, bgcolor=color.new(color.orange, 60))`;

// ── Pure adapter units: lines ────────────────────────────────────────────────

test("lines: anchor resolution maps bar_index → logical + openTime", () => {
  const rows = [
    { value: [{ id: 1, x1: 1, y1: 100, x2: 3, y2: 105, xloc: "bi", yloc: "pr" }] },
  ];
  const { lines } = extractLineDrawings(rows, KLINES);
  assert.equal(lines.length, 1);
  const ln = lines[0];
  assert.equal(ln.logical1, 1);
  assert.equal(ln.time1Ms, 1_704_153_660_000);
  assert.equal(ln.logical2, 3);
  assert.equal(ln.time2Ms, 1_704_153_780_000);
  assert.equal(ln.price1, 100);
  assert.equal(ln.price2, 105);
});

test("lines: xloc.bar_time keeps ms timestamps and null logicals", () => {
  const rows = [
    { value: [{ id: 2, x1: 1704153660, y1: 99, x2: 1704153720, y2: 101, xloc: "bt", yloc: "pr" }] },
  ];
  const { lines } = extractLineDrawings(rows, KLINES);
  const ln = lines[0];
  assert.equal(ln.xloc, "bar_time");
  assert.equal(ln.time1Ms, 1_704_153_660_000, "Pine epoch-SECOND → ms");
  assert.equal(ln.logical1, null);
  assert.equal(ln.logical2, null);
});

test("lines: defaults, width clamp and style/extend aliases", () => {
  const rows = [
    { value: [{ id: 3, x1: 0, y1: 1, x2: 1, y2: 2, xloc: "bar_index", yloc: "price" }] },
    { value: [{ id: 4, x1: 0, y1: 1, x2: 1, y2: 2, xloc: "bi", yloc: "pr", width: 99, style: "linestyle_dashed", extend: "r" }] },
  ];
  const { lines } = extractLineDrawings(rows, KLINES);
  assert.equal(lines[0].width, 1, "Pine default width");
  assert.equal(lines[0].style, "solid", "Pine default style");
  assert.equal(lines[0].extend, "none", "Pine default extend");
  assert.equal(lines[1].width, 5, "clamped to Pine's width domain");
  assert.equal(lines[1].style, "dashed");
  assert.equal(lines[1].extend, "right");
});

test("lines: unknown xloc never renders a guessed position — reported instead", () => {
  const rows = [{ value: [{ id: 5, x1: 0, y1: 1, x2: 1, y2: 2, xloc: "weird", yloc: "pr" }] }];
  const { lines, unsupported } = extractLineDrawings(rows, KLINES);
  assert.equal(lines.length, 0);
  assert.ok(unsupported.some((u) => u.kind.startsWith("line.new xloc")));
});

test("lines: na anchors are reported, not silently dropped", () => {
  const rows = [{ value: [{ id: 6, x1: 0, y1: null, x2: 1, y2: 2, xloc: "bi", yloc: "pr" }] }];
  const { lines, unsupported } = extractLineDrawings(rows, KLINES);
  assert.equal(lines.length, 0);
  assert.ok(unsupported.some((u) => u.kind.includes("na")));
});

test("lines: duplicate ids dedupe across collector rows", () => {
  const row = { value: [{ id: 7, x1: 0, y1: 1, x2: 1, y2: 2, xloc: "bi", yloc: "pr" }] };
  const { lines } = extractLineDrawings([row, row], KLINES);
  assert.equal(lines.length, 1);
});

test("lines: force_overlay is carried through", () => {
  const rows = [
    { value: [{ id: 8, x1: 0, y1: 1, x2: 1, y2: 2, xloc: "bi", yloc: "pr", force_overlay: true }] },
  ];
  const { lines } = extractLineDrawings(rows, KLINES);
  assert.equal(lines[0].forceOverlay, true);
});

// ── Pure adapter units: boxes ────────────────────────────────────────────────

test("boxes: corners map to left/right logical + top/bottom prices", () => {
  const rows = [
    { value: [{ id: 10, left: 0, top: 110, right: 3, bottom: 95, xloc: "bi", yloc: "pr" }] },
  ];
  const { boxes } = extractBoxDrawings(rows, KLINES);
  assert.equal(boxes.length, 1);
  const bx = boxes[0];
  assert.equal(bx.leftLogical, 0);
  assert.equal(bx.leftMs, 1_704_153_600_000);
  assert.equal(bx.rightLogical, 3);
  assert.equal(bx.topPrice, 110);
  assert.equal(bx.bottomPrice, 95);
});

test("boxes: border defaults + bgcolor + text attributes normalize", () => {
  const rows = [
    {
      value: [
        {
          id: 11,
          left: 0,
          top: 10,
          right: 1,
          bottom: 5,
          xloc: "bi",
          yloc: "pr",
          border_color: "#FF9800",
          border_width: 3,
          border_style: "dotted",
          bgcolor: "#9C27B066",
          text: "ZONE",
          text_color: "#FFFFFF",
          text_size: "small",
          text_halign: "left",
          text_valign: "top",
        },
      ],
    },
  ];
  const { boxes } = extractBoxDrawings(rows, KLINES);
  const bx = boxes[0];
  assert.equal(bx.borderColor, "#FF9800");
  assert.equal(bx.borderWidth, 3);
  assert.equal(bx.borderStyle, "dotted");
  assert.equal(bx.bgcolor, "#9C27B066");
  assert.equal(bx.text, "ZONE");
  assert.equal(bx.textColor, "#FFFFFF");
  assert.equal(bx.textSize, "small");
  assert.equal(bx.textHalign, "left");
  assert.equal(bx.textValign, "top");
});

test("boxes: defaults when only geometry is given", () => {
  const rows = [{ value: [{ id: 12, left: 0, top: 10, right: 1, bottom: 5, xloc: "bi", yloc: "pr" }] }];
  const { boxes } = extractBoxDrawings(rows, KLINES);
  const bx = boxes[0];
  assert.equal(bx.borderWidth, 1, "Pine default border width");
  assert.equal(bx.borderStyle, "solid");
  assert.equal(bx.text, "");
  assert.equal(bx.extend, "none");
});

test("boxes: unknown xloc is reported and never placed", () => {
  const rows = [{ value: [{ id: 13, left: 0, top: 10, right: 1, bottom: 5, xloc: "?", yloc: "pr" }] }];
  const { boxes, unsupported } = extractBoxDrawings(rows, KLINES);
  assert.equal(boxes.length, 0);
  assert.ok(unsupported.some((u) => u.kind.startsWith("box.new xloc")));
});

// ── Engine integration ───────────────────────────────────────────────────────

test("lines: line.new() creates exactly one drawing object with semantic anchors", async () => {
  const bars = make1m(80);
  const run = await runVisuals(LAST_BAR_LINE, bars);
  const vis = run.visuals.find((v) => v.type === "lines");
  assert.ok(vis, "a lines visual must exist");
  assert.equal(vis.lines.length, 1);
  assert.equal(vis.overlayLines.length, 0);
  const ln = vis.lines[0];
  assert.equal(ln.logical1, bars.length - 6, "bar_index - 5 → exact logical slot");
  assert.equal(ln.time1Ms, bars[bars.length - 6].ts);
  assert.equal(ln.logical2, bars.length - 1);
  assert.equal(ln.time2Ms, bars[bars.length - 1].ts);
  // Pine evaluates `low`/`high` in the current (last-bar) execution context —
  // the X anchors point at other bars, the Y values are the live bar's OHLC.
  assert.equal(ln.price1, bars[bars.length - 1].low, "y1 = current bar's low");
  assert.equal(ln.price2, bars[bars.length - 1].high, "y2 = current bar's high");
  assert.equal(ln.color.toLowerCase(), "#4caf50");
  assert.equal(ln.style, "dashed");
  assert.equal(ln.width, 2);
  assert.equal(typeof ln.id, "number", "stable registry id");
  assert.equal(
    run.diagnostics.unsupported.filter((u) => u.kind.includes("line.new")).length,
    0,
    "line.new must be rendered, not reported",
  );
});

test("boxes: box.new() creates exactly one drawing object with semantic anchors", async () => {
  const bars = make1m(80);
  const run = await runVisuals(LAST_BAR_BOX, bars);
  const vis = run.visuals.find((v) => v.type === "boxes");
  assert.ok(vis, "a boxes visual must exist");
  assert.equal(vis.boxes.length, 1);
  assert.equal(vis.overlayBoxes.length, 0);
  const bx = vis.boxes[0];
  assert.equal(bx.leftLogical, bars.length - 11);
  assert.equal(bx.rightLogical, bars.length - 1);
  assert.equal(typeof bx.id, "number");
  assert.equal(
    run.diagnostics.unsupported.filter((u) => u.kind.includes("box.new")).length,
    0,
    "box.new must be rendered, not reported",
  );
});

test("drawings: set_xy mutations within one run land in the final snapshot (same object)", async () => {
  const bars = make1m(60);
  // Create, then mutate — PineTS applies the sets to the SAME object and the
  // collector syncs the final live state, so exactly ONE line exists and its
  // endpoint carries the SET values, not the constructor values.
  const script = `//@version=6
indicator("mut", overlay=true)
if barstate.islast
    ln = line.new(bar_index - 10, low, bar_index, high)
    line.set_xy1(ln, bar_index - 3, close)`;
  const run = await runVisuals(script, bars);
  const vis = run.visuals.find((v) => v.type === "lines");
  assert.ok(vis && vis.lines.length === 1, "mutation must not duplicate the object");
  const ln = vis.lines[0];
  assert.equal(ln.logical1, bars.length - 4, "set_xy1 moved endpoint 1");
  assert.equal(ln.time1Ms, bars[bars.length - 4].ts);
  assert.equal(ln.price1, bars[bars.length - 1].close, "set_xy1 y took effect");
  assert.equal(ln.logical2, bars.length - 1, "endpoint 2 untouched");
});

test("drawings: line.delete() within a run removes the object from the snapshot", async () => {
  const bars = make1m(60);
  const script = `//@version=6
indicator("del", overlay=true)
if barstate.islast
    ln = line.new(bar_index, low, bar_index, high)
    line.delete(ln)`;
  const run = await runVisuals(script, bars);
  const vis = run.visuals.find((v) => v.type === "lines");
  assert.equal(vis ? vis.lines.length : 0, 0, "deleted objects are filtered from the live registry");
  // And a line that is NOT deleted in the same script still renders.
  const script2 = `//@version=6
indicator("del2", overlay=true)
if barstate.islast
    ln = line.new(bar_index, low, bar_index, high)
    line.delete(ln)
    line.new(bar_index - 1, low, bar_index, high)`;
  const run2 = await runVisuals(script2, bars);
  const vis2 = run2.visuals.find((v) => v.type === "lines");
  assert.equal(vis2 ? vis2.lines.length : 0, 1, "only the surviving line renders");
});

test("drawings: force_overlay=true lines route to the overlay layer", async () => {
  const bars = make1m(50);
  const script = `//@version=6
indicator("fo", overlay=false)
if barstate.islast
    line.new(bar_index, low, bar_index, high, force_overlay=true)`;
  const run = await runVisuals(script, bars);
  const vis = run.visuals.find((v) => v.type === "lines");
  assert.ok(vis, "lines visual exists");
  assert.equal(vis.lines.length, 0, "pane layer empty");
  assert.equal(vis.overlayLines.length, 1, "overlay layer carries the drawing");
});

test("drawings: lines/boxes co-exist with labels and plots in ONE run", async () => {
  const bars = make1m(60);
  const script = `//@version=6
indicator("all", overlay=true)
plot(ta.ema(close, 9), "EMA 9")
if barstate.islast
    label.new(bar_index, high, "L")
    line.new(bar_index - 2, low, bar_index, high)
    box.new(bar_index - 4, high, bar_index, low)`;
  const run = await runVisuals(script, bars);
  const types = run.visuals.map((v) => v.type).sort();
  assert.ok(types.includes("line"), "plot() still renders");
  assert.ok(types.includes("labels"), "labels still render");
  assert.ok(types.includes("lines"), "lines render");
  assert.ok(types.includes("boxes"), "boxes render");
  const labels = run.visuals.find((v) => v.type === "labels");
  const lines = run.visuals.find((v) => v.type === "lines");
  const boxes = run.visuals.find((v) => v.type === "boxes");
  assert.equal(labels.labels.length, 1, "exactly one label");
  assert.equal(lines.lines.length, 1, "exactly one line");
  assert.equal(boxes.boxes.length, 1, "exactly one box");
  assert.equal(run.diagnostics.unsupported.length, 0, "nothing unsupported remains");
});


