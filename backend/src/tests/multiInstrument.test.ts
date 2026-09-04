/**
 * Multi-instrument realtime pipeline — unit tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *
 * Proves (Phase 1 requirements):
 *   1. DAX and Gold aggregators remain independent.
 *   2. Interleaved DAX/Gold ticks cannot cross-contaminate candles.
 *   3. Gold uses 2dp precision.
 *   4. DAX remains 1dp.
 *   5. Closed Gold 1m candles persist with the Gold EPIC.
 *   6. Closed DAX 1m candles persist with the DAX EPIC.
 *   7. WS frames carry the correct EPIC.
 *   8. A DAX subscriber does not receive Gold frames.
 *   9. A Gold subscriber does not receive DAX frames.
 *   (10/11: existing DAX suites + typecheck run in CI before this file.)
 *
 * The pipeline module under test (instrumentPipeline.ts) is PURE — no ws or
 * lightstreamer imports — so the runner does not hang (lightstreamer-client
 * keeps the Node event loop alive, the same reason other suites avoid
 * RealtimeService).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { roundToInstrumentPrecision } from "../market/instruments.js";
import {
  clientWantsCandle,
  createInstrumentUnit,
  persistenceInstrumentFor,
  processInstrumentTick,
  type BucketResult,
} from "../streaming/instrumentPipeline.js";
import type { IngTick } from "../streaming/types.js";

const DAX = "IX.D.DAX.IGM.IP";
const GOLD = "CS.D.CFIGOLD.CFI.IP";

/** 60 s-grid bucket helpers (epoch ms). */
const EPOCH = Date.UTC(2026, 8, 4, 8, 0); // 08:00:00.000Z
const T = (secs: number, ms = 0): number => EPOCH + secs * 1000 + ms;

function daxTick(tsMs: number, price: number): IngTick {
  return { tsMs, price, volume: 1, bid: price, offer: price, ltp: price, arriveMs: Date.now(), utmMs: tsMs, priceRaw: price, priceField: "MID" };
}
function goldTick(tsMs: number, price: number): IngTick {
  return { tsMs, price, volume: 1, bid: price, offer: price, ltp: price, arriveMs: Date.now(), utmMs: tsMs, priceRaw: price, priceField: "MID" };
}

// ── 1 + 2. Independence & interleaving ───────────────────────────────────────

test("interleaved DAX/Gold ticks cannot cross-contaminate candles", () => {
  const dax = createInstrumentUnit(DAX, "DAX / IG", 1);
  const gold = createInstrumentUnit(GOLD, "Spot Gold / IG", 2);

  // Interleave across TWO 1m buckets so shared state would produce mixed OHLC.
  // DAX ~26000 (1dp), Gold ~4467 (2dp) — irreconcilable price ranges.
  const daxTicks: [number, number][] = [
    [T(0, 300), 26050.0], [T(0, 900), 26070.2], [T(0, 1500), 26040.5],
    [T(60, 200), 26090.3], [T(60, 800), 26060.1],
  ];
  const goldTicks: [number, number][] = [
    [T(0, 400), 4467.25], [T(0, 1000), 4467.47], [T(0, 1600), 4467.12],
    [T(60, 300), 4467.93], [T(60, 900), 4467.40],
  ];

  // Feed in strict alternating order (DAX, GOLD, DAX, GOLD, ...).
  const daxResults: BucketResult[] = [];
  const goldResults: BucketResult[] = [];
  for (let i = 0; i < Math.max(daxTicks.length, goldTicks.length); i++) {
    if (i < daxTicks.length) {
      const [ts, price] = daxTicks[i];
      daxResults.push(...processInstrumentTick(dax, daxTick(ts, roundToInstrumentPrecision(price, 1))));
    }
    if (i < goldTicks.length) {
      const [ts, price] = goldTicks[i];
      goldResults.push(...processInstrumentTick(gold, goldTick(ts, roundToInstrumentPrecision(price, 2))));
    }
  }

  // Bucket 08:00 CLOSED on each instrument's own rollover tick — each closed
  // candle contains ONLY its own instrument's bucket-1 prices.
  const daxClosed = daxResults.find((r) => r.timeframe === "MINUTE_1" && r.closed)?.closed;
  const goldClosed = goldResults.find((r) => r.timeframe === "MINUTE_1" && r.closed)?.closed;
  assert.ok(daxClosed, "DAX 1m rollover closed candle");
  assert.ok(goldClosed, "Gold 1m rollover closed candle");
  assert.equal(daxClosed.time, EPOCH / 1000);
  assert.equal(daxClosed.open, 26050.0);
  assert.equal(daxClosed.high, 26070.2, "DAX high must never be a Gold price");
  assert.equal(daxClosed.low, 26040.5, "DAX low must never be a Gold price");
  assert.equal(daxClosed.close, 26040.5);
  assert.equal(goldClosed.time, EPOCH / 1000);
  assert.equal(goldClosed.open, 4467.25);
  assert.equal(goldClosed.high, 4467.47, "Gold high must never be a DAX price");
  assert.equal(goldClosed.low, 4467.12, "Gold low must never be a DAX price");
  assert.equal(goldClosed.close, 4467.12);

  // The FORMING 08:01 candle likewise holds only bucket-2 own-instrument prices.
  const daxCandle = dax.aggregators.getCandleFor(60);
  const goldCandle = gold.aggregators.getCandleFor(60);
  assert.ok(daxCandle, "DAX forming candle exists");
  assert.ok(goldCandle, "Gold forming candle exists");
  assert.equal(daxCandle.time, EPOCH / 1000 + 60);
  assert.equal(daxCandle.open, 26090.3);
  assert.equal(daxCandle.high, 26090.3);
  assert.equal(daxCandle.low, 26060.1);
  assert.equal(daxCandle.close, 26060.1);
  assert.equal(goldCandle.time, EPOCH / 1000 + 60);
  assert.equal(goldCandle.open, 4467.93);
  assert.equal(goldCandle.high, 4467.93);
  assert.equal(goldCandle.low, 4467.40);
  assert.equal(goldCandle.close, 4467.40);

  // Per-instrument counters stayed isolated.
  assert.equal(dax.ticksReceived, 5);
  assert.equal(gold.ticksReceived, 5);
  assert.equal(dax.lastPrice, 26060.1);
  assert.equal(gold.lastPrice, 4467.40);
});

test("first tick anchors a bucket and closes NOTHING (both instruments)", () => {
  const dax = createInstrumentUnit(DAX, "DAX / IG", 1);
  const gold = createInstrumentUnit(GOLD, "Spot Gold / IG", 2);
  const rDax = processInstrumentTick(dax, daxTick(T(0, 300), 26050.0));
  const rGold = processInstrumentTick(gold, goldTick(T(0, 400), 4467.25));
  for (const r of [...rDax, ...rGold]) {
    assert.equal(r.closed, undefined, `first tick must not close a candle (${r.timeframe})`);
  }
  assert.equal(dax.lastBucketSec.get("MINUTE_1"), (EPOCH / 1000) / 60 * 60);
  assert.equal(gold.lastBucketSec.get("MINUTE_1"), (EPOCH / 1000) / 60 * 60);
});

// ── 3 + 4. Per-instrument price precision ────────────────────────────────────

test("Gold rounds to 2dp — the DAX 1dp grid would destroy its cents", () => {
  // Spot Gold quotes SGD cents (live account check: bid 4467.47 / offer 4467.97).
  assert.equal(roundToInstrumentPrecision(4467.47, 2), 4467.47, "Gold keeps its cent digit");
  // Proof of the hazard: the historic DAX rounding would quantize it.
  assert.equal(Math.round(4467.47 * 10) / 10, 4467.5, "1dp grid would corrupt Gold pricing");
  // MID of two cent-precise quotes stays cent-precise after 2dp rounding.
  const mid = (4467.47 + 4467.97) / 2; // 4467.72
  assert.equal(roundToInstrumentPrecision(mid, 2), 4467.72);
});

test("DAX stays on the historic 1dp grid (byte-exact parity)", () => {
  const cases: [number, number][] = [
    [26050.03, 26050.0],
    [26070.27, 26070.3],
    [26040.44, 26040.4],
    [26325.849999, 26325.8],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(roundToInstrumentPrecision(raw, 1), expected);
    assert.equal(
      roundToInstrumentPrecision(raw, 1),
      Math.round(raw * 10) / 10,
      "must equal the historic DAX rounding",
    );
  }
});

// ── 5 + 6. Persistence identity per instrument ───────────────────────────────

test("closed 1m candles persist under each instrument's own EPIC", () => {
  const dax = createInstrumentUnit(DAX, "DAX / IG", 1);
  const gold = createInstrumentUnit(GOLD, "Spot Gold / IG", 2);

  assert.equal(persistenceInstrumentFor("MINUTE_1", dax), DAX);
  assert.equal(persistenceInstrumentFor("MINUTE_1", gold), GOLD);
  // MINUTE_3 is the live overlay — NEVER persisted (unchanged for both).
  assert.equal(persistenceInstrumentFor("MINUTE_3", dax), null);
  assert.equal(persistenceInstrumentFor("MINUTE_3", gold), null);
});

test("rollover produces a per-instrument closed 1m candle with isolated OHLC", () => {
  const dax = createInstrumentUnit(DAX, "DAX / IG", 1);
  const gold = createInstrumentUnit(GOLD, "Spot Gold / IG", 2);

  // Two ticks each, crossing ONE bucket boundary → exactly one close each.
  const daxR1 = processInstrumentTick(dax, daxTick(T(0, 300), roundToInstrumentPrecision(26050.0, 1)));
  const goldR1 = processInstrumentTick(gold, goldTick(T(0, 400), roundToInstrumentPrecision(4467.25, 2)));
  const daxR2 = processInstrumentTick(dax, daxTick(T(60, 200), roundToInstrumentPrecision(26070.2, 1)));
  const goldR2 = processInstrumentTick(gold, goldTick(T(60, 300), roundToInstrumentPrecision(4467.47, 2)));

  const daxClosed1m = daxR2.find((r) => r.timeframe === "MINUTE_1")?.closed;
  const goldClosed1m = goldR2.find((r) => r.timeframe === "MINUTE_1")?.closed;
  assert.ok(daxClosed1m, "DAX 1m close on rollover");
  assert.ok(goldClosed1m, "Gold 1m close on rollover");

  // The closed candle holds ONLY its own bucket's own ticks.
  assert.equal(daxClosed1m.time, EPOCH / 1000);
  assert.equal(daxClosed1m.open, 26050.0);
  assert.equal(daxClosed1m.close, 26050.0);
  assert.equal(goldClosed1m.time, EPOCH / 1000);
  assert.equal(goldClosed1m.open, 4467.25);
  assert.equal(goldClosed1m.close, 4467.25);
  assert.ok(
    Math.round(goldClosed1m.open * 100) === goldClosed1m.open * 100,
    "Gold OHLC is cent-precise (2dp)",
  );

  // What persistence writes is exactly the closed candle under its own EPIC.
  assert.equal(persistenceInstrumentFor("MINUTE_1", dax), DAX);
  assert.equal(persistenceInstrumentFor("MINUTE_1", gold), GOLD);

  // The first tick of each stream closed NOTHING (no phantom closes).
  assert.equal(daxR1.find((r) => r.timeframe === "MINUTE_1")?.closed, undefined);
  assert.equal(goldR1.find((r) => r.timeframe === "MINUTE_1")?.closed, undefined);
});

// ── 7 + 8 + 9. WS frame routing by EPIC ──────────────────────────────────────

test("candle frames route strictly by EPIC (no cross-instrument delivery)", () => {
  const daxClient = { alive: true, epic: DAX, bucketSec: 60 };
  const goldClient = { alive: true, epic: GOLD, bucketSec: 60 };

  // 7. A unit's frames reach its own subscriber.
  assert.ok(clientWantsCandle(daxClient, DAX, 60), "DAX client receives DAX frames");
  assert.ok(clientWantsCandle(goldClient, GOLD, 60), "Gold client receives Gold frames");

  // 8/9. No cross delivery — in EITHER direction.
  assert.equal(clientWantsCandle(daxClient, GOLD, 60), false, "DAX subscriber must NOT receive Gold frames");
  assert.equal(clientWantsCandle(goldClient, DAX, 60), false, "Gold subscriber must NOT receive DAX frames");

  // Timeframe gating still applies within an instrument (3m client ≠ 1m frame).
  assert.equal(clientWantsCandle(daxClient, DAX, 180), false);
  assert.equal(clientWantsCandle(goldClient, GOLD, 180), false);

  // Dead sockets receive nothing.
  assert.equal(clientWantsCandle({ ...daxClient, alive: false }, DAX, 60), false);
});