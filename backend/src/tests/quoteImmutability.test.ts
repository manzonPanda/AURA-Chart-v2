/**
 * QUOTE IMMUTABILITY AFTER AUTHORITATIVE CLOSE — unit tests (Node test runner
 * via tsx).   npm --prefix backend run test
 *
 * Forensic fix #2: once an authoritative candle CLOSES (the exact OHLC that is
 * persisted), that bucket is IMMUTABLE for chart display. Capital's marketData
 * quote stream and its MINUTE OHLC stream are INDEPENDENT deliveries, so a
 * quote can legitimately arrive AFTER the OHLC candle it belongs to — and that
 * late quote must never repaint the already-closed candle.
 *
 * `unit.lastClosedSec` (set on every authoritative rollover in
 * processInstrumentTick) is the ledger; `processInstrumentQuote` drops any
 * quote whose bucket is ≤ it. The 6dd0927 gate (`bucket < authoritativeTime`,
 * the 3M freeze fix) stays intact and is re-asserted here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createInstrumentUnit,
  processInstrumentQuote,
  processInstrumentTick,
  syncDisplayFromAggregator,
  type QuoteResult,
} from "../streaming/instrumentPipeline.js";
import type { IngTick } from "../streaming/types.js";

const GOLD = "GOLD";

/** 60 s-grid bucket helpers (epoch ms). 08:00:00.000Z start. */
const EPOCH = Date.UTC(2026, 8, 4, 8, 0);
const T = (secs: number, ms = 0): number => EPOCH + secs * 1000 + ms;
/** Bucket-start epoch SECONDS for `secs` seconds after EPOCH (candle.time). */
const B = (secs: number): number => EPOCH / 1000 + secs;

function quoteMid(tsMs: number, price: number): IngTick {
  const bid = Math.round((price - 0.05) * 100) / 100;
  const offer = Math.round((price + 0.05) * 100) / 100;
  return { tsMs, price, volume: 0, bid, offer, arriveMs: Date.now(), priceRaw: price, priceField: "MID" };
}

function ohlcTick(tsMs: number, price: number): IngTick {
  return { tsMs, price, volume: 0, bid: price, offer: price, arriveMs: Date.now(), priceRaw: price, priceField: "MID" };
}

const m1 = (results: QuoteResult[]) => results.find((r) => r.timeframe === "MINUTE_1");
const m3 = (results: QuoteResult[]) => results.find((r) => r.timeframe === "MINUTE_3");

test("closed bucket is immutable: a LATE quote for an already-closed bucket is dropped", () => {
  const unit = createInstrumentUnit(GOLD, "Spot Gold / Capital.com", 2);

  // 08:00 forms from its OHLC pair, quotes paint the 08:01 display…
  processInstrumentTick(unit, ohlcTick(T(0), 4300.0));
  syncDisplayFromAggregator(unit);
  assert.ok(m1(processInstrumentQuote(unit, quoteMid(T(60, 100), 4308.42)))?.display);

  // …the 08:01 pair arrives → 08:00 CLOSES authoritatively.
  const closed = processInstrumentTick(unit, ohlcTick(T(60), 4307.9)).find(
    (r) => r.timeframe === "MINUTE_1",
  )?.closed;
  assert.ok(closed, "bucket 08:00 closed");

  // A LATE quote belonging to the CLOSED 08:00 bucket (quote/OHLC deliveries
  // are independent — this arrives AFTER the close) must NOT produce a
  // display frame: the closed bucket is immutable.
  const late = m1(processInstrumentQuote(unit, quoteMid(T(30, 900), 4308.42)));
  assert.equal(late?.display, undefined, "late quote for the closed bucket is dropped");

  // And the display never rewinds into the closed bucket.
  assert.equal(unit.aggregators.getCandleFor(60)?.time, B(60), "aggregator on the forming 08:01");
  assert.notEqual(unit.liveDisplay.get("MINUTE_1")?.time, B(0), "display stays ahead of the closed bucket");
});

test("closed bucket stays immutable for BOTH timeframes (1m + 3m overlay)", () => {
  const unit = createInstrumentUnit(GOLD, "Spot Gold / Capital.com", 2);

  // 3m authoritative forming bucket 08:03 (opens late, like production).
  processInstrumentTick(unit, ohlcTick(T(180), 4335.0));
  syncDisplayFromAggregator(unit);
  // Quotes drive the NEXT 3m bucket 08:06.
  assert.ok(m3(processInstrumentQuote(unit, quoteMid(T(400, 100), 4340.0)))?.display);

  // The 1m pairs arriving inside the NEXT 3m bucket (08:06) roll the 3m grid:
  // the tick stamped 08:06 closes the 08:03 3m bucket authoritatively.
  processInstrumentTick(unit, ohlcTick(T(240), 4341.0)); // closes 1m 08:03
  processInstrumentTick(unit, ohlcTick(T(300), 4342.0)); // closes 1m 08:04
  const closed3m = processInstrumentTick(unit, ohlcTick(T(360), 4343.0)).find(
    (r) => r.timeframe === "MINUTE_3",
  )?.closed;
  assert.ok(closed3m, "3m bucket 08:03 closed");
  assert.equal(closed3m?.time, B(180));

  // Late 3m quotes stamped inside the closed 08:03 bucket → dropped.
  const late3m = m3(processInstrumentQuote(unit, quoteMid(T(200, 500), 4399.0)));
  assert.equal(late3m?.display, undefined, "late 3m quote for the closed bucket is dropped");
  // The display stays on the newer bucket — never rewound into the closed one.
  assert.equal(unit.liveDisplay.get("MINUTE_3")?.time, B(360));
});

test("immutability does NOT block the NEXT forming bucket (3M smooth display preserved)", () => {
  const unit = createInstrumentUnit(GOLD, "Spot Gold / Capital.com", 2);

  // Authoritative 3m forming 08:03 → closes at the 08:06 1m pair arrival.
  processInstrumentTick(unit, ohlcTick(T(180), 4335.0));
  syncDisplayFromAggregator(unit);
  processInstrumentTick(unit, ohlcTick(T(360), 4343.0)); // rolls 3m to 08:06

  // Quotes for the NEW forming 08:06 bucket still merge (the freeze fix lives).
  const q1 = m3(processInstrumentQuote(unit, quoteMid(T(370, 100), 4350.0)));
  assert.ok(q1?.display, "the next forming bucket still receives quotes");
  assert.equal(q1?.display?.time, B(360));
  const q2 = m3(processInstrumentQuote(unit, quoteMid(T(380, 100), 4355.0)));
  assert.equal(q2?.display?.high, 4355.0, "same-bucket quote still extends high");
  assert.equal(q2?.display?.open, 4350.0, "open immutable within the live bucket");

  // The 1m smooth-display path is equally unaffected by the closed ledger.
  const q1m = m1(processInstrumentQuote(unit, quoteMid(T(370, 200), 4351.0)));
  assert.ok(q1m?.display, "1m display continues after a close");
  assert.equal(q1m?.display?.time, B(360));
});

test("6dd0927 gate intact: strictly-older quotes still rejected, same-bucket quotes still merge", () => {
  const unit = createInstrumentUnit(GOLD, "Spot Gold / Capital.com", 2);
  processInstrumentTick(unit, ohlcTick(T(60), 4335.0)); // authoritative forming 08:01
  syncDisplayFromAggregator(unit);

  // Older bucket than the authoritative FORMING candle → rejected (unchanged).
  const stale = m1(processInstrumentQuote(unit, quoteMid(T(0, 400), 4300.0)));
  assert.equal(stale?.display, undefined, "older-bucket quote still ignored");

  // Same-bucket quote still merges into the display (the 3M freeze fix).
  const same = m1(processInstrumentQuote(unit, quoteMid(T(60, 400), 4399.0)));
  assert.ok(same?.display, "same-bucket quote still merges");
  assert.equal(same?.display?.time, B(60));
  assert.equal(same?.display?.open, 4335.0, "open stays the authoritative OHLC open");
});
