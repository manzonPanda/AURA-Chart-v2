/**
 * Regression tests for CoalescedFlights (services/pineCoalesce.ts) — the
 * per-indicator computation coalescing that keeps Pine drawings alive.
 *
 * BUG BEING LOCKED IN: PineBridge recomputes on every realtime frame. A heavy
 * Pine drawing script (killzone boxes / session envelopes) computes slower
 * than the inter-tick interval. A GLOBAL generation counter that invalidates
 * every computation whenever ANY newer frame arrives therefore discarded the
 * heavy result on every tick during active trading — the killzone never
 * painted. CoalescedFlights gives each indicator its OWN flight/generation:
 * at most one compute in flight per indicator, one dirty flag, and exactly one
 * follow-up against the latest engine state — so slow scripts keep painting.
 *
 * The harness below mirrors PineBridge's EXACT usage:
 *   effect tick → isInFlight(id) ? markDirty(id) : run(id)
 *   run(id)     → begin(id) → await heavy compute (gated) → stale-guard
 *                 (isCurrent) → applyVisuals/setDrawings → finish(id) → follow-up
 *
 * Run: npm --prefix frontend run test   (Node type-stripping, no DOM)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CoalescedFlights } from "../src/services/pineCoalesce.ts";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  const state = { settled: false };
  let resolve;
  const promise = new Promise((res) => {
    resolve = () => {
      state.settled = true;
      res();
    };
  });
  return {
    promise,
    resolve,
    get settled() {
      return state.settled;
    },
  };
}

async function waitFor(pred, timeout = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error("waitFor timeout");
    await delay(1);
  }
}

/** Resolve the current pending gates (one per loop) until every flight finishes. */
async function pump(gates, flights) {
  let guard = 0;
  while (flights.inFlightCount > 0 || flights.dirtyCount > 0) {
    if (++guard > 200) throw new Error("pump did not converge");
    const gate = gates.find((g) => !g.settled);
    if (!gate) break;
    gate.resolve();
    await delay(0);
  }
}

/**
 * PineBridge-mirroring harness. `run` awaits a gate-able "heavy" compute; on
 * completion it stale-checks, records an "applied" (would-be
 * applyVisuals/setDrawings) event, and follows up dirty work exactly once.
 */
function makeHarness() {
  const flights = new CoalescedFlights();
  const gates = [];
  const applied = []; // flight numbers that reached the paint path
  const runNums = [];
  let nextRun = 0;
  let maxInFlight = 0;

  const run = (id) => {
    const token = flights.begin(id);
    if (!token) return;
    maxInFlight = Math.max(maxInFlight, flights.inFlightCount);
    const n = ++nextRun;
    runNums.push(n);
    const gate = deferred();
    gates.push(gate);
    void gate.promise.then(() => {
      // Heavy compute resolved → PineBridge's stale-guard:
      if (!flights.isCurrent(id, token)) return; // stale → NEVER reaches paint
      applied.push(n); // → applyVisuals / primitive.setDrawings (killzone boxes)
      if (flights.finish(id, token)) run(id); // exactly one follow-up
    });
  };

  const tick = (id) => {
    if (flights.isInFlight(id)) {
      flights.markDirty(id); // never enqueues — coalesces into one flag
      return;
    }
    run(id);
  };

  return {
    flights,
    tick,
    gates,
    applied,
    runNums,
    maxInFlight: () => maxInFlight,
  };
}

// ── the exact failure: rapid triggers while a heavy drawing compute is busy ──

test("coalesce: rapid effect triggers during a heavy killzone compute — the completed result reaches paint and one follow-up runs", async () => {
  const h = makeHarness();

  h.tick("killzone"); // flight 1 starts (heavy compute in flight)
  for (let i = 0; i < 60; i++) h.tick("killzone"); // 60 rapid WS frames underneath

  assert.equal(h.flights.inFlightCount, 1, "never more than one in-flight compute per indicator");
  assert.equal(h.flights.dirtyCount, 1, "60 updates coalesce into ONE dirty flag — no queue");

  // The heavy compute finally finishes; the single dirty follow-up runs and drains.
  await pump(h.gates, h.flights);
  await waitFor(() => h.flights.inFlightCount === 0 && h.flights.dirtyCount === 0);

  assert.ok(h.applied.length >= 2, `flight 1 AND its follow-up both reached applyVisuals/setDrawings (${h.applied})`);
  assert.equal(h.applied[0], 1, "the ORIGINAL heavy computation is applied — it is NOT continuously discarded");
  assert.ok(h.runNums.length <= 3, `bounded flights (${h.runNums.length}) — one flight + one follow-up, never a queue`);
  assert.equal(h.maxInFlight(), 1, "at no instant was more than one flight in flight for the same indicator");
});

// ── dirty → exactly one follow-up ───────────────────────────────────────────

test("coalesce: a flood of updates mid-flight collapses to ONE dirty flag and ONE follow-up", () => {
  const flights = new CoalescedFlights();
  const t1 = flights.begin("kz");
  assert.ok(t1, "flight starts");

  for (let i = 0; i < 40; i++) flights.markDirty("kz"); // flood while busy

  assert.equal(flights.dirtyCount, 1, "flood collapses to a single dirty flag");
  assert.ok(flights.finish("kz", t1), "finish reports the follow-up is needed");
  assert.equal(flights.dirtyCount, 0, "dirty cleared before the single follow-up");

  const t2 = flights.begin("kz");
  assert.ok(t2, "follow-up flight begins");
  assert.equal(t2.id, t1.id + 1, "exactly one follow-up (next generation token)");
  assert.equal(flights.finish("kz", t2), false, "no dirty remains → no second follow-up");
});

// ── at most one in-flight per indicator ─────────────────────────────────────

test("coalesce: begin while busy is refused for the same key; independent keys are never blocked", () => {
  const flights = new CoalescedFlights();
  const a = flights.begin("kz");
  const b = flights.begin("kz");
  assert.ok(a, "first flight starts");
  assert.equal(b, null, "second concurrent begin for the SAME key returns null");
  assert.equal(flights.inFlightCount, 1);

  const c = flights.begin("ema");
  assert.ok(c, "an unrelated indicator is NOT blocked by the busy heavy one");
  assert.equal(flights.inFlightCount, 2);
});

// ── stale result can never overwrite a newer completed result ───────────────

test("coalesce: a cancelled (stale) flight can never paint over the newer exit", () => {
  const flights = new CoalescedFlights();
  const t1 = flights.begin("kz");

  // Layout change / teardown lands while flight 1 is computing:
  flights.cancel("kz");

  assert.equal(flights.isCurrent("kz", t1), false, "cancelled flight is stale");
  assert.equal(flights.finish("kz", t1), false, "stale finish schedules no follow-up");
  assert.equal(flights.dirtyCount, 0);

  const t2 = flights.begin("kz");
  assert.ok(t2 && t2.id !== t1.id, "newer flight has a fresh generation token");
  assert.ok(flights.isCurrent("kz", t2), "only the newest flight may paint");
  assert.equal(flights.isCurrent("kz", t1), false, "the older flight stays stale forever");
});

test("coalesce: teardown (cancelAll) makes every in-flight result stale and drops dirty follow-ups", () => {
  const flights = new CoalescedFlights();
  const a = flights.begin("kz");
  const b = flights.begin("ema");
  flights.markDirty("kz");

  flights.cancelAll();

  assert.equal(flights.inFlightCount, 0);
  assert.equal(flights.dirtyCount, 0);
  assert.equal(flights.isCurrent("kz", a), false, "in-flight result stale after teardown");
  assert.equal(flights.isCurrent("ema", b), false);
  assert.equal(flights.finish("kz", a), false, "no follow-up after teardown");
});

// ── multiple indicators stay independent ────────────────────────────────────

test("coalesce: multiple indicators coalesce INDEPENDENTLY under a shared realtime flow", async () => {
  const flights = new CoalescedFlights();
  const gates = [];
  const applied = [];
  let nextRun = 0;

  const run = (id) => {
    const token = flights.begin(id);
    if (!token) return;
    const n = ++nextRun;
    const gate = deferred();
    gates.push(gate); // live `settled` getter so pump() always finds the real pending gate
    void gate.promise.then(() => {
      if (!flights.isCurrent(id, token)) return;
      applied.push({ id, n });
      if (flights.finish(id, token)) run(id);
    });
  };

  const tick = (id) => {
    if (flights.isInFlight(id)) {
      flights.markDirty(id);
      return;
    }
    run(id);
  };

  // Heavy killzone starts, then a light EMA starts — the light one must NOT be
  // blocked by the heavy one's in-flight flight.
  tick("killzone");
  tick("ema");
  assert.equal(flights.inFlightCount, 2, "heavy indicator does not block the other");

  for (let i = 0; i < 30; i++) {
    tick("killzone");
    tick("ema");
  }
  assert.equal(flights.inFlightCount, 2);
  assert.equal(flights.dirtyCount, 2, "each indicator carries its own single dirty flag");

  await pump(gates, flights);
  await waitFor(() => flights.inFlightCount === 0 && flights.dirtyCount === 0);

  const kzRuns = applied.filter((a) => a.id === "killzone");
  const emaRuns = applied.filter((a) => a.id === "ema");
  assert.ok(kzRuns.length >= 1, "killzone completed results reached setDrawings");
  assert.ok(emaRuns.length >= 1, "EMA completes independently of the heavy one");
  // Exact count: 1 original + 1 dirty follow-up per key (never more).
  assert.equal(kzRuns.length, 2, "killzone had exactly 1 original + 1 follow-up");
  assert.equal(emaRuns.length, 2, "ema had exactly 1 original + 1 follow-up");
});