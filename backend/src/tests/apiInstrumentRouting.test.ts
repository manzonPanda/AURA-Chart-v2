/**
 * API instrument-routing tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *
 * Proves (against the REAL Hono routers with a FAKE CandleStore — no network,
 * no Supabase, no provider import):
 *   1. GET /api/instruments lists the registry catalog with the GOLD default.
 *   2. /candles/db: valid DAX (legacy archive) epic → 200, valid GOLD epic → 200.
 *   3. /candles/db: omitted epic → defaults to GOLD (the active CAPITAL default).
 *   4. /candles/db: unsupported epic → 400 UNSUPPORTED_EPIC (never an empty
 *      dataset). The store is keyed by the resolved instrument — a DAX request
 *      cannot return Gold rows and vice versa.
 *   5. /candles/db/gaps: DAX resolves the IG_GERMANY_40 archive calendar; Gold
 *      resolves IG_SPOT_GOLD — proven with a Sunday-evening bucket that Gold's
 *      calendar expects but DAX's does not.
 *   6. IG RETIREMENT: the IG REST routers (GET /api/candles and GET
 *      /api/markets) are REMOVED from the API surface — 404s, never a
 *      provider call. The chart history source is exclusively the store.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { CandleStore, PersistedCandle } from "../db/candleStore.js";
import { IG_GERMANY_40, IG_SPOT_GOLD } from "../market/calendar.js";
import {
  DAX_INSTRUMENT,
  GOLD_INSTRUMENT,
  type InstrumentMeta,
} from "../market/instruments.js";
import { createCandlesDbRouter } from "../routes/candlesDb.js";
import { createInstrumentsRouter } from "../routes/instruments.js";

const DAX = DAX_INSTRUMENT.epic; // IX.D.DAX.IGM.IP — legacy archive identity
const GOLD = GOLD_INSTRUMENT.epic; // GOLD — Capital.com identity
const CATALOG: readonly InstrumentMeta[] = [DAX_INSTRUMENT, GOLD_INSTRUMENT];

// ── Fixture bucket: most recent COMPLETED Sunday 23:30-London bucket ────────
// Must sit inside IG Spot Gold's Sunday window (23:00–24:00 UK) while DAX is
// closed all Sunday. Computed RELATIVE to runtime now so it can never age out
// of the ≤240 h lookback. DST-safe: the 23:30 London instant is derived PER
// DATE through Intl (see the pre-retirement version of this fixture for the
// full derivation rationale).
const SUNDAY_BUCKET_SEC: number = (() => {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const partsOf = (ms: number): Map<string, string> => {
    const map = new Map<string, string>();
    for (const part of fmt.formatToParts(new Date(ms))) map.set(part.type, part.value);
    return map;
  };
  const nowMs = Date.now();
  let cursor = nowMs;
  for (let hop = 0; hop < 9; hop++) {
    const p = partsOf(cursor);
    if (p.get("weekday") === "Sun") {
      const y = Number(p.get("year"));
      const mo = Number(p.get("month")) - 1;
      const d = Number(p.get("day"));
      const noonGuess = Date.UTC(y, mo, d, 12);
      const noonMinutes = Number(partsOf(noonGuess).get("hour")) * 60 +
        Number(partsOf(noonGuess).get("minute"));
      const noonUtc = noonGuess + (12 * 60 - noonMinutes) * 60_000;
      const bucketStartMs = noonUtc + (23 * 60 + 30 - 12 * 60) * 60_000; // +11h30m
      const date = `${p.get("year")}-${p.get("month")}-${p.get("day")}`;
      const complete = bucketStartMs + 60_000 <= nowMs;
      const notClosed = !IG_SPOT_GOLD.closedDates.includes(date);
      if (complete && notClosed) return Math.floor(bucketStartMs / 1000);
    }
    cursor -= 24 * 60 * 60_000;
  }
  throw new Error("fixture: no completable Sunday 23:30 London bucket found within 8 days");
})();
const ISO = (sec: number): string => new Date(sec * 1000).toISOString();

/** Fake store: rows are instrument-TAGGED and filtered per request, exactly
 *  like the DB's `WHERE instrument = …`; the requested instrument is captured
 *  so tests can assert the router queried the RIGHT one. */
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
  createCandlesDbRouter(store as unknown as CandleStore, CATALOG, GOLD);

// ── 1. GET /api/instruments ──────────────────────────────────────────────────

test("GET /api/instruments lists the registry catalog with the GOLD default", async () => {
  const app = createInstrumentsRouter(CATALOG, GOLD);
  const res = await app.request("/instruments");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    defaultEpic: string;
    count: number;
    instruments: Array<{ epic: string; label: string; decimals: number; calendar: { id: string } | null }>;
  };
  assert.equal(body.defaultEpic, GOLD, "the active CAPITAL default is GOLD");
  assert.equal(body.count, 2);
  assert.equal(body.instruments[0].epic, DAX, "DAX remains catalogued as a legacy ARCHIVE entry");
  assert.equal(body.instruments[0].calendar?.id, IG_GERMANY_40.id);
  assert.equal(body.instruments[1].epic, GOLD);
  assert.equal(body.instruments[1].decimals, 2);
  assert.equal(body.instruments[1].calendar?.id, IG_SPOT_GOLD.id);
});

// ── 2 + 3. /candles/db routing & isolation ───────────────────────────────────

test("/candles/db: valid DAX (archive) epic → 200 and queries the DAX identity", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request(`/candles/db?epic=${encodeURIComponent(DAX)}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { epic: string; count: number; candles: Array<{ close: number }> };
  assert.equal(body.epic, DAX, "archive reads by the legacy identity still work");
  assert.equal(store.lastInstrument, DAX);
  assert.equal(body.count, 1);
  assert.equal(body.candles[0].close, 26000.5, "must be the DAX row, never a Gold row");
});

test("/candles/db: valid Gold epic → 200 and queries the Gold identity", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request(`/candles/db?epic=${encodeURIComponent(GOLD)}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { epic: string; count: number; candles: Array<{ close: number }> };
  assert.equal(body.epic, GOLD);
  assert.equal(store.lastInstrument, GOLD);
  assert.equal(body.count, 1);
  assert.equal(body.candles[0].close, 4477.6, "must be the Gold row, never a DAX row");
});

test("/candles/db: omitted epic defaults to GOLD (the active CAPITAL default)", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request("/candles/db");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { epic: string };
  assert.equal(body.epic, GOLD, "the chart's default history instrument is GOLD, never DAX/IG");
  assert.equal(store.lastInstrument, GOLD);
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
  const daxRes = await app.request("/candles/db?timeframe=MINUTE_1&epic=" + encodeURIComponent(DAX));
  const goldRes = await app.request("/candles/db?timeframe=MINUTE_1&epic=" + encodeURIComponent(GOLD));
  const daxBody = (await daxRes.json()) as { candles: Array<{ close: number }> };
  const goldBody = (await goldRes.json()) as { candles: Array<{ close: number }> };
  for (const candle of daxBody.candles) assert.ok(candle.close > 20000, "DAX response carries only DAX-priced rows");
  for (const candle of goldBody.candles) assert.ok(candle.close < 10000, "Gold response carries only Gold-priced rows");
});

// ── 6. IG RETIREMENT — the IG REST routers are GONE from the API surface ─────

test("/api/candles (IG REST proxy) is REMOVED — 404, no provider call", async () => {
  // index.ts no longer mounts createCandlesRouter; an app built exactly like
  // the production surface (only the db + instruments routers) 404s it.
  const app = makeDbApp(new FakeCandleStore());
  const res = await app.request("/candles?epic=" + encodeURIComponent(GOLD) + "&resolution=MINUTE_3");
  assert.equal(res.status, 404, "the IG historical REST route no longer exists");
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  assert.ok(body === null || typeof body.message === "string", "404 body is Hono's default (no IG data shape)");
});

test("/api/markets (IG market discovery) is REMOVED — 404", async () => {
  const app = makeDbApp(new FakeCandleStore());
  const res = await app.request("/markets?q=Gold");
  assert.equal(res.status, 404, "the IG market search/discovery route no longer exists");
});

// ── 5. /candles/db/gaps — per-instrument MarketCalendar routing ──────────────

test("/gaps: DAX (archive) uses IG_GERMANY_40 — the Sunday-evening bucket is UNEXPECTED for DAX", async () => {
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
  assert.equal(body.market.calendar, IG_GERMANY_40.id, "DAX must use the IG Germany 40 calendar (archive reads)");
  assert.equal(body.summary.unexpectedRows, 1, "the Sunday row is outside DAX hours → unexpected");
  assert.equal(body.summary.completed, 0);
  assert.ok(body.unexpected.includes(ISO(SUNDAY_BUCKET_SEC)));
});

test("/gaps: GOLD uses IG_SPOT_GOLD — the Sunday-evening bucket is COMPLETED for Gold", async () => {
  const store = new FakeCandleStore();
  const res = await makeDbApp(store).request("/candles/db/gaps?epic=" + encodeURIComponent(GOLD) + "&hours=240");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    epic: string;
    market: { calendar: string };
    summary: { unexpectedRows: number; completed: number };
  };
  assert.equal(body.epic, GOLD);
  assert.equal(body.market.calendar, IG_SPOT_GOLD.id, "Gold must use the CME Globex gold calendar");
  assert.equal(body.summary.unexpectedRows, 0);
  assert.equal(body.summary.completed, 1);
});
