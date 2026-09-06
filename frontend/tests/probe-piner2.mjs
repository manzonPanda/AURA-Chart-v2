// Probe #2 — syminfo, plot style variants, force_overlay, hline, display=none.
import { compile, Engine, ArrayFeed } from "@heyphat/piner";

const bars = [];
let prev = 50;
for (let i = 0; i < 30; i++) {
  const c = prev + Math.sin(i / 3) * 1.5 + (i % 5 === 0 ? 1 : -0.5);
  bars.push({
    time: 1704153600000 + i * 60000,
    open: prev,
    high: Math.max(prev, c) + 0.5,
    low: Math.min(prev, c) - 0.5,
    close: c,
    volume: 500 + i,
  });
  prev = c;
}

// Syminfo dump via plot values.
const src = `//@version=6
indicator("Probe2", overlay=true)
half = 0.5
// Expose syminfo fields as plots so we can read them back (decode later).
plot(syminfo.mintick, "mintick")
plot(syminfo.pricescale, "pricescale")
plot(syminfo.minmove, "minmove")
plot(syminfo.pointvalue, "pointvalue")
// Timeframe string → plot a numeric sentinel encoding is not possible; dump via label none.
if barstate.islast
    label.new(bar_index, high, "TF=" + timeframe.period + " TICK=" + syminfo.tickerid + " CUR=" + syminfo.currency + " TZ=" + syminfo.timezone, style=label.style_none)
// Style variants.
plot(ta.sma(close, 4), "area", style=plot.style_area, color=color.new(color.blue, 70))
plot(ta.sma(close, 6), "hist", style=plot.style_histogram, color=color.new(color.red, 50))
plot(ta.sma(close, 8), "step", style=plot.style_stepline, color=color.green)
// hline (only allowed in its own scale, fine in overlay with explicit scale?)
hline(49.5, "mid", color=color.gray, linestyle=hline.style_dashed)
// display=none.
plot(ta.sma(close, 10), "hidden", display=display.none)
// force_overlay drawings from a separate-pane indicator.
if barstate.islast
    line.new(bar_index, low, bar_index, high, color=color.yellow, force_overlay=true)
    label.new(bar_index, high, "FO", force_overlay=true)
`;

let compiled;
try {
  compiled = compile(src);
  console.log("COMPILE OK");
} catch (e) {
  console.log("COMPILE ERR:", e.message);
  process.exit(1);
}

const engine = new Engine(compiled, new ArrayFeed(bars), { backend: "js" });
try {
  await engine.run({ symbol: "PROBE2:DAX", timeframe: "1", mintick: 0.01 });
} catch (e) {
  console.log("RUN ERR:", e.message);
  process.exit(1);
}

function stripNa(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    out.push(typeof v === "number" && Number.isFinite(v) ? v : "na");
  }
  return out;
}

console.log("\n=== PLOTS ===");
for (const [id, p] of engine.outputs.plots) {
  console.log(`plot[${id}] title=${p.title} opts=${JSON.stringify(p.options)} last=${stripNa(p.data).pop()} firstNonNull=${stripNa(p.data).findIndex((v) => v !== "na")}`);
}
if (engine.outputs.hlines.size) {
  console.log("=== HLINES ===");
  for (const [, h] of engine.outputs.hlines) console.log(JSON.stringify(h));
}
console.log("\n=== LABELS (syminfo dump + FO) ===");
for (const d of engine.drawings) {
  if (d.type === "label")
    console.log("LABEL", JSON.stringify(d.props).slice(0, 340));
}
console.log("\n=== LINES (FO) ===");
for (const d of engine.drawings) {
  if (d.type === "line")
    console.log("LINE", JSON.stringify(d.props).slice(0, 220));
}