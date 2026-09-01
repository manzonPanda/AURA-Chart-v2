/**
 * Pine import performance benchmark (NOT part of the `npm test` run — the
 * test glob only picks up *.test.mjs).
 *
 *   node tests/pinePerf.mjs
 *
 * Measures full PineTS recomputes of 1 / 5 / 10 imported indicators over 500
 * 1m bars — the worst-case authoritative-candle-change cost per tick (the
 * engine short-circuits identical close streams, so this only runs when the
 * forming candle actually moves or a rollover happens).
 */
import { performance } from "node:perf_hooks";

import { PineIndicatorEngine } from "../src/services/pineEngine.ts";

function rng(seed = 1) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 100 - 50;
  };
}

function make1m(n, startTs = 1_704_153_600_000, seed = 7) {
  const r = rng(seed);
  let acc = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = acc + r();
    acc = c;
    out.push({ ts: startTs + i * 60_000, open: acc, high: acc + 1, low: acc - 1, close: c, volume: 1000 + i });
  }
  return out;
}

function makeScript(n) {
  const plots = Array.from({ length: 2 }, (_, i) => `plot(ta.ema(close, ${n * 2 + i + 2}), "p${i}")`).join("\n");
  return `//@version=6\nindicator("bench ${n}", overlay=true)\nlen = input.int(${n + 2}, "Length", minval=1)\nplot(ta.sma(close, len), "sma")\n${plots}`;
}

async function bench(count, bars) {
  const eng = new PineIndicatorEngine();
  eng.setCandles(bars, null, 60);
  const specs = Array.from({ length: count }, (_, i) => ({
    id: `bench-${i}`,
    source: makeScript(i),
    bindings: [{ title: "Length", paramKey: "len" }],
  }));
  const params = specs.map((_, i) => ({ len: i + 2 }));
  // Warmup (compile + first run — NOT measured).
  for (let i = 0; i < count; i++) await eng.computeScript(specs[i], params[i]);
  // Measure: the per-tick cost when the authoritative close moved.
  const samples = [];
  for (let s = 0; s < 5; s++) {
    const t0 = performance.now();
    for (let i = 0; i < count; i++) await eng.computeScript(specs[i], params[i]);
    samples.push(performance.now() - t0);
  }
  // Fresh-runtime cost: history load / rollover rebuilds the PineTS runtime.
  const t1 = performance.now();
  eng.setCandles(bars, { time: Math.floor(bars[bars.length - 1].ts / 1000), open: 1, high: 2, low: 0.5, close: bars[bars.length - 1].close + 1, volume: 10 }, 60);
  for (let i = 0; i < count; i++) await eng.computeScript(specs[i], params[i]);
  const freshMs = performance.now() - t1;
  eng.dispose();
  const cachedRun = Math.min(...samples);
  return { count, bars: bars.length, cachedRun, freshMs };
}

const bars = make1m(500);
console.log(`Pine import performance — ${bars.length} × 1m bars (5 run samples, min):`);
for (const count of [1, 5, 10]) {
  const r = await bench(count, bars);
  console.log(
    `  ${String(r.count).padStart(2)} imported indicators (${r.count * 3} plots): ` +
      `cached-run ${r.cachedRun.toFixed(1)} ms · fresh-runtime ${r.freshMs.toFixed(1)} ms`,
  );
}
console.log("\ncached-run  = per-tick cost when only the forming close moved (compiles reused)");
console.log("fresh-runtime = history load / rollover cost (PineTS runtime rebuilt)");
