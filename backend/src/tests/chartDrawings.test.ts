/**
 * Chart drawing persistence route tests — GET/PUT/DELETE /api/drawings.
 *
 * Isolation strategy (mirrors tradingProxy.test.ts): the router runs against
 * an IN-MEMORY ChartDrawingStore and a stub session source through Hono's
 * app.request() — no database, no network, no Dashboard. Covered contract:
 *   create → retrieve, update (move), delete, scope isolation (user ×
 *   instrument × timeframe), malformed payload rejection, count/byte caps,
 *   auth gating, and the 503 store-unavailable path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

import {
  createChartDrawingsRouter,
  MAX_DRAWINGS,
  type ChartDrawingRecord,
  type ChartDrawingStore,
  type DrawingSessionSource,
} from "../routes/chartDrawings.js";
import { DashboardApiError } from "../services/dashboardClient.js";

const INSTRUMENTS = [{ epic: "GOLD" }, { epic: "DAX40" }];
const GOOD_TOKEN = "token-good";
const AUTH = { Authorization: `Bearer ${GOOD_TOKEN}` };

/** Session stub: two valid tokens → two distinct owning users. */
const USER_BY_TOKEN: Record<string, string> = {
  [GOOD_TOKEN]: "user-1",
  "token-user-2": "user-2",
};
const sessions: DrawingSessionSource = {
  async getSession(token) {
    const userId = USER_BY_TOKEN[token];
    if (!userId) throw new DashboardApiError(401, "Invalid session token.");
    return { user: { id: userId, email: `${userId}@example.test` } };
  },
};

/** In-memory store with call spies — deep-copies on the way in and out. */
class MemoryStore implements ChartDrawingStore {
  readonly scopes = new Map<string, ChartDrawingRecord[]>();
  loadCalls = 0;
  replaceCalls = 0;
  clearCalls = 0;

  private key(u: string, i: string, t: string): string {
    return `${u}|${i}|${t}`;
  }
  async load(u: string, i: string, t: string): Promise<ChartDrawingRecord[]> {
    this.loadCalls += 1;
    return (this.scopes.get(this.key(u, i, t)) ?? []).map(
      (r) => ({ id: r.id, tool: r.tool, data: JSON.parse(JSON.stringify(r.data)) as Record<string, unknown> }),
    );
  }
  async replace(u: string, i: string, t: string, drawings: readonly ChartDrawingRecord[]): Promise<void> {
    this.replaceCalls += 1;
    this.scopes.set(
      this.key(u, i, t),
      drawings.map((r) => ({ id: r.id, tool: r.tool, data: JSON.parse(JSON.stringify(r.data)) })),
    );
  }
  async clear(u: string, i: string, t: string): Promise<void> {
    this.clearCalls += 1;
    this.scopes.delete(this.key(u, i, t));
  }
}

function makeRoot(store: ChartDrawingStore | null): Hono {
  const root = new Hono();
  root.route("/api", createChartDrawingsRouter({ store, instruments: INSTRUMENTS, sessions }));
  return root;
}

function drawing(id: string, tool = "TrendLine", time = 1_700_000_000, price = 2000.5): Record<string, unknown> {
  return {
    id,
    tool,
    points: [
      { time, price },
      { time: time + 300, price: price + 1.25 },
    ],
    style: { color: "#4f8cff", width: 2, dashed: false, fill: null },
  };
}

async function put(root: Hono, body: unknown, headers: Record<string, string> = AUTH): Promise<Response> {
  return root.request("/api/drawings", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(root: Hono, qs: string, headers: Record<string, string> = AUTH): Promise<Response> {
  return root.request(`/api/drawings?${qs}`, { headers });
}

async function del(root: Hono, qs: string, headers: Record<string, string> = AUTH): Promise<Response> {
  return root.request(`/api/drawings?${qs}`, { method: "DELETE", headers });
}

const SCOPE_QS = "epic=GOLD&timeframe=MINUTE_1";

// ── Auth ──────────────────────────────────────────────────────────────────────

test("auth: missing token → 401 before any scope validation or store work", async () => {
  const store = new MemoryStore();
  const root = makeRoot(store);
  const responses = await Promise.all([
    get(root, SCOPE_QS, {}),
    put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [] }, {}),
    del(root, SCOPE_QS, {}),
  ]);
  for (const res of responses) assert.equal(res.status, 401);
  assert.equal(store.loadCalls + store.replaceCalls + store.clearCalls, 0);
});

test("auth: an invalid session token forwards the Dashboard status and touches no store", async () => {
  const store = new MemoryStore();
  const root = makeRoot(store);
  const res = await get(root, SCOPE_QS, { Authorization: "Bearer expired" });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Invalid session/);
  assert.equal(store.loadCalls, 0);
});

// ── Scope validation ──────────────────────────────────────────────────────────

test("scope: missing epic, unknown epic and unknown timeframe are all 400", async () => {
  const root = makeRoot(new MemoryStore());
  const cases: [string, string][] = [
    ["", "EPIC_MISSING"],
    ["epic=NOPE&timeframe=MINUTE_1", "UNSUPPORTED_EPIC"],
    ["epic=GOLD&timeframe=WEEKLY_1", "INVALID_TIMEFRAME"],
  ];
  for (const [qs, code] of cases) {
    const res = await get(root, qs);
    assert.equal(res.status, 400, qs);
    assert.equal(((await res.json()) as { code: string }).code, code, qs);
  }
  const putRes = await put(root, { epic: "NOPE", timeframe: "MINUTE_1", drawings: [] });
  assert.equal(putRes.status, 400);
  assert.equal(((await putRes.json()) as { code: string }).code, "UNSUPPORTED_EPIC");
});

// ── CRUD lifecycle ────────────────────────────────────────────────────────────

test("create → retrieve: a PUT round-trips through GET with shape + extras intact", async () => {
  const store = new MemoryStore();
  const root = makeRoot(store);
  const drawings = [
    { ...drawing("d1"), locked: true },
    drawing("d2", "Rectangle"),
  ];
  const putRes = await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings });
  assert.equal(putRes.status, 200);
  const putBody = (await putRes.json()) as { ok: boolean; count: number };
  assert.equal(putBody.ok, true);
  assert.equal(putBody.count, 2);

  const getRes = await get(root, SCOPE_QS);
  assert.equal(getRes.status, 200);
  const body = (await getRes.json()) as { epic: string; timeframe: string; count: number; drawings: unknown[] };
  assert.equal(body.epic, "GOLD");
  assert.equal(body.timeframe, "MINUTE_1");
  assert.equal(body.count, 2);
  // Array order (z-order) preserved; extra fields round-trip byte-identical.
  assert.deepEqual(body.drawings, drawings);
});

test("update: moving a drawing replaces its row — no duplicates after a refresh", async () => {
  const root = makeRoot(new MemoryStore());
  await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [drawing("d1")] });

  const moved = {
    ...(drawing("d1") as Record<string, unknown>),
    points: [
      { time: 1_700_000_600, price: 2010 },
      { time: 1_700_000_900, price: 2012.5 },
    ],
  };
  const res = await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [moved] });
  assert.equal(res.status, 200);

  const body = (await (await get(root, SCOPE_QS)).json()) as { count: number; drawings: Array<{ points: unknown }> };
  assert.equal(body.count, 1, "the same id must never duplicate within a scope");
  assert.deepEqual(body.drawings[0].points, moved.points);
});

test("delete: a scope PUT without the id drops it; DELETE clears the whole scope", async () => {
  const store = new MemoryStore();
  const root = makeRoot(store);
  await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [drawing("d1"), drawing("d2")] });

  // Remove d2 via the normal whole-array save.
  await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [drawing("d1")] });
  let body = (await (await get(root, SCOPE_QS)).json()) as { count: number; drawings: { id: string }[] };
  assert.equal(body.count, 1);
  assert.equal(body.drawings[0].id, "d1");

  // DELETE clears the remaining drawings for THIS scope only.
  const other = "epic=GOLD&timeframe=MINUTE_3";
  await put(root, { epic: "GOLD", timeframe: "MINUTE_3", drawings: [drawing("keep")] });
  const res = await del(root, SCOPE_QS);
  assert.equal(res.status, 200);
  body = (await (await get(root, SCOPE_QS)).json()) as typeof body;
  assert.equal(body.count, 0);
  const otherBody = (await (await get(root, other)).json()) as { count: number };
  assert.equal(otherBody.count, 1, "DELETE must not leak across timeframes");
});

test("clear-by-save: PUT with an empty array is a valid save that empties the scope", async () => {
  const root = makeRoot(new MemoryStore());
  await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [drawing("d1")] });
  const res = await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [] });
  assert.equal(res.status, 200);
  const body = (await (await get(root, SCOPE_QS)).json()) as { count: number };
  assert.equal(body.count, 0);
});

// ── Scope isolation ───────────────────────────────────────────────────────────

test("isolation: scopes never mix across instrument × timeframe × user", async () => {
  const root = makeRoot(new MemoryStore());
  await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [drawing("gold-1m")] });
  await put(root, { epic: "GOLD", timeframe: "MINUTE_3", drawings: [drawing("gold-3m")] });
  await put(root, { epic: "DAX40", timeframe: "MINUTE_1", drawings: [drawing("dax-1m")] });

  const qs: [string, string][] = [
    ["epic=GOLD&timeframe=MINUTE_1", "gold-1m"],
    ["epic=GOLD&timeframe=MINUTE_3", "gold-3m"],
    ["epic=DAX40&timeframe=MINUTE_1", "dax-1m"],
  ];
  for (const [query, expectedId] of qs) {
    const body = (await (await get(root, query)).json()) as { count: number; drawings: { id: string }[] };
    assert.equal(body.count, 1, query);
    assert.equal(body.drawings[0].id, expectedId, query);
  }

  // Deleting GOLD 1m leaves every other scope untouched.
  await del(root, "epic=GOLD&timeframe=MINUTE_1");
  for (const [query, expectedId] of qs.slice(1)) {
    const body = (await (await get(root, query)).json()) as { drawings: { id: string }[] };
    assert.equal(body.drawings[0].id, expectedId, query);
  }
});

test("isolation: a second user's drawings are invisible to the first", async () => {
  const root = makeRoot(new MemoryStore());
  const user2 = { Authorization: "Bearer token-user-2" };
  await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [drawing("mine")] });
  await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [drawing("theirs")] }, user2);

  const mine = (await (await get(root, SCOPE_QS)).json()) as { drawings: { id: string }[] };
  const theirs = (await (await get(root, SCOPE_QS, user2)).json()) as { drawings: { id: string }[] };
  assert.deepEqual(mine.drawings.map((d) => d.id), ["mine"]);
  assert.deepEqual(theirs.drawings.map((d) => d.id), ["theirs"]);
});

// ── Malformed payload rejection ───────────────────────────────────────────────

test("malformed payloads → 400 and the store is never written", async () => {
  const store = new MemoryStore();
  const root = makeRoot(store);
  await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [drawing("keep")] });
  const replaceCallsAfterSeed = store.replaceCalls;

  const bad: unknown[] = [
    { epic: "GOLD", timeframe: "MINUTE_1", drawings: "not-an-array" },
    { epic: "GOLD", timeframe: "MINUTE_1" }, // drawings missing
    { epic: "GOLD", timeframe: "MINUTE_1", drawings: [{}] }, // no id/tool/points
    { epic: "GOLD", timeframe: "MINUTE_1", drawings: [{ id: "", tool: "TrendLine", points: [{ time: 1, price: 1 }] }] },
    { epic: "GOLD", timeframe: "MINUTE_1", drawings: [{ id: "x", tool: "", points: [{ time: 1, price: 1 }] }] },
    {
      epic: "GOLD",
      timeframe: "MINUTE_1",
      drawings: [{ id: "x", tool: "TrendLine", points: [{ time: "now", price: 1 }] }], // non-numeric anchor
    },
    {
      epic: "GOLD",
      timeframe: "MINUTE_1",
      drawings: [{ id: "x", tool: "TrendLine", points: [{ time: Infinity, price: 1 }] }], // non-finite anchor
    },
    {
      epic: "GOLD",
      timeframe: "MINUTE_1",
      drawings: [{ id: "x", tool: "TrendLine", points: [{ time: 1, price: 1 }], style: "red" }], // style not an object
    },
    {
      epic: "GOLD",
      timeframe: "MINUTE_1",
      drawings: [drawing("dup"), drawing("dup")], // duplicate ids
    },
    { epic: "GOLD", timeframe: "MINUTE_1", drawings: [drawing("no-points-fail")] }, // fine — control
  ];
  for (const body of bad.slice(0, -1)) {
    const res = await put(root, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 120));
    assert.equal(((await res.json()) as { code: string }).code, "INVALID_DRAWINGS");
  }
  // The control case succeeds — proving the guard rejects only the BAD ones.
  const okRes = await put(root, bad[bad.length - 1]);
  assert.equal(okRes.status, 200);
  // One replace for the seed + one for the control — never one per bad body.
  assert.equal(store.replaceCalls, replaceCallsAfterSeed + 1);

  // Invalid JSON body → 400 BAD_JSON.
  const broken = await root.request("/api/drawings", {
    method: "PUT",
    headers: { ...AUTH, "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(broken.status, 400);
  assert.equal(((await broken.json()) as { code: string }).code, "BAD_JSON");
});

test("caps: more than MAX_DRAWINGS → 400; a >256KB payload → 413", async () => {
  const root = makeRoot(new MemoryStore());

  const tooMany = Array.from({ length: MAX_DRAWINGS + 1 }, (_, i) => drawing(`d${i}`));
  const res1 = await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: tooMany });
  assert.equal(res1.status, 400);
  assert.match(((await res1.json()) as { error: string }).error, /at most 500/);

  // 16 drawings × ~20 KB of pass-through extras ≈ 320 KB total → 413.
  const fat = Array.from({ length: 16 }, (_, i) => ({
    ...(drawing(`f${i}`) as Record<string, unknown>),
    pad: "x".repeat(20_000),
  }));
  const res2 = await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: fat });
  assert.equal(res2.status, 413);
  assert.equal(((await res2.json()) as { code: string }).code, "PAYLOAD_TOO_LARGE");
});

// ── Store availability ────────────────────────────────────────────────────────

test("no PostgreSQL store → 503 DB_NOT_CONFIGURED on every endpoint", async () => {
  const root = makeRoot(null);
  const responses = [
    await get(root, SCOPE_QS),
    await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [] }),
    await del(root, SCOPE_QS),
  ];
  for (const res of responses) {
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code: string }).code, "DB_NOT_CONFIGURED");
  }
});

// ── Annotation + styling validation (text annotation feature) ────────────────

/** A drawing carrying AURA's annotation + extended-style fields. */
function annotated(id: string, tool = "TrendLine"): Record<string, unknown> {
  return {
    ...drawing(id, tool),
    style: {
      color: "#4f8cff",
      width: 2,
      dashed: false,
      fill: null,
      text: "Support",
      textColor: "#e6edf3",
      textSize: 14,
      textPlacement: "above",
      ...(tool === "Rectangle" ? { fill: "rgba(38, 166, 154, 0.3)", fillOpacity: 0.3 } : {}),
    },
  };
}

test("annotation: a fully-annotated drawing round-trips byte-identical", async () => {
  const root = makeRoot(new MemoryStore());
  const d = annotated("a1", "Rectangle");
  const putRes = await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [d] });
  assert.equal(putRes.status, 200);
  const body = (await (await get(root, SCOPE_QS)).json()) as { drawings: unknown[] };
  assert.deepEqual(body.drawings, [d]);
});

test("annotation: a LEGACY drawing with no annotation fields is accepted", async () => {
  const root = makeRoot(new MemoryStore());
  const legacy = drawing("legacy"); // { color, width, dashed, fill } only
  const putRes = await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [legacy] });
  assert.equal(putRes.status, 200);
  const body = (await (await get(root, SCOPE_QS)).json()) as { drawings: unknown[] };
  assert.deepEqual(body.drawings, [legacy]);
});

test("annotation: empty text is a valid save (removes the label, keeps the drawing)", async () => {
  const root = makeRoot(new MemoryStore());
  const d = { ...annotated("e1"), style: { ...(annotated("e1").style as object), text: "" } };
  const putRes = await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [d] });
  assert.equal(putRes.status, 200);
});

test("annotation: malformed annotation fields are rejected with 400", async () => {
  const root = makeRoot(new MemoryStore());
  const bad: [string, Record<string, unknown>][] = [
    ["text too long", { text: "x".repeat(201) }],
    ["text not a string", { text: 123 }],
    ["textColor not a colour", { textColor: "javascript:alert(1)" }],
    ["textSize out of range", { textSize: 999 }],
    ["textPlacement invalid", { textPlacement: "sideways" }],
    ["fillOpacity out of range", { fillOpacity: 5 }],
  ];
  for (const [label, stylePatch] of bad) {
    const d = { ...drawing("bad"), style: { color: "#fff", width: 1, dashed: false, fill: null, ...stylePatch } };
    const res = await put(root, { epic: "GOLD", timeframe: "MINUTE_1", drawings: [d] });
    assert.equal(res.status, 400, label);
    assert.equal(((await res.json()) as { code: string }).code, "INVALID_DRAWINGS", label);
  }
});


