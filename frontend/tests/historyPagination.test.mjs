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

import { HISTORY_LIMIT } from "../src/config/chart.ts";
import { fetchCandlesDb } from "../src/services/api.ts";
import {
  canLoadMore,
  cursorFrom,
  INITIAL_HISTORY_STATUS,
  isExhausted,
  isNearHistoryEdge,
  mergeOlderCandles,
  resolveViewportAction,
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

test("initial history limit remains 2000 (pagination only ADDS older pages)", () => {
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

test("viewport: a captured range restores the exact window after the prepend", () => {
  assert.equal(
    resolveViewportAction({ hasCapturedRange: true, autoFollow: true, following: true }),
    "restore",
  );
  assert.equal(
    resolveViewportAction({ hasCapturedRange: true, autoFollow: false, following: false }),
    "restore",
    "restore wins even when panned away with auto-follow off",
  );
});

test("viewport: without a capture, normal repaint behavior is unchanged", () => {
  assert.equal(
    resolveViewportAction({ hasCapturedRange: false, autoFollow: true, following: true }),
    "follow-latest",
  );
  assert.equal(
    resolveViewportAction({ hasCapturedRange: false, autoFollow: true, following: false }),
    "none",
    "panned-away user is never yanked to the latest candle",
  );
  assert.equal(
    resolveViewportAction({ hasCapturedRange: false, autoFollow: false, following: true }),
    "none",
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



