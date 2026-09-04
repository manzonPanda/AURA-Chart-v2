/**
 * Timeframe-aware EMA alert tests — 1m and 3m units, close-time derivation,
 * per-timeframe independence/cooldown/session/DST, alertTimeframes gates and
 * warm-up reconstruction (Node test runner via tsx: npm --prefix backend run test).
 *
 * Session anchors (America/New_York, IANA — never fixed offsets):
 *   2025-01-15 Wed (EST, UTC-5):
 *     1m bucket 14:30 UTC closes 14:31 UTC = 09:31 NY (first in-session close)
 *     3m bucket 14:30 UTC closes 14:33 UTC = 09:33 NY (first in-session close)
 *     3m bucket 20:57 UTC closes 21:00 UTC = 16:00 NY (last in-session close)
 *     3m bucket 21:00 UTC closes 21:03 UTC = 16:03 NY (out — cancels pending)
 *   DST: 2025-10-31 Fri (EDT, UTC-4) vs 2025-11-03 Mon (EST, UTC-5).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { ClosedSignal } from "../emaAlert/alertPipeline.js";
import { EmaAlertPipeline } from "../emaAlert/alertPipeline.js";
import { closeMsOf, EmaAlertEngine, type ClosedCandleInput } from "../emaAlert/emaAlertEngine.js";
import { defaultEmaAlertSettings, type EmaAlertSettings } from "../emaAlert/emaAlertConfig.js";
import type { PushService } from "../emaAlert/pushService.js";
import type { EmaAlertSettingsStore } from "../emaAlert/settingsStore.js";
import type { CandleStore } from "../db/candleStore.js";

const UTC = (y: number, m: number, d: number, h: number, min: number): number =>
  Date.UTC(y, m - 1, d, h, min);
const SEC = (ms: number): number => Math.floor(ms / 1000);

// ── closeMsOf: per-timeframe close instants (spec item 5) ──────────────────

test("closeMsOf derives +60s for MINUTE_1 and +180s for MINUTE_3 (no hardcoded 60s)", () => {
  const bucket = SEC(UTC(2025, 1, 15, 14, 30));
  assert.equal(closeMsOf("MINUTE_1", bucket), (bucket + 60) * 1000);
  assert.equal(closeMsOf("MINUTE_3", bucket), (bucket + 180) * 1000);
  // Unknown timeframe falls back to the canonical 1m width.
  assert.equal(closeMsOf("MINUTE_5", bucket), (bucket + 60) * 1000);
});

// ── pipeline-level 3m state machine (same machine, 3m buckets) ─────────────

const P0 = SEC(UTC(2025, 1, 14, 22, 0)); // close 17:03 NY — out of session
const T0 = SEC(UTC(2025, 1, 15, 14, 30)); // close 09:33 NY — first 3m in-session close

function settings(overrides: Partial<EmaAlertSettings> = {}): EmaAlertSettings {
  return { ...defaultEmaAlertSettings(), enabled: true, ...overrides };
}

let clockNow = 1000;
function makePipeline(s: EmaAlertSettings): EmaAlertPipeline {
  clockNow = 1000;
  return new EmaAlertPipeline(() => s, { now: () => clockNow });
}

function sig(bucketSec: number, ema9: number, ema20: number, price = 24000): ClosedSignal {
  return { bucketSec, ema9, ema20, price };
}

const bearPrime = [sig(P0, 100, 110), sig(P0 + 180, 100, 111)];
const bullPrime = [sig(P0, 110, 100), sig(P0 + 180, 111, 100)];
const close3 = (bucketSec: number): number => (bucketSec + 180) * 1000;

test("3m bullish confirmation after 2 closed 3m candles", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  const cross = p.onClosedCandle(sig(T0, 105, 100), close3(T0));
  assert.equal(cross.alert, null);
  assert.deepEqual(cross.pending, { direction: "bullish", confirmations: 1, needed: 2 });
  const conf = p.onClosedCandle(sig(T0 + 180, 106, 100), close3(T0 + 180));
  assert.equal(conf.alert?.direction, "bullish");
});

test("3m bearish confirmation after 2 closed 3m candles", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bullPrime[0], 0);
  p.onClosedCandle(bullPrime[1], 0);
  const cross = p.onClosedCandle(sig(T0, 100, 105), close3(T0));
  assert.deepEqual(cross.pending, { direction: "bearish", confirmations: 1, needed: 2 });
  const conf = p.onClosedCandle(sig(T0 + 180, 100, 106), close3(T0 + 180));
  assert.equal(conf.alert?.direction, "bearish");
});

test("3m pending lifecycle cancels when the relationship flips before confirmation", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  p.onClosedCandle(sig(T0, 105, 100), close3(T0)); // bullish pending 1/2
  // The flip cancels the bullish pending and the bear cross starts a fresh
  // bearish lifecycle (same semantics as the 1m state machine).
  const flip = p.onClosedCandle(sig(T0 + 180, 100, 106), close3(T0 + 180));
  assert.equal(flip.alert, null);
  assert.deepEqual(flip.pending, { direction: "bearish", confirmations: 1, needed: 2 });
  // The original bullish lifecycle is gone: a bull re-cross starts over at 1/2.
  const recross = p.onClosedCandle(sig(T0 + 360, 107, 100), close3(T0 + 360));
  assert.equal(recross.alert, null);
  assert.deepEqual(recross.pending, { direction: "bullish", confirmations: 1, needed: 2 });
});

test("3m session end: close at 16:00 NY confirms, close at 16:03 NY is out of session", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  // Cross candle closes 15:57 NY (bucket 20:54) → in-session pending.
  const crossBucket = SEC(UTC(2025, 1, 15, 20, 54));
  const cross = p.onClosedCandle(sig(crossBucket, 105, 100), close3(crossBucket));
  assert.deepEqual(cross.pending, { direction: "bullish", confirmations: 1, needed: 2 });
  // Confirmation closes 16:00 NY (bucket 20:57) → the LAST in-session close → alert.
  const lastBucket = SEC(UTC(2025, 1, 15, 20, 57));
  const conf = p.onClosedCandle(sig(lastBucket, 106, 100), close3(lastBucket));
  assert.equal(conf.alert?.direction, "bullish", "16:00 NY close must still confirm");
  // A fresh cross closing 16:03 NY (bucket 21:00) is out of session → never opens.
  const outBucket = SEC(UTC(2025, 1, 15, 21, 0));
  const afterEnd = p.onClosedCandle(sig(outBucket, 90, 100), close3(outBucket));
  assert.equal(afterEnd.alert, null);
  assert.equal(afterEnd.pending, null, "16:03 NY close is out of session");
});

test("3m DST: EDT 09:33 NY close is in-session; the same UTC instant is 08:33 on an EST day (out)", () => {
  // EDT day: 2025-10-31, bucket 13:30 UTC closes 13:33 UTC = 09:33 EDT → in.
  const pEdt = makePipeline(settings());
  pEdt.onClosedCandle(bearPrime[0], 0);
  pEdt.onClosedCandle(bearPrime[1], 0);
  const edtBucket = SEC(UTC(2025, 10, 31, 13, 30));
  const edt = pEdt.onClosedCandle(sig(edtBucket, 105, 100), close3(edtBucket));
  assert.deepEqual(edt.pending, { direction: "bullish", confirmations: 1, needed: 2 });

  // EST day: 2025-11-03, the SAME 13:30 UTC bucket closes 08:33 EST → out
  // (a bear candle there merely tracks the relationship; nothing opens).
  const pEst = makePipeline(settings());
  pEst.onClosedCandle(bearPrime[0], 0);
  pEst.onClosedCandle(bearPrime[1], 0);
  const estBucket = SEC(UTC(2025, 11, 3, 13, 30));
  const est = pEst.onClosedCandle(sig(estBucket, 100, 112), close3(estBucket));
  assert.equal(est.alert, null);
  assert.equal(est.pending, null);
  // The EST 09:33 close (14:30 UTC bucket) is in-session: a bull cross opens.
  const estInBucket = SEC(UTC(2025, 11, 3, 14, 30));
  const estIn = pEst.onClosedCandle(sig(estInBucket, 105, 100), close3(estInBucket));
  assert.deepEqual(estIn.pending, { direction: "bullish", confirmations: 1, needed: 2 });
});

// ── engine-level: independent per-timeframe units ──────────────────────────

interface EngineHarness {
  engine: EmaAlertEngine;
  pushes: Array<Record<string, unknown>>;
}

function flatRows(count: number, close: number): Array<{ time: number; open: number; high: number; low: number; close: number; tickCount: number | null }> {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const time = SEC(UTC(2025, 1, 15, 11, 0) + i * 60_000); // 11:00 UTC onward — out of session
    rows.push({ time, open: close, high: close, low: close, close, tickCount: 1 });
  }
  return rows;
}

function makeEngine(overrides: {
  settings?: Partial<EmaAlertSettings>;
  runtime?: { lastAlertBullishAt: Record<string, number>; lastAlertBearishAt: Record<string, number> };
} = {}): EngineHarness {
  const pushes: Array<Record<string, unknown>> = [];
  let runtime = overrides.runtime ?? { lastAlertBullishAt: {}, lastAlertBearishAt: {} };

  const pushStub = {
    configured: true,
    publicKey: (): string | null => "test-public-key",
    count: (): number => 1,
    add: (): void => {},
    remove: (): void => {},
    sendAll: async (payload: Record<string, unknown>) => {
      pushes.push(payload);
      return { sent: 1, pruned: 0 };
    },
  } as unknown as PushService;

  const storeStub = {
    load: () => ({
      settings: { ...defaultEmaAlertSettings(), enabled: true, ...overrides.settings },
      runtime,
    }),
    save: (state: unknown): void => {
      runtime = (state as { runtime: typeof runtime }).runtime;
    },
  } as unknown as EmaAlertSettingsStore;

  const candleStoreStub = {
    loadCandles: async (): Promise<ReturnType<typeof flatRows>> => flatRows(210, 20000),
  } as unknown as CandleStore;

  const engine = new EmaAlertEngine({
    epic: "IX.D.DAX.IGM.IP",
    instrumentLabel: "DAX / IG",
    candleStore: candleStoreStub,
    push: pushStub,
    store: storeStub,
    clock: { now: () => 1_000_000_000 },
    broadcast: (): void => {},
  });
  return { engine, pushes };
}

function candle(timeSec: number, close: number): ClosedCandleInput {
  return { time: timeSec, open: close - 1, high: close + 1, low: close - 2, close };
}

test("warm-up reconstructs BOTH units: 1m directly, 3m derived from the same 1m rows — no notifications", async () => {
  const { engine, pushes } = makeEngine();
  await engine.start();
  const snap = engine.statusSnapshot();
  assert.equal(pushes.length, 0, "warm-up must never emit notifications (either timeframe)");
  assert.equal(snap.states["MINUTE_1"]?.closedCandles, 210);
  assert.equal(snap.states["MINUTE_3"]?.closedCandles, 70, "3m unit derives 70 complete 3m candles from 210 1m rows");
  assert.equal(snap.states["MINUTE_3"]?.ready, true);
  // Flat series → both EMAs converge on 20000 (real PineTS math on 3m candles).
  assert.ok(Math.abs((snap.states["MINUTE_3"]?.lastEma9 ?? 0) - 20000) < 1e-6);
});

test("1m and 3m units alert independently: identical bullish lifecycles produce TWO pushes", async () => {
  const { engine, pushes } = makeEngine();
  await engine.start();
  const cross = SEC(UTC(2025, 1, 15, 14, 30));
  // 1m lifecycle (closes 09:31 + 09:32 NY).
  engine.onClosedCandle(candle(cross, 20001), "MINUTE_1");
  engine.onClosedCandle(candle(cross + 60, 20002), "MINUTE_1");
  await engine.flush();
  // 3m lifecycle (closes 09:33 + 09:36 NY).
  engine.onClosedCandle(candle(cross, 20001), "MINUTE_3");
  engine.onClosedCandle(candle(cross + 180, 20002), "MINUTE_3");
  await engine.flush();
  assert.equal(pushes.length, 2, "1m and 3m detections must be fully independent");
  assert.equal(pushes[0].timeframe, "MINUTE_1");
  assert.equal(pushes[1].timeframe, "MINUTE_3");
});

test("a 1m alert's cooldown never suppresses a 3m alert (per-timeframe cooldown, restart-preserved)", async () => {
  const now = 1_000_000_000;
  // MINUTE_1 alerted 1 min ago (inside the 30-min cooldown); MINUTE_3 31 min ago (expired).
  const { engine, pushes } = makeEngine({
    runtime: {
      lastAlertBullishAt: { MINUTE_1: now - 60_000, MINUTE_3: now - 31 * 60_000 },
      lastAlertBearishAt: {},
    },
  });
  await engine.start();
  const cross = SEC(UTC(2025, 1, 15, 14, 30));
  engine.onClosedCandle(candle(cross, 20001), "MINUTE_1");
  engine.onClosedCandle(candle(cross + 60, 20002), "MINUTE_1");
  await engine.flush();
  assert.equal(pushes.length, 0, "1m cooldown must suppress the 1m alert");
  engine.onClosedCandle(candle(cross, 20001), "MINUTE_3");
  engine.onClosedCandle(candle(cross + 180, 20002), "MINUTE_3");
  await engine.flush();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].timeframe, "MINUTE_3", "the 3m unit must be unaffected by the 1m cooldown");
});

test("alertTimeframes gate: [MINUTE_3] silences 1m while 3m still alerts (and vice versa)", async () => {
  const cross = SEC(UTC(2025, 1, 15, 14, 30));
  // 3m only.
  const only3 = makeEngine({ settings: { alertTimeframes: ["MINUTE_3"] } });
  await only3.engine.start();
  only3.engine.onClosedCandle(candle(cross, 20001), "MINUTE_1");
  only3.engine.onClosedCandle(candle(cross + 60, 20002), "MINUTE_1");
  await only3.engine.flush();
  assert.equal(only3.pushes.length, 0, "1m must be disabled by alertTimeframes");
  only3.engine.onClosedCandle(candle(cross, 20001), "MINUTE_3");
  only3.engine.onClosedCandle(candle(cross + 180, 20002), "MINUTE_3");
  await only3.engine.flush();
  assert.equal(only3.pushes.length, 1);
  assert.equal(only3.pushes[0].timeframe, "MINUTE_3");

  // 1m only.
  const only1 = makeEngine({ settings: { alertTimeframes: ["MINUTE_1"] } });
  await only1.engine.start();
  only1.engine.onClosedCandle(candle(cross, 20001), "MINUTE_3");
  only1.engine.onClosedCandle(candle(cross + 180, 20002), "MINUTE_3");
  await only1.engine.flush();
  assert.equal(only1.pushes.length, 0, "3m must be disabled by alertTimeframes");
  only1.engine.onClosedCandle(candle(cross, 20001), "MINUTE_1");
  only1.engine.onClosedCandle(candle(cross + 60, 20002), "MINUTE_1");
  await only1.engine.flush();
  assert.equal(only1.pushes.length, 1);
  assert.equal(only1.pushes[0].timeframe, "MINUTE_1");
});

test("a 3m alert's notification carries the 3m close instant (+180s), never the 1m assumption", async () => {
  const { engine, pushes } = makeEngine();
  await engine.start();
  const cross = SEC(UTC(2025, 1, 15, 14, 30));
  engine.onClosedCandle(candle(cross, 20001), "MINUTE_3");
  engine.onClosedCandle(candle(cross + 180, 20002), "MINUTE_3");
  await engine.flush();
    assert.equal(pushes.length, 1);
  // Confirmation candle bucket 14:33 UTC closes at 14:36 UTC = (bucket + 180)s.
  assert.equal(pushes[0].confirmedAtMs, (cross + 180 + 180) * 1000);
});