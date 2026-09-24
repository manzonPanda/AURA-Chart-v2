/**
 * P3-D — selected-account overlay FEED state machine tests (pure, no DOM/fetch).
 * Runs with Node's type stripping:  npm --prefix frontend run test
 *
 * These cover Part 2/Part 3/Part 8 of the P3-D brief at the state-machine
 * boundary the App actually drives:
 *
 *   accounts → selectedAccountId → ONE GET trades(selected) → buildTradeOverlays()
 *
 * Acceptance coverage in this file:
 *   B  selected account defaults correctly        (resolveSelectedAccountId)
 *   C  persisted account restores correctly       (resolveSelectedAccountId)
 *   D  selecting Account A yields only A's overlays (feedSuccess scoping)
 *   E  switching A → B removes A's overlays        (feedLoading hard boundary)
 *   F  B's overlays appear after selection         (buildTradeOverlays → feed)
 *   G  trade API failure produces an explicit error state (feedFailure)
 *   H  zero trades differs from request failure    (phase ready + count 0 vs error)
 *   L  mismatch prevents live overlay merging      (allowsLiveMt5Data gate)
 *   N  P3-C event for another account does not alter the selected account
 *   O  P3-C event for the selected account triggers bounded refetch
 *   P  DAX40 remains unresolved                    (buildTradeOverlays + resolved)
 *   Q  XAUUSD → GOLD still works                   (buildTradeOverlays)
 *   T  switching accounts cannot leave stale overlays behind (incl. late responses)
 *
 * The REAL production modules are imported — no reimplementation of the rules.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  feedFailure,
  feedLoading,
  feedSuccess,
  initialOverlayFeed,
  overlayFeedErrorMessage,
  overlayFeedLabel,
} from "../src/services/overlayFeed.ts";
import { buildTradeOverlays } from "../src/services/tradeOverlay.ts";
import {
  allowsLiveMt5Data,
  resolveSelectedAccountId,
  tradeEventAffectsSelection,
} from "../src/services/accountSelection.ts";
import { ApiError } from "../src/services/api.ts";
import { MT5_SERVER_TIME_ZONE, mt5ServerWallToBucketMs } from "../src/services/mt5Time.ts";

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

/** One P1/P2 historical trade row (verbatim contract shape). */
const row = (over = {}) => ({
  account_id: ACCOUNT_A,
  ticket: "9001",
  instrument: "XAUUSD",
  buy_sell: "Buy",
  lots: "0.10",
  price_open: "2000.50",
  price_close: "2010.25",
  sl: "1990.00",
  tp: "2020.00",
  risk_per_trade: null,
  rrr: "1:2",
  mfe: null,
  mae: null,
  time_open: "2026-09-15 10:00:00",
  time_close: "2026-09-15 12:00:00",
  pnl: "97.50",
  status: "closed",
  ...over,
});

// ── B/C — default + persisted selection (dashboard fallback chain) ───────────
test("B/C: persisted selection is restored, otherwise the first account applies", () => {
  const accounts = [{ id: ACCOUNT_B }, { id: ACCOUNT_A }];
  assert.equal(resolveSelectedAccountId(accounts, ACCOUNT_A), ACCOUNT_A); // restored
  assert.equal(resolveSelectedAccountId(accounts, "stale/foreign"), ACCOUNT_B); // deterministic default
  assert.equal(resolveSelectedAccountId(accounts, null), ACCOUNT_B);
  assert.equal(resolveSelectedAccountId([], ACCOUNT_A), null); // no accounts ⇒ nothing
});

// ── D — one selected account is the ONLY overlay source ─────────────────────
test("D: feed scope is exactly ONE account and loading never merges accounts", () => {
  const aRows = [row(), row({ ticket: "9002" })];
  const aOverlays = buildTradeOverlays(aRows, 60);
  assert.equal(aOverlays.length, 2);

  const loading = feedLoading(initialOverlayFeed(), ACCOUNT_A);
  assert.equal(loading.accountId, ACCOUNT_A);
  assert.equal(loading.phase, "loading");
  assert.deepEqual(loading.overlays, []); // nothing rendered while in flight

  const ready = feedSuccess(loading, ACCOUNT_A, aOverlays, aRows.length);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.tradeCount, 2);
  assert.ok(ready.overlays.every((o) => o.resolved && o.epic === "GOLD"));
});

// ── E/T — switching accounts drops the previous account's overlays ──────────
test("E/T: switching A → B drops A's overlays immediately; A can never mix back", () => {
  const aOverlays = buildTradeOverlays([row()], 60);
  const aReady = feedSuccess(feedLoading(initialOverlayFeed(), ACCOUNT_A), ACCOUNT_A, aOverlays, 1);
  assert.equal(aReady.overlays.length, 1);

  // Switch: the hard boundary — A's overlay set is gone before B's request runs.
  const switched = feedLoading(aReady, ACCOUNT_B);
  assert.equal(switched.accountId, ACCOUNT_B);
  assert.deepEqual(switched.overlays, []);
  assert.equal(switched.tradeCount, 0);

  // A late (stale) A response must NOT repopulate the chart while B is selected.
  const staleLate = feedSuccess(switched, ACCOUNT_A, aOverlays, 1);
  assert.equal(staleLate, switched); // dropped unchanged
  assert.deepEqual(staleLate.overlays, []);
  const staleFail = feedFailure(switched, ACCOUNT_A, new ApiError(500, "X", "boom"));
  assert.equal(staleFail, switched); // a stale failure cannot blank or mutate B
});

// ── F — the newly selected account's overlays appear ───────────────────────
test("F: B's overlays appear after selection and stay B-scoped", () => {
  const bOverlays = buildTradeOverlays(
    [row({ account_id: ACCOUNT_B, ticket: "7001", instrument: "XAUUSD" })],
    60,
  );
  const state = feedSuccess(feedLoading(initialOverlayFeed(), ACCOUNT_B), ACCOUNT_B, bOverlays, 1);
  assert.equal(state.accountId, ACCOUNT_B);
  assert.equal(state.overlays.length, 1);
  assert.equal(state.tradeCount, 1);
  assert.equal(state.phase, "ready");
  // A same-account refresh reconciles (keeps identity) instead of blanking.
  const refreshed = feedSuccess(state, ACCOUNT_B, bOverlays, 1);
  assert.equal(refreshed.overlays.length, 1);
  assert.equal(refreshed.overlays[0].key, state.overlays[0].key);
});

// ── G — failures are explicit, never a silent empty chart ──────────────────
test("G: request failure produces an explicit error/unauthorized state", () => {
  const loading = feedLoading(initialOverlayFeed(), ACCOUNT_A);
  const failed = feedFailure(loading, ACCOUNT_A, new ApiError(502, "UPSTREAM", "Unreachable."));
  assert.equal(failed.phase, "error");
  assert.match(overlayFeedErrorMessage(failed), /Historical trades unavailable/);
  assert.equal(overlayFeedLabel(failed), "Trades unavailable");

  const denied = feedFailure(loading, ACCOUNT_A, new ApiError(403, "FORBIDDEN", "Nope."));
  assert.equal(denied.phase, "unauthorized");
  assert.match(overlayFeedErrorMessage(denied), /Not authorized/);
  assert.equal(overlayFeedLabel(denied), "Trades not authorized");

  // Non-ApiError failures still classify as a transport error (never blank).
  const weird = feedFailure(loading, ACCOUNT_A, new Error("socket hang up"));
  assert.equal(weird.phase, "error");
  assert.match(overlayFeedErrorMessage(weird), /socket hang up/);
});

test("G: a failed REFRESH keeps the account's overlays (non-destructive)", () => {
  const overlays = buildTradeOverlays([row()], 60);
  const ready = feedSuccess(feedLoading(initialOverlayFeed(), ACCOUNT_A), ACCOUNT_A, overlays, 1);
  const failed = feedFailure(feedLoading(ready, ACCOUNT_A), ACCOUNT_A, new ApiError(504, "T", "Timeout."));
  assert.equal(failed.phase, "error");
  assert.equal(failed.overlays.length, 1); // still this account's authoritative rows
});

// ── H — zero trades is NOT a failure ───────────────────────────────────────
test("H: zero trades (ready/0) is distinguishable from failure and from loading", () => {
  const empty = feedSuccess(feedLoading(initialOverlayFeed(), ACCOUNT_A), ACCOUNT_A, [], 0);
  assert.equal(empty.phase, "ready");
  assert.equal(empty.tradeCount, 0);
  assert.equal(overlayFeedLabel(empty), "No trades");
  assert.equal(overlayFeedErrorMessage(empty), null);

  assert.equal(overlayFeedLabel(initialOverlayFeed()), "No trades loaded"); // not loaded yet
  assert.equal(overlayFeedLabel(feedLoading(initialOverlayFeed(), ACCOUNT_A)), "Loading trades…");
  const failed = feedFailure(
    feedLoading(initialOverlayFeed(), ACCOUNT_A),
    ACCOUNT_A,
    new ApiError(500, "E", "x"),
  );
  assert.notEqual(overlayFeedLabel(empty), overlayFeedLabel(failed));
  assert.notEqual(overlayFeedErrorMessage(empty), overlayFeedErrorMessage(failed));
});

// ── N/O — P3-C advisory frames are account-scoped hints only ───────────────
test("N/O: an advisory for another account is ignored; the selected one refetches", () => {
  assert.equal(tradeEventAffectsSelection(ACCOUNT_B, ACCOUNT_A), false); // N
  assert.equal(tradeEventAffectsSelection(ACCOUNT_A, ACCOUNT_A), true); // O
  assert.equal(tradeEventAffectsSelection(null, ACCOUNT_A), true); // untagged → scoped refetch
  assert.equal(tradeEventAffectsSelection(ACCOUNT_A, null), false); // nothing selected → no target
});

test("L/M: mismatch suppresses live-driven refreshes; match and unknown keep them", () => {
  assert.equal(allowsLiveMt5Data("mismatch"), false);
  assert.equal(allowsLiveMt5Data("match"), true);
  assert.equal(allowsLiveMt5Data("unknown"), true);
});

// ── P/Q/R — symbol + timestamp policy unchanged by the account work ────────
test("Q: XAUUSD → GOLD still resolved; P: DAX40 stays unresolved (never DAX)", () => {
  const [gold] = buildTradeOverlays([row({ instrument: "XAUUSD" })], 60);
  assert.equal(gold.resolved, true);
  assert.equal(gold.epic, "GOLD");
  assert.equal(gold.mt5Symbol, "XAUUSD");

  const [dax] = buildTradeOverlays([row({ instrument: "DAX40", ticket: "161" })], 60);
  assert.equal(dax.resolved, false); // P3-D Part 10 — NOT authorized yet
  assert.equal(dax.epic, "DAX40"); // raw preserved, never mapped to DAX or GOLD
  assert.equal(dax.mt5Symbol, "DAX40");

  const [blank] = buildTradeOverlays([row({ instrument: "", ticket: "12" })], 60);
  assert.equal(blank.resolved, false); // upstream data-quality row — never invented
  assert.equal(blank.mt5Symbol, "");
});

test("R: Europe/Helsinki per-timestamp DST conversion is unchanged", () => {
  assert.equal(MT5_SERVER_TIME_ZONE, "Europe/Helsinki");
  // Winter wall clock 10:00 EET (UTC+2) → 08:00Z; summer 10:00 EEST → 07:00Z.
  assert.equal(mt5ServerWallToBucketMs("2026-01-15 10:00:00", 3600), Date.UTC(2026, 0, 15, 8));
  assert.equal(mt5ServerWallToBucketMs("2026-07-15 10:00:00", 3600), Date.UTC(2026, 6, 15, 7));

  // The overlay path uses the same conversion, entry and exit independently.
  const [winter] = buildTradeOverlays(
    [row({ time_open: "2026-01-15 10:00:00", time_close: "2026-01-15 12:00:00" })],
    60,
  );
  const [summer] = buildTradeOverlays(
    [row({ time_open: "2026-07-15 10:00:00", time_close: "2026-07-15 12:00:00" })],
    60,
  );
  assert.equal(winter.entryBucketMs, Date.UTC(2026, 0, 15, 8));
  assert.equal(winter.exitBucketMs, Date.UTC(2026, 0, 15, 10));
  assert.equal(summer.entryBucketMs, Date.UTC(2026, 6, 15, 7));
  assert.equal(summer.exitBucketMs, Date.UTC(2026, 6, 15, 9));
});
