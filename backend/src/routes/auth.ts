import { Hono } from "hono";
import { DashboardClient, DashboardApiError } from "../services/dashboardClient.js";

/**
 * POST /api/auth/sign-in · GET /api/auth/session · POST /api/auth/sign-out
 *
 * NARROW auth forwarder (P2): the ONLY auth surface AURA Chart exposes. The
 * browser signs in against the EXISTING Dashboard local-auth system through
 * this backend — it never talks to the Dashboard URL directly, and this
 * backend never validates or stores credentials/tokens itself (the Dashboard
 * stays the single source of authentication truth).
 *
 * Deliberately NOT a generic auth proxy: exactly these three fixed operations,
 * fixed upstream paths, no pass-through of arbitrary bodies/headers beyond the
 * JSON the Dashboard expects. Tokens are never logged and never appear in
 * URLs or query strings. Errors keep the upstream status with fixed messages.
 */

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

export function createAuthRouter(client: DashboardClient): Hono {
  const app = new Hono();

  app.post("/auth/sign-in", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "A JSON body with email and password is required." }, 400);
    }
    const email = (body as any)?.email;
    const password = (body as any)?.password;
    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
      return c.json({ error: "Email and password are required." }, 400);
    }
    try {
      const data = await client.signIn(email.trim(), password);
      // Session + user echoed as the Dashboard returns them; the token lives
      // ONLY in this response body (client-side namespaced storage) — never in
      // a URL, a query string or a log line.
      return c.json({ session: data.session, user: data.user ?? data.session.user ?? null });
    } catch (err) {
      if (err instanceof DashboardApiError) {
        return c.json({ error: err.message }, err.status as any);
      }
      console.error("[auth proxy] sign-in failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "Sign-in request failed." }, 502);
    }
  });

  app.get("/auth/session", async (c) => {
    const token = extractBearer(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Missing authorization token." }, 401);
    try {
      const data = await client.getSession(token);
      return c.json(data);
    } catch (err) {
      if (err instanceof DashboardApiError) {
        return c.json({ error: err.message }, err.status as any);
      }
      console.error("[auth proxy] session check failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "Session check failed." }, 502);
    }
  });

  app.post("/auth/sign-out", async (c) => {
    const token = extractBearer(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Missing authorization token." }, 401);
    try {
      const data = await client.signOut(token);
      return c.json(data);
    } catch (err) {
      if (err instanceof DashboardApiError) {
        return c.json({ error: err.message }, err.status as any);
      }
      console.error("[auth proxy] sign-out failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "Sign-out request failed." }, 502);
    }
  });

  return app;
}
