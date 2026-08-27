import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { isConfigured, loadConfig } from "./config.js";
import { IgClient } from "./ig/client.js";
import { createCandlesRouter } from "./routes/candles.js";
import { createMarketsRouter } from "./routes/markets.js";

const config = loadConfig();
const ig = new IgClient({
  apiKey: config.ig.apiKey,
  username: config.ig.username,
  password: config.ig.password,
  accountId: config.ig.accountId,
  baseUrl: config.ig.baseUrl,
  sessionVersion: config.ig.sessionVersion,
  sendEncryptFlag: config.ig.sendEncryptFlag,
});

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

app.onError((err, c) => {
  // Log upstream details server-side but NEVER include secrets/tokens.
  console.error("[api] unhandled error:", err);
  return c.json({ error: "Internal server error", code: "INTERNAL" }, 500);
});

const port = config.port;
serve({ fetch: app.fetch, port, hostname: config.host }, (info) => {
  console.log(`\n  IG chart API ready  ->  http://localhost:${info.port}/api/health`);
  console.log(`  environment         ->  ${config.ig.baseUrl.includes("demo") ? "demo" : "live"}`);
  if (!isConfigured(config)) {
    console.log("  credentials         ->  MISSING (see backend/.env)");
  } else if (!config.ig.defaultEpic) {
    console.log("  default epic        ->  unset (pass ?epic= or set IG_DAX_EPIC)");
  }
});
