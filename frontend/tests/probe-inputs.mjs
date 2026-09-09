/**
 * TEMPORARY probe (not committed) — determines which Piner input kinds accept
 * overrides from the host, and what value shapes they take. Drives the
 * settings-UI audit: which controls can be real vs which must stay read-only.
 * Writes results to probe-out.log (the dev shell here swallows stdout).
 */
import { compile, Engine, ArrayFeed } from "@heyphat/piner";

const out = [];
const log = (...a) => out.push(a.join(" "));


const bars = Array.from({ length: 30 }, (_, i) => ({
  time: 1700000000000 + i * 60000,
  open: 100 + i,
  high: 105 + i,
  low: 95 + i,
  close: 102 + i,
  volume: 1000 + i,
}));

async function run(src, inputs) {
  const compiled = compile(src);
  const engine = new Engine(compiled, new ArrayFeed(bars), {
    backend: "js",
    ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
  });
  await engine.run({ symbol: "TEST", timeframe: "1", mintick: 0.01 });
  const plots = [];
  for (const [, p] of engine.outputs.plots) {
    plots.push({ title: p.title ?? "?", last: p.data[p.data.length - 1] });
  }
  return plots;
}

const SCRIPTS = {
  int: { src: '//@version=6\nindicator("t")\nlen = input.int(5, "Length")\nplot(len)', def: 5 },
  intOverride: { src: '//@version=6\nindicator("t")\nlen = input.int(5, "Length")\nplot(len)', inputs: { Length: 12 }, expect: 12 },
  float: { src: '//@version=6\nindicator("t")\nm = input.float(2.0, "Mult")\nplot(m)', inputs: { Mult: 3.5 }, expect: 3.5 },
  bool: { src: '//@version=6\nindicator("t")\nb = input.bool(true, "Show")\nplot(b ? 3 : 4)', inputs: { Show: false }, expect: 4 },
  color: {
    src: '//@version=6\nindicator("t")\nc = input.color(color.red, "Col")\nplot(1, color=c)',
    inputs: { Col: "#00ff00" },
  },
  enumString: {
    src: '//@version=6\nindicator("t")\nm = input.string("A", "Mode", options=["A","B"])\nplot(m == "A" ? 1 : 2)',
    inputs: { Mode: "B" },
    expect: 2,
  },
  plainString: {
    src: '//@version=6\nindicator("t")\nm = input.string("xyz", "Txt")\nplot(1)',
    inputs: { Txt: "hello" },
  },
};

console.log("── basic kinds ──");
for (const [name, s] of Object.entries(SCRIPTS)) {
  try {
    const plots = await run(s.src, s.inputs);
    log(`${name}: OK`, JSON.stringify(plots));
  } catch (e) {
    log(`${name}: FAILED — ${e.message}`);
  }
}

log("── source kind ──");
for (const [name, val] of Object.entries({
  stringHigh: "high",
  stringHl2: "hl2",
  stringOpen: "open",
  stringDollarHigh: "$.high",
  number: 123,
})) {
  try {
    const plots = await run('//@version=6\nindicator("t")\ns = input.source(close, "Src")\nplot(s)', { Src: val });
    log(`source override ${name} (${JSON.stringify(val)}): OK`, JSON.stringify(plots));
  } catch (e) {
    log(`source override ${name} (${JSON.stringify(val)}): FAILED — ${e.message}`);
  }
}

log("── timeframe/symbol/session kinds ──");
for (const [name, src, inputs] of Object.entries({
  timeframe: ['//@version=6\nindicator("t")\ntf = input.timeframe("60", "TF")\nplot(1)', { TF: "240" }],
  symbol: ['//@version=6\nindicator("t")\nsy = input.symbol("AAPL", "Sym")\nplot(1)', { Sym: "MSFT" }],
  session: ['//@version=6\nindicator("t")\nses = input.session("0930-1600", "Ses")\nplot(1)', { Ses: "1300-2000" }],
  enumKeyword: ['//@version=6\nindicator("t")\ne = input.enum("A", "E", ["A","B"])\nplot(1)', { E: "B" }],
})) {
  try {
    const plots = await run(src, inputs);
    log(`${name}: OK`, JSON.stringify(plots));
  } catch (e) {
    log(`${name}: FAILED — ${e.message}`);
  }
}

log("── metadata: group/tooltip/options exposure ──");
const c = compile(
  '//@version=6\nindicator("t")\n' +
    'a = input.int(1, "A", group="Group One", tooltip="The A input")\n' +
    'b = input.float(0.5, "B", step=0.25, minval=0, maxval=2, group="Group One")\n' +
    's = input.source(close, "S", tooltip="price source")\n' +
    'm = input.string("x", "M", options=["x","y","z"])\n' +
    'tf = input.timeframe("60", "TF")\n' +
    "plot(a + b)",
);
log(JSON.stringify(c.metadata.inputs, null, 1));

log("── realistic AURA cases ──");
// (a) timeframe input, NO override at all — does the script even run?
try {
  const plots = await run('//@version=6\nindicator("t")\ntf = input.timeframe("60", "TF")\nplot(1)');
  log("timeframe no-override: OK", JSON.stringify(plots));
} catch (e) {
  log("timeframe no-override: FAILED —", e.message);
}
// (b) int + timeframe inputs, override ONLY the int (AURA's persisted record
//     contains the timeframe defval too — what if it's sent?)
const MIXED = '//@version=6\nindicator("t")\nn = input.int(5, "Len")\ntf = input.timeframe("60", "TF")\nplot(n)';
try {
  const plots = await run(MIXED, { Len: 9 });
  log("mixed, override int only: OK", JSON.stringify(plots));
} catch (e) {
  log("mixed, override int only: FAILED —", e.message);
}
try {
  const plots = await run(MIXED, { Len: 9, TF: "60" });
  log("mixed, override int + TF defval: OK", JSON.stringify(plots));
} catch (e) {
  log("mixed, override int + TF defval: FAILED —", e.message);
}
// (c) enum without override
try {
  const plots = await run('//@version=6\nindicator("t")\ne = input.enum("A", "E", ["A","B"])\nplot(e == "A" ? 1 : 2)');
  log("enum no-override: OK", JSON.stringify(plots));
} catch (e) {
  log("enum no-override: FAILED —", e.message);
}
// (d) source override with hlc3/ohlc4 leaf names (AURA price sources)
for (const leaf of ["hlc3", "ohlc4", "close"]) {
  try {
    const plots = await run('//@version=6\nindicator("t")\ns = input.source(close, "Src")\nplot(s)', { Src: leaf });
    log(`source leaf ${leaf}: OK`, JSON.stringify(plots));
  } catch (e) {
    log(`source leaf ${leaf}: FAILED —`, e.message);
  }
}
// (e) bool override with non-boolean, int override with float (coercion shape)
try {
  const plots = await run('//@version=6\nindicator("t")\nn = input.int(5, "Len")\nplot(n)', { Len: 7.7 });
  log("int override with float 7.7: OK", JSON.stringify(plots));
} catch (e) {
  log("int override with float 7.7: FAILED —", e.message);
}

console.log(out.join("\n"));


