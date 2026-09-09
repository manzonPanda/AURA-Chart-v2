/**
 * Williams Fractals regression — `fractal.pine` line-extension rendering.
 * Root cause pinned here: unbounded line-object accumulation hit
 * max_lines_count=500, so Piner's DrawingPool silently evicted the OLDEST
 * drawings. Fix: finished (frozen-x2) lines retire FIFO via
 * line.delete(array.shift(doneLines)) under a 400 cap; live lines untouched.
 * Detection/frontier logic is NOT re-tested here — only the visible contract
 * of the confirmed UP level at pivot 10 / price 110 (and its DOWN mirror).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PinerPineEngine } from "../src/services/pinePinerEngine.ts";
import {
  FRACTAL_CLOSES_NOBREAK,
  FRACTAL_HIGHS,
  FRACTAL_PINE_SOURCE,
  fractalLines,
  fractalScenarioBars,
  fractalUp110,
} from "./fractalFixture.mjs";

const SPEC = { id: "fractal-regression", source: FRACTAL_PINE_SOURCE, bindings: [] };

function engineOver(bars) {
  const eng = new PinerPineEngine();
  eng.setCandles(bars, null, 60, null);
  return eng;
}

test("fractal: unbroken UP level extends pivot->pivot+5 (x1=10,x2=15,y=110)", async () => {
  const eng = engineOver(fractalScenarioBars(FRACTAL_HIGHS, FRACTAL_CLOSES_NOBREAK));
  const run = await eng.computeScriptVisuals(SPEC);
  assert.ok(run, "script must run");
  assert.equal(run.diagnostics.unsupported.length, 0, "no silently unsupported line feature");
  const up = fractalUp110(fractalLines(run));
  assert.ok(up, "UP level at pivot 10 / 110 must exist");
  assert.equal(up.logical1, 10, "x1 is the pivot (bar_index - n)");
  assert.equal(up.logical2, 15, "x2 spans the full 5-candle lifetime");
  assert.equal(up.price1, 110);
  assert.equal(up.price2, 110, "y1 == y2 horizontal");
  assert.equal(up.xloc, "bar_index");
  assert.equal(up.extend, "none");
  eng.dispose();
});

test("fractal: first close >= level ends line WITH breaking candle as x2", async () => {
  const closes = [...FRACTAL_CLOSES_NOBREAK];
  closes[12] = 110;
  const eng = engineOver(fractalScenarioBars(FRACTAL_HIGHS, closes));
  const up = fractalUp110(fractalLines(await eng.computeScriptVisuals(SPEC)));
  assert.ok(up, "UP level must exist");
  assert.equal(up.logical1, 10);
  assert.equal(up.logical2, 12, "breaking candle included as final x2");
  assert.equal(up.price2, 110);
  eng.dispose();
});

test("fractal: wick touch without close break does NOT stop the line", async () => {
  const H = [...FRACTAL_HIGHS];
  const C = [...FRACTAL_CLOSES_NOBREAK];
  H[13] = 112;
  C[13] = 104;
  const eng = engineOver(fractalScenarioBars(H, C));
  const up = fractalUp110(fractalLines(await eng.computeScriptVisuals(SPEC)));
  assert.ok(up, "UP level must exist");
  assert.equal(up.logical1, 10);
  assert.equal(up.logical2, 15, "wick-only touch must not truncate");
  assert.equal(up.price2, 110);
  eng.dispose();
});


test("fractal DOWN mirror: unbroken support spans pivot->pivot+5; close break sets x2", async () => {
  const H = [110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100, 101, 102, 103, 104, 105, 106, 107];
  const Lw = [109, 108, 107, 106, 105, 104, 103, 102, 101, 100, 90, 91, 92, 93, 94, 95, 96, 97];
  const Cn = [109.5, 108.5, 107.5, 106.5, 105.5, 104.5, 103.5, 102.5, 101.5, 100.5, 99, 96, 97, 98, 99, 100, 101, 102];
  const mk = (Cc) => H.map((h, i) => ({ ts: 1_704_153_600_000 + i * 60_000, open: Cc[i] - 0.5, high: h, low: Lw[i], close: Cc[i], volume: 1000 }));
  const eng = engineOver(mk(Cn));
  const dn = fractalLines(await eng.computeScriptVisuals(SPEC)).find((l) => l.logical1 === 10 && l.price1 === 90);
  assert.ok(dn, "DOWN level at pivot 10 / 90 must exist");
  assert.equal(dn.logical2, 15, "unbroken DOWN support spans full lifetime");
  assert.equal(dn.price2, 90, "y1 == y2 at pivot low");
  eng.dispose();
  const Cb = [...Cn];
  Cb[13] = 90;
  const eng2 = engineOver(mk(Cb));
  const dn2 = fractalLines(await eng2.computeScriptVisuals(SPEC)).find((l) => l.logical1 === 10 && l.price1 === 90);
  assert.ok(dn2, "broken DOWN level must exist");
  assert.equal(dn2.logical2, 13, "breaking candle included as final x2");
  eng.dispose();
  eng2.dispose();
});

test("fractal: dense histories stay under max_lines_count (no pool eviction)", async () => {
  const bars = [];
  let c = 100;
  for (let i = 0; i < 3000; i++) {
    const phase = i % 4;
    const h = phase === 2 ? c + 5 : c + 0.5;
    const cc = c + 0.1;
    bars.push({ ts: 1_704_153_600_000 + i * 60_000, open: c, high: h, low: c - 0.5, close: cc, volume: 1000 });
    c = cc;
  }
  const eng = engineOver(bars);
  const run = await eng.computeScriptVisuals(SPEC);
  assert.ok(run, "script must run");
  const lines = fractalLines(run);
  assert.ok(lines.length <= 500, `pool under max_lines_count=500 (got ${lines.length})`);
  assert.ok(lines.length > 0, "recent levels survive retention");
  const last = lines[lines.length - 1];
  assert.ok(last.logical2 >= 2995, "newest levels reach the live edge");
  for (const l of lines) {
    assert.equal(l.price1, l.price2, "every line stays horizontal");
    assert.ok(l.logical2 - l.logical1 >= 1 && l.logical2 - l.logical1 <= 5, "span within lifetime");
  }
  eng.dispose();
});
