/**
 * BACKEND CLOSED-FRAME CONTRACT — static source-contract test (same style as
 * chartContextMenu.test.mjs): the realtime relay MUST emit explicit
 * `source:"ohlc" phase:"closed"` frames carrying the exact persisted OHLC, tag
 * forming OHLC frames as `phase:"forming"`, tag quote display frames as
 * `source:"quote"`, and expose `serverNowMs` for the countdown calibration.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

const relay = readFileSync(
  new URL("../../backend/src/streaming/realtimeService.ts", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("relay emits an explicit CLOSED candle frame per authoritative close", () => {
  assert.ok(relay.includes('phase: "closed"'), "closed frames carry phase:'closed'");
  assert.ok(relay.includes('source: "ohlc"'), "closed frames carry source:'ohlc'");
  // The relay path is wired into the tick handler right where the candle is
  // persisted/listened — one emission per authoritative close.
  assert.ok(relay.includes("relayClosedCandle("), "closed relay is invoked from the tick path");
  assert.match(relay, /if \(closed\) \{[\s\S]*?relayClosedCandle\(/);
});

test("forming OHLC frames are tagged forming; quote display frames are tagged quote", () => {
  assert.match(relay, /type: "candle", epic, timeframe, source: "ohlc", phase: "forming", \.\.\.candle/);
  assert.match(relay, /source: "quote",\s*\n\s*phase: "forming",\s*\n\s*\.\.\.result\.display/);
});

test("status frames expose serverNowMs (countdown clock calibration)", () => {
  assert.match(relay, /serverNowMs: Date\.now\(\)/);
});

test("clock calibration: offset measured per status frame, countdown uses effectiveNow", () => {
  // Frontend keeps `clockOffsetMs = serverNowMs − Date.now()` from every status
  // frame and counts down against `Date.now() + clockOffsetMs`.
  const core = readFileSync(new URL("../src/services/realtimeCore.ts", import.meta.url), "utf8");
  assert.ok(core.includes("clockOffsetFromStatus"), "offset measurement helper exists");
  const hook = readFileSync(new URL("../src/services/realtime.ts", import.meta.url), "utf8");
  assert.match(hook, /clockOffsetMs: clockOffsetFromStatus\(sm\.serverNowMs, Date\.now\(\)\)/);
  const chart = readFileSync(
    new URL("../src/components/TradingChart/TradingChart.tsx", import.meta.url),
    "utf8",
  );
  assert.match(chart, /const effectiveNow = now \+ \(clockOffsetMs \?\? 0\)/);
  assert.match(chart, /candleCloseCountdown\(liveCandle, bucketSec, effectiveNow\)/);
});

test("the existing forming behavior is preserved (no removal, additive only)", () => {
  // Per-client fan-out of the forming candle still happens exactly once per
  // tick result, and the quote relay still fans out its display candle.
  assert.ok(relay.includes("clientWantsCandle(client, epic, bucketSec)"));
  assert.ok(relay.includes("clientWantsCandle(client, epic, result.bucketSec)"));
  assert.ok(!/phase: "closed",\s*\.\.\.candle/.test(relay), "forming fan-out is never tagged closed");
});
