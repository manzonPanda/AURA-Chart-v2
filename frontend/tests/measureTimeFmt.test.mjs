/**
 * Measurement readout presentation pass — MeasureTimeFmt.
 *
 * The contract under test:
 *   1. timeTokenToHM converts CandleKit's native fmtTime tokens ("45s" |
 *      "90m" | "1.5h") to AURA's unit style — each part shown only when it
 *      has a value ("45m" | "1h 30m" | "2h") — and FAILS OPEN (null) on
 *      anything it does not recognise.
 *   2. LOOP GUARD: re-reading our own output returns null or the identical
 *      string — the MutationObserver write loop always terminates.
 *   3. The readout stays the LIBRARY's (<MeasurementOverlay /> still mounted,
 *      prop-less): AURA only wraps it and hides the % row. The "AURA owns no
 *      ruler math" contract in drawingToolbar.test.mjs keeps covering the
 *      values themselves.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { timeTokenToHM } from "../src/services/measureTimeFmt.ts";

const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("timeTokenToHM: native fmtTime tokens → unit style (part only when non-zero)", () => {
  assert.equal(timeTokenToHM("45s"), "0m"); // both parts empty → fallback
  assert.equal(timeTokenToHM("5m"), "5m"); // hours empty → omitted, no padding
  assert.equal(timeTokenToHM("60m"), "1h"); // minutes empty → omitted
  assert.equal(timeTokenToHM("90m"), "1h 30m");
  assert.equal(timeTokenToHM("1.5h"), "1h 30m");
  assert.equal(timeTokenToHM("2h"), "2h");
  assert.equal(timeTokenToHM("1.0h"), "1h");
  assert.equal(timeTokenToHM("26h"), "26h"); // hours never wrap to days
});

test("timeTokenToHM: loop guard — our own output never re-converts (observer terminates)", () => {
  for (const out of ["0m", "5m", "1h", "1h 30m", "2h", "26h"]) {
    const again = timeTokenToHM(out);
    assert.ok(
      again === null || again === out,
      `"${out}" re-read as ${JSON.stringify(again)} — must be null or identical`,
    );
  }
});

test("timeTokenToHM: fails open on anything else (future wording / malformed)", () => {
  assert.equal(timeTokenToHM("1:30"), null); // the retired colon format
  assert.equal(timeTokenToHM(""), null);
  assert.equal(timeTokenToHM("90 min"), null);
  assert.equal(timeTokenToHM("soon"), null);
});

test("wiring: the library readout is wrapped (prop-less); the % row is themed out", () => {
  const chart = readSrc("../src/components/TradingChart/TradingChart.tsx");
  assert.match(
    chart,
    /<MeasureTimeFmt>[\s\S]*?<MeasurementOverlay\s*\/>[\s\S]*?<\/MeasureTimeFmt>/,
    "MeasurementOverlay mounts inside the formatting wrapper",
  );

  const styles = readSrc("../src/styles.css");
  assert.match(
    styles,
    /\.measure-time-fmt \.ck-measure-pct \{\s*display:\s*none/,
    "% row hidden by theming (the overlay exposes no formatter prop)",
  );

  const layer = readSrc("../src/components/TradingChart/DrawingLayer.tsx");
  const title = /export const MEASURE_TITLE = "([^"]*)"/.exec(layer);
  assert.ok(title, "MEASURE_TITLE exported");
  assert.ok(!title[1].includes("%"), "tooltip must not promise the hidden % move");
  assert.ok(title[1].includes("bars"), "tooltip still promises bars");
});
