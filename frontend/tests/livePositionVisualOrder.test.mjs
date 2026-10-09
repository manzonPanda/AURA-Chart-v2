import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isNewerLivePositionVisual,
  livePositionVisualKey,
  shouldAcceptLivePositionVisual,
} from "../src/services/livePositionVisual.ts";

const ACCT = "acc-1";
const TICKET = "1001";
const KEY = livePositionVisualKey(ACCT, TICKET);

const frame = (sourceSequence, sequence, ticket = TICKET) => ({
  type: "tradeVisual",
  accountId: ACCT,
  ticket,
  profit: 12.5,
  swap: -0.25,
  slValue: null,
  sourceId: "src-A",
  sourceSequence,
  sequence,
  at: null,
});

/** Mimics App.tsx's fast path: a frame only advances the token when APPLIED. */
function step(order, visual, keys) {
  if (!shouldAcceptLivePositionVisual(order, visual, keys)) return order;
  const next = new Map(order);
  const key = livePositionVisualKey(visual.accountId, visual.ticket);
  next.set(key, {
    sourceId: visual.sourceId,
    sourceSequence: visual.sourceSequence,
    sequence: visual.sequence,
  });
  return next;
}

test("a frame for a ticket outside the authoritative set is rejected", () => {
  assert.equal(shouldAcceptLivePositionVisual(new Map(), frame(1, 1), new Set()), false);
});

test("REGRESSION: a discarded frame must NOT advance the ordering token", () => {
  // The burst that accompanies a live ENTRY arrives while `accountState` is
  // still catching up, so the ticket is not authoritative yet.
  const order = step(new Map(), frame(1, 1), new Set());
  assert.equal(order.has(KEY), false, "the rejected frame must leave the token untouched");

  // Once the ticket becomes authoritative the SAME source state is re-delivered.
  const keys = new Set([KEY]);
  assert.equal(
    isNewerLivePositionVisual(order, frame(1, 1)),
    true,
    "a re-delivered frame must still be accepted after the ticket turns authoritative",
  );
  assert.equal(shouldAcceptLivePositionVisual(order, frame(1, 1), keys), true);
});

test("an authoritative, newer frame is accepted and advances the token", () => {
  const keys = new Set([KEY]);
  assert.equal(shouldAcceptLivePositionVisual(new Map(), frame(1, 1), keys), true);
  const order = step(new Map(), frame(1, 1), keys);
  assert.equal(order.get(KEY)?.sourceSequence, 1);
  // A duplicate/stale same-source frame is now correctly suppressed.
  assert.equal(shouldAcceptLivePositionVisual(order, frame(1, 1), keys), false);
  // A genuinely newer one still lands.
  assert.equal(shouldAcceptLivePositionVisual(order, frame(2, 2), keys), true);
});

test("a ticket-less frame is never accepted", () => {
  const bad = frame(1, 1, "   ");
  assert.equal(livePositionVisualKey(ACCT, "   "), null);
  assert.equal(shouldAcceptLivePositionVisual(new Map(), bad, new Set([KEY])), false);
});

test("foreign tickets are scoped out of the authoritative set", () => {
  const other = frame(1, 1, "9999");
  assert.equal(shouldAcceptLivePositionVisual(new Map(), other, new Set([KEY])), false);
});

// ── Wiring contract (source-level) ────────────────────────────────────────────

test("wiring: App gates on authority BEFORE writing the ordering token", () => {
  const src = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const gate = src.indexOf("shouldAcceptLivePositionVisual(");
  const write = src.indexOf("livePositionVisualOrderRef.current = nextOrder;");
  assert.ok(gate > 0, "App must use shouldAcceptLivePositionVisual");
  assert.ok(write > 0, "App must record the accepted ordering token");
  assert.ok(
    gate < write,
    "the authority gate must run before the ordering token is written",
  );
});
