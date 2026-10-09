/**
 * DERIVED-TIMEFRAME FETCH WINDOW — the store row cap.
 *
 * BUG (found in the 5m browser diagnostic): a derived timeframe's history
 * loader asks the store for `limit * minutes + minutes + 1` 1m rows, but the
 * store silently caps any single fetch at MAX_CANDLE_STORE_ROWS (10 000).
 *
 *   MINUTE_5, limit=2000  ->  2000*5 + 5 + 1 = 10006  >  10000  -> TRUNCATED
 *
 * The store returned fewer rows than requested, so `hasMore`
 * (`raw.length >= requested1m`) evaluated FALSE and the frontend stopped
 * paginating ~30 minutes short of the true start of history. Nothing threw;
 * the 5m candles themselves were all correct.
 *
 * The fix clamps the EFFECTIVE derived limit so the underlying request can
 * never exceed the store cap. This file pins that arithmetic, and the real
 * router test below proves it end-to-end against a store that enforces it.
 *
 * Run: npm --prefix backend run test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MAX_CANDLE_STORE_ROWS, type CandleStore, type PersistedCandle } from "../db/candleStore.js";
import { effectiveDerivedLimit, derivedOneMinRequest, createCandlesDbRouter } from "../routes/candlesDb.js";
import { GOLD_INSTRUMENT } from "../market/instruments.js";
import { CANONICAL_TIMEFRAME, minutesFor } from "../streaming/timeframes.js";

// ── The invariant ─────────────────────────────────────────────────────────────

test("cap: the store cap is a named constant with the historical value", () => {
  assert.equal(MAX_CANDLE_STORE_ROWS, 10000, "unchanged from the previous inline literal");
});

test("5m: limit=2000 is clamped so the 1m request never exceeds the store cap", () => {
  const minutes = minutesFor("MINUTE_5")!;
  const effective = effectiveDerivedLimit(2000, minutes);
  // The un-clamped request would be 10006 — one row over the cap.
  assert.equal(2000 * minutes + minutes + 1, 10006);
  assert.ok(effective < 2000, "the effective limit IS reduced");
  assert.equal(effective, Math.floor((MAX_CANDLE_STORE_ROWS - minutes - 1) / minutes));
  assert.equal(effective, 1998);
  // THE invariant this whole change exists to guarantee:
  assert.ok(
    derivedOneMinRequest(effective, minutes) <= MAX_CANDLE_STORE_ROWS,
    `effective*5+5+1 (${derivedOneMinRequest(effective, minutes)}) <= ${MAX_CANDLE_STORE_ROWS}`,
  );
  assert.equal(derivedOneMinRequest(effective, minutes), 9996);
});

test("cap: the invariant holds for every registered derived timeframe and a range of limits", () => {
  for (const minutes of [2, 3, 5, 15, 30, 60]) {
    for (const limit of [1, 100, 500, 1000, 2000, 5000, 10000]) {
      const effective = effectiveDerivedLimit(limit, minutes);
      const requested = derivedOneMinRequest(effective, minutes);
      assert.ok(
        requested <= MAX_CANDLE_STORE_ROWS,
        `${minutes}m limit=${limit} -> effective=${effective} requested=${requested} (over cap)`,
      );
      // It must also never ask for MORE than the caller wanted.
      assert.ok(effective <= limit, `${minutes}m limit=${limit} must not inflate to ${effective}`);
      // And it must stay positive so a page is always possible.
      assert.ok(effective >= 1, `${minutes}m limit=${limit} produced a non-positive limit`);
    }
  }
});

// ── 1m unchanged ──────────────────────────────────────────────────────────────

test("1m: the stored-row path is untouched — the clamp never applies", () => {
  // 1m takes the `minutes <= 1` branch in loadTimeframeCandles, which passes
  // `limit` straight through to the store. Neither derived helper is called
  // there, so `limit` reaches the store verbatim.
  assert.equal(minutesFor("MINUTE_1"), 1);
  // The clamp is a no-op at 1m: it would not have reduced the limit anyway.
  assert.equal(effectiveDerivedLimit(2000, 1), 2000);
  assert.equal(effectiveDerivedLimit(2000, 1), Math.min(2000, MAX_CANDLE_STORE_ROWS - 2));
  // `derivedOneMinRequest` is the DERIVED-bucket formula (which drops a forming
  // bucket); 1m has no bucket to drop, so it is never routed through it. The
  // real 1m request is exactly `limit` — which is what the store receives.
  const storeRequestFor1m = 2000;
  assert.equal(storeRequestFor1m <= MAX_CANDLE_STORE_ROWS, true);
  // And the helper, if it were ever applied at 1m, still stays under the cap.
  assert.ok(derivedOneMinRequest(2000, 1) <= MAX_CANDLE_STORE_ROWS);
});

// ── 3m unchanged (already under the cap) ──────────────────────────────────────

test("3m: limit=2000 is NOT clamped — its request was already under the cap", () => {
  const minutes = minutesFor("MINUTE_3")!;
  const effective = effectiveDerivedLimit(2000, minutes);
  assert.equal(effective, 2000, "3m behaviour is byte-for-byte unchanged");
  assert.equal(derivedOneMinRequest(effective, minutes), 6004);
  assert.ok(derivedOneMinRequest(effective, minutes) <= MAX_CANDLE_STORE_ROWS);
});

test("3m: the clamp only engages once 3m alone would exceed the cap", () => {
  const minutes = 3;
  // 3m stays unclamped right up to the limit that WOULD overflow.
  const largestUnclamped = Math.floor((MAX_CANDLE_STORE_ROWS - minutes - 1) / minutes);
  assert.equal(effectiveDerivedLimit(largestUnclamped, minutes), largestUnclamped);
  assert.equal(effectiveDerivedLimit(largestUnclamped + 1, minutes), largestUnclamped);
});

// ── Truthful hasMore ──────────────────────────────────────────────────────────

test("hasMore: an unclamped store page can no longer be misread as the end of history", () => {
  // The regression: raw.length (9996) < requested1m (10006) made hasMore false
  // even though far older rows existed. With the clamp, `requested1m` is what
  // the store was actually asked for AND can actually return, so the existing
  // `raw.length >= requested1m` comparison is truthful again.
  const minutes = 5;
  const requested = derivedOneMinRequest(effectiveDerivedLimit(2000, minutes), minutes);
  assert.ok(requested <= MAX_CANDLE_STORE_ROWS);
  // Simulate a full page coming back: hasMore must be TRUE.
  const rawLength = requested;
  assert.equal(rawLength >= requested, true, "a full page now implies hasMore=true");
});

// ── E. Real-router regression: the request the store actually receives ───────

/**
 * A store that ENFORCES MAX_CANDLE_STORE_ROWS exactly like the real one, and
 * records what it was asked for. Deep enough that a truthful `hasMore` is
 * distinguishable from a truncated one.
 */
/** One recorded `loadCandles` call — what the route ACTUALLY asked the store. */
class StoreCall {
  constructor(
    readonly instrument: string,
    readonly timeframe: string,
    readonly limit: number,
  ) {}
}

class CappedStore {
  readonly calls: StoreCall[] = [];
  private readonly rows: PersistedCandle[];
  constructor(depth: number, startSec: number) {
    this.rows = Array.from({ length: depth }, (_, i) => ({
      time: startSec + i * 60,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      tickCount: 5,
      status: "completed" as const,
    }));
  }
  async loadCandles(instrument: string, timeframe: string, limit: number, beforeSec?: number) {
    this.calls.push(new StoreCall(instrument, timeframe, limit));
    // The real store's exact clamp.
    const capped = Math.max(1, Math.min(MAX_CANDLE_STORE_ROWS, Math.round(limit) || 500));
    let rows = this.rows;
    if (beforeSec !== undefined) rows = rows.filter((r) => r.time < beforeSec);
    return rows.slice(Math.max(0, rows.length - capped));
  }
}

const makeApp = (store: CappedStore) =>
  createCandlesDbRouter(store as unknown as CandleStore, [GOLD_INSTRUMENT], GOLD_INSTRUMENT.epic);

const START = Math.floor(Date.UTC(2026, 8, 1, 0, 0) / 1000);

test("router: MINUTE_5 at limit=2000 succeeds and never asks the store for more than the cap", async () => {
  // 20 000 one-minute rows: deep enough that a truncated fetch would still
  // return a full page's worth of data and hide the bug behind a 200 response.
  const store = new CappedStore(20000, START);
  const res = await makeApp(store).request(
    `/candles/db?epic=${GOLD_INSTRUMENT.epic}&timeframe=MINUTE_5&limit=2000`,
  );
  assert.equal(res.status, 200, "the request must succeed");
  const body = await res.json();
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].timeframe, CANONICAL_TIMEFRAME, "5m still reads the 1m rows");
  assert.ok(
    store.calls[0].limit <= MAX_CANDLE_STORE_ROWS,
    `store was asked for ${store.calls[0].limit} rows — over the ${MAX_CANDLE_STORE_ROWS} cap`,
  );
  assert.equal(store.calls[0].limit, 9996);
  // Requirement D, asserted literally at the real router boundary: the row
  // count the store was asked for IS `effective*5 + 5 + 1` and it fits.
  const effective5m = effectiveDerivedLimit(2000, minutesFor("MINUTE_5")!);
  assert.equal(store.calls[0].limit, effective5m * 5 + 5 + 1);
  assert.ok(effective5m * 5 + 5 + 1 <= MAX_CANDLE_STORE_ROWS);
  // A truthful hasMore: far older data exists, so it must be true.
  assert.equal(body.hasMore, true, "hasMore must not be faked false by a truncated fetch");
  assert.ok(body.candles.length > 0);
  // The returned series is still valid ascending 5m data.
  for (let i = 1; i < body.candles.length; i++) {
    assert.ok(body.candles[i].time > body.candles[i - 1].time, "strictly ascending");
    assert.equal(body.candles[i].time % 300, 0, "aligned to the 5m grid");
  }
});

test("router: 5m pagination keeps walking backwards while older history exists", async () => {
  // The user-visible symptom of the bug: pagination STOPS early. Page 2 (sent
  // with the `before` cursor) must still return strictly older candles, and the
  // SAME clamped row count must be used on every page.
  const store = new CappedStore(20000, START);
  const app = makeApp(store);
  const page1 = await (
    await app.request(`/candles/db?epic=${GOLD_INSTRUMENT.epic}&timeframe=MINUTE_5&limit=2000`)
  ).json();
  assert.equal(page1.hasMore, true);

  const oldest = page1.candles[0].time;
  const page2 = await (
    await app.request(
      `/candles/db?epic=${GOLD_INSTRUMENT.epic}&timeframe=MINUTE_5&limit=2000&before=${oldest}`,
    )
  ).json();

  assert.equal(page2.candles.length > 0, true, "page 2 must not be empty");
  assert.ok(
    page2.candles[page2.candles.length - 1].time < oldest,
    "page 2 is strictly older than page 1 — the cursor still makes progress",
  );
  assert.equal(page2.hasMore, true, "20k rows of history is deeper than two pages");
  // Every page plans against the SAME cap — no page can be silently truncated.
  assert.equal(store.calls.length, 2);
  for (const call of store.calls) {
    assert.ok(call.limit <= MAX_CANDLE_STORE_ROWS, `page asked for ${call.limit} rows`);
    assert.equal(call.limit, 9996);
  }
});

test("router: MINUTE_3 at limit=2000 is byte-for-byte unchanged (6004 rows requested)", async () => {
  const store = new CappedStore(20000, START);
  const res = await makeApp(store).request(
    `/candles/db?epic=${GOLD_INSTRUMENT.epic}&timeframe=MINUTE_3&limit=2000`,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(store.calls[0].limit, 6004, "3m must not be clamped — it already fit");
  assert.equal(body.hasMore, true, "3m hasMore is unchanged");
  assert.equal(body.count, 2000, "3m still returns the full requested page");
});

test("router: MINUTE_1 passes `limit` straight through, unclamped and unconverted", async () => {
  const store = new CappedStore(20000, START);
  const res = await makeApp(store).request(
    `/candles/db?epic=${GOLD_INSTRUMENT.epic}&timeframe=MINUTE_1&limit=2000`,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(store.calls[0].timeframe, CANONICAL_TIMEFRAME, "1m reads its own stored rows");
  assert.equal(store.calls[0].limit, 2000, "1m must reach the store verbatim");
  assert.equal(body.candles.length, 2000);
  assert.equal(body.hasMore, true);
});

test("router: a small MINUTE_5 limit is never inflated by the clamp", async () => {
  const store = new CappedStore(20000, START);
  const res = await makeApp(store).request(
    `/candles/db?epic=${GOLD_INSTRUMENT.epic}&timeframe=MINUTE_5&limit=50`,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(
    store.calls[0].limit,
    256,
    "50*5+5+1 — the clamp must not alter small requests",
  );
  // 51 not 50: the fetch deliberately carries extra head-room so the still-
  // forming newest bucket can be dropped, which can yield one MORE complete
  // macro candle than requested. That is long-standing derived-path behaviour
  // and is unchanged by the clamp.
  assert.equal(body.count, 51, "small 5m requests keep their pre-existing count behaviour");
  assert.equal(body.hasMore, true);
});
