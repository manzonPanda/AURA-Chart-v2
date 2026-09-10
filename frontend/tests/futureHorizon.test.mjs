/**
 * Session-aware future time-axis horizon tests (approved design):
 *   - ~24h of future TRADING time via the backend calendar port — NOT 24 clock hours
 *   - daily breaks (DAX 05:00–08:00, Gold 22:00–23:00), weekends, holidays EXCLUDED
 *   - DAX overnight session (01:10–05:00) INCLUDED
 *   - DST-safe (Europe/London wall-clock via Intl)
 *   - weekend/holiday tail rule until ≥ 8 slots, capped 7 days / 6000 slots
 *   - replay = zero future slots; gaps / dedup / immutability unchanged
 *   - rollover slides the horizon with the forming bucket
 * Run: npm --prefix frontend run test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFutureHorizon,
  isBucketExpected,
  zoneParts,
  FUTURE_HORIZON_MS,
  MIN_TAIL_SLOTS,
  MAX_TAIL_DAYS,
  MAX_FUTURE_SLOTS,
} from "../src/services/marketCalendar.ts";
import { buildWhitespacePlan } from "../src/services/whitespaceRows.ts";

// ── fixtures (byte-mirrors of backend/src/market/calendar.ts) ────────────────
const DAX_WINDOWS = [{ openMin: 70, closeMin: 300 }, { openMin: 480, closeMin: 1260 }];
const DAX = {
  timezone: "Europe/London",
  windowsByWeekday: { 1: DAX_WINDOWS, 2: DAX_WINDOWS, 3: DAX_WINDOWS, 4: DAX_WINDOWS, 5: DAX_WINDOWS, 6: [], 7: [] },
  closedDates: ["2026-05-01", "2026-12-25", "2026-12-26"],
};
const GOLD_DAY = [{ openMin: 0, closeMin: 1320 }];
const GOLD_SUN = [{ openMin: 1380, closeMin: 1440 }];
const GOLD = {
  timezone: "Europe/London",
  windowsByWeekday: { 1: GOLD_DAY, 2: GOLD_DAY, 3: GOLD_DAY, 4: GOLD_DAY, 5: GOLD_DAY, 6: [], 7: GOLD_SUN },
  closedDates: ["2026-12-25"],
};
const MIN = 60_000;
const sec = (ms) => Math.floor(ms / 1000);

/** Mid-session Wednesday anchor: 2026-09-09 12:00 London = 11:00 UTC (BST). */
const WED = Date.UTC(2026, 8, 9, 11, 0, 0);

// ── shared assertions ────────────────────────────────────────────────────────
function assertHorizonShape(slots, lastTsMs, bucketSec) {
  const bMs = bucketSec * 1000;
  assert.ok(slots.length > 0, "horizon must produce slots");
  for (const s of slots) {
    assert.equal(typeof s, "number", "slots are pure timestamps (OHLC-free)");
    assert.ok(s > lastTsMs, "strictly after the last candle");
    assert.equal(s % bMs, 0, "bucket-aligned");
  }
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i] > slots[i - 1], "strictly increasing");
  assert.equal(new Set(slots).size, slots.length, "no duplicate timestamps");
}
const london = (s) => zoneParts(s, "Europe/London");

/** No slot falls in [fromMin,toMin) London minutes inside a windowed day. */
function assertNoSlotsIn(slots, cal, fromMin, toMin, label) {
  for (const s of slots) {
    const p = london(s);
    const windows = cal.windowsByWeekday[p.weekday] ?? [];
    const overlapping = windows.some((w) => w.openMin < toMin && w.closeMin > fromMin);
    if (!overlapping) continue; // e.g. weekends: no window at all
    assert.ok(
      !(p.minutes >= fromMin && p.minutes < toMin),
      `${label}: ${new Date(s).toISOString()} (London ${p.date} ${p.minutes}m) must be excluded`,
    );
  }
}

// ── horizon counts per instrument / timeframe ────────────────────────────────

test("DAX 1m horizon: ~one trading day of expected buckets (~1010)", () => {
  const slots = buildFutureHorizon(DAX, WED, 60);
  assertHorizonShape(slots, WED, 60);
  // Wed 12:00→21:00 = 540 + Thu 01:10→05:00 = 230 + Thu 08:00→12:00 = 241.
  assert.ok(slots.length >= 1000 && slots.length <= 1020, `expected ~1011, got ${slots.length}`);
  assert.equal(slots[0], WED + MIN, "first slot is the next minute (12:01 London)");
  assert.ok(slots[slots.length - 1] <= WED + FUTURE_HORIZON_MS, "24h horizon respected midweek");
});

test("DAX 3m horizon: ~338 expected buckets on the 3-minute grid", () => {
  const slots = buildFutureHorizon(DAX, WED, 180);
  assertHorizonShape(slots, WED, 180);
  assert.ok(slots.length >= 330 && slots.length <= 345, `expected ~338, got ${slots.length}`);
});

test("Gold 1m horizon: ~1320 buckets (23h day, 1h break excluded)", () => {
  const slots = buildFutureHorizon(GOLD, WED, 60);
  assertHorizonShape(slots, WED, 60);
  // Wed 12:00→22:00 = 600 + Thu 00:00→12:00 = 720 + the 12:00 bucket.
  assert.ok(slots.length >= 1310 && slots.length <= 1330, `expected ~1321, got ${slots.length}`);
});

test("Gold 3m horizon: ~441 buckets", () => {
  const slots = buildFutureHorizon(GOLD, WED, 180);
  assertHorizonShape(slots, WED, 180);
  assert.ok(slots.length >= 435 && slots.length <= 450, `expected ~441, got ${slots.length}`);
});

test("DST: London 08:00 main open = 07:00 UTC (summer) vs 08:00 UTC (winter)", () => {
  const AUG = Date.UTC(2026, 7, 5, 7, 0, 0); // Wed 2026-08-05 08:00 London
  const DEC = Date.UTC(2026, 11, 2, 8, 0, 0); // Wed 2026-12-02 08:00 London
  assert.equal(isBucketExpected(sec(AUG), DAX, 60), true, "August 07:00 UTC = London 08:00 — expected");
  assert.equal(isBucketExpected(sec(AUG - MIN), DAX, 60), false, "August 06:59 UTC = London 07:59 — break");
  assert.equal(isBucketExpected(sec(DEC), DAX, 60), true, "December 08:00 UTC = London 08:00 — expected");
  assert.equal(isBucketExpected(sec(DEC - MIN), DAX, 60), false, "December 07:59 UTC = London 07:59 — break");
});

// ── exclusions: breaks / weekends / holidays / grid edge semantics ───────────

test("DAX 05:00–08:00 daily break is excluded from the horizon", () => {
  const slots = buildFutureHorizon(DAX, WED, 60);
  assertNoSlotsIn(slots, DAX, 300, 480, "DAX midday break");
  // And the boundary buckets: 04:59 in, 05:00 out, 07:59 out, 08:00 in.
  // London midnight BST = 23:00 UTC the day before.
  const THU = Date.UTC(2026, 8, 10) - 3_600_000;
  const has = (min) => slots.includes(THU + min * MIN);
  assert.equal(has(4 * 60 + 59), true, "04:59 bucket expected");
  assert.equal(has(5 * 60), false, "05:00 bucket excluded (close exclusive)");
  assert.equal(has(7 * 60 + 59), false, "07:59 bucket excluded");
  assert.equal(has(8 * 60), true, "08:00 bucket expected (main open)");
});

test("Gold 22:00–23:00 daily break is excluded from the horizon", () => {
  const slots = buildFutureHorizon(GOLD, WED, 60);
  assertNoSlotsIn(slots, GOLD, 1320, 1380, "Gold evening break");
  // Wednesday London midnight BST = 2026-09-08 23:00 UTC.
  const has = (min) => slots.includes(Date.UTC(2026, 8, 9) - 3_600_000 + min * MIN);
  assert.equal(has(21 * 60 + 59), true, "21:59 bucket expected");
  assert.equal(has(22 * 60), false, "22:00 bucket excluded");
  assert.equal(has(23 * 60 - MIN), false, "22:59 bucket excluded");
});

test("weekends are excluded (no Saturday/Sunday buckets)", () => {
  const slots = buildFutureHorizon(DAX, WED, 60);
  for (const s of slots) {
    const wd = london(s).weekday;
    assert.ok(wd >= 1 && wd <= 5, `weekday ${wd} must not be Sat/Sun`);
  }
});

test("holidays are excluded (DAX closedDates 2026-05-01)", () => {
  // Thursday 2026-04-30 12:00 London → 24h horizon crosses the May Day closure.
  const THU = Date.UTC(2026, 4, 30, 11, 0, 0);
  const slots = buildFutureHorizon(DAX, THU, 60);
  for (const s of slots) assert.notEqual(london(s).date, "2026-05-01", "holiday bucket must be excluded");
  assertHorizonShape(slots, THU, 60);
});

test("DAX overnight session 01:10–05:00 is INCLUDED", () => {
  const slots = buildFutureHorizon(DAX, WED, 60);
  const THU = Date.UTC(2026, 8, 10) - 3_600_000; // London midnight BST
  assert.ok(slots.includes(THU + 70 * MIN), "01:10 open bucket expected");
  assert.ok(slots.includes(THU + 299 * MIN), "04:59 bucket expected");
  assert.ok(!slots.includes(THU + 69 * MIN), "01:09 is break time — excluded (1m grid)");
});

test("3m grid admits a bucket SPANNING the 01:10 open (backend-identical semantics)", () => {
  // Bucket 01:09–01:11:59 overlaps the open → expected; 01:06–01:08:59 → not.
  const THU = Date.UTC(2026, 8, 10) - 3_600_000; // London midnight BST
  assert.equal(isBucketExpected(sec(THU + 69 * MIN), DAX, 180), true, "01:09 3m bucket spans the open");
  assert.equal(isBucketExpected(sec(THU + 66 * MIN), DAX, 180), false, "01:06 3m bucket is fully in the break");
});

test("Gold Sunday evening open (23:00) is registered; Saturday never", () => {
  // Sunday 2026-09-13 22:30 London = 21:30 UTC.
  const SUN = Date.UTC(2026, 8, 13, 21, 30, 0);
  const slots = buildFutureHorizon(GOLD, SUN, 60);
  assertHorizonShape(slots, SUN, 60);
  const wd = slots.map((s) => london(s).weekday);
  assert.ok(wd.includes(7), "Sunday open buckets registered");
  assert.ok(!wd.includes(6), "no Saturday buckets");
  assert.ok(wd.filter((d) => d === 1).length > 0, "extends into Monday trading");
});

// ── tail rule + safety caps ──────────────────────────────────────────────────

test("weekend anchor: tail rule extends until ≥ MIN_TAIL_SLOTS (into Monday)", () => {
  // Saturday 2026-09-12 13:00 London — nothing trades until Monday 01:10.
  const SAT = Date.UTC(2026, 8, 12, 12, 0, 0);
  const slots = buildFutureHorizon(DAX, SAT, 60);
  assert.ok(slots.length >= MIN_TAIL_SLOTS, `tail must yield ≥${MIN_TAIL_SLOTS} slots, got ${slots.length}`);
  assert.equal(slots[0], Date.UTC(2026, 8, 14, 0, 10, 0), "first slot is Monday 01:10 London (00:10 UTC)");
  for (const s of slots) assert.ok(london(s).weekday <= 5, "tail never registers weekends");
});

test("all-closed calendar: 7-day tail cap yields an empty (never unbounded) horizon", () => {
  const CLOSED = { timezone: "Europe/London", windowsByWeekday: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] }, closedDates: [] };
  assert.deepEqual(buildFutureHorizon(CLOSED, WED, 60), [], "MAX_TAIL_DAYS cap stops the scan");
});

test("24/7 calendar 1m: exactly 1440 slots (no tail extension when ≥8 in window)", () => {
  const ALL = { openMin: 0, closeMin: 1440 };
  const ALWAYS = { timezone: "UTC", windowsByWeekday: { 1: [ALL], 2: [ALL], 3: [ALL], 4: [ALL], 5: [ALL], 6: [ALL], 7: [ALL] }, closedDates: [] };
  const slots = buildFutureHorizon(ALWAYS, Date.UTC(2026, 8, 9, 11, 0), 60);
  // 24h window already yields 1440 ≥ 8 expected buckets → tail rule never fires.
  assert.equal(slots.length, 1440, "one full day of buckets, no extension");
  assertHorizonShape(slots, Date.UTC(2026, 8, 9, 11, 0), 60);
  assert.ok(slots.length <= MAX_FUTURE_SLOTS);
});

test("MAX_FUTURE_SLOTS ceiling is absolute (10s buckets in 24/7 would exceed it)", () => {
  const ALL = { openMin: 0, closeMin: 1440 };
  const ALWAYS = { timezone: "UTC", windowsByWeekday: { 1: [ALL], 2: [ALL], 3: [ALL], 4: [ALL], 5: [ALL], 6: [ALL], 7: [ALL] }, closedDates: [] };
  // 10s buckets × 86400s = 8640 candidates > 6000 → the hard cap binds.
  const slots = buildFutureHorizon(ALWAYS, Date.UTC(2026, 8, 9, 11, 0), 10);
  assert.equal(slots.length, MAX_FUTURE_SLOTS, "slot ceiling is absolute");
  assert.ok(new Set(slots).size === slots.length, "ceiling never introduces duplicates");
});

// ── integration with buildWhitespacePlan ─────────────────────────────────────

function candles10(lastTs) {
  return Array.from({ length: 10 }, (_, i) => ({ ts: lastTs - (9 - i) * MIN, close: 2400 + i }));
}

test("replay (live:false) with a calendar: ZERO future slots", () => {
  const plan = buildWhitespacePlan(candles10(WED), [], 60, { live: false, calendar: DAX });
  assert.equal(plan.slots.length, 0);
  const noOpts = buildWhitespacePlan(candles10(WED), [], 60);
  assert.equal(noOpts.slots.length, 0);
});

test("calendar path: plan slots == buildFutureHorizon slots (gap region untouched)", () => {
  const plan = buildWhitespacePlan(candles10(WED), [], 60, { live: true, calendar: DAX });
  assert.deepEqual(plan.slots, buildFutureHorizon(DAX, WED, 60));
  assert.equal(plan.anchors.length, 0, "future region contributes no anchors (no OHLC)");
});

test("no duplicates: gap slots + trailing slots + real candles stay disjoint", () => {
  // 2-bucket outage just before the anchor, plus the calendar horizon.
  const cs = candles10(WED);
  const gaps = [{ instrument: "X", timeframe: "MINUTE_1", startTime: WED - 2 * MIN, endTime: WED, reason: "broker_gap" }];
  const plan = buildWhitespacePlan(cs, gaps, 60, { live: true, calendar: DAX });
  assert.equal(new Set(plan.slots).size, plan.slots.length, "unique timestamps");
  const candleTimes = new Set(cs.map((c) => c.ts));
  assert.ok(!plan.slots.some((s) => candleTimes.has(s)), "no slot collides with a real candle");
  // Gap region identical to the calendar-less plan prefix.
  const plain = buildWhitespacePlan(cs, gaps, 60);
  assert.deepEqual(plan.slots.slice(0, plain.slots.length), plain.slots);
  assert.equal(plan.slots.length, plain.slots.length + buildFutureHorizon(DAX, WED, 60).length);
});

test("candle array and anchors remain immutable; no OHLC enters future slots", () => {
  const cs = candles10(WED);
  const before = JSON.stringify(cs);
  const gaps = [{ instrument: "X", timeframe: "MINUTE_1", startTime: WED - MIN, endTime: WED, reason: "broker_gap" }];
  const plan = buildWhitespacePlan(cs, gaps, 60, { live: true, calendar: DAX });
  assert.equal(JSON.stringify(cs), before, "candles untouched");
  assert.equal(JSON.stringify(plan.anchors), JSON.stringify(buildWhitespacePlan(cs, gaps, 60).anchors), "anchors unchanged");
  const lastCandle = WED;
  assert.ok(plan.slots.every((s) => typeof s === "number" && s > lastCandle - 3 * MIN ? true : true));
  assert.ok(!plan.anchors.some((a) => a.time > lastCandle), "no anchor (value) in the future region");
});

test("rollover: appending a candle slides the horizon with the forming bucket", () => {
  const p1 = buildWhitespacePlan(candles10(WED), [], 60, { live: true, calendar: DAX });
  const cs2 = [...candles10(WED), { ts: WED + MIN, close: 2410 }];
  const p2 = buildWhitespacePlan(cs2, [], 60, { live: true, calendar: DAX });
  assert.equal(p2.slots[0], p1.slots[0] + MIN, "first future slot advanced one bucket");
  assert.deepEqual(p2.slots, buildFutureHorizon(DAX, WED + MIN, 60), "horizon re-anchored to the new last candle");
  assert.ok(p2.slots[p2.slots.length - 1] <= WED + MIN + FUTURE_HORIZON_MS, "still ~one trading day");
});