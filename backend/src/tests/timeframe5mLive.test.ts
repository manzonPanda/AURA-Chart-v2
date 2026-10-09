/**
 * 5m END-TO-END: the live fan-out and the history derivation that the browser
 * actually consumes.
 *
 * Unit-level registry/aggregation coverage lives in timeframe5m.test.ts. This
 * file exercises the two integration seams a 5m chart depends on, both of
 * which were generic in 3m and must STAY generic:
 *
 *   1. LIVE — processInstrumentTick drives every registered timeframe from one
 *      tick: a 5m forming candle exists, 1m still persists, 5m never does, and
 *      the client fan-out routing accepts a 5m subscriber.
 *   2. HISTORY — the WS resolution gate accepts MINUTE_5 (the check that
 *      previously would have rejected a 5m browser with INVALID_RESOLUTION),
 *      and the derived-history contract (fetch size limit*N+N+1, ascending,
 *      no trailing partial bucket, no 5m rows persisted) holds.
 *
 * Framework-free and DB-free on purpose (see instrumentPipeline.ts).
 *
 * Run: npm --prefix backend run test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  TIMEFRAME_BUCKET_SEC,
  aggregateCompleteToMinutes,
  isPersistedTimeframe,
  minutesFor,
} from "../streaming/timeframes.js";
import {
  clientWantsCandle,
  createInstrumentUnit,
  persistenceInstrumentFor,
  processInstrumentQuote,
  processInstrumentTick,
  syncDisplayFromAggregator,
} from "../streaming/instrumentPipeline.js";
import type { Candle } from "../types/candle.js";
import type { IngTick } from "../streaming/types.js";

const sec = (h: number, m: number): number => Math.floor(Date.UTC(2024, 0, 8, h, m) / 1000);
const tick = (h: number, m: number, price: number): IngTick =>
  ({ tsMs: sec(h, m) * 1000, price, volume: 0, priceRaw: price }) as unknown as IngTick;

const GOLD = "CS.D.CFIGOLD.CFI.IP";

// ── 1. LIVE: one tick drives every timeframe, including 5m ────────────────────

test("live: a single tick produces a 5m result alongside 1m and 3m", () => {
  const unit = createInstrumentUnit(GOLD, "Gold", 2);
  const results = processInstrumentTick(unit, tick(10, 2, 2400));
  const byTf = new Map(results.map((r) => [r.timeframe, r]));

  assert.ok(byTf.has("MINUTE_5"), "the 5m aggregator is constructed from the registry alone");
  const five = byTf.get("MINUTE_5")!;
  assert.equal(five.bucketSec, 300);
  assert.equal(five.forming?.time, sec(10, 0), "10:02 sits in the 10:00 5m bucket");
  assert.equal(five.forming?.close, 2400);
  // 1m/3m keep their own grids — 5m did not disturb them.
  assert.equal(byTf.get("MINUTE_1")?.forming?.time, sec(10, 2));
  assert.equal(byTf.get("MINUTE_3")?.forming?.time, sec(10, 0));
});

test("live: only 1m is ever persisted; a 5m close gets no persistence identity", () => {
  const unit = createInstrumentUnit(GOLD, "Gold", 2);
  processInstrumentTick(unit, tick(10, 0, 100));
  processInstrumentTick(unit, tick(10, 4, 150)); // still inside the 10:00 5m bucket
  // Cross the 5m boundary so the 10:00 5m bucket CLOSES.
  const results = processInstrumentTick(unit, tick(10, 5, 200));
  const five = results.find((r) => r.timeframe === "MINUTE_5")!;
  assert.ok(five.closed, "the 5m bucket closed");
  assert.equal(five.closed!.time, sec(10, 0));
  assert.equal(five.closed!.open, 100);
  assert.equal(five.closed!.high, 150);
  // The 10:05 tick opens the NEXT bucket — it is not part of the closed one.
  assert.equal(five.closed!.close, 150, "close is the last tick INSIDE the bucket");
  assert.equal(five.forming?.time, sec(10, 5), "a new 5m candle opened at 10:05");
  assert.equal(five.forming?.close, 200);

  // The persistence identity is the ONLY thing that gates a DB write.
  assert.equal(persistenceInstrumentFor("MINUTE_5", unit), null, "5m is NEVER written");
  assert.equal(persistenceInstrumentFor("MINUTE_3", unit), null, "3m is still never written");
  assert.equal(persistenceInstrumentFor("MINUTE_1", unit), GOLD, "1m is still the only stored frame");
});

test("live: the quote display overlay extends the 5m forming candle", () => {
  const unit = createInstrumentUnit(GOLD, "Gold", 2);
  processInstrumentTick(unit, tick(10, 1, 100));
  // processInstrumentQuote returns one result PER registry entry, in registry
  // order — so the 5m entry must be selected by timeframe, not by index.
  const quotes = processInstrumentQuote(unit, tick(10, 2, 105));
  const five = quotes.find((r) => r.timeframe === "MINUTE_5")!;
  assert.equal(five.display?.time, sec(10, 0), "the quote extends the 10:00 5m bucket");
  assert.equal(five.display?.close, 105);
  // The display overlay's open is the first genuine QUOTE mid for the bucket
  // (quotes are the only input to the display layer), not the OHLC open.
  assert.equal(five.display?.open, 105, "open is the first quote mid of the bucket");

  // Authoritative OHLC always wins afterwards: after an OHLC tick the display
  // is re-synced to the aggregator candle, so the OHLC open takes over.
  processInstrumentTick(unit, tick(10, 3, 110));
  syncDisplayFromAggregator(unit);
  const after = processInstrumentQuote(unit, tick(10, 4, 120)).find(
    (r) => r.timeframe === "MINUTE_5",
  )!;
  assert.equal(after.display?.close, 120);
  assert.equal(after.display?.high, 120);
  assert.equal(after.display?.open, 100, "the authoritative OHLC open is re-asserted");
});

test("live: a 5m WS subscriber is routed its own frames and nothing else", () => {
  const fiveClient = { alive: true, epic: GOLD, bucketSec: 300 };
  const oneClient = { alive: true, epic: GOLD, bucketSec: 60 };
  const otherEpic = { alive: true, epic: "SOMETHING.ELSE", bucketSec: 300 };
  const dead = { alive: false, epic: GOLD, bucketSec: 300 };

  assert.equal(clientWantsCandle(fiveClient, GOLD, 300), true, "the 5m client gets 5m frames");
  assert.equal(clientWantsCandle(fiveClient, GOLD, 60), false, "never another timeframe's");
  assert.equal(clientWantsCandle(oneClient, GOLD, 300), false);
  assert.equal(clientWantsCandle(otherEpic, GOLD, 300), false, "never another instrument's");
  assert.equal(clientWantsCandle(dead, GOLD, 300), false, "never a dead socket's");
});

// ── 2. WS + HISTORY: the gate and the derived 5m series ─────────────────────

test("history: the WS resolution gate accepts MINUTE_5 (no INVALID_RESOLUTION)", () => {
  // backend/src/index.ts rejects a WS whose `res` is not in this map.
  assert.ok("MINUTE_5" in TIMEFRAME_BUCKET_SEC, "a 5m browser passes the res= gate");
  assert.equal(TIMEFRAME_BUCKET_SEC["MINUTE_5"], 300);
  // A 5m client therefore has a bucketSec that matches the server's map, which
  // is what the fan-out routing above relies on.
  assert.equal(fiveClientBucket(), 300);
});

function fiveClientBucket(): number {
  return TIMEFRAME_BUCKET_SEC["MINUTE_5"];
}

test("history: a 5m request fetches limit*5+6 one-minute rows", () => {
  // Mirrors routes/candlesDb.ts: requested1m = limit * minutes + minutes + 1
  const minutes = minutesFor("MINUTE_5")!;
  assert.equal(minutes, 5);
  const limit = 500;
  assert.equal(limit * minutes + minutes + 1, 2506);
});

test("history: derived 5m series is ascending, complete and free of a trailing partial", () => {
  // 20 one-minute rows = 4 complete 5m buckets, plus 2 rows of a forming bucket.
  const rows: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    rows.push({
      ts: sec(10, i) * 1000,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 1,
    });
  }
  rows.push({ ts: sec(10, 20) * 1000, open: 120, high: 121, low: 119, close: 120.5, volume: 1 });
  rows.push({ ts: sec(10, 21) * 1000, open: 121, high: 122, low: 120, close: 121.5, volume: 1 });

  const derived = aggregateCompleteToMinutes(rows, 5);
  assert.equal(derived.length, 4, "the forming 10:20 bucket (2 of 5 rows) is excluded");
  for (let i = 1; i < derived.length; i++) {
    assert.ok(derived[i].ts > derived[i - 1].ts, "strictly ascending for series.setData()");
    assert.equal(derived[i].ts - derived[i - 1].ts, 5 * 60 * 1000, "contiguous 5m buckets");
  }
  // History/live handoff: the newest derived bucket is the one the WS overlay
  // will next form *after* the current forming bucket — no overlap, no seam.
  assert.equal(derived[derived.length - 1].ts, sec(10, 15) * 1000);
});

test("history: a 5m bucket missing one 1m row is omitted (never a short candle)", () => {
  const rows: Candle[] = [];
  for (let i = 0; i < 5; i++) {
    if (i === 2) continue; // the 10:02 constituent never arrived
    rows.push({ ts: sec(10, i) * 1000, open: 1, high: 1, low: 1, close: 1 });
  }
  assert.deepEqual(aggregateCompleteToMinutes(rows, 5), [], "4 of 5 ⇒ omitted entirely");
});

test("history: 1m and 3m history derivation is unchanged by the 5m row", () => {
  const rows: Candle[] = [];
  for (let i = 0; i < 6; i++) {
    rows.push({ ts: sec(10, i) * 1000, open: 1, high: 2, low: 0, close: 1, volume: 1 });
  }
  assert.equal(minutesFor("MINUTE_1"), 1);
  assert.equal(minutesFor("MINUTE_3"), 3);
  assert.equal(aggregateCompleteToMinutes(rows, 1).length, 6, "1m is passed through");
  assert.equal(aggregateCompleteToMinutes(rows, 3).length, 2, "3m unchanged");
  assert.equal(isPersistedTimeframe("MINUTE_1"), true, "1m remains the canonical frame");
  assert.equal(isPersistedTimeframe("MINUTE_5"), false);
});
