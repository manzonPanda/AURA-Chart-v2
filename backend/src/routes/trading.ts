import { Hono } from "hono";
import { DashboardClient, DashboardApiError } from "../services/dashboardClient.js";
import { createMt5AccountReader } from "../services/mt5Account.js";
import type { Mt5AccountIdentity } from "../services/mt5Account.js";

/**
 * GET /api/trading/* — same-origin proxy to the Trading Dashboard's P1
 * read-only trading API (P2 boundary phase).
 *
 * The browser reaches trading data ONLY through these routes; the Dashboard
 * URL, PostgreSQL and any direct MT5/Socket.IO path stay server-side. The
 * caller's Bearer token is extracted from the Authorization header (NEVER
 * accepted from a query parameter) and forwarded opaquely — this backend
 * neither validates nor stores it; the Dashboard's session auth + P1
 * account-ownership layer remain the single security boundary.
 *
 * Allowlist: exactly four fixed GET paths. There is deliberately NO generic
 * /api/proxy/* — a browser-supplied upstream path can never be constructed.
 * Only the five allowlisted trades query params are forwarded; everything
 * else in the query string is dropped. Upstream HTTP error semantics
 * (401/403/400/500) are preserved; upstream outage maps to 502/504.
 * Tokens are never logged.
 *
 * P3-D adds exactly ONE path: GET /trading/mt5/account. It is read-only, takes
 * no parameters, validates the caller's session upstream (so a forged token
 * cannot probe MT5 state), and returns a display-safe identity read
 * server-side from the EXISTING local pythonMt5 bridge endpoint. The bridge
 * URL never reaches the browser and no new transport is introduced.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract the Bearer token from the Authorization header (header-only). */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/** Allowlisted trades query params — anything else is dropped, never forwarded. */
const TRADES_QUERY_ALLOWLIST = ["from", "to", "instrument", "status", "limit"] as const;

export function createTradingRouter(
  client: DashboardClient,
  /** P3-D: injectable so tests never touch a real local MT5 bridge. */
  readMt5Identity: () => Promise<Mt5AccountIdentity> = createMt5AccountReader(),
): Hono {
  const app = new Hono();

  /** Shared handler wrapper: token gate + upstream error normalisation. */
  const withAuth = (
    handler: (c: { req: any; json: any }, token: string) => Promise<Response>,
  ) =>
    (c: any) => {
      const token = extractBearer(c.req.header("Authorization"));
      if (!token) {
        return c.json({ error: "Missing authorization token." }, 401);
      }
      return handler(c, token).catch((err: unknown) => {
        if (err instanceof DashboardApiError) {
          // Upstream status preserved (401/403/400/500); 502/504 are this
          // client's outage normalisations. Messages are fixed text — no
          // tokens, no upstream internals, no base URL.
          return c.json({ error: err.message }, err.status as any);
        }
        // Unknown failure: fixed 502, details logged WITHOUT any header data.
        console.error("[trading proxy] unexpected error:", err instanceof Error ? err.message : err);
        return c.json({ error: "Trading data request failed." }, 502);
      });
    };

  // A — account selector list (only the caller's own accounts upstream).
  app.get(
    "/trading/accounts",
    withAuth(async (c, token) => {
      const data = await client.listAccounts(token);
      return c.json(data);
    }),
  );

  // B — historical + open trades for ONE account. Path param is a strictly
  // validated UUID (malformed ⇒ 400 here, before any upstream call); only
  // allowlisted query params are forwarded.
  app.get(
    "/trading/accounts/:accountId/trades",
    withAuth(async (c, token) => {
      const accountId = c.req.param("accountId");
      if (!UUID_RE.test(accountId)) {
        return c.json({ error: "accountId must be a UUID." }, 400);
      }
      const forwarded = new URLSearchParams();
      for (const key of TRADES_QUERY_ALLOWLIST) {
        const value = c.req.query(key);
        if (value !== undefined && value !== "") forwarded.set(key, value);
      }
      const data = await client.listTrades(
        token,
        accountId,
        Object.fromEntries(forwarded) as Record<string, string>,
      );
      return c.json(data);
    }),
  );

  // C — account state (config/limits now; live MT5 money arrives in a later phase).
  app.get(
    "/trading/accounts/:accountId/state",
    withAuth(async (c, token) => {
      const accountId = c.req.param("accountId");
      if (!UUID_RE.test(accountId)) {
        return c.json({ error: "accountId must be a UUID." }, 400);
      }
      const data = await client.getAccountState(token, accountId);
      return c.json(data);
    }),
  );

  // D — (P3-D) MT5 account identity of the LOCAL terminal, so the UI can show
  // MATCH/MISMATCH against the selected dashboard account. Read-only; the
  // session is validated upstream FIRST (a forged token never reaches the
  // bridge). No query params are read. The payload is display-safe only.
  app.get(
    "/trading/mt5/account",
    withAuth(async (c, token) => {
      await client.getSession(token);
      const account = await readMt5Identity();
      return c.json({ account });
    }),
  );

  return app;
}
