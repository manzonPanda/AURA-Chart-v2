import { Hono } from "hono";
import type { EmaAlertEngine } from "../emaAlert/emaAlertEngine.js";
import type { PushSubscriptionShape } from "../emaAlert/pushService.js";

/**
 * EMA Reversal Alert REST endpoints (backend-only configuration surface).
 *
 *   GET  /api/ema-alert                     → settings + live engine state
 *   POST /api/ema-alert/settings            → patch settings (applies live)
 *   GET  /api/ema-alert/push/public-key     → VAPID public key for subscribe
 *   POST /api/ema-alert/push/subscribe      → store a browser push subscription
 *   POST /api/ema-alert/push/unsubscribe    → remove a subscription by endpoint
 *   POST /api/ema-alert/push/test           → one test notification (no secrets)
 *
 * SAFETY: responses never include subscription tokens, endpoints or keys.
 */
export function createEmaAlertRouter(engine: EmaAlertEngine): Hono {
  const app = new Hono();

  app.get("/ema-alert", (c) => c.json({ settings: engine.getSettings(), state: engine.statusSnapshot() }));

  app.post("/ema-alert/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be JSON.", code: "INVALID_JSON" }, 400);
    }
    const settings = await engine.applySettings(body);
    return c.json({ settings, state: engine.statusSnapshot() });
  });

  app.get("/ema-alert/push/public-key", (c) => {
    const key = engine.statusSnapshot().pushConfigured ? engine.vapidPublicKey() : null;
    return c.json({ configured: Boolean(key), publicKey: key });
  });

  app.post("/ema-alert/push/subscribe", async (c) => {
    let body: { subscription?: PushSubscriptionShape };
    try {
      body = (await c.req.json()) as { subscription?: PushSubscriptionShape };
    } catch {
      return c.json({ error: "Request body must be JSON.", code: "INVALID_JSON" }, 400);
    }
    const sub = body.subscription;
    if (
      !sub ||
      typeof sub.endpoint !== "string" ||
      !sub.endpoint.startsWith("https://") ||
      !sub.keys ||
      typeof sub.keys.p256dh !== "string" ||
      typeof sub.keys.auth !== "string"
    ) {
      return c.json({ error: "Invalid push subscription shape.", code: "INVALID_SUBSCRIPTION" }, 400);
    }
    engine.subscribePush(sub);
    return c.json({ ok: true, count: engine.statusSnapshot().pushSubscriptions });
  });

  app.post("/ema-alert/push/unsubscribe", async (c) => {
    let body: { endpoint?: string };
    try {
      body = (await c.req.json()) as { endpoint?: string };
    } catch {
      return c.json({ error: "Request body must be JSON.", code: "INVALID_JSON" }, 400);
    }
    if (typeof body.endpoint !== "string") {
      return c.json({ error: "Missing endpoint.", code: "MISSING_ENDPOINT" }, 400);
    }
    engine.unsubscribePush(body.endpoint);
    return c.json({ ok: true, count: engine.statusSnapshot().pushSubscriptions });
  });

  app.post("/ema-alert/push/test", async (c) => {
    const result = await engine.sendTestNotification();
    return c.json(result);
  });

  return app;
}
