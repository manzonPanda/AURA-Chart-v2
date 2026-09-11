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
  SILVER_INSTRUMENT,
  configuredInstruments,
  instrumentMetaFor,
  roundToInstrumentPrecision,
} from "../market/instruments.js";

const cfg = (defaultEpic: string, goldEpic: string, silverEpic = ""): Config =>
  ({ ig: { defaultEpic, goldEpic, silverEpic } }) as unknown as Config;

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

// ── Silver + DAX-disable (collection reconfiguration) ────────────────────────

test("registry: Silver metadata — canonical EPIC CS.D.CFDSILVER.CMG.IP, IG Spot Silver calendar", () => {
  const meta = instrumentMetaFor("CS.D.CFDSILVER.CMG.IP");
  assert.equal(meta.epic, SILVER_INSTRUMENT.epic);
  assert.equal(SILVER_INSTRUMENT.epic, "CS.D.CFDSILVER.CMG.IP", "canonical Silver EPIC is frozen");
  assert.ok(meta.label.includes("Silver"));
  assert.equal(meta.decimals, 2, "one pip = 1 Cents/Troy Ounce ⇒ cent quoting grid (2dp), same rule as Gold");
  assert.equal(meta.calendar?.id, "ig-spot-silver", "Silver has its OWN calendar identifier");
  assert.notEqual(meta.calendar?.id, "ig-germany-40", "Silver never uses the DAX calendar");
  assert.notEqual(meta.calendar?.id, "ig-spot-gold", "Silver never silently aliases the Gold calendar object");
});

test("registry: Gold identity is UNCHANGED — same EPIC, label, decimals, calendar as before Silver", () => {
  const meta = instrumentMetaFor("CS.D.CFIGOLD.CFI.IP");
  assert.equal(GOLD_INSTRUMENT.epic, "CS.D.CFIGOLD.CFI.IP", "Gold EPIC frozen");
  assert.equal(meta.decimals, 2);
  assert.equal(meta.calendar?.id, "ig-spot-gold");
});

test("registry: DAX entry is still REGISTERED (existing rows/DB identity never dropped)", () => {
  const meta = instrumentMetaFor("IX.D.DAX.IGM.IP");
  assert.equal(DAX_INSTRUMENT.epic, "IX.D.DAX.IGM.IP");
  assert.equal(meta.calendar?.id, "ig-germany-40");
});

test("configuredInstruments: DAX collection DISABLED when IG_DAX_EPIC is empty — only Gold+Silver collect", () => {
  const list = configuredInstruments(cfg("", "CS.D.CFIGOLD.CFI.IP", "CS.D.CFDSILVER.CMG.IP"));
  assert.equal(list.length, 2, "empty DAX epic ⇒ DAX never enters the collection set");
  assert.equal(list[0].epic, "CS.D.CFIGOLD.CFI.IP", "Gold enabled");
  assert.equal(list[1].epic, "CS.D.CFDSILVER.CMG.IP", "Silver enabled");
  assert.ok(!list.some((i) => i.epic === "IX.D.DAX.IGM.IP"), "no DAX stream/backfill/scheduled collection");
});

test("configuredInstruments: Silver disabled when IG_SILVER_EPIC unset (BC) — Gold behavior unchanged", () => {
  const list = configuredInstruments(cfg("", "CS.D.CFIGOLD.CFI.IP"));
  assert.equal(list.length, 1);
  assert.equal(list[0].epic, "CS.D.CFIGOLD.CFI.IP");
});

test("configuredInstruments: duplicate Silver/Gold EPICs collapse (never double-persist one market)", () => {
  const list = configuredInstruments(cfg("", "CS.D.CFIGOLD.CFI.IP", "CS.D.CFIGOLD.CFI.IP"));
  assert.equal(list.length, 1);
});

test("DB identity: instrument column = raw EPIC, so Gold/Silver/DAX cannot collide in Supabase", () => {
  const identities = new Set(
    [GOLD_INSTRUMENT.epic, SILVER_INSTRUMENT.epic, DAX_INSTRUMENT.epic],
  );
  assert.equal(identities.size, 3, "three distinct (instrument,timeframe,bucket_time) partitions");
  // The canonical SMT pair shares nothing but the bucket grid:
  assert.notEqual(GOLD_INSTRUMENT.epic, SILVER_INSTRUMENT.epic);
});

test("rounding: Spot Silver keeps its cent digit (2dp) — one pip = 1 Cent/Troy Ounce", () => {
  assert.equal(roundToInstrumentPrecision(6393.94, 2), 6393.94);
  assert.equal(roundToInstrumentPrecision(6393.976, 2), 6393.98);
  assert.notEqual(roundToInstrumentPrecision(6393.976, 1), 6393.98, "1dp would destroy Silver's cent pip");
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
