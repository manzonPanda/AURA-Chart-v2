/**
 * Alert gates — unit tests (cooldown, session boundaries, DST across the
 * pipeline, enable/disable switches). Node test runner via tsx:
 *   npm --prefix backend run test
 *
 * Session buckets: 2025-01-15 (Wednesday, EST). B0 closes 09:31 NY; the last
 * in-session close is 15:59 NY (bucket start 20:58 UTC closes 21:00 UTC).
 * DST-day buckets use 2025-10-31 (Fri, EDT) and 2025-11-03 (Mon, EST).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { ClosedSignal } from "../emaAlert/alertPipeline.js";
import { EmaAlertPipeline } from "../emaAlert/alertPipeline.js";
import { defaultEmaAlertSettings, type EmaAlertSettings } from "../emaAlert/emaAlertConfig.js";

const UTC = (y: number, m: number, d: number, h = 0, min = 0): number => Date.UTC(y, m - 1, d, h, min);
const B0 = Math.floor(UTC(2025, 1, 15, 14, 30) / 1000); // close 09:31 NY (EST)
const P0 = Math.floor(UTC(2025, 1, 14, 22, 0) / 1000); // close 17:01 NY (out)

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

const bearPrime = [sig(P0, 100, 110), sig(P0 + 60, 100, 111)];
const bullPrime = [sig(P0, 110, 100), sig(P0 + 60, 111, 100)];

/** Drive one full bullish lifecycle starting at bucket `start` (in-session). */
function bullishLifecycle(p: EmaAlertPipeline, start: number): void {
  p.onClosedCandle(sig(start, 105, 100), (start + 60) * 1000); // cross 1/2
  p.onClosedCandle(sig(start + 60, 106, 100), (start + 120) * 1000); // confirm
}

/** Drive one full bearish lifecycle starting at bucket `start` (in-session). */
function bearishLifecycle(p: EmaAlertPipeline, start: number): void {
  p.onClosedCandle(sig(start, 100, 105), (start + 60) * 1000);
  p.onClosedCandle(sig(start + 60, 100, 106), (start + 120) * 1000);
}

test("7. cooldown suppresses a duplicate-direction notification until it expires", () => {
  let now = 1_000;
  const p = new EmaAlertPipeline(() => settings(), { now: () => now });
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  bullishLifecycle(p, B0); // bullish alert #1 (now = 1000)
  assert.ok(p.getLastAlertAt().bullish > 0);
  // Opposite direction is independent: a bearish reversal right after alerts.
  now += 4 * 60_000; // +4 min
  bearishLifecycle(p, B0 + 120);
  assert.ok(p.getLastAlertAt().bearish > 0);
  // New BULLISH lifecycle within the 30-min cooldown → suppressed.
  now += 5 * 60_000; // +5 min (9 min since the bullish alert)
  bullishLifecycle(p, B0 + 240);
  assert.equal(p.getLastAlertAt().bullish, 1_000, "bullish timestamp must not advance");
  // After the cooldown expires, a NEW bullish lifecycle alerts again. A bear
  // cycle runs first so the bull cross is a genuine transition (after the
  // suppressed confirm the relationship was still "bull").
  now += 25 * 60_000; // total 34 min since the bullish alert
  bearishLifecycle(p, B0 + 360);
  bullishLifecycle(p, B0 + 480);
  assert.ok(p.getLastAlertAt().bullish > 1_000, "bullish should alert after cooldown");
});

test("8. session start is respected: no lifecycle completes before 09:31 closes", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  // Cross candle closing 09:29 NY (bucket 14:28 UTC) — OUT of session:
  // the pending reversal is cancelled immediately, nothing can alert.
  const pre = p.onClosedCandle(sig(UTC(2025, 1, 15, 14, 28) / 1000, 105, 100), UTC(2025, 1, 15, 14, 29));
  assert.equal(pre.alert, null);
  assert.equal(pre.pending, null);
  // A relationship that only exists pre-session never fires at the open:
  // the first in-session candles see a stable relationship → steady state.
  const first = p.onClosedCandle(sig(B0, 105, 100), (B0 + 60) * 1000); // close 09:31
  assert.equal(first.alert, null, "overnight relationship must not alert at the open");
  assert.equal(first.pending, null);
  // A crossover genuinely starting in-session still alerts: bear lifecycle
  // first (creates the opposite baseline in-session), then a bullish cross.
  bearishLifecycle(p, B0 + 60); // closes 09:32/09:33 NY → bearish alert
  assert.ok(p.getLastAlertAt().bearish > 0);
  bullishLifecycle(p, B0 + 180); // closes 09:34/09:35 NY → bullish alert
  assert.ok(p.getLastAlertAt().bullish > 0);
});

test("9. session end is respected: 15:59 close confirms, 16:01 close cannot", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  // Lifecycle confirming on the candle closing 16:00 NY (the 15:59 bar is
  // the cross at close 15:59): both closes are in-session → alert fires.
  const lastCross = Math.floor(UTC(2025, 1, 15, 20, 57) / 1000); // close 15:59 NY
  bullishLifecycle(p, lastCross); // confirm candle closes 16:00 NY
  assert.ok(p.getLastAlertAt().bullish > 0, "close at 16:00 NY is the last confirmable close");
  // A cross at the 16:00 close then a confirming candle closing 16:01 NY →
  // out of session → cancelled, no alert.
  const p2 = makePipeline(settings());
  p2.onClosedCandle(sig(P0, 100, 110), 0);
  p2.onClosedCandle(sig(P0 + 60, 100, 111), 0);
  const crossAtEnd = p2.onClosedCandle(sig(Math.floor(UTC(2025, 1, 15, 20, 59) / 1000), 105, 100), UTC(2025, 1, 15, 21, 0));
  assert.deepEqual(crossAtEnd.pending, { direction: "bullish", confirmations: 1, needed: 2 });
  const afterEnd = p2.onClosedCandle(sig(Math.floor(UTC(2025, 1, 15, 21, 0) / 1000), 106, 100), UTC(2025, 1, 15, 21, 1));
  assert.equal(afterEnd.alert, null, "close at 16:01 NY is out of session");
  assert.equal(afterEnd.pending, null);
});

test("10. DST transition handled: the same UTC instant flips session membership", () => {
  // 2025-10-31 (Fri, EDT, UTC-4): bucket 13:30 UTC closes 13:31 UTC = 09:31 NY → in-session.
  const pEdt = makePipeline(settings());
  pEdt.onClosedCandle(sig(Math.floor(UTC(2025, 10, 30, 21, 0) / 1000), 100, 110), 0);
  pEdt.onClosedCandle(sig(Math.floor(UTC(2025, 10, 30, 21, 1) / 1000), 100, 111), 0);
  const edtCross = Math.floor(UTC(2025, 10, 31, 13, 30) / 1000);
  const edt = pEdt.onClosedCandle(sig(edtCross, 105, 100), (edtCross + 60) * 1000);
  assert.deepEqual(edt.pending, { direction: "bullish", confirmations: 1, needed: 2 }, "EDT 09:31 close is in-session");

  // 2025-11-03 (Mon, EST, UTC-5): the SAME 13:31 UTC is now 08:31 NY → out.
  // Feed it as a BEAR candle: out-of-session closes track the relationship
  // (lastRelation becomes bear) and never emit.
  const pEst = makePipeline(settings());
  pEst.onClosedCandle(sig(P0, 100, 110), 0);
  pEst.onClosedCandle(sig(P0 + 60, 100, 111), 0);
  const estCross = Math.floor(UTC(2025, 11, 3, 13, 30) / 1000);
  const est = pEst.onClosedCandle(sig(estCross, 100, 105), (estCross + 60) * 1000);
  assert.equal(est.alert, null, "EST 08:31 close is out of session");
  assert.equal(est.pending, null, "out-of-session candles never open a lifecycle");
  // The wall-clock rule held across the transition: 14:31 UTC = 09:31 EST is
  // in-session, and a genuine bull cross there opens a pending lifecycle.
  const estCross2 = Math.floor(UTC(2025, 11, 3, 14, 30) / 1000); // close 09:31 EST
  const est2 = pEst.onClosedCandle(sig(estCross2, 105, 100), (estCross2 + 60) * 1000);
  assert.deepEqual(est2.pending, { direction: "bullish", confirmations: 1, needed: 2 }, "EST 09:31 close is in-session");
});

test("11. alert disabled means no notification (defensive gate)", () => {
  const p = new EmaAlertPipeline(() => settings({ enabled: false }), { now: () => Date.now() });
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  const cross = p.onClosedCandle(sig(B0, 105, 100), (B0 + 60) * 1000);
  const conf = p.onClosedCandle(sig(B0 + 60, 106, 100), (B0 + 120) * 1000);
  assert.equal(conf.alert, null, "disabled alerts must never notify");
  assert.equal(conf.suppressed, "disabled");
  void cross;
});

test("12. bullish disabled means bullish notifications are suppressed (bearish still fire)", () => {
  const p = makePipeline(settings({ bullishEnabled: false }));
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  bullishLifecycle(p, B0); // bullish confirmation consumed silently
  assert.equal(p.getLastAlertAt().bullish, 0);
  // The lifecycle is consumed — feeding more bull candles does not alert later.
  const again = p.onClosedCandle(sig(B0 + 120, 107, 100), (B0 + 180) * 1000);
  assert.equal(again.alert, null);
  // Bearish remains enabled → a bearish lifecycle alerts normally.
  bearishLifecycle(p, B0 + 180);
  assert.ok(p.getLastAlertAt().bearish > 0, "bearish must still alert");
});

test("13. bearish disabled means bearish notifications are suppressed (bullish still fire)", () => {
  const p = makePipeline(settings({ bearishEnabled: false }));
  p.onClosedCandle(bullPrime[0], 0);
  p.onClosedCandle(bullPrime[1], 0);
  bearishLifecycle(p, B0);
  assert.equal(p.getLastAlertAt().bearish, 0);
  const again = p.onClosedCandle(sig(B0 + 120, 100, 107), (B0 + 180) * 1000);
  assert.equal(again.alert, null);
  bullishLifecycle(p, B0 + 180);
  assert.ok(p.getLastAlertAt().bullish > 0, "bullish must still alert");
});
