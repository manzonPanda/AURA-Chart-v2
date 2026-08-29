import type { Server as HttpServer } from "node:http";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { isConfigured, loadConfig } from "./config.js";
import { CandleStore } from "./db/candleStore.js";
import { createSupabaseAdmin } from "./db/supabaseClient.js";
import { IgClient } from "./ig/client.js";
import { installLifecycle } from "./lib/lifecycle.js";
import { SecretRedactor } from "./lib/redact.js";
import { createCandlesDbRouter } from "./routes/candlesDb.js";
import { createCandlesRouter } from "./routes/candles.js";
import { createMarketsRouter } from "./routes/markets.js";
import { RESOLUTION_BUCKET_SEC, createRealtime, redactEpic } from "./realtime.js";

const config = loadConfig();

/**
 * Completed-candle persistence (Supabase). Null when SUPABASE_URL/SERVICE_KEY
 * are unset — in that case the backend runs exactly as before, minus DB saves.
 * Persistence is strictly downstream of the realtime path and can never
 * affect the IG stream or the chart.
 */
const supabaseAdmin = createSupabaseAdmin(config.supabase);
const candleStore = supabaseAdmin ? new CandleStore(supabaseAdmin, config.supabase.table) : null;
if (candleStore) {
  console.log("  [DB] Supabase candle persistence ENABLED (completed 3m candles will be upserted).");
} else {
  console.log("  [DB] Supabase not configured — completed candles will NOT be persisted (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).");
}

const ig = new IgClient({
  apiKey: config.ig.apiKey,
  username: config.ig.username,
  password: config.ig.password,
  accountId: config.ig.accountId,
  baseUrl: config.ig.baseUrl,
  sessionVersion: config.ig.sessionVersion,
  sendEncryptFlag: config.ig.sendEncryptFlag,
});

/** Shared real-time service: one IG Lightstreamer connection + aggregators. */
const realtime = createRealtime(ig, config.ig.defaultEpic, candleStore);

const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  }),
);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    configured: isConfigured(config),
    instrumentConfigured: Boolean(config.ig.defaultEpic),
    environment: config.ig.baseUrl.includes("demo") ? "demo" : "live",
  }),
);

app.route("/api", createCandlesRouter(ig, config.ig.defaultEpic));
app.route("/api", createMarketsRouter(ig));
// Chart history from OUR persistence — frontend's normal history source; IG
// REST stays a bootstrap/backfill source only (its 429/403 allowance errors
// can never affect this endpoint).
app.route("/api", createCandlesDbRouter(candleStore, config.ig.defaultEpic));

// Streaming status. Truthful: mirrors the actual IG Lightstreamer state, not
// whether a browser socket happens to be open.
app.get("/api/stream/status", (c) => c.json(realtime.snapshot()));

app.onError((err, c) => {
  // Log upstream details server-side but NEVER include secrets/tokens.
  console.error("[api] unhandled error:", err);
  return c.json({ error: "Internal server error", code: "INTERNAL" }, 500);
});

const port = config.port;

const server = serve({ fetch: app.fetch, port, hostname: config.host }, (info) => {
  console.log(`\n  IG chart API ready      ->  http://localhost:${info.port}/api/health`);
  console.log(`  realtime stream ws      ->  ws://localhost:${info.port}/ws`);
  console.log(`  environment             ->  ${config.ig.baseUrl.includes("demo") ? "demo" : "live"}`);
  if (!isConfigured(config)) {
    console.log("  credentials             ->  MISSING (see backend/.env)");
  } else if (!config.ig.defaultEpic) {
    console.log("  streaming epic          ->  unset (set IG_DAX_EPIC)");
  }
});

// ── Production hardening: graceful shutdown + fatal-error guards ────────────
// Render sends SIGTERM on every deploy/restart. On SIGTERM: disconnect
// Lightstreamer, permanently stop reconnect/heartbeat timers, close the WS
// relay + HTTP server, exit 0. On uncaughtException/unhandledRejection: log
// with every secret redacted, then exit 1 so the platform restarts the
// process instead of leaving it in an unknown state. Nothing here touches
// aggregation, MID math, bucket math, persistence or the frontend.
const redactor = new SecretRedactor(() => [
  config.ig.apiKey,
  config.ig.password,
  ...realtime.redactables(), // live CST / X-SECURITY-TOKEN, re-read at log time
  config.supabase.serviceKey,
]);

const lifecycle = installLifecycle({
  redactor,
  stopRealtime: () => realtime.stop(),
  closeWebSocketServer: () => wss.close(),
  closeHttpServer: (onClosed) => {
    // serve() returns a plain node:http Server here (no http2 options used).
    const httpServer = server as HttpServer;
    httpServer.closeIdleConnections(); // drop idle keep-alives now
    httpServer.close(onClosed); // stop accepting, drain active requests
  },
});

// Attach a WebSocket relay to the SAME HTTP server that serves the REST API,
// on the `/ws` path. The browser socket never carries IG credentials.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  // Shutdown in progress: accept no new relay sockets — the closing HTTP
  // server can still see an upgrade request arrive during tear-down.
  if (lifecycle.isShuttingDown()) {
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const epic = (url.searchParams.get("epic") || "").trim() || config.ig.defaultEpic.trim();
  const res = (url.searchParams.get("res") || "").toUpperCase();

  if (!epic) {
    ws.send(JSON.stringify({ type: "error", code: "EPIC_MISSING", error: "Streaming epic is not configured." }));
    ws.close();
    return;
  }
  if (!(res in RESOLUTION_BUCKET_SEC)) {
    ws.send(
      JSON.stringify({
        type: "error",
        code: "INVALID_RESOLUTION",
        error: `Unsupported timeframe resolution: "${res}".`,
      }),
    );
    ws.close();
    return;
  }

  console.log(`[WS] socket connected res=${res} epic=${redactEpic(epic)}`);
  realtime.addClient(ws, epic, res);

  ws.on("close", () => {
    realtime.removeClient(ws);
  });
  ws.on("error", () => realtime.removeClient(ws));
});

// Starts the IG Lightstreamer subscription when configured (the service also
// self-heals on IG disconnects / token expiry without racing auth retries).
if (isConfigured(config) && config.ig.defaultEpic) {
  void realtime.start();
} else {
  console.log("  [IG] streaming disabled — configure IG_DAX_EPIC + credentials to stream.");
}
