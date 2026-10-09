/**
 * Chart drawing persistence (per-user) — GET/PUT/DELETE /api/drawings.
 *
 * TradingView-style persistence for CandleKit's built-in drawing tools: every
 * committed drawing is stored as one PostgreSQL row in public.chart_drawings,
 * scoped to (user_id, instrument, timeframe) so drawings survive refresh,
 * timeframe switches and redeploys — and can never bleed between users.
 *
 * AUTH: session-scoped Bearer, identical to routes/auth.ts — the token is
 * forwarded to the Trading Dashboard's session endpoint (the single source of
 * authentication truth) which resolves the OWNING user id. The token itself is
 * never logged, never stored, and never appears in a URL/query string.
 *
 * VALIDATION mirrors routes/candlesDb.ts: the requested instrument must be in
 * the configured UI registry and the timeframe in TIMEFRAME_BUCKET_SEC. On top
 * of that, each submitted drawing is shape-checked (see validateDrawings):
 * at most 500 drawings, 1..32 anchor points, finite coordinates, id/tool
 * strings, and a total payload ≤ 256 KB — a malformed or hostile body can
 * never reach the database.
 *
 * WRITE SEMANTICS: whole-array replace per scope, transactionally
 * (DELETE scope + INSERT array) — see createPgChartDrawingStore. An empty
 * array is a valid save and clears the scope.
 *
 * The store is dependency-injected (ChartDrawingStore) so the route tests run
 * with an in-memory stub — no database, no network, no dashboard.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DashboardApiError } from "../services/dashboardClient.js";
import { TIMEFRAME_BUCKET_SEC } from "../streaming/timeframes.js";

/** Hard cap per scope — mirrors the frontend's drawingPersistence.ts. */
export const MAX_DRAWINGS = 500;
/** Byte cap of one serialized drawing array (UTF-8), same on both sides. */
export const MAX_DRAWINGS_JSON_BYTES = 256 * 1024;
/** Generous ceiling on anchors per drawing (Fib/Channel tools need ≤ 4). */
const MAX_POINTS_PER_DRAWING = 32;
const MAX_ID_LENGTH = 128;
const MAX_TOOL_LENGTH = 64;
/** Headroom over MAX_DRAWINGS_JSON_BYTES for the JSON body wrapper
 *  (instrument/timeframe/keys) so an accepted array can never trip the
 *  pre-parse content-length guard. */
const MAX_BODY_BYTES = MAX_DRAWINGS_JSON_BYTES + 4 * 1024;

/** One persisted drawing AFTER validation — exactly what the store accepts. */
export interface ChartDrawingRecord {
  id: string;
  tool: string;
  /** The serialized drawing minus `id`/`tool`: { points, style, ...extras }. */
  data: Record<string, unknown>;
}

/**
 * Storage contract (DI): every call is already scoped to the authenticated
 * user — a store implementation must never read/write across user ids.
 */
export interface ChartDrawingStore {
  load(userId: string, instrument: string, timeframe: string): Promise<ChartDrawingRecord[]>;
  replace(
    userId: string,
    instrument: string,
    timeframe: string,
    drawings: readonly ChartDrawingRecord[],
  ): Promise<void>;
  clear(userId: string, instrument: string, timeframe: string): Promise<void>;
}

/**
 * Session validation (DI) — structurally satisfied by DashboardClient: the
 * token either resolves to a user (valid session) or the call throws
 * (DashboardApiError → its status is forwarded, anything else → 502).
 */
export interface DrawingSessionSource {
  getSession(token: string): Promise<{ user: { id: string; email?: string | null } }>;
}

export interface ChartDrawingsRouterOptions {
  /** null when PostgreSQL is unconfigured → every endpoint answers 503. */
  store: ChartDrawingStore | null;
  /** Configured instrument registry (uiInstruments) — the scope whitelist. */
  instruments: readonly { epic: string }[];
  sessions: DrawingSessionSource;
}

/** Bearer extraction — byte-for-byte the rules of routes/auth.ts. */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Strict shape check on ONE raw drawing. Accepted post-normalization form:
 *   { id: string, tool: string, points: [{time, price}...], style?: {...} }
 * Extra fields (future tool state) pass through UNVALIDATED inside `data` —
 * they round-trip byte-identical via JSONB.
 */
function validateOneDrawing(raw: unknown): { ok: true; record: ChartDrawingRecord } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: "drawing must be an object" };
  const { id, tool, points, style, ...extras } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !id.trim() || id.length > MAX_ID_LENGTH) {
    return { ok: false, reason: "drawing.id must be a non-empty string (≤128 chars)" };
  }
  if (typeof tool !== "string" || !tool.trim() || tool.length > MAX_TOOL_LENGTH) {
    return { ok: false, reason: "drawing.tool must be a non-empty string (≤64 chars)" };
  }
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_POINTS_PER_DRAWING) {
    return { ok: false, reason: `drawing.points must have 1..${MAX_POINTS_PER_DRAWING} anchors` };
  }
  for (const p of points) {
    if (!isPlainObject(p) || !isFiniteNumber(p.time) || !isFiniteNumber(p.price)) {
      return { ok: false, reason: "each point needs finite numeric time + price" };
    }
  }
  if (style !== undefined && !isPlainObject(style)) {
    return { ok: false, reason: "drawing.style must be an object when present" };
  }
  return {
    ok: true,
    record: {
      id: id.trim(),
      tool: tool.trim(),
      data: { points, ...(style !== undefined ? { style } : {}), ...extras },
    },
  };
}

/** Whole-array validation (count + per-drawing shape + total byte cap). */
export function validateDrawings(raw: unknown): {
  ok: true;
  records: ChartDrawingRecord[];
} | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "drawings must be an array" };
  if (raw.length > MAX_DRAWINGS) {
    return { ok: false, reason: `at most ${MAX_DRAWINGS} drawings per scope` };
  }
  const records: ChartDrawingRecord[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const one = validateOneDrawing(item);
    if (!one.ok) return one;
    if (seen.has(one.record.id)) return { ok: false, reason: `duplicate drawing id "${one.record.id}"` };
    seen.add(one.record.id);
    records.push(one.record);
  }
  const bytes = Buffer.byteLength(JSON.stringify(records), "utf8");
  if (bytes > MAX_DRAWINGS_JSON_BYTES) {
    return {
      ok: false,
      reason: `drawings payload too large (${bytes} bytes > ${MAX_DRAWINGS_JSON_BYTES})`,
    };
  }
  return { ok: true, records };
}

// ── Scope + session helpers ───────────────────────────────────────────────────

/** 503 body shared by every endpoint when PostgreSQL is unconfigured (mirrors routes/candlesDb.ts). */
const DB_UNAVAILABLE = {
  error:
    "Chart-drawing persistence is not configured — set AURA_DB_URL (via /etc/aura/postgres.env on the VM) to enable PostgreSQL persistence.",
  code: "DB_NOT_CONFIGURED",
} as const;

/** Validated drawing scope (instrument × timeframe) or the 400 body to send back. */
type ScopeResult =
  | { ok: true; epic: string; timeframe: string }
  | { ok: false; error: string; code: string };

/**
 * Scope whitelist validation shared by ALL endpoints: the epic must be in the
 * configured UI registry and the timeframe in TIMEFRAME_BUCKET_SEC — a request
 * can only ever read/write a scope the chart itself can render.
 */
function resolveScope(
  epicRaw: string | undefined,
  timeframeRaw: string | undefined,
  instruments: readonly { epic: string }[],
): ScopeResult {
  const epic = (epicRaw ?? "").trim();
  if (!epic) return { ok: false, error: "Missing instrument `epic`.", code: "EPIC_MISSING" };
  if (!instruments.some((i) => i.epic === epic)) {
    return { ok: false, error: `Unsupported instrument epic "${epic}".`, code: "UNSUPPORTED_EPIC" };
  }
  const timeframe = (timeframeRaw ?? "").trim().toUpperCase();
  if (!(timeframe in TIMEFRAME_BUCKET_SEC)) {
    return {
      ok: false,
      error: `Invalid timeframe "${timeframe}". Supported: ${Object.keys(TIMEFRAME_BUCKET_SEC).join(", ")}`,
      code: "INVALID_TIMEFRAME",
    };
  }
  return { ok: true, epic, timeframe };
}

/** Bearer → owning user id. Error semantics identical to routes/auth.ts. */
type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: ContentfulStatusCode; error: string };

/** DashboardApiError.status is a plain number — clamp it to a legal HTTP status. */
function asHttpStatus(status: number): ContentfulStatusCode {
  return status >= 400 && status <= 599 ? (status as ContentfulStatusCode) : 502;
}

async function authorize(
  sessions: DrawingSessionSource,
  header: string | undefined,
): Promise<AuthResult> {
  const token = extractBearer(header);
  if (!token) return { ok: false, status: 401, error: "Missing authorization token." };
  try {
    const session = await sessions.getSession(token);
    if (!session?.user?.id) {
      return { ok: false, status: 502, error: "Session check failed." };
    }
    return { ok: true, userId: session.user.id };
  } catch (err) {
    if (err instanceof DashboardApiError) {
      return { ok: false, status: asHttpStatus(err.status), error: err.message };
    }
    // Never log the token — only the failure itself.
    console.error("[drawings] session check failed:", err instanceof Error ? err.message : err);
    return { ok: false, status: 502, error: "Session check failed." };
  }
}

/** Coerce a parsed-JSON value to a string (non-strings read as "absent"). */
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * GET    /api/drawings?epic=<EPIC>&timeframe=<MINUTE_x>  → the scope's drawings
 * PUT    /api/drawings  { epic, timeframe, drawings }    → transactional whole-array replace
 * DELETE /api/drawings?epic=<EPIC>&timeframe=<MINUTE_x>  → clear the scope
 *
 * Every endpoint: session auth FIRST (401/forwarded status before any scope or
 * store work), then scope whitelist, then the store. The resolved user id —
 * never a client-supplied identity — is the store key, so a request can never
 * read or write another user's drawings.
 */
export function createChartDrawingsRouter(options: ChartDrawingsRouterOptions): Hono {
  const { store, instruments, sessions } = options;
  const app = new Hono();

  app.get("/drawings", async (c) => {
    const auth = await authorize(sessions, c.req.header("Authorization"));
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const scope = resolveScope(c.req.query("epic"), c.req.query("timeframe"), instruments);
    if (!scope.ok) return c.json({ error: scope.error, code: scope.code }, 400);

    if (!store) return c.json(DB_UNAVAILABLE, 503);

    try {
      const records = await store.load(auth.userId, scope.epic, scope.timeframe);
      // Reassemble the CandleKit serialized Drawing shape: { id, tool, ...data }
      // where data = { points, style, ...extras } — byte-identical round trip.
      const drawings = records.map((r) => ({ id: r.id, tool: r.tool, ...r.data }));
      return c.json({ epic: scope.epic, timeframe: scope.timeframe, count: drawings.length, drawings });
    } catch (err) {
      console.error("[drawings] load failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "Failed to load persisted drawings.", code: "DB_LOAD_FAILED" }, 500);
    }
  });

  app.put("/drawings", async (c) => {
    const auth = await authorize(sessions, c.req.header("Authorization"));
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    // Pre-parse byte guard: a hostile oversized body never reaches JSON.parse.
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return c.json(
        { error: `Request body too large (${declared} bytes > ${MAX_BODY_BYTES}).`, code: "PAYLOAD_TOO_LARGE" },
        413,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON.", code: "BAD_JSON" }, 400);
    }
    if (!isPlainObject(body)) {
      return c.json({ error: "Request body must be a JSON object.", code: "BAD_BODY" }, 400);
    }

    const scope = resolveScope(asString(body.epic), asString(body.timeframe), instruments);
    if (!scope.ok) return c.json({ error: scope.error, code: scope.code }, 400);

    const validated = validateDrawings(body.drawings);
    if (!validated.ok) {
      // Size violations answer 413 (mirrors the pre-parse guard); shape
      // violations answer 400 — both are rejected BEFORE any database work.
      const tooLarge = validated.reason.includes("too large");
      return c.json(
        { error: validated.reason, code: tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_DRAWINGS" },
        tooLarge ? 413 : 400,
      );
    }

    if (!store) return c.json(DB_UNAVAILABLE, 503);

    try {
      await store.replace(auth.userId, scope.epic, scope.timeframe, validated.records);
      return c.json({ ok: true, epic: scope.epic, timeframe: scope.timeframe, count: validated.records.length });
    } catch (err) {
      console.error("[drawings] save failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "Failed to save drawings.", code: "DB_SAVE_FAILED" }, 500);
    }
  });

  app.delete("/drawings", async (c) => {
    const auth = await authorize(sessions, c.req.header("Authorization"));
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const scope = resolveScope(c.req.query("epic"), c.req.query("timeframe"), instruments);
    if (!scope.ok) return c.json({ error: scope.error, code: scope.code }, 400);

    if (!store) return c.json(DB_UNAVAILABLE, 503);

    try {
      await store.clear(auth.userId, scope.epic, scope.timeframe);
      return c.json({ ok: true, epic: scope.epic, timeframe: scope.timeframe });
    } catch (err) {
      console.error("[drawings] delete failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "Failed to delete drawings.", code: "DB_DELETE_FAILED" }, 500);
    }
  });

  return app;
}
