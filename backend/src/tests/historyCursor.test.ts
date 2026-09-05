/**
 * History-pagination cursor tests for GET /api/candles/db (Node test runner
 * via tsx):   npm --prefix backend run test
 *
 * Proves against the REAL Hono router with a recording FAKE CandleStore:
 *   1. no `before` → store queried WITHOUT a cursor (latest page).
 *   2. `before=<epoch-sec>` → store receives the cursor; only strictly-older
 *      rows are returned (boundary row excluded — no duplicates possible).
 *   3. `hasMore` reflects page-fullness (full page → true, short page → false).
 *   4. invalid `before` values are ignored (fall back to the latest page).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { CandleStore, PersistedCandle } from "../db/candleStore.js";
import { DAX_INSTRUMENT, GOLD_INSTRUMENT, type InstrumentMeta } from "../market/instruments.js";
import { createCandlesDbRouter } from "../routes/candlesDb.js";

const DAX = DAX_INSTRUMENT.epic;
const INSTRUMENTS: readonly InstrumentMeta[] = [DAX_INSTRUMENT, GOLD_INSTRUMENT];

const T0 = Math.floor(Date.UTC(2026, 8, 3, 8, 0) / 1000); // 2026-09-03 08:00 UTC
const ROWS: PersistedCandle[] = Array.from({ length: 12 }, (_, i) => ({
  time: T0 + i * 60,
  open: 26000 + i,
  high: 26001 + i,
  low: 25999 + i,
  close: 26000.5 + i,
  tickCount: 10,
  status: "completed" as const,
}));

/** Recording fake: mirrors the real store's cursor semantics (strictly older). */
class RecordingStore {
  calls: Array<{ instrument: string; timeframe: string; limit: number; beforeSec?: number }> = [];
  pageCap = Number.POSITIVE_INFINITY; // simulate PostgREST per-request clamping

  async loadCandles(
    instrument: string,
    timeframe: string,
    limit: number,
    beforeSec?: number,
  ): Promise<PersistedCandle[]> {
    this.calls.push({ instrument, timeframe, limit, beforeSec });
    const cursor =
      typeof beforeSec === "number" && Number.isFinite(beforeSec) && beforeSec > 0
        ? beforeSec
        : undefined;
    const rows = ROWS
      .filter((r) => (cursor === undefined ? true : r.time < cursor))
      .sort((a, b) => b.time - a.time)
      .slice(0, Math.min(limit, this.pageCap))
      .sort((a, b) => a.time - b.time);
    return rows;
  }
}

const makeApp = (store: RecordingStore) =>
  createCandlesDbRouter(store as unknown as CandleStore, INSTRUMENTS);

test("no before param → store queried WITHOUT a cursor (latest page)", async () => {
  const store = new RecordingStore();
  const res = await makeApp(store).request(`/candles/db?epic=${DAX}&timeframe=MINUTE_1&limit=5`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].beforeSec, undefined);
  assert.equal(body.count, 5);
  assert.equal(body.hasMore, true, "full page → older rows may exist");
  assert.equal(body.candles[0].time, T0 + 7 * 60, "newest window returned");
});

test("before cursor reaches the store and only strictly-older rows come back", async () => {
  const store = new RecordingStore();
  const cursor = T0 + 6 * 60; // the 7th row's bucket — the boundary
  const res = await makeApp(store).request(
    `/candles/db?epic=${DAX}&timeframe=MINUTE_1&limit=5&before=${cursor}`,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(store.calls[0].beforeSec, cursor);
  assert.equal(store.calls[0].limit, 5);
  // Rows: T0..T0+5 (six rows strictly older). Newest 5 of those.
  assert.equal(body.count, 5);
  assert.equal(body.hasMore, true);
  const times = body.candles.map((c: { time: number }) => c.time);
  for (const t of times) assert.ok(t < cursor, "strictly older than the cursor");
  // Newest 5 strictly-older rows, ascending: T0+60 .. T0+5*60
  assert.equal(times[0], T0 + 60);
  assert.equal(times[times.length - 1], T0 + 5 * 60, "no boundary duplicate, ascending");
});

test("short page → hasMore=false (no more history below the cursor)", async () => {
  const store = new RecordingStore();
  const cursor = T0 + 2 * 60; // only 2 older rows exist
  const res = await makeApp(store).request(
    `/candles/db?epic=${DAX}&timeframe=MINUTE_1&limit=5&before=${cursor}`,
  );
  const body = await res.json();
  assert.equal(body.count, 2);
  assert.equal(body.hasMore, false, "short page → exhausted");
});

test("invalid before values are ignored (latest-page behavior preserved)", async () => {
  for (const bad of ["abc", "-5", "0"]) {
    const store = new RecordingStore();
    const res = await makeApp(store).request(
      `/candles/db?epic=${DAX}&timeframe=MINUTE_1&limit=3&before=${bad}`,
    );
    const body = await res.json();
    assert.equal(store.calls[0].beforeSec, undefined, `before=${bad} ignored`);
    assert.equal(body.count, 3);
    assert.equal(body.candles[0].time, T0 + 9 * 60);
  }
});
