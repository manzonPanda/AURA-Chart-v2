/**
 * Quote-driven LIVE DISPLAY pipeline tests — unit tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *
 * The pure pipeline module under test is instrumentPipeline.ts (no ws/streaming
 * imports — the streaming websocket layer keeps the Node event loop alive, so
 * suites avoid RealtimeService just like multiInstrument.test.ts).
 *
 * Covers the live forming-candle overlay built from Capital marketData quote
 * mids and its STRICT isolation from the authoritative OHLC aggregator:
 *   - multiple quote mids move ONE forming candle (open immutable, close
 *     tracks the latest mid, high=max, low=min);
 *   - quotes NEVER touch unit.aggregators → the closed/persisted candle stays
 *     pure-OHLC;
 *   - no new/backdated/duplicate candles from quotes;
 *   - authoritative OHLC snapshots replace the quote display (truth wins);
 *   - unchanged mids produce no frames.
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

/** A genuine quote-derived mid (Capital marketData → capitalMid) tick. */
function quoteMid(tsMs: number, price: number): IngTick {
  const bid = Math.round((price - 0.05) * 100) / 100;
  const offer = Math.round((price + 0.05) * 100) / 100;
  return { tsMs, price, volume: 0, bid, offer, arriveMs: Date.now(), priceRaw: price, priceField: "MID" };
}

/** A genuine OHLC burst tick (Capital ohlc.event → 4-tick burst, like emitBurst). */
function ohlcTick(tsMs: number, price: number): IngTick {
  return { tsMs, price, volume: 0, bid: price, offer: price, arriveMs: Date.now(), priceRaw: price, priceField: "MID" };
}

/** The MINUTE_1 result of a quote processing pass. */
function m1(results: QuoteResult[]) {
  return results.find((r) => r.timeframe === "MINUTE_1");
}

test("4-8. multiple quote mids move ONE forming candle intra-bar", () => {
  const unit = createInstrumentUnit(GOLD, "Spot Gold / Capital.com", 2);
  // Authoritative forming bucket 08:01 comes from the OHLC pair (like production:
  // pair(08:01) opens bucket 08:01 ~1 minute late).
  processInstrumentTick(unit, ohlcTick(T(60), 4335.0));
  syncDisplayFromAggregator(unit);
  assert.equal(unit.aggregators.getCandleFor(60)?.time, B(60), "authoritative forming = 08:01");

  // Quotes for bucket 08:02 (no OHLC truth yet) — the live minute leading.
  const q1 = m1(processInstrumentQuote(unit, quoteMid(T(120, 100), 4336.5)));
  assert.ok(q1?.display, "first quote opens the display candle");
  assert.equal(q1?.display?.time, B(120), "correct bucket start (epoch 60s grid)");
  assert.deepEqual(
    [q1?.display?.open, q1?.display?.high, q1?.display?.low, q1?.display?.close],
    [4336.5, 4336.5, 4336.5, 4336.5],
    "first quote seeds open=high=low=close",
  );

  const q2 = m1(processInstrumentQuote(unit, quoteMid(T(120, 500), 4337.2)));
  assert.deepEqual(
    [q2?.display?.open, q2?.display?.high, q2?.display?.low, q2?.display?.close],
    [4336.5, 4337.2, 4336.5, 4337.2],
    "rise → high + close move up, open immutable",
  );

  const q3 = m1(processInstrumentQuote(unit, quoteMid(T(120, 900), 4335.9)));
  assert.deepEqual(
    [q3?.display?.open, q3?.display?.high, q3?.display?.low, q3?.display?.close],
    [4336.5, 4337.2, 4335.9, 4335.9],
    "fall → low + close move down, open still immutable",
  );

  const q4 = m1(processInstrumentQuote(unit, quoteMid(T(120, 1300), 4337.2)));
  assert.deepEqual(
    [q4?.display?.open, q4?.display?.high, q4?.display?.low, q4?.display?.close],
    [4336.5, 4337.2, 4335.9, 4337.2],
    "close always tracks the LATEST genuine mid; extremes stay monotonic",
  );

  // Same bucket throughout — the aggregator never saw a new bucket.
  const agg = unit.aggregators.getCandleFor(60);
  assert.equal(agg?.time, B(60), "authoritative aggregator still on bucket 08:01");
  assert.equal(agg?.high, 4335.0, "aggregator high untouched by quote 4337.2");
  assert.equal(agg?.low, 4335.0, "aggregator low untouched by quote 4335.9");
  assert.equal(agg?.close, 4335.0, "aggregator close untouched by quotes");
});

test("9. unchanged quote mids produce no extra display frames", () => {
  const unit = createInstrumentUnit(GOLD, "Spot Gold / Capital.com", 2);
  processInstrumentTick(unit, ohlcTick(T(60), 4335.0));
  syncDisplayFromAggregator(unit);
  assert.ok(m1(processInstrumentQuote(unit, quoteMid(T(120), 4336.5)))?.display);
  // Same mid again → no state, no frame.
  assert.equal(m1(processInstrumentQuote(unit, quoteMid(T(120), 4336.5)))?.display, undefined);
  // A changed mid with a new extreme does move the candle.
  const again = m1(processInstrumentQuote(unit, quoteMid(T(120), 4336.6)));
  assert.ok(again?.display, "a genuinely higher close does move the candle");
});

test("10. quote timestamps never create duplicate/new/backdated candles", () => {
  const unit = createInstrumentUnit(GOLD, "Spot Gold / Capital.com", 2);
  processInstrumentTick(unit, ohlcTick(T(60), 4335.0)); // authoritative 08:01
  syncDisplayFromAggregator(unit);

  // A quote stamped for an OLDER bucket than the authoritative forming candle
  // must be ignored (would otherwise re-open a previously-rolled bucket).
  const stale = m1(processInstrumentQuote(unit, quoteMid(T(0, 400), 4330.0)));
  assert.equal(stale?.display, undefined, "older-bucket quote is ignored");

  // A quote stamped for the SAME bucket as the authoritative forming candle is
  // ignored too — the OHLC truth already owns that bucket's display.
  const same = m1(processInstrumentQuote(unit, quoteMid(T(60, 400), 4399.0)));
  assert.equal(same?.display, undefined, "authoritative-bucket quote is ignored");

  // Only a strictly NEWER bucket opens the display candle; one tick, one candle.
  const next = m1(processInstrumentQuote(unit, quoteMid(T(120, 100), 4340.0)));
  assert.equal(next?.display?.time, B(120));
  assert.equal(unit.liveDisplay.get("MINUTE_1")?.time, B(120), "one MINUTE_1 display candle");
  // and the aggregator still holds exactly ONE forming candle (no dupes created).
  assert.equal(unit.aggregators.getCandleFor(60)?.time, B(60));
});

test("11-12. quote-derived updates are NEVER persisted; OHLC stays the aggregate source", () => {
  const unit = createInstrumentUnit(GOLD, "Spot Gold / Capital.com", 2);

  // Minute 08:00 receives its authoritative OHLC burst (open/high/low/close —
  // the production 4-tick pair replay, all stamped 08:00).
  processInstrumentTick(unit, ohlcTick(T(0), 4300.0)); // open
  processInstrumentTick(unit, ohlcTick(T(0), 4350.0)); // high
  processInstrumentTick(unit, ohlcTick(T(0), 4280.0)); // low
  processInstrumentTick(unit, ohlcTick(T(0), 4320.0)); // close
  syncDisplayFromAggregator(unit);

  // Quotes for the NEXT minute race to extremes far beyond the OHLC truth.
  processInstrumentQuote(unit, quoteMid(T(60, 100), 4400.0));
  processInstrumentQuote(unit, quoteMid(T(60, 500), 4500.0));
  processInstrumentQuote(unit, quoteMid(T(60, 900), 4100.0));
  processInstrumentQuote(unit, quoteMid(T(60, 1500), 4090.0));
  // Quote display is now wildly different from the OHLC truth.
  assert.equal(unit.liveDisplay.get("MINUTE_1")?.high, 4500.0);
  assert.equal(unit.liveDisplay.get("MINUTE_1")?.low, 4090.0);

  // The authoritative aggregator state NEVER saw ANY of those quote mids.
  assert.equal(unit.aggregators.getCandleFor(60)?.open, 4300.0, "OHLC pair opens at 4300");
  assert.equal(unit.aggregators.getCandleFor(60)?.high, 4350.0, "no quote contamination");

  // The 08:01 OHLC pair then closes 08:00 with PURE OHLC values (not 4090…4500).
  const closed = processInstrumentTick(unit, ohlcTick(T(60), 4340.0)).find(
    (r) => r.timeframe === "MINUTE_1",
  )?.closed;
  assert.ok(closed, "the 08:01 pair closes bucket 08:00");
  assert.equal(closed?.open, 4300.0);
  assert.equal(closed?.high, 4350.0, "persisted high = OHLC-derived (quote 4500 excluded)");
  assert.equal(closed?.low, 4280.0, "persisted low = OHLC-derived (quote 4090 excluded)");
  assert.equal(closed?.close, 4320.0, "persisted close = the OHLC close win");
  assert.equal(closed?.time, B(0), "bucket time unchanged (60s epoch grid)");
});

test("13. OHLC rollover replaces/finalizes the quote-derived display (truth wins)", () => {
  const unit = createInstrumentUnit(GOLD, "Spot Gold / Capital.com", 2);
  // Authoritative 08:01; quotes build the 08:02 display candle.
  processInstrumentTick(unit, ohlcTick(T(60), 4335.0));
  syncDisplayFromAggregator(unit);
  processInstrumentQuote(unit, quoteMid(T(120, 100), 4340.0));
  processInstrumentQuote(unit, quoteMid(T(120, 500), 4345.0));
  const before = unit.liveDisplay.get("MINUTE_1");
  assert.equal(before?.open, 4340.0, "quote-derived open before the snapshot");

  // The 08:02 OHLC pair arrives → authoritative snapshot (open 4336.0) replaces
  // the quote-derived display wholesale — including its open.
  processInstrumentTick(unit, ohlcTick(T(120), 4336.0));
  syncDisplayFromAggregator(unit);
  const after = unit.liveDisplay.get("MINUTE_1");
  assert.equal(after?.time, B(120), "display stays on the same bucket");
  assert.equal(after?.open, 4336.0, "authoritative open wins over the quote-derived open");
  assert.equal(after?.close, 4336.0, "authoritative snapshot is the new display truth");
  assert.equal(after?.high, 4336.0);
  assert.equal(after?.low, 4336.0);
});

test("3m. the quote overlay also drives the MINUTE_3 grid (never persisted)", () => {
  const unit = createInstrumentUnit(GOLD, "Spot Gold / Capital.com", 2);
  // Authoritative 3m bucket 08:03, then quotes for the NEXT 3m bucket 08:06.
  processInstrumentTick(unit, ohlcTick(T(180), 4335.0));
  syncDisplayFromAggregator(unit);
  const r = processInstrumentQuote(unit, quoteMid(T(400, 100), 4340.0)).find(
    (x) => x.timeframe === "MINUTE_3",
  );
  assert.ok(r?.display, "3m display opens on its own 180s grid");
  assert.equal(r?.display?.time, B(360), "3m bucket start (08:06) on the 180s epoch grid");
  assert.equal(r?.display?.open, 4340.0);
  // Same-bucket 3m quote merges.
  const r2 = processInstrumentQuote(unit, quoteMid(T(440, 100), 4345.0)).find(
    (x) => x.timeframe === "MINUTE_3",
  );
  assert.equal(r2?.display?.high, 4345.0, "3m high extends");
  assert.equal(r2?.display?.open, 4340.0, "3m open immutable");
  // Isolation holds for the 3m grid too: the 3m aggregator (in-memory overlay,
  // never persisted) was untouched by any quote.
  assert.equal(unit.aggregators.getCandleFor(180)?.high, 4335.0);
  // And quotes can never create a 3m bucket at/below the authoritative 3m one.
  const stale3m = processInstrumentQuote(unit, quoteMid(T(180, 200), 4300.0)).find(
    (x) => x.timeframe === "MINUTE_3",
  );
  assert.equal(stale3m?.display, undefined, "authoritative-bucket 3m quote ignored");
});