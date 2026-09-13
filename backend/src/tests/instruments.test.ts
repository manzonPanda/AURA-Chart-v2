/**
 * Instrument registry — unit tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *
 * Provider model (IG RETIRED): registry metadata (EPIC → label/precision/
 * calendar), the CAPITAL-only COLLECTION set, the wider UI/historical ARCHIVE
 * catalog, and the per-instrument price rounding grid (DAX 1dp vs Gold/Silver
 * 2dp). Tests prove: GOLD resolves to CAPITAL, SILVER is NOT actively
 * collected, and there is no IG fallback when Capital is unconfigured.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { Config } from "../config.js";
import {
  DAX_INSTRUMENT,
  GOLD_INSTRUMENT,
  LEGACY_GOLD_INSTRUMENT,
  SILVER_INSTRUMENT,
  configuredInstruments,
  instrumentMetaFor,
  roundToInstrumentPrecision,
  uiInstruments,
} from "../market/instruments.js";

const cfg = (capital?: { apiKey?: string; apiPassword?: string; identifier?: string }): Config =>
  ({
    capital: {
      apiKey: capital?.apiKey ?? "",
      apiPassword: capital?.apiPassword ?? "",
      identifier: capital?.identifier ?? "",
      baseUrl: "https://api-capital.backend-capital.com",
      streamingUrl: "wss://api-streaming-capital.backend-capital.com/connect",
    },
  }) as unknown as Config;

const CAPITAL = { apiKey: "test-key", apiPassword: "test-pw", identifier: "test@example.com" };

// ── Registry metadata (archive entries retain their identities) ──────────────

test("registry: DAX metadata — 1-decimal quoting, IG Germany 40 calendar, archive label", () => {
  const meta = instrumentMetaFor("IX.D.DAX.IGM.IP");
  assert.equal(meta.epic, DAX_INSTRUMENT.epic);
  assert.ok(meta.label.includes("archive"), "DAX is labelled as a legacy archive entry");
  assert.equal(meta.decimals, 1);
  assert.equal(meta.calendar?.id, "ig-germany-40");
  assert.equal(meta.provider, "IG", "DAX's provider tag is the legacy IG label — it is never collected");
});

test("registry: Spot Gold metadata — CAPITAL provider, 2dp, Globex gold calendar", () => {
  const meta = instrumentMetaFor("GOLD");
  assert.equal(meta.epic, GOLD_INSTRUMENT.epic);
  assert.equal(meta.epic, "GOLD", "Gold EPIC is the Capital.com symbol");
  assert.ok(meta.label.includes("Gold"));
  assert.equal(meta.decimals, 2);
  assert.equal(meta.calendar?.id, "ig-spot-gold");
  assert.equal(meta.provider, "CAPITAL", "Gold streams/persists via Capital.com — the ONLY active provider");
});

test("registry: Silver metadata — legacy IG identity retained as ARCHIVE ONLY, never collected", () => {
  const meta = instrumentMetaFor("CS.D.CFDSILVER.CMG.IP");
  assert.equal(meta.epic, SILVER_INSTRUMENT.epic);
  assert.equal(SILVER_INSTRUMENT.epic, "CS.D.CFDSILVER.CMG.IP", "canonical archive Silver EPIC is frozen");
  assert.ok(SILVER_INSTRUMENT.label.includes("archive"), "Silver is labelled as archive-only, not active");
  assert.equal(SILVER_INSTRUMENT.provider, "IG");
  assert.equal(meta.decimals, 2);
  assert.equal(meta.calendar?.id, "ig-spot-silver", "Silver keeps its own archive calendar");
});

test("registry: legacy IG Gold still resolves for archive reads", () => {
  const meta = instrumentMetaFor("CS.D.CFIGOLD.CFI.IP");
  assert.equal(meta.epic, LEGACY_GOLD_INSTRUMENT.epic);
  assert.equal(meta.provider, "IG");
  assert.equal(meta.decimals, 2);
});

test("registry: unknown EPIC falls back BC-conservatively (1 decimal, no calendar)", () => {
  const meta = instrumentMetaFor("XX.D.UNKNOWN.IP");
  assert.equal(meta.epic, "XX.D.UNKNOWN.IP");
  assert.equal(meta.decimals, 1, "unregistered EPICs must keep the historic 1-decimal rounding");
  assert.equal(meta.calendar, null, "never guess another market's hours");
  assert.equal(meta.provider, "IG", "unregistered epics carry the safe legacy label — RealtimeService refuses them");
});

// ── COLLECTION SET — CAPITAL only, no IG fallback ───────────────────────────

test("GOLD resolves to CAPITAL: with Capital creds the collection set is exactly [GOLD]", () => {
  const list = configuredInstruments(cfg(CAPITAL));
  assert.deepEqual(list.map((i) => i.epic), ["GOLD"], "the ONLY collected instrument is GOLD (Capital)");
  assert.equal(list[0].provider, "CAPITAL");
});

test("SILVER is NOT collected: never in the collection set (no guessed Capital symbol)", () => {
  const list = configuredInstruments(cfg(CAPITAL));
  assert.ok(!list.some((i) => i.epic === "CS.D.CFDSILVER.CMG.IP"), "the IG Silver epic is NOT collected");
  assert.equal(list.length, 1, "SILVER → CAPITAL is deliberately NOT configured yet");
});

test("DAX is NOT collected: the IG archive entries never enter the collection set", () => {
  const list = configuredInstruments(cfg(CAPITAL));
  assert.ok(!list.some((i) => i.provider === "IG"), "no IG-provider entry can become active");
  assert.ok(!list.some((i) => i.epic === "IX.D.DAX.IGM.IP"));
});

test("NO IG fallback: without Capital creds the collection set is EMPTY (nothing collected)", () => {
  const list = configuredInstruments(cfg());
  assert.deepEqual(list, [], "Capital unconfigured ⇒ no market data collected; IG is NOT a fallback");
});

// ── UI / ARCHIVE catalog (wider than the collection set) ────────────────────

test("uiInstruments: with Capital creds → DAX archive + GOLD active + SILVER archive", () => {
  const list = uiInstruments(cfg(CAPITAL));
  const epics = list.map((i) => i.epic);
  assert.ok(epics.includes("GOLD"), "GOLD listed as the active instrument");
  assert.ok(epics.includes("IX.D.DAX.IGM.IP"), "DAX retained for archive reads");
  assert.ok(epics.includes("CS.D.CFDSILVER.CMG.IP"), "Silver retained for archive reads");
  assert.ok(!epics.includes("CS.D.CFIGOLD.CFI.IP"), "legacy IG Gold stays out of the UI list");
});

test("uiInstruments: without Capital creds → archive catalog still lists legacy Gold", () => {
  const list = uiInstruments(cfg());
  const epics = list.map((i) => i.epic);
  assert.ok(epics.includes("CS.D.CFIGOLD.CFI.IP"), "legacy gold remains viewable in the archive catalog");
  assert.ok(epics.includes("IX.D.DAX.IGM.IP"));
});

// ── DB identity + rounding grid (unchanged invariants) ──────────────────────

test("DB identity: instrument column = raw symbol/EPIC — Gold/Silver/DAX cannot collide", () => {
  const identities = new Set([GOLD_INSTRUMENT.epic, SILVER_INSTRUMENT.epic, DAX_INSTRUMENT.epic]);
  assert.equal(identities.size, 3, "three distinct (instrument,timeframe,bucket_time) partitions");
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
  assert.notEqual(roundToInstrumentPrecision(4467.476, 1), 4467.48);
});
