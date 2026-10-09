/**
 * Drawing persistence tests — the service layer that stands between
 * CandleKit's DrawingEngine and the AURA backend (/api/drawings).
 *
 * Covered:
 *   - serialize / deserialize (engine.export JSON ↔ Drawing[])
 *   - shape + count + byte validation (mirrors the backend contract)
 *   - DrawingSync lifecycle: load → restore baseline, debounced/coalesced
 *     saves, delete-clears-scope, restore-echo suppression, failure handling
 *     (local state survives, bounded retry), shutdown flush
 *   - create → refresh → restore, move → refresh → moved position,
 *     delete → refresh → absent
 *   - timeframe scope isolation
 *   - HTTP layer: URLs, Bearer header, PUT/DELETE bodies (stubbed fetch)
 *   - TradingChart / DrawingLayer / styles wiring (source contract)
 *
 * No DOM, no real network, no real timers — schedulers and transports are
 * injected, exactly the seams DrawingSync exposes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DrawingSync,
  MAX_DRAWINGS,
  clearScopeDrawings,
  drawingsToEngineJson,
  engineExportToArray,
  fetchScopeDrawings,
  saveScopeDrawings,
  validateDrawingList,
  validateDrawingsForSave,
} from "../src/services/drawingPersistence.ts";

const SCOPE = { epic: "GOLD", timeframe: "MINUTE_1" };

/** A CandleKit-shaped serialized drawing. */
function drawing(id, tool = "TrendLine", time = 1_700_000_000, price = 2000) {
  return {
    id,
    tool,
    points: [
      { time, price },
      { time: time + 300, price: price + 1.5 },
    ],
    style: { color: "#4f8cff", width: 2, dashed: false, fill: null },
  };
}

/** Manual scheduler — the test owns time; runAll() = "the window elapsed". */
function makeScheduler() {
  let nextId = 1;
  const pending = new Map();
  return {
    schedule(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    runAll() {
      const jobs = [...pending.values()];
      pending.clear();
      for (const job of jobs) job.fn();
    },
    get size() {
      return pending.size;
    },
    get lastDelay() {
      const jobs = [...pending.values()];
      return jobs.length > 0 ? jobs[jobs.length - 1].ms : null;
    },
  };
}

/** Let fire-and-forget async persistence settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * In-memory fake server with GET/PUT/DELETE semantics per scope — the
 * persistence contract of /api/drawings without the network.
 */
function makeFakeServer() {
  const scopes = new Map();
  const calls = { load: 0, save: 0, clear: 0 };
  const state = { failSave: false, failLoad: false };
  const key = (scope) => `${scope.epic}|${scope.timeframe}`;
  return {
    scopes,
    calls,
    state,
    transport: {
      async load(scope) {
        calls.load += 1;
        if (state.failLoad) throw new Error("load offline");
        return JSON.parse(JSON.stringify(scopes.get(key(scope)) ?? []));
      },
      async save(scope, drawings) {
        calls.save += 1;
        if (state.failSave) throw new Error("save offline");
        scopes.set(key(scope), JSON.parse(JSON.stringify(drawings)));
      },
      async clear(scope) {
        calls.clear += 1;
        if (state.failSave) throw new Error("clear offline");
        scopes.delete(key(scope));
      },
    },
  };
}

function makeSync(server, scope = SCOPE, phases = null) {
  const scheduler = makeScheduler();
  const sync = new DrawingSync({
    scope,
    transport: server.transport,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
    onPhase: phases
      ? (phase, detail) => phases.push(detail ? `${phase}:${detail}` : phase)
      : undefined,
  });
  return { sync, scheduler };
}

// ── Serialize / deserialize ───────────────────────────────────────────────────

test("validateDrawingList accepts engine-shaped drawings and rejects malformed ones", () => {
  const ok = validateDrawingList([drawing("a"), drawing("b", "FibRetracement")]);
  assert.equal(ok.ok, true);

  const bad = [
    "not-an-array",
    [{}],
    [{ id: "", tool: "TrendLine", points: [{ time: 1, price: 1 }] }],
    [{ id: "x", tool: "", points: [{ time: 1, price: 1 }] }],
    [{ id: "x", tool: "TrendLine", points: [] }],
    [{ id: "x", tool: "TrendLine", points: [{ time: "now", price: 1 }] }],
    [{ id: "x", tool: "TrendLine", points: [{ time: 1, price: null }] }],
    [{ id: "x", tool: "TrendLine", points: [{ time: 1, price: 1 }], style: "red" }],
    [drawing("dup"), drawing("dup")],
    [{ id: "x", tool: "TrendLine", points: Array.from({ length: 33 }, (_, i) => ({ time: i, price: 1 })) }],
  ];
  for (const value of bad) {
    assert.equal(validateDrawingList(value).ok, false, JSON.stringify(value).slice(0, 80));
  }
});

test("validateDrawingsForSave enforces the count cap and the byte cap", () => {
  const tooMany = Array.from({ length: MAX_DRAWINGS + 1 }, (_, i) => drawing(`d${i}`));
  const capped = validateDrawingsForSave(tooMany);
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /at most 500/);

  const fat = Array.from({ length: 16 }, (_, i) => ({ ...drawing(`f${i}`), pad: "x".repeat(20_000) }));
  const oversized = validateDrawingsForSave(fat);
  assert.equal(oversized.ok, false);
  assert.match(oversized.reason, /too large/);
});

test("engine.export JSON round-trips through engineExportToArray / drawingsToEngineJson", () => {
  const drawings = [drawing("a"), drawing("b", "Rectangle")];
  // engine.export() is JSON.stringify(drawings) — same wire format both ways.
  const exported = JSON.stringify(drawings);
  const parsed = engineExportToArray(exported);
  assert.deepEqual(parsed, drawings);
  assert.deepEqual(JSON.parse(drawingsToEngineJson(parsed)), drawings);

  assert.equal(engineExportToArray("{broken"), null);
  assert.equal(engineExportToArray(JSON.stringify([{ nope: true }])), null);
});

// ── DrawingSync lifecycle ─────────────────────────────────────────────────────

test("sync: load reports loading → ready and adopts the server set as baseline", async () => {
  const server = makeFakeServer();
  server.scopes.set("GOLD|MINUTE_1", [drawing("seeded")]);
  const phases = [];
  const { sync } = makeSync(server, SCOPE, phases);

  const loaded = await sync.load();
  assert.deepEqual(loaded.map((d) => d.id), ["seeded"]);
  assert.deepEqual(phases, ["loading", "ready"]);

  // Notifying the EXACT loaded set is a restore echo — nothing is scheduled.
  const { sync: sync2, scheduler } = makeSync(server);
  await sync2.load();
  sync2.notifyChange(loaded);
  assert.equal(scheduler.size, 0, "restore echo must not schedule a save");
});

test("sync: rapid changes coalesce into ONE debounced save of the final state", async () => {
  const server = makeFakeServer();
  const { sync, scheduler } = makeSync(server);
  await sync.load();

  // Simulated drag: ten engine emissions, each moving the anchor.
  for (let i = 0; i < 10; i++) {
    const moved = drawing("d1", "TrendLine", 1_700_000_000 + i * 60, 2000 + i);
    sync.notifyChange([moved]);
  }
  assert.equal(server.calls.save, 0, "nothing saves while the window is open");
  assert.equal(scheduler.size, 1, "each change restarts the SAME single timer");
  assert.equal(scheduler.lastDelay, 700, "default debounce window");

  scheduler.runAll();
  await tick();
  assert.equal(server.calls.save, 1, "exactly one PUT for the whole gesture");
  const stored = server.scopes.get("GOLD|MINUTE_1");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].points[0].time, 1_700_000_000 + 9 * 60, "final dragged position persisted");
});

test("sync: a duplicate emission (select/tool events) never schedules a save", async () => {
  const server = makeFakeServer();
  const { sync, scheduler } = makeSync(server);
  await sync.load();
  const set = [drawing("d1")];
  sync.notifyChange(set);
  sync.notifyChange(set); // engine also emits on select — same snapshot
  assert.equal(scheduler.size, 1);
  scheduler.runAll();
  await tick();
  sync.notifyChange(set); // identical to the saved baseline now
  assert.equal(scheduler.size, 0, "post-save duplicate is free");
  assert.equal(server.calls.save, 1);
});

test("create → refresh → restore: a fresh sync loads exactly what was saved", async () => {
  const server = makeFakeServer();
  const created = [drawing("trend-1"), drawing("box-1", "Rectangle")];

  const first = makeSync(server);
  await first.sync.load();
  first.sync.notifyChange(created);
  first.scheduler.runAll();
  await tick();

  // "Refresh": brand-new sync instance against the same server state.
  const phases = [];
  const second = makeSync(server, SCOPE, phases);
  const restored = await second.sync.load();
  assert.deepEqual(restored, created);
  assert.deepEqual(phases, ["loading", "ready"]);
});

test("move → refresh → restored at the moved position", async () => {
  const server = makeFakeServer();
  server.scopes.set("GOLD|MINUTE_1", [drawing("d1")]);

  const sync1 = makeSync(server);
  await sync1.sync.load();
  const moved = {
    ...drawing("d1"),
    points: [
      { time: 1_700_000_600, price: 2010 },
      { time: 1_700_000_900, price: 2012.5 },
    ],
  };
  sync1.sync.notifyChange([moved]);
  sync1.scheduler.runAll();
  await tick();

  const sync2 = makeSync(server);
  const restored = await sync2.sync.load();
  assert.deepEqual(restored[0].points, moved.points, "moved anchors survive the refresh");
});

test("delete → refresh → absent; deleting the LAST drawing clears the scope via DELETE", async () => {
  const server = makeFakeServer();
  server.scopes.set("GOLD|MINUTE_1", [drawing("keep"), drawing("drop")]);

  const sync1 = makeSync(server);
  await sync1.sync.load();
  sync1.sync.notifyChange([drawing("keep")]); // "drop" deleted locally
  sync1.scheduler.runAll();
  await tick();
  assert.equal(server.scopes.get("GOLD|MINUTE_1").length, 1);

  // Delete the last one → the empty set reaches clear() (DELETE), not PUT [].
  sync1.sync.notifyChange([]);
  sync1.scheduler.runAll();
  await tick();
  assert.equal(server.calls.clear, 1, "empty scope uses the DELETE path");
  assert.equal(server.scopes.has("GOLD|MINUTE_1"), false);

  const sync2 = makeSync(server);
  assert.deepEqual(await sync2.sync.load(), [], "deleted drawing does not return after refresh");
});

test("reverting a change back to the saved state cancels the pending save", async () => {
  const server = makeFakeServer();
  const original = [drawing("d1")];
  server.scopes.set("GOLD|MINUTE_1", original);

  const { sync, scheduler } = makeSync(server);
  await sync.load();

  sync.notifyChange([drawing("d1", "TrendLine", 1_700_001_000)]);
  assert.equal(scheduler.size, 1);
  sync.notifyChange(original); // user undid back to server state
  assert.equal(scheduler.size, 0, "no timer left for a reverted snapshot");

  scheduler.runAll();
  await tick();
  assert.equal(server.calls.save, 0, "nothing to persist after the revert");
});

test("save failure: local state survives, phase=error, retryNow re-persists", async () => {
  const server = makeFakeServer();
  const phases = [];
  const { sync, scheduler } = makeSync(server, SCOPE, phases);
  await sync.load();

  const local = [drawing("d1")];
  server.state.failSave = true;
  sync.notifyChange(local);
  scheduler.runAll();
  await tick();
  assert.ok(phases.some((p) => p.startsWith("error")), "failure is reported, never silent");
  assert.equal(server.scopes.has("GOLD|MINUTE_1"), false, "server unchanged");

  // The drawing is NOT discarded: one retry persists it once the API recovers.
  server.state.failSave = false;
  sync.retryNow();
  scheduler.runAll();
  await tick();
  assert.deepEqual(server.scopes.get("GOLD|MINUTE_1"), local, "local work persisted after recovery");
  assert.ok(phases.includes("saved"));
});

test("shutdown flushes unsaved work fire-and-forget before the engine dies", async () => {
  const server = makeFakeServer();
  const { sync, scheduler } = makeSync(server);
  await sync.load();
  sync.notifyChange([drawing("unsaved")]);
  assert.equal(scheduler.size, 1);

  sync.shutdown(); // scope switch / unmount — React cleanup cannot await
  await tick();
  await tick();
  assert.equal(server.calls.save, 1, "pending snapshot flushed despite cancelled timers");
  assert.deepEqual(server.scopes.get("GOLD|MINUTE_1"), [drawing("unsaved")]);

  // A disposed sync ignores later emissions (the old engine is dead anyway).
  sync.notifyChange([drawing("late")]);
  assert.equal(scheduler.size, 0);
});

test("scopes never mix: GOLD 1m and GOLD 3m persist and reload independently", async () => {
  const server = makeFakeServer();
  const oneMin = { epic: "GOLD", timeframe: "MINUTE_1" };
  const threeMin = { epic: "GOLD", timeframe: "MINUTE_3" };

  const a = makeSync(server, oneMin);
  const b = makeSync(server, threeMin);
  await a.sync.load();
  await b.sync.load();

  a.sync.notifyChange([drawing("gold-1m")]);
  a.scheduler.runAll();
  await tick();
  b.sync.notifyChange([drawing("gold-3m", "HorizontalLine")]);
  b.scheduler.runAll();
  await tick();

  assert.deepEqual((await makeSync(server, oneMin).sync.load()).map((d) => d.id), ["gold-1m"]);
  assert.deepEqual((await makeSync(server, threeMin).sync.load()).map((d) => d.id), ["gold-3m"]);
  assert.equal(server.scopes.size, 2, "two scope buckets, no cross-contamination");
});

// ── HTTP layer (stubbed fetch) ────────────────────────────────────────────────

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("HTTP: GET/PUT/DELETE talk to /api/drawings with scope params + Bearer", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === "PUT") return jsonResponse(200, { ok: true, count: 1 });
    return jsonResponse(200, { epic: "GOLD", timeframe: "MINUTE_1", count: 1, drawings: [drawing("d1")] });
  };
  try {
    const loaded = await fetchScopeDrawings(SCOPE, "test-token");
    assert.deepEqual(loaded.map((d) => d.id), ["d1"]);
    assert.match(calls[0].url, /\/api\/drawings\?epic=GOLD&timeframe=MINUTE_1$/);
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
    assert.equal(calls[0].init.method ?? "GET", "GET");

    await saveScopeDrawings(SCOPE, [drawing("d1")], "test-token");
    const put = calls[1];
    assert.equal(put.init.method, "PUT");
    assert.equal(put.init.headers["content-type"], "application/json");
    assert.equal(put.init.headers.Authorization, "Bearer test-token");
    const body = JSON.parse(put.init.body);
    assert.equal(body.epic, "GOLD");
    assert.equal(body.timeframe, "MINUTE_1");
    assert.deepEqual(body.drawings, [drawing("d1")]);

    await clearScopeDrawings(SCOPE, "test-token");
    const del = calls[2];
    assert.equal(del.init.method, "DELETE");
    assert.match(del.url, /epic=GOLD&timeframe=MINUTE_1$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("HTTP: backend errors surface as typed ApiErrors; no session ⇒ NO_SESSION before any fetch", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse(400, { error: "bad drawings", code: "INVALID_DRAWINGS" });
    await assert.rejects(
      saveScopeDrawings(SCOPE, [drawing("d1")], "test-token"),
      (err) => err.code === "INVALID_DRAWINGS" && err.status === 400,
    );

    globalThis.fetch = async () => jsonResponse(503, { error: "db down", code: "DB_NOT_CONFIGURED" });
    await assert.rejects(fetchScopeDrawings(SCOPE, "test-token"), (err) => err.code === "DB_NOT_CONFIGURED");

    // Node has no browser storage → getToken() is null → typed NO_SESSION
    // error thrown BEFORE any network call.
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return jsonResponse(200, { drawings: [] });
    };
    await assert.rejects(fetchScopeDrawings(SCOPE), (err) => err.code === "NO_SESSION");
    assert.equal(fetched, false, "unauthenticated requests never reach the network");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("HTTP: locally-invalid drawings are rejected before the request; malformed server payloads throw", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      calls.push(String(url));
      return jsonResponse(200, { drawings: "this-is-not-an-array" });
    };
    await assert.rejects(saveScopeDrawings(SCOPE, [{ nope: 1 }], "tok"), (err) => err.code === "INVALID_DRAWINGS");
    assert.equal(calls.length, 0, "client-side validation happens before fetch");

    await assert.rejects(fetchScopeDrawings(SCOPE, "tok"), (err) => err.code === "BAD_DRAWINGS_PAYLOAD");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Wiring contract (source-level) ────────────────────────────────────────────

const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("wiring: TradingChart creates a per-scope controller with localStorage persistence disabled", () => {
  const src = readSrc("../src/components/TradingChart/TradingChart.tsx");
  assert.match(src, /new DrawingController\(\{ storageKey: null \}\)/, "no localStorage authority");
  assert.match(src, /\[instrumentEpic, resolution\]/, "controller keyed by instrument × timeframe scope");
  assert.match(src, /drawing=\{drawingController\}/, "ChartView receives the drawing plugin");
  assert.match(src, /<DrawingLayer/, "persistence bridge is mounted");
  assert.match(src, /epic=\{instrumentEpic\}/);
  assert.match(src, /timeframe=\{resolution\}/);
});

test("wiring: DrawingLayer restores via engine.import and drives CandleKit's ENGINE (no second toolbar)", () => {
  const src = readSrc("../src/components/TradingChart/DrawingLayer.tsx");
  // The toolbar is pure chrome over CandleKit's DrawingEngine — it starts tools,
  // deletes and locks through the SAME API the library's own toolbar calls, so
  // none of the drawing behaviour is reimplemented.
  assert.match(src, /engine\.startTool\(/, "tools are started through CandleKit's engine");
  assert.match(src, /engine\.removeSelected\(/, "delete goes through the engine, never removeAll");
  // CandleKit's <DrawingToolbar> is intentionally NOT used: it hard-codes a
  // destructive "Clear all" that AURA must never expose (and would duplicate
  // the delete/lock controls AURA owns itself).
  assert.ok(!/removeAll\s*\(/.test(src), "no destructive clear-all is reachable from AURA's toolbar");
  assert.match(src, /engine\.import\(/, "restores through the official serialization API");
  assert.match(src, /sync\s*\.load\(\)/, "loads persisted drawings on scope change");
  assert.match(src, /notifyChange\(engine\.getDrawings\(\)\)/, "engine changes drive persistence");
  assert.match(src, /restoringRef/, "restore echo is suppressed");
  assert.match(src, /replayActive/, "toolbar hidden while Replay owns the chart");
});

test("wiring: styles theme the toolbar; the service never touches localStorage", () => {
  const styles = readSrc("../src/styles.css");
  assert.match(styles, /\.drawing-toolbar \{/);
  assert.match(styles, /\.drawing-layer \{/);
  assert.match(styles, /\.drawing-status--error/);

  const service = readSrc("../src/services/drawingPersistence.ts");
  // Strip comments first: the module's doc-header DELIBERATELY mentions both
  // tokens to document that they are NOT used — the contract under test is
  // that the executable code never touches them.
  const serviceCode = service
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(!serviceCode.includes("localStorage"), "localStorage is not an authoritative store");
  assert.ok(!serviceCode.includes("storageKey"), "CandleKit's KV storage is not enabled by the service");
});
