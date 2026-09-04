/**
 * Phase 3 — instrument selection tests (Node type-stripping runner):
 *   npm --prefix frontend run test
 *
 * Covers: registry loading (fetchInstruments), default-DAX resolution,
 * persisted selection (localStorage round-trip + stale stored EPIC fallback),
 * the selected EPIC reaching the history API (fetchCandlesDb), and catalog
 * lookup. The React hook consumes exactly these pure pieces.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { fetchCandlesDb } from "../src/services/api.ts";
import {
  INSTRUMENT_STORAGE_KEY,
  fetchInstruments,
  findInstrument,
  loadSelectedEpic,
  resolveSelectedEpic,
  saveSelectedEpic,
} from "../src/services/instruments.ts";

const DAX = "IX.D.DAX.IGM.IP";
const GOLD = "CS.D.CFIGOLD.CFI.IP";

const CATALOG = {
  defaultEpic: DAX,
  count: 2,
  instruments: [
    { epic: DAX, label: "DAX / IG", decimals: 1, calendar: { id: "ig-germany-40", label: "IG Germany 40 (DAX) CFD", timezone: "Europe/London" } },
    { epic: GOLD, label: "Spot Gold / IG", decimals: 2, calendar: { id: "ig-spot-gold", label: "IG Spot Gold (SGD) CFD", timezone: "Europe/London" } },
  ],
};

/** In-memory localStorage stand-in (also proves no `window` is required). */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    _map: map,
  };
}

// ── resolveSelectedEpic: default DAX, persisted pick, stale pick ─────────────

test("resolveSelectedEpic: no stored selection → registry default (DAX)", () => {
  assert.equal(resolveSelectedEpic([DAX, GOLD], DAX, null), DAX);
  assert.equal(resolveSelectedEpic([DAX, GOLD], DAX, ""), DAX);
});

test("resolveSelectedEpic: a persisted, still-registered EPIC wins", () => {
  assert.equal(resolveSelectedEpic([DAX, GOLD], DAX, GOLD), GOLD);
  assert.equal(resolveSelectedEpic([DAX, GOLD], DAX, DAX), DAX);
});

test("resolveSelectedEpic: a stale stored EPIC (removed from registry) falls back to default", () => {
  assert.equal(resolveSelectedEpic([DAX, GOLD], DAX, "MT.D.GC.FGM3.IP"), DAX);
});

test("resolveSelectedEpic: degenerate registries never crash (empty → '')", () => {
  assert.equal(resolveSelectedEpic([], "", null), "");
  assert.equal(resolveSelectedEpic([GOLD], "", null), GOLD, "no default → first registered");
});

// ── localStorage persistence ─────────────────────────────────────────────────

test("saveSelectedEpic/loadSelectedEpic round-trips through the storage key", () => {
  const storage = fakeStorage();
  assert.equal(loadSelectedEpic(storage), null);
  saveSelectedEpic(GOLD, storage);
  assert.equal(storage._map.get(INSTRUMENT_STORAGE_KEY), GOLD);
  assert.equal(loadSelectedEpic(storage), GOLD);
});

test("loadSelectedEpic survives throwing storage (private mode) → null", () => {
  const boom = { getItem: () => { throw new Error("blocked"); } };
  assert.equal(loadSelectedEpic(boom), null);
  const boomSet = { getItem: () => null, setItem: () => { throw new Error("blocked"); } };
  assert.doesNotThrow(() => saveSelectedEpic(GOLD, boomSet));
});

// ── registry loading (GET /api/instruments) ──────────────────────────────────

test("fetchInstruments parses the backend registry (source of truth)", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(CATALOG), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    const cat = await fetchInstruments();
    assert.ok(calls[0].endsWith("/api/instruments"), "must call GET /api/instruments");
    assert.equal(cat.defaultEpic, DAX);
    assert.equal(cat.instruments.length, 2);
    assert.equal(cat.instruments[1].decimals, 2);
    assert.equal(cat.instruments[1].calendar?.id, "ig-spot-gold");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchInstruments rejects malformed payloads instead of guessing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
  try {
    await assert.rejects(() => fetchInstruments(), (err) => err.code === "INVALID_INSTRUMENTS");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchInstruments surfaces backend error codes (e.g. 500)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "boom", code: "INTERNAL" }), { status: 500 }));
  try {
    await assert.rejects(() => fetchInstruments(), (err) => err.status === 500 && err.code === "INTERNAL");
  } finally {
    globalThis.fetch = original;
  }
});

// ── the selected EPIC reaches the history API ────────────────────────────────

test("fetchCandlesDb passes the selected EPIC to /api/candles/db", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ epic: GOLD, timeframe: "MINUTE_1", count: 1, candles: [{ time: 1788513600, open: 4477.5, high: 4477.9, low: 4477.1, close: 4477.6, tickCount: 12 }] }),
      { status: 200 },
    );
  });
  try {
    const { epic, candles } = await fetchCandlesDb("MINUTE_1", 500, GOLD);
    assert.ok(calls[0].includes(`epic=${encodeURIComponent(GOLD)}`), `history URL must carry the Gold EPIC — got ${calls[0]}`);
    assert.equal(epic, GOLD);
    assert.equal(candles.length, 1);
    assert.equal(candles[0].close, 4477.6);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchCandlesDb without an epic omits the param (backend defaults to DAX)", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ epic: DAX, timeframe: "MINUTE_1", count: 0, candles: [] }), { status: 200 });
  });
  try {
    await fetchCandlesDb("MINUTE_3", 500);
    assert.ok(!calls[0].includes("epic="), "BC: omitted epic must not send an epic param");
  } finally {
    globalThis.fetch = original;
  }
});

// ── catalog lookup ───────────────────────────────────────────────────────────

test("findInstrument resolves metadata for the active EPIC (null when unknown)", () => {
  assert.equal(findInstrument(CATALOG, GOLD)?.label, "Spot Gold / IG");
  assert.equal(findInstrument(CATALOG, DAX)?.decimals, 1);
  assert.equal(findInstrument(CATALOG, "BOGUS"), null);
  assert.equal(findInstrument(null, DAX), null);
});
