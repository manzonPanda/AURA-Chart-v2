/**
 * Incremental history pagination tests ("Load More History").
 *
 *   npm --prefix frontend run test
 *
 * Covers the pure pagination core (services/historyPagination.ts), the
 * fetchCandlesDb cursor contract, and a flow-contract simulation that mirrors
 * App.tsx's loadMoreHistory wiring (guards → fetch → merge → exhausted).
 * No chart/DOM needed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HISTORY_HORIZON,
  HISTORY_HORIZONS,
  HISTORY_LIMIT,
  sanitizeHistoryHorizon,
} from "../src/config/chart.ts";
import { historyHorizonPages, MAX_HISTORY_PAGES } from "../src/services/historyHorizon.ts";
import { fetchCandlesDb } from "../src/services/api.ts";
import {
  canLoadMore,
  cursorFrom,
  INITIAL_HISTORY_STATUS,
  isExhausted,
  isNearHistoryEdge,
  mergeOlderCandles,
  shouldShowLoadMore,
} from "../src/services/historyPagination.ts";

const DAX = "IX.D.DAX.IGM.IP";
const BUCKET = 60_000; // 1m
const BASE = 1_788_500_000_000; // epoch ms (Sep 2026)

/** Ascending 1m candles. */
function candles(count, startMs = BASE) {
  return Array.from({ length: count }, (_, i) => ({
    ts: startMs + i * BUCKET,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 101 + i,
  }));
}

/** Build the backend response body shape for a page of candles. */
function dbPage(rows, hasMore) {
  return {
    epic: DAX,
    timeframe: "MINUTE_1",
    count: rows.length,
    hasMore,
    candles: rows.map((c) => ({
      time: Math.floor(c.ts / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      tickCount: null,
    })),
  };
}

/** Minimal mirror of App.tsx's loadMoreHistory wiring (pure state machine).
 *  `gapMs>0` models the REAL network await: the loading flag stays set across
 *  the async gap, which is exactly what blocks duplicate in-flight requests. */
function makePager(initialCandles, pages, gapMs = 0) {
  const state = {
    candles: initialCandles,
    status: { ...INITIAL_HISTORY_STATUS },
    fetches: [],
  };
  async function loadMore() {
    if (!canLoadMore(state.status, state.candles.length > 0)) return; // App guard
    const cursor = cursorFrom(state.candles);
    if (cursor === null) return;
    state.status = { ...state.status, loading: true, error: null };
    state.fetches.push(cursor); // request in flight (cursor = oldest loaded)
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs)); // the fetch
    const page = pages.shift();
    const data = page instanceof Error ? page : dbPage(page.rows, page.hasMore);
    const older = data.candles.map((c) => ({
      ts: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    const { merged, added } = mergeOlderCandles(state.candles, older, cursor);
    state.status = {
      loading: false,
      exhausted: isExhausted(data.hasMore, added),
      error: null,
    };
    if (added > 0) state.candles = merged;
  }
  return { state, loadMore };
}

// 1 ── Initial history window unchanged ────────────────────────────────────────

test("history page size remains 2000 (initial horizon AND Load More share it)", () => {
  assert.equal(HISTORY_LIMIT, 2000);
});

// 2 ── before cursor is sent correctly ─────────────────────────────────────────

test("fetchCandlesDb sends the before cursor as an epoch-seconds query param", async () => {
  const original = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => dbPage([], true) };
  });
  try {
    await fetchCandlesDb("MINUTE_1", 2000, DAX, Math.floor((BASE + 5 * BUCKET) / 1000));
    const u = new URL(requestedUrl, "http://localhost");
    assert.equal(u.pathname, "/api/candles/db");
    assert.equal(u.searchParams.get("timeframe"), "MINUTE_1");
    assert.equal(u.searchParams.get("limit"), "2000");
    assert.equal(u.searchParams.get("epic"), DAX);
    assert.equal(Number(u.searchParams.get("before")), Math.floor((BASE + 5 * BUCKET) / 1000));
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchCandlesDb omits before for the initial (latest) page and maps hasMore", async () => {
  const original = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => dbPage([], false) };
  });
  try {
    const out = await fetchCandlesDb("MINUTE_1", 2000, DAX);
    const u = new URL(requestedUrl, "http://localhost");
    assert.equal(u.searchParams.has("before"), false);
    assert.equal(out.hasMore, false);
  } finally {
    globalThis.fetch = original;
  }
});

// 3–6 ── Merge semantics via the flow-contract pager ──────────────────────────

test("older candles are returned, prepended, and the dataset stays ascending", async () => {
  const initial = candles(10, BASE); // ts 0..9
  const olderPage = candles(10, BASE - 10 * BUCKET); // ts -10..-1
  const pager = makePager(initial, [{ rows: olderPage, hasMore: true }]);
  await pager.loadMore();
  const s = pager.state;
  assert.equal(s.candles.length, 20);
  assert.equal(s.candles[0].ts, BASE - 10 * BUCKET);
  assert.equal(s.candles[s.candles.length - 1].ts, BASE + 9 * BUCKET);
  for (let i = 1; i < s.candles.length; i++) {
    assert.ok(s.candles[i].ts > s.candles[i - 1].ts, "ascending after merge");
  }
  assert.equal(s.status.exhausted, false);
  assert.equal(s.status.loading, false);
});

test("no duplicate candles at the cursor boundary", async () => {
  const initial = candles(10, BASE); // cursor will be ts=0
  // Page (mis)includes the boundary candle ts=0 — the merge keeps exactly one.
  const page = [candles(1, BASE)[0], ...candles(5, BASE - 5 * BUCKET)];
  const pager = makePager(initial, [{ rows: page, hasMore: true }]);
  await pager.loadMore();
  const s = pager.state;
  const tsSet = new Set(s.candles.map((c) => c.ts));
  assert.equal(s.candles.length, tsSet.size, "no duplicate timestamps");
  assert.equal(s.candles.filter((c) => c.ts === BASE).length, 1, "boundary candle kept once");
  assert.equal(s.candles.length, 15);
});

test("multiple sequential Load More requests accumulate distinct pages", async () => {
  const initial = candles(5, BASE);
  const pages = [
    { rows: candles(5, BASE - 5 * BUCKET), hasMore: true },
    { rows: candles(5, BASE - 10 * BUCKET), hasMore: true },
    { rows: candles(5, BASE - 15 * BUCKET), hasMore: true },
  ];
  const pager = makePager(initial, pages);
  await pager.loadMore();
  await pager.loadMore();
  await pager.loadMore();
  const s = pager.state;
  assert.equal(s.fetches.length, 3);
  assert.equal(s.candles.length, 20);
  assert.equal(s.candles[0].ts, BASE - 15 * BUCKET);
  assert.equal(s.status.exhausted, false);
});

test("no-more-history: hasMore=false marks the dataset exhausted", async () => {
  const initial = candles(5, BASE);
  const pager = makePager(initial, [{ rows: candles(3, BASE - 3 * BUCKET), hasMore: false }]);
  await pager.loadMore();
  const s = pager.state;
  assert.equal(s.candles.length, 8);
  assert.equal(s.status.exhausted, true);
  await pager.loadMore(); // further click is a guarded no-op
  assert.equal(s.fetches.length, 1);
});

test("zero-new-candles (idempotent re-fetch) also exhausts pagination", async () => {
  const initial = candles(5, BASE);
  const pager = makePager(initial, [{ rows: candles(5, BASE), hasMore: true }]);
  await pager.loadMore();
  assert.equal(pager.state.candles.length, 5);
  assert.equal(pager.state.status.exhausted, true);
});

test("loading state prevents duplicate in-flight requests", async () => {
  const initial = candles(5, BASE);
  const pages = [{ rows: candles(5, BASE - 5 * BUCKET), hasMore: true }];
  // gapMs models the real network await so the second click lands mid-request.
  const pager = makePager(initial, pages, 10);
  const first = pager.loadMore();
  const second = pager.loadMore(); // status.loading is true → guard blocks
  await Promise.all([first, second]);
  assert.equal(pager.state.fetches.length, 1);
  assert.equal(pager.state.candles.length, 10, "page still applied after the gap");
});

test("canLoadMore: false while loading / exhausted / without candles", () => {
  assert.equal(canLoadMore({ loading: true, exhausted: false, error: null }, true), false);
  assert.equal(canLoadMore({ loading: false, exhausted: true, error: null }, true), false);
  assert.equal(canLoadMore(INITIAL_HISTORY_STATUS, false), false);
  assert.equal(canLoadMore(INITIAL_HISTORY_STATUS, true), true);
  assert.equal(canLoadMore({ loading: false, exhausted: false, error: "boom" }, true), true);
});

test("cursor is always derived from the CURRENT dataset (never stored across scopes)", () => {
  const dax = candles(5, BASE);
  const gold = candles(5, BASE + 5000 * BUCKET); // another instrument's window
  assert.equal(cursorFrom(dax), BASE);
  assert.equal(cursorFrom(gold), BASE + 5000 * BUCKET);
  assert.equal(cursorFrom([]), null);
  assert.deepEqual({ ...INITIAL_HISTORY_STATUS }, { loading: false, exhausted: false, error: null });
});

test("merge never drops or alters newer/live candles (strictly-older prepend only)", () => {
  const existing = candles(5, BASE);
  const liveCandle = { ...existing[4] };
  const page = candles(5, BASE - 5 * BUCKET);
  const { merged, added } = mergeOlderCandles(existing, page, existing[0].ts);
  assert.equal(added, 5);
  assert.equal(merged.length, 10);
  assert.equal(merged[9].ts, liveCandle.ts);
  assert.deepEqual(merged[9], liveCandle);
  // Newer-than-cursor candles in the fetched page are ignored entirely.
  const polluted = [...candles(3, BASE + 10 * BUCKET), ...page];
  const r2 = mergeOlderCandles(existing, polluted, existing[0].ts);
  assert.equal(r2.added, 5);
  assert.equal(r2.merged.length, 10);
});

test("merge does not mutate the existing dataset (immutable prepend)", () => {
  const existing = candles(5, BASE);
  const snapshot = existing.map((c) => ({ ...c }));
  mergeOlderCandles(existing, candles(3, BASE - 3 * BUCKET), existing[0].ts);
  assert.deepEqual(existing, snapshot);
});

test("the history control is hidden during an active Replay session", () => {
  assert.equal(
    shouldShowLoadMore({ replayActive: true, exhausted: false, nearEdge: true, hasData: true }),
    false,
  );
  assert.equal(
    shouldShowLoadMore({ replayActive: false, exhausted: false, nearEdge: true, hasData: true }),
    true,
  );
  assert.equal(
    shouldShowLoadMore({ replayActive: false, exhausted: false, nearEdge: false, hasData: true }),
    false,
    "only revealed near the historical edge",
  );
  assert.equal(
    shouldShowLoadMore({ replayActive: false, exhausted: false, nearEdge: true, hasData: false }),
    false,
  );
});

test("edge proximity: within threshold buckets of the oldest candle reveals the control", () => {
  const oldestSec = BASE / 1000;
  assert.equal(isNearHistoryEdge(oldestSec + 10 * 60, oldestSec, 60), true, "10 bars → near");
  assert.equal(isNearHistoryEdge(oldestSec + 40 * 60, oldestSec, 60), true, "exactly 40 bars → near");
  assert.equal(isNearHistoryEdge(oldestSec + 41 * 60, oldestSec, 60), false, "41 bars → not near");
  assert.equal(isNearHistoryEdge(Number.NaN, oldestSec, 60), false);
  assert.equal(isNearHistoryEdge(oldestSec, 0, 60), false);
  assert.equal(isNearHistoryEdge(oldestSec, Number.NaN, 60), false);
});

// 7 ── History HORIZON (calendar-aware initial page plan) ─────────────────────
// 2026-09-14T12:00:00Z — 13:00 London (BST) — a MONDAY. Pins the planner so the
// expected-trading-minute math is deterministic (no Date.now() dependence).
const NOW = 1_789_387_200_000;
const DAY_MS = 86_400_000;

const DAX_WEEK = {
  1: [{ openMin: 70, closeMin: 300 }, { openMin: 480, closeMin: 1260 }], // 01:10–05:00, 08:00–21:00 UK
  2: [{ openMin: 70, closeMin: 300 }, { openMin: 480, closeMin: 1260 }],
  3: [{ openMin: 70, closeMin: 300 }, { openMin: 480, closeMin: 1260 }],
  4: [{ openMin: 70, closeMin: 300 }, { openMin: 480, closeMin: 1260 }],
  5: [{ openMin: 70, closeMin: 300 }, { openMin: 480, closeMin: 1260 }],
  6: [],
  7: [],
};
const GOLD_WEEK = {
  1: [{ openMin: 0, closeMin: 1320 }], // 00:00–22:00 UK
  2: [{ openMin: 0, closeMin: 1320 }],
  3: [{ openMin: 0, closeMin: 1320 }],
  4: [{ openMin: 0, closeMin: 1320 }],
  5: [{ openMin: 0, closeMin: 1320 }],
  6: [],
  7: [{ openMin: 1380, closeMin: 1440 }], // Sunday 23:00–24:00 UK (Globex week open)
};
const DAX_CAL = { timezone: "Europe/London", windowsByWeekday: DAX_WEEK, closedDates: [] };
const GOLD_CAL = { timezone: "Europe/London", windowsByWeekday: GOLD_WEEK, closedDates: [] };
const SILVER_CAL = GOLD_CAL; // the backend registry mirrors gold windows for silver

/** plan helper: pageSize defaults to the chart's fixed history page size. */
const planOf = (opts) => historyHorizonPages({ nowMs: NOW, pageSize: HISTORY_LIMIT, ...opts });

test("horizon: default is 2 weeks; all four options sanitize round-trip", () => {
  assert.equal(DEFAULT_HISTORY_HORIZON, "2w");
  assert.deepEqual(HISTORY_HORIZONS.map((h) => h.key), ["1w", "2w", "3w", "1m"]);
  assert.deepEqual(HISTORY_HORIZONS.map((h) => h.days), [7, 14, 21, 30]);
  for (const h of HISTORY_HORIZONS) assert.equal(sanitizeHistoryHorizon(h.key), h.key);
  assert.equal(sanitizeHistoryHorizon("nonsense"), DEFAULT_HISTORY_HORIZON);
  assert.equal(sanitizeHistoryHorizon(42), DEFAULT_HISTORY_HORIZON);
  assert.equal(sanitizeHistoryHorizon(null), DEFAULT_HISTORY_HORIZON);
});

test("horizon: DAX page plan is calendar-aware and timeframe-aware (2w default)", () => {
  const dax2w = planOf({ horizon: "2w", calendar: DAX_CAL, bucketSec: 60 });
  // 10 DAX session-days × 1,010 min/day (2 weeks from a Monday anchor).
  assert.equal(dax2w.targetMinutes, 10100);
  assert.equal(dax2w.targetCandles, 10100);
  assert.equal(dax2w.requests, 6);
  // 3m buckets carry 3× the trading time → a third of the candles → 2 pages.
  assert.equal(planOf({ horizon: "2w", calendar: DAX_CAL, bucketSec: 180 }).requests, 2);
});

test("horizon: Gold/Silver sessions (longer days + Sunday open) differ from DAX", () => {
  const gold2w = planOf({ horizon: "2w", calendar: GOLD_CAL, bucketSec: 60 });
  // 14 days × Globex hours: 10 weekdays × 1,320 + 2 Sunday slots × 60 + partial edges.
  assert.equal(gold2w.targetMinutes, 13320);
  assert.equal(gold2w.requests, 7);
    assert.equal(planOf({ horizon: "2w", calendar: GOLD_CAL, bucketSec: 180 }).requests, 3); // 13320 / 3 = 4440, ceil(4440/2000) = 3
  assert.equal(
    planOf({ horizon: "2w", calendar: SILVER_CAL, bucketSec: 60 }).requests,
    gold2w.requests,
    "silver mirrors the gold windows",
  );
});

test("horizon: 1w/3w/1m page counts grow with the horizon (DAX 1m)", () => {
  const pages = (h) => planOf({ horizon: h, calendar: DAX_CAL, bucketSec: 60 }).requests;
  assert.equal(pages("1w"), 3);
  assert.equal(pages("2w"), 6);
  assert.equal(pages("3w"), 8);
  assert.equal(pages("1m"), 11);
  assert.equal(planOf({ horizon: "1w", calendar: DAX_CAL, bucketSec: 180 }).requests, 1);
  assert.equal(planOf({ horizon: "1m", calendar: DAX_CAL, bucketSec: 180 }).requests, 4);
});

test("horizon: closed dates subtract the day's sessions", () => {
  const closed = { timezone: "Europe/London", windowsByWeekday: DAX_WEEK, closedDates: ["2026-09-10"] };
  const p = planOf({ horizon: "2w", calendar: closed, bucketSec: 60 });
  assert.equal(p.targetMinutes, 9090, "10,100 − the 1,010-min Thursday session");
  assert.equal(p.requests, 5);
});

test("horizon: no calendar → single-page (pre-horizon) fallback, never over-fetches", () => {
  assert.equal(planOf({ horizon: "2w", calendar: null, bucketSec: 60 }).requests, 1);
  assert.equal(planOf({ horizon: "1m", calendar: null, bucketSec: 60 }).requests, 1);
});

test("horizon: page count is clamped by MAX_HISTORY_PAGES and never below 1", () => {
  const huge = planOf({ horizon: "1m", calendar: GOLD_CAL, bucketSec: 60, pageSize: 100 });
  assert.equal(huge.requests, MAX_HISTORY_PAGES);
  const tiny = planOf({ horizon: "2w", calendar: GOLD_CAL, bucketSec: 27 * 3600 });
  assert.equal(tiny.requests, 1);
});

// ── Horizon flow simulation (App.tsx loadHistory wiring, mirrored) ───────────

function makeHorizonLoader(pages, targetPages, gapMs = 0) {
  const state = { candles: [], fetches: [], status: { ...INITIAL_HISTORY_STATUS } };
  async function loadInitial() {
    let loaded = [];
    let cursor = undefined; // undefined → the newest page (no before param)
    let lastHasMore = true;
    let pagesFetched = 0;
    while (pagesFetched < targetPages && lastHasMore) {
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      state.fetches.push(cursor);
      const page = pages.shift();
      const data = page instanceof Error ? page : dbPage(page.rows, page.hasMore);
      const older = data.candles.map((c) => ({
        ts: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close,
      }));
      let added;
      if (loaded.length === 0) {
        loaded = older;
        added = loaded.length;
      } else {
        const res = mergeOlderCandles(loaded, older, cursor);
        loaded = res.merged;
        added = res.added;
      }
      lastHasMore = data.hasMore && added > 0;
      if (loaded.length > 0) cursor = loaded[0].ts;
      pagesFetched++;
    }
    state.candles = loaded; // only the FINAL merged dataset is announced
    state.status = { loading: false, exhausted: !lastHasMore, error: null };
  }
  return { state, loadInitial };
}

test("horizon load: chains pages with progressively older before cursors, one final dataset", async () => {
  const pages = Array.from({ length: 12 }, (_, i) => ({
    rows: candles(HISTORY_LIMIT, BASE - i * HISTORY_LIMIT * BUCKET),
    hasMore: true,
  }));
  const loader = makeHorizonLoader(pages, 6);
  await loader.loadInitial();
  const s = loader.state;
  assert.equal(s.fetches.length, 6, "exactly the planned number of pages");
  assert.equal(s.fetches[0], undefined, "page 1 is the newest page (no before)");
  for (let i = 1; i < s.fetches.length; i++) {
    assert.ok(Number.isFinite(s.fetches[i]), `cursor ${i} is defined (ms)`);
  }
  for (let i = 2; i < s.fetches.length; i++) {
    assert.ok(s.fetches[i] < s.fetches[i - 1], `cursor ${i} strictly older than cursor ${i - 1}`);
  }
  assert.equal(s.candles.length, 6 * HISTORY_LIMIT);
  for (let i = 1; i < s.candles.length; i++) {
    assert.ok(s.candles[i].ts > s.candles[i - 1].ts, "final dataset strictly ascending");
  }
  assert.equal(s.candles[s.candles.length - 1].ts, BASE + (HISTORY_LIMIT - 1) * BUCKET);
  assert.equal(s.candles[0].ts, BASE - 5 * HISTORY_LIMIT * BUCKET);
  assert.equal(s.status.exhausted, false, "more pages remain after the horizon reached");
});

test("horizon load: overlapping boundary candles are deduped, dataset stays ascending", async () => {
  const pages = [
    { rows: candles(HISTORY_LIMIT, BASE), hasMore: true },
    {
      // (mis)include the cursor candle itself — the merge keeps exactly one.
      rows: [candles(1, BASE)[0], ...candles(HISTORY_LIMIT, BASE - HISTORY_LIMIT * BUCKET)],
      hasMore: true,
    },
  ];
  const loader = makeHorizonLoader(pages, 2);
  await loader.loadInitial();
  const s = loader.state;
  assert.equal(s.candles.length, 2 * HISTORY_LIMIT);
  assert.equal(new Set(s.candles.map((c) => c.ts)).size, 2 * HISTORY_LIMIT, "no duplicate timestamps");
  for (let i = 1; i < s.candles.length; i++) {
    assert.ok(s.candles[i].ts > s.candles[i - 1].ts);
  }
});

test("horizon load: backend exhaustion stops paging early and exhausts Load More", async () => {
  const pages = [
    { rows: candles(HISTORY_LIMIT, BASE), hasMore: true },
    { rows: candles(500, BASE - HISTORY_LIMIT * BUCKET), hasMore: false },
  ];
  const loader = makeHorizonLoader(pages, 6);
  await loader.loadInitial();
  assert.equal(loader.state.fetches.length, 2, "stopped at the exhausted page");
  assert.equal(loader.state.status.exhausted, true);
  assert.equal(loader.state.candles.length, HISTORY_LIMIT + 500);
});

test("Load More works after an initial horizon load (same fixed page size)", async () => {
  const horizon = Array.from({ length: 8 }, (_, i) => ({
    rows: candles(HISTORY_LIMIT, BASE - i * HISTORY_LIMIT * BUCKET),
    hasMore: true,
  }));
  const loader = makeHorizonLoader(horizon, 6);
  await loader.loadInitial();
  const oldestAfterHorizon = loader.state.candles[0].ts;
  const pager = makePager(loader.state.candles, [
    { rows: candles(HISTORY_LIMIT, oldestAfterHorizon - HISTORY_LIMIT * BUCKET), hasMore: true },
  ]);
  await pager.loadMore();
  assert.equal(pager.state.fetches[0], oldestAfterHorizon, "Load More cursor = the horizon's oldest");
  assert.equal(pager.state.candles.length, 7 * HISTORY_LIMIT);
  assert.equal(pager.state.status.exhausted, false);
});



