/**
 * Instrument registry — unit tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *
 * Phase 0 multi-instrument: registry metadata (EPIC → label/precision/
 * calendar), config wiring with IG_DAX_EPIC backward compatibility, and the
 * per-instrument price rounding grid (DAX 1dp vs Spot Gold 2dp).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { Config } from "../config.js";
import {
  DAX_INSTRUMENT,
  GOLD_INSTRUMENT,
  configuredInstruments,
  instrumentMetaFor,
  roundToInstrumentPrecision,
} from "../market/instruments.js";

const cfg = (defaultEpic: string, goldEpic: string): Config =>
  ({ ig: { defaultEpic, goldEpic } }) as unknown as Config;

test("registry: DAX metadata — 1-decimal quoting, IG Germany 40 calendar", () => {
  const meta = instrumentMetaFor("IX.D.DAX.IGM.IP");
  assert.equal(meta.epic, DAX_INSTRUMENT.epic);
  assert.equal(meta.label, "DAX / IG");
  assert.equal(meta.decimals, 1);
  assert.equal(meta.calendar?.id, "ig-germany-40");
});

test("registry: Spot Gold metadata — 2-decimal SGD quoting, IG Spot Gold calendar", () => {
  const meta = instrumentMetaFor("CS.D.CFIGOLD.CFI.IP");
  assert.equal(meta.epic, GOLD_INSTRUMENT.epic);
  assert.ok(meta.label.includes("Gold"));
  assert.equal(meta.decimals, 2);
  assert.equal(meta.calendar?.id, "ig-spot-gold");
});

test("registry: unknown EPIC falls back BC-conservatively (1 decimal, no calendar)", () => {
  const meta = instrumentMetaFor("XX.D.UNKNOWN.IP");
  assert.equal(meta.epic, "XX.D.UNKNOWN.IP");
  assert.equal(meta.label, "XX.D.UNKNOWN.IP");
  assert.equal(meta.decimals, 1, "unregistered EPICs must keep the historic 1-decimal rounding");
  assert.equal(meta.calendar, null, "never guess another market's hours");
});

test("configuredInstruments: DAX-only config (goldEpic unset) → exactly one instrument", () => {
  const list = configuredInstruments(cfg("IX.D.DAX.IGM.IP", ""));
  assert.equal(list.length, 1);
  assert.equal(list[0].epic, "IX.D.DAX.IGM.IP");
});

test("configuredInstruments: both EPICs → DAX first (default), Gold second", () => {
  const list = configuredInstruments(cfg("IX.D.DAX.IGM.IP", "CS.D.CFIGOLD.CFI.IP"));
  assert.equal(list.length, 2);
  assert.equal(list[0].epic, "IX.D.DAX.IGM.IP");
  assert.equal(list[1].epic, "CS.D.CFIGOLD.CFI.IP");
});

test("configuredInstruments: duplicate EPICs collapse (never double-persist one market)", () => {
  const list = configuredInstruments(cfg("IX.D.DAX.IGM.IP", "IX.D.DAX.IGM.IP"));
  assert.equal(list.length, 1);
});

test("configuredInstruments: nothing configured → empty list", () => {
  assert.equal(configuredInstruments(cfg("", "")).length, 0);
});

test("rounding: DAX 1dp grid matches the historic Math.round(raw*10)/10 exactly", () => {
  const oldDaxRound = (raw: number): number => Math.round(raw * 10) / 10;
  const mids = [26069.53, 26067.0, 26072.299999999996, 18342.050000003, 24123.949999999999];
  for (const raw of mids) {
    assert.equal(roundToInstrumentPrecision(raw, 1), oldDaxRound(raw), `BC break at ${raw}`);
  }
});

test("rounding: Spot Gold keeps its cent digit (2dp) that DAX rounding would destroy", () => {
  assert.equal(roundToInstrumentPrecision(4467.473, 2), 4467.47);
  assert.equal(roundToInstrumentPrecision(4467.476, 2), 4467.48);
  assert.equal(roundToInstrumentPrecision(4467.97, 2), 4467.97);
  // The old 1-decimal path would quantize Gold onto a 0.1 grid — forbidden:
  assert.notEqual(roundToInstrumentPrecision(4467.476, 1), 4467.48);
});
