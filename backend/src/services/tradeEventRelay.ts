/**
 * P3-C — LIVE MT5 TRADE EVENT RELAY (server-side only).
 *
 * Event path (NO new transport — both hops reuse the EXISTING mechanisms):
 *   pythonMt5 (already persists trades server-side via the data API)
 *     → aura-backend data-api publishChange("trades")      [existing, advisory]
 *     → aura-backend SSE bus  GET /api/events               [existing, user-filtered]
 *     → THIS module — one server-side SSE subscriber per VALIDATED AURA session
 *       token (validated through the existing DashboardClient.getSession, the
 *       same authority as every P2 call)
 *     → additive /ws frame { type: "trade", ... } to THAT user's clients only
 *     → frontend debounced bounded refetch through the UNCHANGED P2 REST chain
 *       → existing buildTradeOverlays / TradeOverlayBridge / Primitive.
 *
 * The frame is an ADVISORY trigger: it carries only identity fields the
 * upstream bus already proved (table/action/accountId/at). No trade values are
 * invented or reconstructed here — the browser refetches real rows via the
 * existing P2 API, so duplicates become idempotent refetches.
 *
 * Authorization: an upstream subscription exists only for a VALIDATED session;
 * aura-backend already filters change events by the token's userId, and this
 * module fans frames out exclusively to /ws clients authenticated as that SAME
 * user. No other user's MT5 trades can ever reach a client.
 *
 * Ordering/duplicates: upstream may emit several events per lifecycle step
 * (OPEN → UPDATE* → CLOSE, duplicates included). Every burst is coalesced per
 * (userId, accountId) into ONE refresh trigger (DEBOUNCE_MS window); the
 * trailing frame wins. Candle realtime flow is untouched.
 */
import type { DashboardClient } from "./dashboardClient.js";

/** Additive /ws frame — advisory trigger only (no trade values). */
export interface TradeEventFrame {
  type: "trade";
  table: "trades";
  action: string; // upstream action string (INSERT/UPDATE/…) — advisory
  accountId: string | null; // ownership already verified upstream
  userId: string; // validated session owner — the routing key
  at: string | null; // upstream advisory ISO timestamp or null
}

/** Minimal socket surface (real ws.WebSocket satisfies it). */
interface WsLike {
  on(event: string, cb: (...args: unknown[]) => void): void;
  send(data: string): void;
}

interface AuthedClient {
  ws: WsLike;
  userId: string;
  token: string;
}

interface UpstreamSub {
  abort: AbortController;
  token: string;
  refs: number;
}

/** Coalesce window for bursts of change events (ms). */
export const TRADE_REFRESH_DEBOUNCE_MS = 500;

export interface TradeEventRelay {
  /** Opt a /ws client into trade events via {type:"auth",token} frames. */
  attach(ws: WsLike): void;
  /** Detach + ref-count cleanup (idempotent; also wired to ws close). */
  detach(ws: WsLike): void;
  /** Abort every upstream SSE subscriber (lifecycle shutdown). */
  stop(): void;
  /** Test/diagnostic: active upstream subscriptions. */
  subscriptionCount(): number;
  /** Test/diagnostic: authenticated client count. */
  authedClientCount(): number;
}

/** Parse one raw SSE event block ("event: x\ndata: y") into parts. */
export function parseSseEvent(block: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Create the relay. `dashboardClient` is the EXISTING P2 client (session
 * validation authority); `dashboardBaseUrl` is the existing dashboard config;
 * `fetchImpl` is injectable for tests. Nothing else is imported — the /ws
 * registry stays untouched; index.ts wires `attach(ws)` into its connection
 * block as an additive listener.
 */
export function createTradeEventRelay(
  dashboardClient: Pick<DashboardClient, "getSession">,
  dashboardBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): TradeEventRelay {
  const clients = new Map<WsLike, AuthedClient>();
  const subs = new Map<string, UpstreamSub>(); // userId → ref-counted SSE sub
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const lastFrame = new Map<string, TradeEventFrame>();

  /** Fan a coalesced frame out ONLY to clients authenticated as `userId`. */
  function fanOut(userId: string, frame: TradeEventFrame): void {
    for (const c of clients.values()) {
      if (c.userId !== userId) continue;
      try {
        c.ws.send(JSON.stringify(frame));
      } catch {
        /* dead socket — its close/error handler calls detach */
      }
    }
  }

  /** Coalesce bursts per (userId, accountId) → one trailing refresh trigger. */
  function scheduleRefresh(userId: string, accountId: string | null, frame: TradeEventFrame): void {
    const key = `${userId}|${accountId ?? "*"}`;
    lastFrame.set(key, frame);
    if (pending.has(key)) return;
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        const f = lastFrame.get(key);
        lastFrame.delete(key);
        if (f) fanOut(userId, f);
      }, TRADE_REFRESH_DEBOUNCE_MS),
    );
  }

  /** Ref-counted upstream subscription per userId (one per user, N tabs). */
  function subscribe(userId: string, token: string): void {
    const existing = subs.get(userId);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const abort = new AbortController();
    subs.set(userId, { abort, token, refs: 1 });
    void runSseLoop(userId); // one consumption loop per user (retries inside)
  }

  function unsubscribe(userId: string): void {
    const sub = subs.get(userId);
    if (!sub) return;
    sub.refs -= 1;
    if (sub.refs <= 0) {
      sub.abort.abort();
      subs.delete(userId);
    }
  }

  /** One SSE consumption loop per user; retries with backoff while subscribed. */
  async function runSseLoop(userId: string): Promise<void> {
    for (;;) {
      const sub = subs.get(userId);
      if (!sub) return;
      const abort = new AbortController();
      sub.abort = abort;
      try {
        const res = await fetchImpl(`${dashboardBaseUrl}/api/events`, {
          headers: { Authorization: `Bearer ${sub.token}` },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`upstream /api/events status=${res.status}`);
        }
        await consumeSse(res.body, userId);
      } catch (err) {
        if (abort.signal.aborted) return; // deliberate stop/detach — expected
        console.warn(
          "[TRADE-RELAY] upstream SSE error:",
          err instanceof Error ? err.message : err,
        );
      }
      const still = subs.get(userId);
      if (!still || still.abort !== abort) return; // unsubscribed mid-flight
      await new Promise((resolve) => setTimeout(resolve, 5000)); // backoff retry
    }
  }

  /** Read one upstream SSE stream to completion, emitting coalesced frames. */
  async function consumeSse(body: ReadableStream<Uint8Array>, userId: string): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const evt = parseSseEvent(block);
        // aura-backend emits `event: change` with the advisory JSON payload.
        if (!evt || evt.event !== "change") continue;
        const payload = safeJson(evt.data);
        if (!payload || payload.type !== "change" || payload.table !== "trades") continue;
        // Authorization boundary (defense in depth): the bus tags every change
        // with its owning user. This stream is fetched with OUR validated token
        // and aura-backend already filters server-side, but never relay an event
        // that *claims* a different owner — a foreign userId here means the
        // upstream is broken or hostile. (Covered by the P3-C auth boundary test.)
        if (typeof payload.userId === "string" && payload.userId !== userId) continue;
        // ROUTING KEY IS OUR VALIDATED userId — never the upstream payload's
        // (the socket fan-out trusts only the session we verified ourselves).
        const frame: TradeEventFrame = {
          type: "trade",
          table: "trades",
          action: typeof payload.action === "string" ? payload.action : "unknown",
          accountId: typeof payload.accountId === "string" ? payload.accountId : null,
          userId,
          at: typeof payload.at === "string" ? payload.at : null,
        };
        scheduleRefresh(userId, frame.accountId, frame);
      }
    }
  }

  /** Handle one client {type:"auth",token} frame — validates, then subscribes. */
  async function handleAuthFrame(ws: WsLike, raw: unknown): Promise<void> {
    const msg = safeJson(String(raw));
    if (!msg || msg.type !== "auth" || typeof msg.token !== "string" || msg.token === "") {
      return; // not an auth frame — ignore (market-data frames never arrive here)
    }
    const token = msg.token;
    try {
      // EXISTING P2 session authority — the same call every /api/trading/* proxy
      // request relies on. A token that cannot be validated subscribes to nothing.
      const session = await dashboardClient.getSession(token);
      const userId = session?.user?.id;
      if (!userId) throw new Error("session resolved without a user id");
      const previous = clients.get(ws);
      if (previous) {
        // Re-auth on the same socket: drop the old user's ref first.
        clients.delete(ws);
        unsubscribe(previous.userId);
      }
      clients.set(ws, { ws, userId, token });
      subscribe(userId, token);
      try {
        ws.send(JSON.stringify({ type: "tradeAuth", ok: true }));
      } catch {
        /* socket died mid-ack — close handler cleans up */
      }
    } catch {
      // Invalid/expired token: explicitly NOT authenticated — no trade frames.
      try {
        ws.send(JSON.stringify({ type: "tradeAuth", ok: false }));
      } catch {
        /* ignore */
      }
    }
  }

  function attach(ws: WsLike): void {
    // Additive listener only — the /ws registry and its candle flow are untouched.
    ws.on("message", handleAuthFrame.bind(null, ws));
  }

  function detach(ws: WsLike): void {
    const client = clients.get(ws);
    if (!client) return;
    clients.delete(ws);
    unsubscribe(client.userId);
  }

  function stop(): void {
    for (const sub of subs.values()) sub.abort.abort();
    subs.clear();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    lastFrame.clear();
    clients.clear();
  }

  return {
    attach,
    detach,
    stop,
    subscriptionCount: () => subs.size,
    authedClientCount: () => clients.size,
  };
}
