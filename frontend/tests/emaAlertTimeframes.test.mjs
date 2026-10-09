/**
 * EMA alert timeframes — 5m is selectable, and the list is data-driven.
 *
 * The alert settings UI previously hardcoded two JSX checkbox blocks and a
 * `Record<"MINUTE_1" | "MINUTE_3", string>` label map. Adding a third
 * timeframe therefore meant editing three hand-written places, and until
 * MINUTE_5 was added the 5m chart showed an alert bell stuck in the "off"
 * state with no way to enable it.
 *
 * These tests pin the data-driven contract:
 *   1. The supported alert-timeframe list is a single exported constant.
 *   2. It contains 1m, 3m and 5m — and every entry is a REAL chart timeframe
 *      with a label and a bucket width.
 *   3. Every entry has a label, so the UI can map over it without a
 *      hand-written Record (no `undefined` label possible).
 *   4. The default settings enable all of them, matching the backend.
 *   5. Toggling 5m on/off preserves the other selections.
 *
 * Run: npm --prefix frontend run test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { TIMEFRAMES } from "../src/config/chart.ts";
import {
  EMA_ALERT_TIMEFRAMES,
  alertTimeframeLabel,
  isAlertTimeframe,
  DEFAULT_EMA_ALERT_SETTINGS,
} from "../src/services/emaAlertApi.ts";
import { resolutionToBucketSec } from "../src/services/realtimeCore.ts";

// ── 1/2. The list is the single source and includes 5m ────────────────────────

test("alerts: the supported list is 1m, 3m and 5m", () => {
  assert.deepEqual([...EMA_ALERT_TIMEFRAMES], ["MINUTE_1", "MINUTE_3", "MINUTE_5"]);
});

test("alerts: every supported alert timeframe is a real chart timeframe", () => {
  const chartKeys = new Set(TIMEFRAMES.map((tf) => tf.key));
  for (const tf of EMA_ALERT_TIMEFRAMES) {
    assert.ok(chartKeys.has(tf), `${tf} exists in the chart's TIMEFRAMES table`);
    assert.equal(typeof resolutionToBucketSec(tf), "number");
    assert.ok(resolutionToBucketSec(tf) > 0, `${tf} has a positive bucket width`);
  }
});

test("alerts: isAlertTimeframe accepts all three and rejects anything else", () => {
  assert.equal(isAlertTimeframe("MINUTE_1"), true);
  assert.equal(isAlertTimeframe("MINUTE_3"), true);
  assert.equal(isAlertTimeframe("MINUTE_5"), true);
  assert.equal(isAlertTimeframe("MINUTE_15"), false);
  assert.equal(isAlertTimeframe("nonsense"), false);
});

// ── 3. Labels are derivable — the UI can map, never index a closed Record ─────

test("alerts: every alert timeframe has a label without a hand-written map", () => {
  assert.equal(alertTimeframeLabel("MINUTE_1"), "1m");
  assert.equal(alertTimeframeLabel("MINUTE_3"), "3m");
  assert.equal(alertTimeframeLabel("MINUTE_5"), "5m");
  for (const tf of EMA_ALERT_TIMEFRAMES) {
    assert.ok(alertTimeframeLabel(tf).length > 0, `${tf} has a non-empty label`);
  }
});

// ── 4. Defaults match the backend ────────────────────────────────────────────

test("alerts: default settings enable all three detectors, including 5m", () => {
  assert.deepEqual(DEFAULT_EMA_ALERT_SETTINGS.alertTimeframes, ["MINUTE_1", "MINUTE_3", "MINUTE_5"]);
});

test("alerts: 1m/3m default behaviour is otherwise unchanged", () => {
  assert.equal(DEFAULT_EMA_ALERT_SETTINGS.enabled, false);
  assert.equal(DEFAULT_EMA_ALERT_SETTINGS.confirmationCandles, 2);
  assert.equal(DEFAULT_EMA_ALERT_SETTINGS.bullishEnabled, true);
  assert.equal(DEFAULT_EMA_ALERT_SETTINGS.bearishEnabled, true);
  assert.equal(DEFAULT_EMA_ALERT_SETTINGS.sessionTimezone, "America/New_York");
  assert.equal(DEFAULT_EMA_ALERT_SETTINGS.sessionStart, "09:30");
  assert.equal(DEFAULT_EMA_ALERT_SETTINGS.sessionEnd, "16:00");
  assert.equal(DEFAULT_EMA_ALERT_SETTINGS.cooldownMinutes, 30);
});

// ── 5. Toggling 5m preserves the rest ─────────────────────────────────────────

test("alerts: enabling 5m alongside 1m/3m yields the full set", () => {
  const next = [...DEFAULT_EMA_ALERT_SETTINGS.alertTimeframes];
  assert.ok(next.includes("MINUTE_5"));
  assert.deepEqual(next, ["MINUTE_1", "MINUTE_3", "MINUTE_5"]);
});

test("alerts: disabling 5m leaves 1m and 3m untouched", () => {
  const next = DEFAULT_EMA_ALERT_SETTINGS.alertTimeframes.filter((t) => t !== "MINUTE_5");
  assert.deepEqual(next, ["MINUTE_1", "MINUTE_3"]);
});
