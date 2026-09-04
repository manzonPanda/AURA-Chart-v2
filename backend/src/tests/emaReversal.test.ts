/**
 * EMA 9/20 reversal state machine — unit tests (Node test runner via tsx).
 *   npm --prefix backend run test
 *
 * The pipeline is fed SYNTHETIC EMA pairs (the PineTS adapter is exercised
 * separately by the engine wiring + the existing pineEquivalence tests), so
 * these tests are fully deterministic and I/O-free.
 *
 * Session buckets: 2025-01-15 is a Wednesday (EST, UTC-5). Bucket start
 * 14:30 UTC closes at 14:31 UTC = 09:31 NY — the first in-session close of
 * the day. Pre-session priming candles close at 17:01/17:02 NY (out of
 * session) so their relationship is tracked without ever emitting.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { ClosedSignal } from "../emaAlert/alertPipeline.js";
import { EmaAlertPipeline } from "../emaAlert/alertPipeline.js";
import { defaultEmaAlertSettings, type EmaAlertSettings } from "../emaAlert/emaAlertConfig.js";

const UTC = (y: number, m: number, d: number, h = 0, min = 0): number => Date.UTC(y, m - 1, d, h, min);
/** Bucket start whose CLOSE is 09:31 NY on 2025-01-15 (in-session). */
const B0 = Math.floor(UTC(2025, 1, 15, 14, 30) / 1000);
/** Out-of-session priming buckets on 2025-01-14 (close 17:01/17:02 NY). */
const P0 = Math.floor(UTC(2025, 1, 14, 22, 0) / 1000);

function settings(overrides: Partial<EmaAlertSettings> = {}): EmaAlertSettings {
  return { ...defaultEmaAlertSettings(), enabled: true, ...overrides };
}

/** Mutable test clock — starts at a non-zero epoch so cooldown logic engages. */
let clockNow = 1000;

function makePipeline(s: EmaAlertSettings): EmaAlertPipeline {
  clockNow = 1000;
  return new EmaAlertPipeline(() => s, { now: () => clockNow });
}

function sig(bucketSec: number, ema9: number, ema20: number, price = 24000): ClosedSignal {
  return { bucketSec, ema9, ema20, price };
}

/** Prime the tracked relationship to "bear" (EMA 9 below EMA 20), out of session. */
const bearPrime = [sig(P0, 100, 110), sig(P0 + 60, 100, 111)];
/** Prime the tracked relationship to "bull" (EMA 9 above EMA 20), out of session. */
const bullPrime = [sig(P0, 110, 100), sig(P0 + 60, 111, 100)];

test("1. bullish crossover confirmed after 2 closed candles", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  // Cross candle (closes 09:31 NY, in session): pending, confirmation 1/2.
  const cross = p.onClosedCandle(sig(B0, 105, 100), (B0 + 60) * 1000);
  assert.equal(cross.alert, null);
  assert.deepEqual(cross.pending, { direction: "bullish", confirmations: 1, needed: 2 });
  // Second closed candle holding EMA 9 > EMA 20 → confirmed.
  const conf = p.onClosedCandle(sig(B0 + 60, 106, 100), (B0 + 120) * 1000);
  assert.ok(conf.alert, "expected a confirmed alert");
  assert.equal(conf.alert.direction, "bullish");
  assert.equal(conf.alert.price, 24000);
  assert.equal(conf.pending, null);
});

test("2. bearish crossover confirmed after 2 closed candles", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bullPrime[0], 0);
  p.onClosedCandle(bullPrime[1], 0);
  const cross = p.onClosedCandle(sig(B0, 100, 105), (B0 + 60) * 1000);
  assert.equal(cross.alert, null);
  assert.deepEqual(cross.pending, { direction: "bearish", confirmations: 1, needed: 2 });
  const conf = p.onClosedCandle(sig(B0 + 60, 100, 106), (B0 + 120) * 1000);
  assert.ok(conf.alert, "expected a confirmed alert");
  assert.equal(conf.alert.direction, "bearish");
});

test("3. bullish crossover fails confirmation when EMA reverses immediately", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  const cross = p.onClosedCandle(sig(B0, 105, 100), (B0 + 60) * 1000);
  assert.deepEqual(cross.pending, { direction: "bullish", confirmations: 1, needed: 2 });
  // EMA 9 falls back below EMA 20 before confirmation completes: the bullish
  // pending is cancelled and, by the signal definition, the flip candle is
  // itself a fresh BEARISH cross (prev held EMA 9 > EMA 20, this closed
  // candle establishes EMA 9 < EMA 20) — a new pending, never a bullish alert.
  const fail = p.onClosedCandle(sig(B0 + 60, 100, 105), (B0 + 120) * 1000);
  assert.equal(fail.alert, null, "the bullish reversal must not alert");
  assert.deepEqual(fail.pending, { direction: "bearish", confirmations: 1, needed: 2 });
  assert.equal(p.state().established, "bearish", "only the priming relationship was ever established");
});

test("4. bearish crossover fails confirmation when EMA reverses immediately", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bullPrime[0], 0);
  p.onClosedCandle(bullPrime[1], 0);
  const cross = p.onClosedCandle(sig(B0, 100, 105), (B0 + 60) * 1000);
  assert.deepEqual(cross.pending, { direction: "bearish", confirmations: 1, needed: 2 });
  const fail = p.onClosedCandle(sig(B0 + 60, 105, 100), (B0 + 120) * 1000);
  assert.equal(fail.alert, null, "the bearish reversal must not alert");
  assert.deepEqual(fail.pending, { direction: "bullish", confirmations: 1, needed: 2 });
  assert.equal(p.state().established, "bullish", "only the priming relationship was ever established");
});

test("5. no alert from an intrabar/live candle (non-advancing buckets ignored)", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  const cross = p.onClosedCandle(sig(B0, 105, 100), (B0 + 60) * 1000);
  assert.deepEqual(cross.pending, { direction: "bullish", confirmations: 1, needed: 2 });
  // Replays of the SAME closed bucket — e.g. a misrouted intrabar update —
  // are ignored: no new lifecycle, no confirmation progress, no alert.
  for (const ema9 of [110, 120, 130]) {
    const replay = p.onClosedCandle(sig(B0, ema9, 100), (B0 + 60) * 1000);
    assert.equal(replay.alert, null, "replayed bucket must never alert");
    assert.deepEqual(replay.pending, { direction: "bullish", confirmations: 1, needed: 2 });
  }
  // An OLDER bucket is ignored too.
  const old = p.onClosedCandle(sig(B0 - 600, 130, 100), (B0 - 540) * 1000);
  assert.equal(old.alert, null);
  assert.deepEqual(old.pending, { direction: "bullish", confirmations: 1, needed: 2 });
  // The pipeline only ever advances on a strictly newer CLOSED candle.
  const conf = p.onClosedCandle(sig(B0 + 60, 106, 100), (B0 + 120) * 1000);
  assert.equal(conf.alert?.direction, "bullish");
});


test("6. no duplicate alerts while the EMA relationship remains unchanged", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  p.onClosedCandle(sig(B0, 105, 100), (B0 + 60) * 1000); // cross → 1/2
  const first = p.onClosedCandle(sig(B0 + 60, 106, 100), (B0 + 120) * 1000);
  assert.ok(first.alert, "first confirmation should alert");
  // EMA 9 stays above EMA 20 for many candles → no further alerts.
  for (let i = 1; i <= 10; i++) {
    const o = p.onClosedCandle(sig(B0 + 60 + i * 60, 107 + i, 100), (B0 + 120 + i * 60) * 1000);
    assert.equal(o.alert, null, `candle ${i} must not re-alert`);
    assert.equal(o.pending, null);
  }
});

test("6b. a re-cross through flat starts a genuinely new lifecycle", () => {
  const p = makePipeline(settings());
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  p.onClosedCandle(sig(B0, 105, 100), (B0 + 60) * 1000);
  assert.ok(p.onClosedCandle(sig(B0 + 60, 106, 100), (B0 + 120) * 1000).alert);
  // Flat breaks the relationship (pending would be cancelled), then a fresh
  // bullish transition begins — a new lifecycle, allowed to alert again once
  // the cooldown from the first alert has expired.
  const flat = p.onClosedCandle(sig(B0 + 720, 100, 100), (B0 + 780) * 1000);
  assert.equal(flat.alert, null);
  clockNow += 31 * 60_000; // expire the 30-minute cooldown before re-alerting
  const cross2 = p.onClosedCandle(sig(B0 + 780, 108, 100), (B0 + 840) * 1000);
  assert.deepEqual(cross2.pending, { direction: "bullish", confirmations: 1, needed: 2 });
  assert.equal(p.onClosedCandle(sig(B0 + 840, 109, 100), (B0 + 900) * 1000).alert?.direction, "bullish");
});

test("14. confirmation setting of 1 alerts on the cross candle itself", () => {
  const p = makePipeline(settings({ confirmationCandles: 1 }));
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  const cross = p.onClosedCandle(sig(B0, 105, 100), (B0 + 60) * 1000);
  assert.ok(cross.alert, "confirmation=1 should alert on the closed cross candle");
  assert.equal(cross.alert.direction, "bullish");
});

test("15. confirmation setting of 3 requires three closed candles", () => {
  const p = makePipeline(settings({ confirmationCandles: 3 }));
  p.onClosedCandle(bearPrime[0], 0);
  p.onClosedCandle(bearPrime[1], 0);
  const c1 = p.onClosedCandle(sig(B0, 105, 100), (B0 + 60) * 1000);
  assert.deepEqual(c1.pending, { direction: "bullish", confirmations: 1, needed: 3 });
  assert.equal(c1.alert, null);
  const c2 = p.onClosedCandle(sig(B0 + 60, 106, 100), (B0 + 120) * 1000);
  assert.deepEqual(c2.pending, { direction: "bullish", confirmations: 2, needed: 3 });
  assert.equal(c2.alert, null);
  const c3 = p.onClosedCandle(sig(B0 + 120, 107, 100), (B0 + 180) * 1000);
  assert.equal(c3.pending, null);
  assert.equal(c3.alert?.direction, "bullish");
});
