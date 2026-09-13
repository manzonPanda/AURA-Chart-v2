import type { Server as HttpServer } from "node:http";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { isCapitalConfigured, loadConfig } from "./config.js";
import { CapitalClient } from "./capital/client.js";
import { CandleStore, CandleBackend, PgCandleStore, SupabaseCandleStore } from "./db/candleStore.js";
import { createSupabaseAdmin } from "./db/supabaseClient.js";
import { getPgPool, pgEnvSummary, pgSecrets } from "./db/pgPool.js";
import { EmaAlertEngine } from "./emaAlert/emaAlertEngine.js";
import { PushService } from "./emaAlert/pushService.js";
import { EmaAlertSettingsStore } from "./emaAlert/settingsStore.js";
import { defaultEmaAlertSettings, sanitizeEmaAlertSettings } from "./emaAlert/emaAlertConfig.js";
import { installLifecycle } from "./lib/lifecycle.js";
import { SecretRedactor } from "./lib/redact.js";
import {
  GOLD_INSTRUMENT,
  configuredInstruments,
  uiInstruments,
} from "./market/instruments.js";
import { createCandlesDbRouter } from "./routes/candlesDb.js";
import { createEmaAlertRouter } from "./routes/emaAlert.js";
import { createInstrumentsRouter } from "./routes/instruments.js";
import { RESOLUTION_BUCKET_SEC, createRealtime, redactEpic } from "./realtime.js";

const config = loadConfig();

/**
 * Completed-candle persistence. Preference order for v1:
 *   1. Local Oracle PostgreSQL (`aura` DB, localhost:5432) — the new canonical
 *      market-data store, read from /etc/aura/postgres.env (never logged).
 *   2. Supabase (service-role) — kept as a read-only fallback shim only; live
 *      writes now go to PostgreSQL. Supabase data is NOT migrated or copied.
 *
 * Null when NEITHER is configured — backend runs with live candles delivered
 * over WS only (no persistence), exactly as before.
 * Persistence is strictly downstream of the realtime path and can never affect
 * the Capital stream or the chart.
 */
const pgPool = getPgPool();
const supabaseAdmin = pgPool ? null : createSupabaseAdmin(config.supabase);
let candleStore: CandleBackend | null = null;
if (pgPool) {
  candleStore = new PgCandleStore(pgPool, config.supabase.table);
  console.log(
    `  [DB] PostgreSQL candle persistence ENABLED -> localhost:${pgEnvSummary().port}/${pgEnvSummary().database}` +
      ` as ${pgEnvSummary().user} (table=${config.supabase.table}; MINUTE_1 canonical,` +
      ` MINUTE_3 derived on read; no Supabase data copied).`,
  );
} else if (supabaseAdmin) {
  candleStore = new SupabaseCandleStore(supabaseAdmin, config.supabase.table);
  console.log("  [DB] Supabase candle persistence ENABLED (completed 1m candles only will be upserted; 3m is derived live + aggregated on read).");
} else {
  console.log("  [DB] No persistence configured — completed candles will NOT be persisted (set /etc/aura/postgres.env or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).");
}

/**
 * Capital.com provider client — the ONLY active market-data provider. Present
 * ONLY when Capital credentials are configured (CAPITAL_API_KEY/PASSWORD/
 * IDENTIFIER). Passed into the realtime service so CAPITAL-provider
 * instruments ("GOLD") stream through the CapitalStreamClient seam. When null,
 * NO market data is collected at all — there is deliberately NO fallback to
 * IG (retired) or any other provider. Never instantiated with unverified
 * credentials: any auth failure surfaces in the stream's own session
 * lifecycle, not here.
 */
const capitalClient = isCapitalConfigured(config) ? new CapitalClient(config.capital) : null;

/**
 * Real-time service: ONE Capital WebSocket connection PER configured CAPITAL
 * instrument ("GOLD" today). Ticks are routed by EPIC before aggregation —
 * each instrument owns fully independent aggregator state, rollovers,
 * persistence and status. instruments[0] ("GOLD") is the default:
 * snapshot()/closed-candle listeners (EMA engine) remain bound to it. Any
 * IG-provider epic cannot become active (RealtimeService refuses it).
 */
const instruments = configuredInstruments(config);
const realtime = createRealtime(instruments, candleStore, capitalClient);
const defaultEpic = GOLD_INSTRUMENT.epic;

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
    configured: isCapitalConfigured(config),
    instrumentConfigured: instruments.length > 0,
    // The configured COLLECTION set with its metadata (CAPITAL provider only).
    instruments: instruments.map((i) => ({ epic: i.epic, label: i.label, decimals: i.decimals })),
    environment: /demo/.test(config.capital.baseUrl) ? "demo" : "production",
  }),
);

// Instrument registry — the frontend's source of truth for the selector.
// The WIDER UI/HISTORICAL catalog is served (DAX + Silver remain as LEGACY
// ARCHIVE entries — queryable history only, NEVER collected), with the active
// default GOLD. The IG REST routers (GET /api/candles, /api/markets) were
// removed with the IG retirement — the chart's only history source is the
// persisted store below.
app.route(
  "/api",
  createInstrumentsRouter(
    uiInstruments(config),
    GOLD_INSTRUMENT.epic,
  ),
);
// Chart history from OUR persistence (Oracle PostgreSQL; Supabase read-only
// fallback). Instrument-aware: ?epic= validated against the UI/HISTORICAL
// catalog (archive epics remain readable); omitted → GOLD.
app.route("/api", createCandlesDbRouter(candleStore, uiInstruments(config), GOLD_INSTRUMENT.epic));

// ── EMA Reversal Alerts (server-side detection + Web Push) ──────────────────
// Runtime state lives in backend/data/*.json (gitignored) — the database is
// untouched. The engine is fed EXCLUSIVELY by COMPLETED candles from the
// realtime service (both 1m and 3m rollovers); the forming candle can never
// reach the detector. Notification generation is config-driven
// (`alertTimeframes`) and runs regardless of any browser connection.
// Runtime state directory: backend/data/ in BOTH layouts —
//   dev:  backend/src/index.ts → ../data/  → backend/data/
//   prod: backend/dist/index.js → ../data/ → backend/data/
// (gitignored; never served; the database is untouched).
const emaDataDir = fileURLToPath(new URL("../data/", import.meta.url));
const pushService = new PushService(
  config.vapid,
  `${emaDataDir}push-subscriptions.json`,
);
const emaSettingsStore = new EmaAlertSettingsStore(`${emaDataDir}ema-alert-settings.json`,
  config.emaAlertEnabledOnBoot
    ? sanitizeEmaAlertSettings({ ...defaultEmaAlertSettings(), enabled: true })
    : null,
);
const emaAlertEngine = new EmaAlertEngine({
  epic: defaultEpic, // "GOLD" — the active CAPITAL default instrument
  instrumentLabel: GOLD_INSTRUMENT.label,
  candleStore,
  push: pushService,
  store: emaSettingsStore,
  broadcast: (msg) => realtime.broadcastAuxiliary(msg),
});
// The EMA engine is bound to the DEFAULT instrument (GOLD, the only CAPITAL
// instrument collected today). RealtimeService's onClosedCandle gate follows
// the DEFAULT EPIC (instruments[0]) — IG/DAX closes can never reach it
// (IG is retired and nothing IG is ever streamed).
if (instruments.length > 0) {
  realtime.onClosedCandle((candle, timeframe) => {
    emaAlertEngine.onClosedCandle(candle, timeframe);
  });
}
// P1 reconnect seed: every newly-added WS client immediately receives the
// CURRENT alert snapshot — after a backend restart a reconnecting tab restores
// its bell state without waiting for the next closed-candle broadcast.
realtime.onClientSeed(() => ({ type: "emaAlert", state: emaAlertEngine.statusSnapshot() }));
app.route("/api", createEmaAlertRouter(emaAlertEngine));

// Streaming status. Truthful: mirrors the actual Capital stream state, not
// whether a browser socket happens to be open.
app.get("/api/stream/status", (c) => c.json(realtime.snapshot()));

app.onError((err, c) => {
  // Log upstream details server-side but NEVER include secrets/tokens.
  console.error("[api] unhandled error:", err);
  return c.json({ error: "Internal server error", code: "INTERNAL" }, 500);
});

const port = config.port;

const server = serve({ fetch: app.fetch, port, hostname: config.host }, (info) => {
  console.log(`\n  AURA API ready          ->  http://localhost:${info.port}/api/health`);
  console.log(`  realtime stream ws      ->  ws://localhost:${info.port}/ws`);
  console.log(
    `  instruments             ->  ${instruments.length ? instruments.map((i) => `${i.label} (${i.epic}, ${i.decimals}dp)`).join(" + ") : "(none — Capital not configured, no IG fallback)"}`,
  );
  console.log(`  environment             ->  ${/demo/.test(config.capital.baseUrl) ? "demo" : "production"}`);
  if (!instruments.length) {
    console.log("  market-data collection ->  OFF (set CAPITAL_* credentials; IG is retired — no fallback)");
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
  ...realtime.redactables(), // Capital key/password + live CST / X-SECURITY-TOKEN, re-read at log time
  config.supabase.serviceKey,
  ...pgSecrets(), // PostgreSQL password from /etc/aura/postgres.env
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
// on the `/ws` path. The browser socket never carries provider credentials.
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
  const epic = (url.searchParams.get("epic") || "").trim() || defaultEpic.trim();
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

// Starts the Capital WebSocket subscription when configured. The gate is the
// CONFIGURED COLLECTION set + Capital credentials. When Capital is missing the
// service runs (chart + archive reads) but collects NOTHING — there is
// deliberately no IG or other fallback.
if (capitalClient && instruments.length > 0) {
  void realtime.start();
} else {
  console.log(
    "  [STREAM] Capital market-data collection DISABLED — configure CAPITAL_API_KEY / CAPITAL_API_PASSWORD / CAPITAL_IDENTIFIER " +
      (instruments.length ? "" : "(no CAPITAL instruments registered) ") +
      ". IG is retired — no fallback provider exists.",
  );
}

// EMA alert engine: warms up from persisted 1m candles (if any), then reacts
// to every COMPLETED candle. Fully self-contained — a warm-up failure must
// never prevent the chart/stream from running.
void emaAlertEngine.start();

