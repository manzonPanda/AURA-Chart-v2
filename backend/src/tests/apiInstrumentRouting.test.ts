/**
 * Phase 2 — API instrument-awareness tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *
 * Proves (against the REAL Hono routers with a FAKE CandleStore / IG client —
 * no network, no Supabase, no lightstreamer import):
 *   1. GET /api/instruments lists the configured registry + default EPIC.
 *   2. /candles/db: valid DAX epic → 200, valid Gold epic → 200.
 *   3. /candles/db: omitted epic → defaults to DAX (BC).
 *   4. /candles/db: unsupported epic → 400 UNSUPPORTED_EPIC (never an empty
 *      dataset), and the IG REST router never touches IG for it.
 *   5. Candle queries are keyed by the resolved instrument — a DAX request
 *      cannot return Gold rows and vice versa (store sees the right WHERE).
 *   6. /candles/db/gaps: DAX resolves the IG_GERMANY_40 calendar; Gold
 *      resolves IG_SPOT_GOLD — proven behaviorally with a Sunday-evening
 *      bucket that Gold's calendar expects but DAX's does not (unexpected
 *      for DAX, completed for Gold).
 *   7. Registry identity: the calendar routing source is the registry.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { CandleStore, PersistedCandle } from "../db/candleStore.js";
import type { IgClient } from "../ig/client.js";
import { IG_GERMANY_40, IG_SPOT_GOLD } from "../market/calendar.js";
import {
  DAX_INSTRUMENT,
  GOLD_INSTRUMENT,
  instrumentMetaFor,
  type InstrumentMeta,
} from "../market/instruments.js";
import { createCandlesDbRouter } from "../routes/candlesDb.js";
import { createCandlesRouter } from "../routes/candles.js";
import { createInstrumentsRouter } from "../routes/instruments.js";

const DAX = DAX_INSTRUMENT.epic; // IX.D.DAX.IGM.IP
const GOLD = GOLD_INSTRUMENT.epic; // CS.D.CFIGOLD.CFI.IP
const INSTRUMENTS: readonly InstrumentMeta[] = [DAX_INSTRUMENT, GOLD_INSTRUMENT];

/** Sunday 2026-08-30 22:30 UTC = 23:30 London (BST): inside IG Spot Gold's
 *  Sunday window (23:00–24:00 UK) — and DAX is closed all Sunday. */
const SUNDAY_BUCKET_SEC = Math.floor(Date.UTC(2026, 7, 30, 22, 30) / 1000);
const ISO = (sec: number): string => new Date(sec * 1000).toISOString();

/** Fake store: rows are instrument-TAGGED and filtered per request, exactly
 *  like Supabase's `WHERE instrument = …`; the requested instrument is
 *  captured so tests can assert the router queried the RIGHT one. */
class FakeCandleStore {
  readonly rows: Array<PersistedCandle & { instrument: string }> = [
    { instrument: DAX, time: SUNDAY_BUCKET_SEC, open: 26000.0, high: 26001.0, low: 25999.0, close: 26000.5, tickCount: 10, status: "completed" },
    { instrument: GOLD, time: SUNDAY_BUCKET_SEC, open: 4477.5, high: 4477.9, low: 4477.1, close: 4477.6, tickCount: 12, status: "completed" },
  ];
  lastInstrument: string | null = null;
  lastTimeframe: string | null = null;
  async loadCandles(instrument: string, timeframe: string, limit: number): Promise<PersistedCandle[]> {
    this.lastInstrument = instrument;
    this.lastTimeframe = timeframe;
    return this.rows.filter((r) => r.instrument === instrument).slice(0, limit);
  }
}

const makeDbApp = (store: FakeCandleStore) =>
  createCandlesDbRouter(store as unknown as CandleStore, INSTRUMENTS);

/** Fake IG REST client: captures the requested /prices/{epic} path. */
function makeFakeIg(): { ig: IgClient; requestedPath: () => string | null } {
  let path: string | null = null;
  const ig = {
    request: async (p: string) => {
      path = p;
      return {
        prices: [
          {
            snapshotTimeUTC: "2026-09-04T08:00:00",
            openPrice: { midTraded: 26000 },
            highPrice: { midTraded: 26010 },
            lowPrice: { midTraded: 25990 },
            closePrice: { midTraded: 26005 },
            lastTradedVolume: 1,
          },
        ],
      };
    },
  } as unknown as IgClient;
  return { ig, requestedPath: () => path };
}

// ── 1. GET /api/instruments ──────────────────────────────────────────────────

test("GET /api/instruments lists the configured registry with the DAX default", async () => {
  const app = createInstrumentsRouter(INSTRUMENTS, DAX);
  const res = await app.request("/instruments");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    defaultEpic: string;
    count: number;
    instruments: Array<{ epic: string; label: string; decimals: number; calendar: { id: string } | null }>;
  };
  assert.equal(body.defaultEpic, DAX);
  assert.equal(body.count, 2);
  assert.equal(body.instruments[0].epic, DAX);
  assert.equal(body.instruments[0].decimals, 1);
  assert.equal(body.instruments[0].calendar?.id, IG_GERMANY_40.id);
  assert.equal(body.instruments[1].epic, GOLD);
  assert.equal(body.instruments[1].decimals, 2);
  assert.equal(body.instruments[1].calendar?.id, IG_SPOT_GOLD.id);
});

// ── 2 + 3 + 5. /candles/db routing & isolation ───────────────────────────────

test("/candles/db: valid DAX epic → 200 and queries the DAX identity", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request(`/candles/db?epic=${encodeURIComponent(DAX)}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { epic: string; count: number; candles: Array<{ close: number }> };
  assert.equal(body.epic, DAX);
  assert.equal(store.lastInstrument, DAX, "store must be keyed by the DAX identity");
  assert.equal(body.count, 1);
  assert.equal(body.candles[0].close, 26000.5, "must be the DAX row, never a Gold row");
});

test("/candles/db: valid Gold epic → 200 and queries the Gold identity", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request(`/candles/db?epic=${encodeURIComponent(GOLD)}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { epic: string; count: number; candles: Array<{ close: number }> };
  assert.equal(body.epic, GOLD);
  assert.equal(store.lastInstrument, GOLD, "store must be keyed by the Gold identity");
  assert.equal(body.count, 1);
  assert.equal(body.candles[0].close, 4477.6, "must be the Gold row, never a DAX row");
});

test("/candles/db: omitted epic defaults to DAX (BC)", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request("/candles/db");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { epic: string };
  assert.equal(body.epic, DAX);
  assert.equal(store.lastInstrument, DAX);
});

test("/candles/db: unsupported epic → 400 UNSUPPORTED_EPIC (no silent empty set)", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request("/candles/db?epic=MT.D.GC.FGM3.IP");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string; error: string };
  assert.equal(body.code, "UNSUPPORTED_EPIC");
  assert.ok(body.error.includes(GOLD), "error lists the configured instruments");
  assert.equal(store.lastInstrument, null, "the store must never be queried for an unconfigured EPIC");
});

test("/candles/db: a DAX query cannot return Gold candles and vice versa", async () => {
  const store = new FakeCandleStore();
  const app = makeDbApp(store);
  const daxRes = await app.request("/candles/db?timeframe=MINUTE_1");
  const goldRes = await app.request("/candles/db?timeframe=MINUTE_1&epic=" + encodeURIComponent(GOLD));
  const daxBody = (await daxRes.json()) as { candles: Array<{ close: number }> };
  const goldBody = (await goldRes.json()) as { candles: Array<{ close: number }> };
  for (const candle of daxBody.candles) assert.ok(candle.close > 20000, "DAX response carries only DAX-priced rows");
  for (const candle of goldBody.candles) assert.ok(candle.close < 10000, "Gold response carries only Gold-priced rows");
});

// ── 4. /api/candles (IG REST proxy) validation ───────────────────────────────

test("/api/candles: unsupported epic → 400 and IG is NEVER called", async () => {
  const { ig, requestedPath } = makeFakeIg();
  const app = createCandlesRouter(ig, INSTRUMENTS);
  const res = await app.request("/candles?epic=NOT.A.REAL.EPIC&resolution=MINUTE");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "UNSUPPORTED_EPIC");
  assert.equal(requestedPath(), null, "rejection must happen before any IG REST call");
});

test("/api/candles: Gold epic routes to IG's Gold /prices path; omitted → DAX", async () => {
  // NOTE: resolution must be a router-supported one (CHART_RESOLUTIONS is
  // ["MINUTE_3"] today) — this test asserts EPIC routing, not resolutions.
  const gold = makeFakeIg();
  const goldRes = await createCandlesRouter(gold.ig, INSTRUMENTS).request(
    "/candles?resolution=MINUTE_3&epic=" + encodeURIComponent(GOLD),
  );
  assert.equal(goldRes.status, 200);
  assert.equal(gold.requestedPath(), `/prices/${GOLD}`, "IG must be asked for the GOLD epic");
  const goldBody = (await goldRes.json()) as { epic: string };
  assert.equal(goldBody.epic, GOLD);

  const dax = makeFakeIg();
  const daxRes = await createCandlesRouter(dax.ig, INSTRUMENTS).request("/candles?resolution=MINUTE_3");
  assert.equal(daxRes.status, 200);
  assert.equal(dax.requestedPath(), `/prices/${DAX}`, "omitted epic must default to DAX (BC)");
  const daxBody = (await daxRes.json()) as { epic: string };
  assert.equal(daxBody.epic, DAX);
});

// ── 6. /candles/db/gaps — per-instrument MarketCalendar routing ──────────────

test("/gaps: DAX uses IG_GERMANY_40 — the Sunday-evening bucket is UNEXPECTED for DAX", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request("/candles/db/gaps?epic=" + encodeURIComponent(DAX) + "&hours=240");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    epic: string;
    market: { calendar: string };
    summary: { unexpectedRows: number; completed: number };
    unexpected: string[];
  };
  assert.equal(body.epic, DAX);
  assert.equal(body.market.calendar, IG_GERMANY_40.id, "DAX must use the IG Germany 40 calendar");
  assert.equal(body.summary.unexpectedRows, 1, "the Sunday row is outside DAX hours → unexpected");
  assert.equal(body.summary.completed, 0);
  assert.ok(body.unexpected.includes(ISO(SUNDAY_BUCKET_SEC)));
});

test("/gaps: Gold uses IG_SPOT_GOLD — the Sunday-evening bucket is EXPECTED for Gold", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request("/candles/db/gaps?epic=" + encodeURIComponent(GOLD) + "&hours=240");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    epic: string;
    market: { calendar: string };
    summary: { unexpectedRows: number; completed: number };
    unexpected: string[];
    missing: string[];
  };
  assert.equal(body.epic, GOLD);
  assert.equal(body.market.calendar, IG_SPOT_GOLD.id, "Gold must use the IG Spot Gold calendar");
  assert.equal(body.summary.unexpectedRows, 0, "Gold trades Sunday 23:30 UK — the row is a normal bucket");
  assert.equal(body.summary.completed, 1);
  assert.ok(!body.unexpected.includes(ISO(SUNDAY_BUCKET_SEC)));
  assert.ok(!body.missing.includes(ISO(SUNDAY_BUCKET_SEC)));
});

test("/gaps: omitted epic defaults to DAX and its calendar", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request("/candles/db/gaps?hours=240");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { epic: string; market: { calendar: string } };
  assert.equal(body.epic, DAX);
  assert.equal(body.market.calendar, IG_GERMANY_40.id);
});

test("/gaps: unsupported epic → 400 UNSUPPORTED_EPIC", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request("/candles/db/gaps?epic=BOGUS.EPIC&hours=1");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "UNSUPPORTED_EPIC");
});

test("/gaps: a configured EPIC without a registered calendar → 400 NO_MARKET_CALENDAR (never guessed)", async () => {
  // A configured instrument with NO calendar (the registry's conservative
  // fallback for unknown EPICs) must be REFUSED, not scanned with DAX hours.
  const store = new FakeCandleStore();
  const custom: InstrumentMeta[] = [...INSTRUMENTS, instrumentMetaFor("ZZ.UNREGISTERED.EPIC")];
  const app = createCandlesDbRouter(store as unknown as CandleStore, custom);
  const res = await app.request("/candles/db/gaps?epic=ZZ.UNREGISTERED.EPIC&hours=1");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "NO_MARKET_CALENDAR");
});

// ── 7. Registry identity — the calendar routing source ───────────────────────

test("registry: DAX resolves IG_GERMANY_40 and Gold resolves IG_SPOT_GOLD (identity)", () => {
  assert.equal(instrumentMetaFor(DAX).calendar, IG_GERMANY_40);
  assert.equal(instrumentMetaFor(GOLD).calendar, IG_SPOT_GOLD);
  assert.equal(instrumentMetaFor(DAX).decimals, 1);
  assert.equal(instrumentMetaFor(GOLD).decimals, 2);
});

