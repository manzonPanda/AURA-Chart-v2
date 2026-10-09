import { API_BASE, ApiError, toApiError } from "./api.ts";
import { getToken } from "./auth.ts";
import type { Drawing } from "@getcandlekit/charts";

/**
 * AURA drawing persistence — the ONLY path between CandleKit's DrawingEngine
 * and the Hono backend (`/api/drawings`, PostgreSQL `chart_drawings`).
 *
 * SCOPE: drawings are persisted per (instrument epic × timeframe) — the same
 * chart-identity key the rest of AURA scopes state by. Anchors travel in
 * CandleKit's DATA space ({ time: epoch seconds, price }), never pixels, so a
 * restored drawing lands exactly where it was drawn at any zoom/pan/size.
 *
 * localStorage is deliberately NOT an authority here: CandleKit's own
 * `storageKey` KV is left disabled (see TradingChart) and every load/save goes
 * through the authenticated API.
 *
 * The module is DOM-free and transport-injectable so the whole persistence
 * lifecycle (create → save → reload, move, delete, debounce, retry) is unit
 * testable under `node --test` without a browser.
 */

/** Chart identity a set of drawings belongs to. */
export interface DrawingScope {
  epic: string;
  timeframe: string;
}

/** Client-side caps — byte-for-byte mirrors of routes/chartDrawings.ts. */
export const MAX_DRAWINGS = 500;
export const MAX_DRAWINGS_JSON_BYTES = 256 * 1024;
/** Coalescing window for engine changes (drag emits per mousemove). */
export const DRAWING_SAVE_DEBOUNCE_MS = 700;
/** Bounded retry pacing after a failed save — the UI stays authoritative. */
export const DRAWING_RETRY_MS = 2_000;
export const DRAWING_MAX_RETRIES = 3;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Per-drawing validation — strict mirror of the backend's validateOneDrawing. */
function parseDrawing(value: unknown): Drawing | null {
  if (!isPlainObject(value)) return null;
  const { id, tool, points, style } = value;
  if (typeof id !== "string" || !id.trim() || id.length > 128) return null;
  if (typeof tool !== "string" || !tool.trim() || tool.length > 64) return null;
  if (!Array.isArray(points) || points.length < 1 || points.length > 32) return null;
  for (const p of points) {
    if (!isPlainObject(p) || !isFiniteNumber(p.time) || !isFiniteNumber(p.price)) return null;
  }
  if (style !== undefined && !isPlainObject(style)) return null;
  // Unknown extras (future CandleKit fields) pass through untouched — they
  // round-trip via the backend's JSONB `drawing_data` byte-identical.
  return value as unknown as Drawing;
}

export type DrawingListResult =
  | { ok: true; drawings: Drawing[] }
  | { ok: false; reason: string };

/** Validate an arbitrary JSON value as a Drawing[] (shape only — no caps). */
export function validateDrawingList(value: unknown): DrawingListResult {
  if (!Array.isArray(value)) return { ok: false, reason: "drawings must be an array" };
  const drawings: Drawing[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const drawing = parseDrawing(item);
    if (!drawing) return { ok: false, reason: "each drawing needs a valid id, tool and anchors" };
    if (seen.has(drawing.id)) return { ok: false, reason: `duplicate drawing id "${drawing.id}"` };
    seen.add(drawing.id);
    drawings.push(drawing);
  }
  return { ok: true, drawings };
}

/** Lenient parse for LOAD responses: malformed ⇒ null (caller decides). */
export function parseDrawings(value: unknown): Drawing[] | null {
  const result = validateDrawingList(value);
  return result.ok ? result.drawings : null;
}

/** Save-side validation: shape + count + byte caps (all three backend-enforced too). */
export function validateDrawingsForSave(drawings: readonly unknown[]): DrawingListResult {
  const shaped = validateDrawingList(drawings);
  if (!shaped.ok) return shaped;
  if (shaped.drawings.length > MAX_DRAWINGS) {
    return { ok: false, reason: `at most ${MAX_DRAWINGS} drawings per scope` };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(shaped.drawings)).length;
  if (bytes > MAX_DRAWINGS_JSON_BYTES) {
    return { ok: false, reason: `drawings payload too large (${bytes} bytes > ${MAX_DRAWINGS_JSON_BYTES})` };
  }
  return shaped;
}

/** CandleKit `engine.export()` JSON → validated Drawing[]. */
export function engineExportToArray(json: string): Drawing[] | null {
  try {
    return parseDrawings(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Drawing[] → the JSON string CandleKit's `engine.import()` expects. */
export function drawingsToEngineJson(drawings: readonly Drawing[]): string {
  return JSON.stringify(drawings);
}

// ── HTTP API (same-origin, Bearer-authenticated — mirrors services/tradingApi.ts) ──

/** Bearer-attached same-origin headers; no session ⇒ typed NO_SESSION error. */
async function bearerHeaders(tokenOverride?: string): Promise<Record<string, string>> {
  const token = tokenOverride ?? getToken();
  if (!token) throw new ApiError(401, "NO_SESSION", "Not signed in.");
  return { Authorization: `Bearer ${token}` };
}

interface DrawingsResponse {
  epic?: string;
  timeframe?: string;
  count?: number;
  drawings?: unknown;
}

function scopeQuery(scope: DrawingScope): URLSearchParams {
  return new URLSearchParams({ epic: scope.epic, timeframe: scope.timeframe });
}

/** GET /api/drawings — the scope's persisted drawings (validated before use). */
export async function fetchScopeDrawings(scope: DrawingScope, token?: string): Promise<Drawing[]> {
  const headers = await bearerHeaders(token);
  const res = await fetch(`${API_BASE}/drawings?${scopeQuery(scope).toString()}`, { headers });
  if (!res.ok) throw await toApiError(res);
  const body = (await res.json()) as DrawingsResponse;
  const parsed = validateDrawingList(body.drawings ?? []);
  if (!parsed.ok) {
    throw new ApiError(500, "BAD_DRAWINGS_PAYLOAD", `Server returned malformed drawings: ${parsed.reason}`);
  }
  return parsed.drawings;
}

/** PUT /api/drawings — whole-array replace of the scope (empty array clears it). */
export async function saveScopeDrawings(
  scope: DrawingScope,
  drawings: readonly Drawing[],
  token?: string,
): Promise<void> {
  const validated = validateDrawingsForSave(drawings);
  if (!validated.ok) throw new ApiError(400, "INVALID_DRAWINGS", validated.reason);
  const headers = await bearerHeaders(token);
  const res = await fetch(`${API_BASE}/drawings`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ epic: scope.epic, timeframe: scope.timeframe, drawings: validated.drawings }),
  });
  if (!res.ok) throw await toApiError(res);
}

/** DELETE /api/drawings — clears every drawing of the scope. */
export async function clearScopeDrawings(scope: DrawingScope, token?: string): Promise<void> {
  const headers = await bearerHeaders(token);
  const res = await fetch(`${API_BASE}/drawings?${scopeQuery(scope).toString()}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw await toApiError(res);
}

// ── Transport seam (injectable for tests) ─────────────────────────────────────

/** The three persistence operations DrawingSync drives. */
export interface DrawingTransport {
  load(scope: DrawingScope): Promise<Drawing[]>;
  save(scope: DrawingScope, drawings: readonly Drawing[]): Promise<void>;
  clear(scope: DrawingScope): Promise<void>;
}

/** Production transport — the authenticated HTTP transport above. */
export const httpDrawingTransport: DrawingTransport = {
  load: (scope) => fetchScopeDrawings(scope),
  save: (scope, drawings) => saveScopeDrawings(scope, drawings),
  clear: (scope) => clearScopeDrawings(scope),
};

// ── Sync engine (debounce / coalesce / retry) ─────────────────────────────────

export type DrawingSyncPhase = "idle" | "loading" | "ready" | "saving" | "saved" | "error";

export interface DrawingSyncOptions {
  scope: DrawingScope;
  /** Defaults to the authenticated HTTP transport. */
  transport?: DrawingTransport;
  debounceMs?: number;
  retryMs?: number;
  maxRetries?: number;
  /** Injectable scheduler — tests drive time manually. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  onPhase?: (phase: DrawingSyncPhase, detail?: string) => void;
}

/**
 * Scope-scoped persistence synchronizer.
 *
 * - `load()` fetches the server set, remembers it as the saved baseline and
 *   reports loading → ready | error.
 * - `notifyChange(current)` diffs snapshots and coalesces every burst (drag
 *   emits per mousemove) into ONE debounced save; identical snapshots are free.
 * - Failures NEVER discard the local snapshot: the phase flips to `error`,
 *   bounded retries run, and the next change re-arms the save.
 * - `shutdown()` cancels timers and fire-and-forget flushes anything unsaved
 *   (scope switches unmount the engine immediately after).
 */
export class DrawingSync {
  readonly scope: DrawingScope;
  private readonly transport: DrawingTransport;
  private readonly debounceMs: number;
  private readonly retryMs: number;
  private readonly maxRetries: number;
  private readonly scheduleFn: (fn: () => void, ms: number) => unknown;
  private readonly cancelFn: (handle: unknown) => void;
  private readonly onPhase?: (phase: DrawingSyncPhase, detail?: string) => void;

  private timer: unknown = null;
  /** Latest unsaved snapshot (JSON) — the local truth until a save succeeds. */
  private pendingJson: string | null = null;
  /** Last snapshot the SERVER confirmed — the diff baseline. */
  private savedJson: string | null = null;
  private inFlight = false;
  private requeue = false;
  private retries = 0;
  private disposed = false;

  constructor(options: DrawingSyncOptions) {
    this.scope = options.scope;
    this.transport = options.transport ?? httpDrawingTransport;
    this.debounceMs = options.debounceMs ?? DRAWING_SAVE_DEBOUNCE_MS;
    this.retryMs = options.retryMs ?? DRAWING_RETRY_MS;
    this.maxRetries = options.maxRetries ?? DRAWING_MAX_RETRIES;
    this.scheduleFn = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelFn =
      options.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onPhase = options.onPhase;
  }

  private emit(phase: DrawingSyncPhase, detail?: string): void {
    this.onPhase?.(phase, detail);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.cancelFn(this.timer);
      this.timer = null;
    }
  }

  private restartTimer(): void {
    this.cancelTimer();
    this.timer = this.scheduleFn(() => {
      this.timer = null;
      void this.persist();
    }, this.debounceMs);
  }

  /** Fetch the scope's server set; becomes the new saved baseline. */
  async load(): Promise<Drawing[]> {
    this.emit("loading");
    try {
      const drawings = await this.transport.load(this.scope);
      this.cancelTimer();
      this.savedJson = JSON.stringify(drawings);
      this.pendingJson = null;
      this.emit("ready");
      return drawings;
    } catch (err) {
      this.emit("error", errorMessage(err));
      throw err;
    }
  }

  /**
   * Called on every DrawingEngine change with the CURRENT engine array.
   * Snapshots are compared before any work happens, so select-only or
   * duplicate emissions cost one stringify and nothing else.
   */
  notifyChange(drawings: readonly unknown[]): void {
    if (this.disposed) return;
    let json: string;
    try {
      json = JSON.stringify(drawings);
    } catch {
      return;
    }
    if (json === this.savedJson) {
      // Reverted back to the server state — nothing left to persist.
      this.cancelTimer();
      this.pendingJson = null;
      this.retries = 0;
      return;
    }
    if (json === this.pendingJson) return;
    this.pendingJson = json;
    this.retries = 0;
    this.restartTimer();
  }

  /** Save immediately (timer cancelled first) — used by the flush path. */
  async flush(): Promise<void> {
    this.cancelTimer();
    await this.persist();
  }

  /** Manual retry (error chip): re-arm the pending save right away. */
  retryNow(): void {
    if (this.disposed) return;
    this.retries = 0;
    if (this.pendingJson !== null) this.restartTimer();
  }

  /**
   * End-of-life: stop timers and, if anything is unsaved, persist it
   * fire-and-forget — the caller (React cleanup) cannot await.
   */
  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    if (this.pendingJson !== null && this.pendingJson !== this.savedJson) {
      void this.persist();
    }
  }

  private async persist(): Promise<void> {
    if (this.pendingJson === null) return;
    if (this.inFlight) {
      this.requeue = true;
      return;
    }
    const json = this.pendingJson;
    if (json === this.savedJson) {
      this.pendingJson = null;
      return;
    }

    let parsed: DrawingListResult;
    try {
      parsed = validateDrawingList(JSON.parse(json));
    } catch {
      parsed = { ok: false, reason: "unreadable drawing snapshot" };
    }
    if (!parsed.ok) {
      // Structurally impossible via the engine — surface it, never retry-storm.
      this.emit("error", parsed.reason);
      return;
    }

    this.inFlight = true;
    this.emit("saving");
    try {
      if (parsed.drawings.length === 0) await this.transport.clear(this.scope);
      else await this.transport.save(this.scope, parsed.drawings);
      this.savedJson = json;
      if (this.pendingJson === json) this.pendingJson = null;
      this.retries = 0;
      this.emit("saved");
    } catch (err) {
      // Local snapshot stays pending — the drawing NEVER disappears because
      // a save failed; the chip reports it and bounded retries continue.
      this.emit("error", errorMessage(err));
      if (!this.disposed && this.retries < this.maxRetries) {
        this.retries += 1;
        this.timer = this.scheduleFn(() => {
          this.timer = null;
          void this.persist();
        }, this.retryMs);
      }
    } finally {
      this.inFlight = false;
      if (this.requeue) {
        this.requeue = false;
        if (!this.disposed && this.pendingJson !== null && this.timer === null) this.restartTimer();
      }
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
