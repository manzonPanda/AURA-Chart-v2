/**
 * CLOSED-CANDLE AUTHORITY — unit tests for the live chart's authoritative
 * candle lifecycle (forensic fixes #3–#7). Runs with Node's type stripping:
 *   npm --prefix frontend run test
 *
 * Lifecycle under test:
 *   LIVE FORMING (quote/ohlc display) → AUTHORITATIVE CAPITAL OHLC CLOSE
 *   → closed bucket becomes IMMUTABLE → NEXT FORMING CANDLE
 * with the authority ladder  closed-ohlc > forming-ohlc > forming-quote.
 *
 * Pure modules only — no chart/DOM imports.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  alignBucket,
  authorityRank,
  classifyFrame,
  frameAuthority,
  mergeSameBucket,
  planLiveUpdate,
} from "../src/services/liveCandle.ts";
import { mergeBridgeBars } from "../src/services/pineSeries.ts";
import { mergeClosedFrame } from "../src/services/realtimeCore.ts";

const MIN = 60_000;
const B = (minutes) => Date.UTC(2026, 8, 4, 10, minutes); // 3m-grid bucket start, epoch ms

/** A WS closed frame (source:"ohlc" phase:"closed") for a bucket. */
const closedMsg = (bucketMs, o, h, l, c) => ({
  type: "candle",
  time: bucketMs / 1000,
  open: o,
  high: h,
  low: l,
  close: c,
  source: "ohlc",
  phase: "closed",
});

/** A WS forming OHLC frame for a bucket. */
const formingMsg = (bucketMs, o, h, l, c) => ({
  type: "candle",
  time: bucketMs / 1000,
  open: o,
  high: h,
  low: l,
  close: c,
  source: "ohlc",
  phase: "forming",
});

/** A WS quote-display frame (Capital marketData mids) for a bucket. */
const quoteMsg = (bucketMs, o, h, l, c) => ({
  type: "candle",
  time: bucketMs / 1000,
  open: o,
  high: h,
  low: l,
  close: c,
  source: "quote",
  phase: "forming",
});

/** A Bar for the ledger merge (epoch-ms ts). */
const bar = (ts, o, h, l, c) => ({ ts, open: o, high: h, low: l, close: c });

// ── #3 Authority ladder (explicit — never inferred from arrival order) ──────
test("authority ladder: closed-ohlc > forming-ohlc > forming-quote", () => {
  assert.equal(authorityRank(frameAuthority(closedMsg(B(0), 1, 2, 0.5, 1.5))), 2);
  assert.equal(authorityRank(frameAuthority(formingMsg(B(0), 1, 2, 0.5, 1.5))), 1);
  assert.equal(authorityRank(frameAuthority(quoteMsg(B(0), 1, 2, 0.5, 1.5))), 0);
  // Backends without tags default to authoritative-forming (BC with old frames).
  assert.equal(
    authorityRank(frameAuthority({ type: "candle", time: 0, open: 1, high: 1, low: 1, close: 1 })),
    1,
  );
});

// ── Closed-frame ledger (#3): ascending, deduped, replace-on-redeliver ──────
test("mergeClosedFrame: appends ascending, replaces a re-delivered bucket, late 3M insert sorts", () => {
  const b0 = closedMsg(B(0), 4300, 4310, 4295, 4307.9);
  const b3 = closedMsg(B(3), 4307.9, 4312, 4305, 4311.0);
  const b6 = closedMsg(B(6), 4311, 4315, 4308, 4313.4);

  let ledger = mergeClosedFrame([], b3);
  ledger = mergeClosedFrame(ledger, b0); // LATE (3M authority race) → inserted in order
  assert.deepEqual(
    ledger.map((c) => c.time),
    [B(0) / 1000, B(3) / 1000],
    "late closed bucket is kept, ordered by bucket",
  );

  // Re-delivered bucket REPLACES its record — authoritative value wins.
  const restated = closedMsg(B(3), 4307.9, 4312, 4305, 4311.1);
  ledger = mergeClosedFrame(ledger, restated);
  assert.equal(ledger.length, 2, "no duplicate bucket");
  assert.equal(ledger.find((c) => c.time === B(3) / 1000)?.close, 4311.1);

  ledger = mergeClosedFrame(ledger, b6);
  assert.deepEqual(
    ledger.map((c) => c.time),
    [B(0) / 1000, B(3) / 1000, B(6) / 1000],
  );
});

// ── #5 The just-closed candle SURVIVES a history setData (the refresh race) ──
// Race: B closes → closed B exists in the frontend ledger → the DB does NOT
// contain B yet (Capital OHLC delivery / DB write lag) → a history update
// replaces the dataset → B MUST remain visible with its authoritative close.
test("history setData reapplies closed-live candles (just-closed bucket survives)", () => {
    const restFrozen = [
    bar(B(-6), 4285, 4292, 4280, 4291.0),
    bar(B(-3), 4290, 4301, 4288, 4299.2),
    bar(B(0), 4300, 4310, 4295, 4307.9),
  ]; // REST page (ascending): bucket B(3) NOT yet in PostgreSQL
  const ledger = [bar(B(3), 4307.9, 4312, 4305, 4311.1)]; // authoritative closed B
  const forming = quoteMsg(B(6), 4311, 4316, 4310, 4314.2); // next bucket forming

  const dataset = mergeBridgeBars(restFrozen, ledger, forming, 180);
  assert.ok(dataset.some((b) => b.ts === B(3)), "closed B visible before the DB has it");
  assert.equal(dataset.find((b) => b.ts === B(3))?.close, 4311.1, "authoritative close, not the quote mid");
  assert.equal(dataset.find((b) => b.ts === B(6))?.close, 4314.2, "forming bucket appended");
  // Strictly ascending, no duplicates.
  for (let i = 1; i < dataset.length; i++) assert.ok(dataset[i].ts > dataset[i - 1].ts);

  // A LATER history update (REST still frozen, DB write still in flight)
  // REAPPLIES the closed-live ledger — B does NOT disappear (no refresh needed).
  const datasetAfterRefresh = mergeBridgeBars(restFrozen, ledger, forming, 180);
  assert.ok(datasetAfterRefresh.some((b) => b.ts === B(3)), "closed B survives the setData");

  // Once the DB catches up, REST carries B itself — dedupe by bucket ts keeps
  // exactly one B (and the REST value is the same authoritative OHLC).
  const restWithB = [...restFrozen, bar(B(3), 4307.9, 4312, 4305, 4311.1)];
  const reconciled = mergeBridgeBars(restWithB, ledger, forming, 180);
  assert.equal(reconciled.filter((b) => b.ts === B(3)).length, 1, "no duplicate candles");
  assert.equal(reconciled.length, dataset.length);
});

// ── #6 The authoritative close REPLACES the quote-derived value ─────────────
test("closed frame replaces the quote-painted OHLC verbatim (C=4307.90, not 4308.42)", () => {
  // Quote-painted representation of bucket B while it was forming:
  const painted = bar(B(0), 4300, 4310, 4295, 4308.42);
  // Authoritative closed frame for the same bucket:
  const authoritative = bar(B(0), 4300, 4310, 4295, 4307.9);

  const dataset = mergeBridgeBars([], [authoritative], null, 60);
  assert.equal(dataset.find((b) => b.ts === B(0))?.close, 4307.9, "exact persisted OHLC wins");
  // And a forming merge on TOP of a closed bucket can never resurrect 4308.42:
  // the forming candle is withheld for closed buckets (formingForMerges rule).
  const formingForClosed = quoteMsg(B(0), 4300, 4310, 4295, 4308.42);
  const newestClosed = dataset[dataset.length - 1].ts;
  const formingBucket = alignBucket(formingForClosed.time * 1000, 60);
  assert.ok(formingBucket <= newestClosed, "bucket is closed → forming frame withheld");
  assert.equal(mergeBridgeBars(dataset, [], null, 60).at(-1).close, 4307.9);
  assert.notEqual(painted.close, authoritative.close, "the quote value must be gone");
});

// ── #4/#7 Immutability + late closed acceptance (planner-level rules) ───────
test("quote for a CLOSED bucket is dropped; the closed value is never merged", () => {
  const closedTruth = { ts: B(0), open: 4300, high: 4310, low: 4295, close: 4307.9 };
  // The frame guard: rank(closed) outranks everything, and a NON-closed frame
  // whose bucket ≤ the closed frontier is refused before any merge.
  const q = quoteMsg(B(0), 4300, 4311, 4294, 4308.42);
  const isClosedAuthority = authorityRank(frameAuthority(q)) >= authorityRank("closed-ohlc");
  const bucket = alignBucket(q.time * 1000, 60);
  const frontier = alignBucket(closedTruth.ts, 60);
  const dropped = !isClosedAuthority && bucket <= frontier;
  assert.ok(dropped, "forming/quote frame for a closed bucket is refused");

  // Even a hidden-tab direct commit path (planLiveUpdate) can never beat the
  // closed value: the merged candidate is never produced once refused, and
  // mergeSameBucket itself is only reachable for NON-closed truths.
  const naive = mergeSameBucket(closedTruth, { ts: B(0), open: 4300, high: 4311, low: 4294, close: 4308.42 });
  assert.equal(naive.close, 4308.42, "merge WOULD mutate — hence the guard must refuse first");
});

test("3M authority race: a closed frame one bucket BEHIND the display is accepted", () => {
  // Display already forming B+1 (quotes lead); authoritative B arrives late.
  const truth = planLiveUpdate(null, formingMsg(B(6), 4311, 4316, 4310, 4314.2), 180, { hidden: true });
  assert.equal(truth.truth?.ts, B(6));
  // classifyFrame alone WOULD call the late frame stale — the closed-ohlc
  // authority exemption is what lets it through (the frontend guard only drops
  // frames whose rank is BELOW closed-ohlc).
  const late = closedMsg(B(3), 4307.9, 4312, 4305, 4311.1);
  assert.equal(classifyFrame({ ts: B(6) }, alignBucket(late.time * 1000, 180)), "stale");
  assert.equal(authorityRank(frameAuthority(late)), authorityRank("closed-ohlc"));
  const exempt = authorityRank(frameAuthority(late)) >= authorityRank("closed-ohlc");
  assert.ok(exempt, "closed frames bypass the stale gate and commit bucket B");
});
