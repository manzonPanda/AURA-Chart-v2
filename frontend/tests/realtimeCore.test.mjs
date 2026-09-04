/**
 * Phase 3 — realtime WS primitive tests (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * Covers the pure pieces of the instrument-aware stream layer:
 *   - buildRealtimeWsUrl: the WS URL carries the SELECTED epic (and scheme).
 *   - isFrameForInstrument: stale frames from the other instrument are
 *     rejected; BC frames without an epic pass.
 *   - initialStream: every switch starts from a CLEAN boundary (no previous
 *     instrument's candle/counters can survive).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRealtimeWsUrl,
  initialStream,
  isFrameForInstrument,
} from "../src/services/realtimeCore.ts";

const DAX = "IX.D.DAX.IGM.IP";
const GOLD = "CS.D.CFIGOLD.CFI.IP";
const LOC = { protocol: "http:", host: "localhost:5173" };

// ── WS URL building ──────────────────────────────────────────────────────────

test("buildRealtimeWsUrl embeds the selected EPIC + resolution", () => {
  const url = buildRealtimeWsUrl("MINUTE_1", GOLD, LOC);
  assert.ok(url.startsWith("ws://localhost:5173/ws?"), url);
  assert.ok(url.includes("res=MINUTE_1"), url);
  assert.ok(url.includes(`epic=${encodeURIComponent(GOLD)}`), url);
});

test("buildRealtimeWsUrl: https page → wss; omitted epic → no epic param (BC default)", () => {
  const wss = buildRealtimeWsUrl("MINUTE_3", DAX, { protocol: "https:", host: "aura.example" });
  assert.ok(wss.startsWith("wss://aura.example/ws?"), wss);
  const noEpic = buildRealtimeWsUrl("MINUTE_3", undefined, LOC);
  assert.ok(!noEpic.includes("epic="), noEpic);
  assert.ok(noEpic.includes("res=MINUTE_3"), noEpic);
});

// ── stale-frame instrument guard ─────────────────────────────────────────────

test("isFrameForInstrument: frames for the OTHER instrument are rejected (both directions)", () => {
  assert.equal(isFrameForInstrument(GOLD, DAX), false, "a Gold frame must not update a DAX view");
  assert.equal(isFrameForInstrument(DAX, GOLD), false, "a DAX frame must not update a Gold view");
});

test("isFrameForInstrument: own-instrument frames and BC frames pass", () => {
  assert.equal(isFrameForInstrument(DAX, DAX), true);
  assert.equal(isFrameForInstrument(GOLD, GOLD), true);
  assert.equal(isFrameForInstrument(undefined, DAX), true, "older backend frames carry no epic → BC pass-through");
  assert.equal(isFrameForInstrument(null, GOLD), true);
  assert.equal(isFrameForInstrument("", DAX), true);
});

test("isFrameForInstrument: unresolved selection accepts everything (backend default = DAX)", () => {
  assert.equal(isFrameForInstrument(DAX, ""), true);
  assert.equal(isFrameForInstrument(GOLD, ""), true);
});

// ── clean-switch boundary ────────────────────────────────────────────────────

test("initialStream is a blank boundary — no candle, zeroed counters (both instruments)", () => {
  for (const status of ["DISCONNECTED", "CONNECTING"]) {
    const s = initialStream(status);
    assert.equal(s.candle, null, "the previous instrument's forming candle must be gone");
    assert.equal(s.emaAlert, null);
    assert.equal(s.ticks, 0);
    assert.equal(s.lastPrice, null);
    assert.equal(s.lastTickAt, 0);
    assert.equal(s.status, status);
  }
  assert.equal(initialStream().status, "DISCONNECTED");
});