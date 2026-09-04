/**
 * EMA Reversal Alert engine integration test — the REAL PineTS adapter wired
 * through the pipeline (unlike the synthetic-pair state-machine tests).
 *
 * Flow under test:
 *   engine.start() warms up from the (fake) candle store over a flat,
 *   out-of-session series → no alerts may be produced during warm-up.
 *   Then two LIVE closed candles close in-session on 2025-01-15 (Wed, EST):
 *   14:30 UTC closes 09:31 NY, 14:31 UTC closes 09:32 NY. The first rises
 *   just above a long flat 20000 series so EMA 9 crosses EMA 20; the second
 *   holds the relationship → confirmation 2/2 → a Web Push must fire.
 *
 * Run: npm --prefix backend run test
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { CandleStore } from "../db/candleStore.js";
import { defaultEmaAlertSettings } from "../emaAlert/emaAlertConfig.js";
import type { PushService } from "../emaAlert/pushService.js";
import type { EmaAlertSettingsStore } from "../emaAlert/settingsStore.js";
import { EmaAlertEngine } from "../emaAlert/emaAlertEngine.js";

const UTC = (h: number, min: number): number => Date.UTC(2025, 0, 15, h, min);

function flatRows(fromUtcMin: number, count: number, close: number): Array<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number | null;
}> {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const time = Math.floor((UTC(0, 0) + fromUtcMin * 60_000 + i * 60_000) / 1000);
    rows.push({ time, open: close, high: close, low: close, close, tickCount: 1 });
  }
  return rows;
}

const PRE_CANDLES = 210; // 11:00→14:29 UTC (06:00→09:30 NY closes), all out-of-session
const preRows = flatRows(11 * 60, PRE_CANDLES, 20000);

function makeEngine(): {
  engine: EmaAlertEngine;
  pushes: Array<Record<string, unknown>>;
  saved: Array<unknown>;
} {
  const pushes: Array<Record<string, unknown>> = [];
  const saved: Array<unknown> = [];

  const pushStub = {
    configured: true,
    publicKey: (): string | null => "test-public-key",
    count: (): number => 0,
    add: (): void => {},
    remove: (): void => {},
    sendAll: async (payload: Record<string, unknown>) => {
      pushes.push(payload);
      return { sent: 1, pruned: 0 };
    },
  } as unknown as PushService;

  const storeStub = {
    load: () => ({
      settings: { ...defaultEmaAlertSettings(), enabled: true },
      runtime: { lastAlertBullishAt: 0, lastAlertBearishAt: 0 },
    }),
    save: (state: unknown) => saved.push(state),
  } as unknown as EmaAlertSettingsStore;

  const candleStoreStub = {
    loadCandles: async (): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; tickCount: number | null }>> => preRows,
  } as unknown as CandleStore;

  const engine = new EmaAlertEngine({
    epic: "IX.D.DAX.IGM.IP",
    instrumentLabel: "DAX / IG",
    candleStore: candleStoreStub,
    push: pushStub,
    store: storeStub,
    broadcast: (): void => {},
  });
  return { engine, pushes, saved };
}

test("engine: real PineTS EMA adapter confirms a bullish reversal and pushes once", async () => {
  const { engine, pushes, saved } = makeEngine();
  await engine.start();

  // Warm-up replay must NOT have alerted.
  assert.equal(pushes.length, 0, "warm-up replay must never emit a notification");

     // Live closed candles: cross (09:31 NY close) + confirmation (09:32 NY close).
  const crossAt = Math.floor(UTC(14, 30) / 1000);
  const confirmAt = Math.floor(UTC(14, 31) / 1000);
  engine.onClosedCandle({ time: crossAt, open: 20000, high: 20001, low: 19999, close: 20001 }, "MINUTE_1");
  engine.onClosedCandle({ time: confirmAt, open: 20001, high: 20002, low: 20000, close: 20002 }, "MINUTE_1");
  await engine.flush();

  assert.equal(pushes.length, 1, "exactly one confirmed alert must be pushed");
  assert.equal(pushes[0].direction, "bullish");
  assert.equal(pushes[0].confirmationCandles, 2);
  assert.equal(pushes[0].instrument, "DAX / IG");
  assert.ok(pushes[0].confirmedAtMs === (confirmAt + 60) * 1000, "time must be the close instant");

  const snap = engine.statusSnapshot();
  assert.equal(snap.states["MINUTE_1"]?.lastAlert?.direction, "bullish");
  assert.ok(snap.states["MINUTE_1"]?.lastEma9 !== null && snap.states["MINUTE_1"]!.lastEma9! > snap.states["MINUTE_1"]!.lastEma20!, "EMA 9 > EMA 20 after confirm");
  assert.equal(snap.states["MINUTE_1"]?.pending, null, "no pending lifecycle after confirmation");

  // The cooldown continuity was persisted.
  assert.ok(saved.length >= 1, "state must be persisted after the alert");
  const persisted = saved[saved.length - 1] as { runtime?: { lastAlertBullishAt: Record<string, number> } };
  assert.ok((persisted.runtime?.lastAlertBullishAt?.["MINUTE_1"] ?? 0) > 0, "bullish cooldown timestamp persisted");

  // Duplicate protection: holding the relationship does NOT fire again.
  engine.onClosedCandle({ time: confirmAt + 60, open: 20002, high: 20003, low: 20001, close: 20003 }, "MINUTE_1");
  await engine.flush();
  assert.equal(pushes.length, 1, "no duplicate alert while the relationship holds");
});

test("engine: settings disabled prevents delivery while detection still runs", async () => {
  const { engine, pushes } = makeEngine();
  await engine.start();
  // Disable mid-flight (no restart) — a confirmed reversal after this must be
  // suppressed (the lifecycle is still consumed; the gate blocks delivery).
  await engine.applySettings({ enabled: false });

     const crossAt = Math.floor(UTC(14, 30) / 1000);
  const confirmAt = Math.floor(UTC(14, 31) / 1000);
  engine.onClosedCandle({ time: crossAt, open: 20000, high: 20001, low: 19999, close: 20001 }, "MINUTE_1");
  engine.onClosedCandle({ time: confirmAt, open: 20001, high: 20002, low: 20000, close: 20002 }, "MINUTE_1");
  await engine.flush();

  assert.equal(pushes.length, 0, "disabled alerts must never push");
  const snap = engine.statusSnapshot();
  assert.equal(snap.enabled, false);
});