// Probe #3 — Piner semantics needed for the AURA adapter:
// line/box enums, marker row shape, delete lifecycle, bar_time units, dynamic
// per-bar plot colors, drawing caps, `time` builtin, run-options surface.
import { compile, Engine, ArrayFeed } from "@heyphat/piner";

const bars = [];
let prev = 100;
for (let i = 0; i < 40; i++) {
  const c = prev + Math.sin(i / 3) * 2 + (i % 4 === 0 ? 2 : -1);
  bars.push({
    time: 1704153600000 + i * 60000,
    open: prev,
    high: Math.max(prev, c) + 1,
    low: Math.min(prev, c) - 1,
    close: c,
    volume: 1000 + i,
  });
  prev = c;
}

const src = `//@version=6
indicator("Probe4", overlay=true)
len = input.int(5, "Length", minval=1, maxval=50)
plot(ta.sma(close, len), "sma")
hline(100, "mid", color=color.gray, linestyle=hline.style_dashed)
plotshape(close > open, style=shape.triangleup, location=location.belowbar, color=color.green, text="U", size=size.small)
plotchar(close < open, char="d", location=location.abovebar, color=color.red, text="dn")
if barstate.islast
    line.new(bar_index - 10, low, bar_index, high, color=color.purple, force_overlay=true)
    label.new(bar_index, high, "FO", force_overlay=true, style=label.style_label_up, textcolor=color.white, textalign=text.align_right)
`;

const L = [];
const out = (...a) => L.push(a.join(" "));
const compiled = compile(src);
out("inputs:", JSON.stringify(compiled.metadata.inputs));

const engine = new Engine(compiled, new ArrayFeed(bars), { backend: "js", inputs: { Length: 14 } });
await engine.run({ symbol: "P4:X", timeframe: "1", mintick: 0.01 });

out("\n=== PLOTS (input override sma len=14) ===");
for (const [id, p] of engine.outputs.plots) {
  out(id, p.title, "last5=" + JSON.stringify(p.data.slice(-5).map((v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : "na"))));
}
out("\n=== HLINES ===");
for (const [id, h] of engine.outputs.hlines) out(id, JSON.stringify(h));
out("\n=== MARKERS (full rows) ===");
for (const [id, m] of engine.outputs.markers) {
  const objs = m.data.filter((v) => v != null).slice(0, 3);
  out(id, m.title, "objRows=" + JSON.stringify(objs));
}
out("\n=== DRAWINGS ===");
for (const d of engine.drawings) out(d.type, "id=" + d.id, JSON.stringify(d.props));
import { writeFileSync } from "node:fs";
writeFileSync(new URL("../p4.txt", import.meta.url), L.join("\n") + "\n");
