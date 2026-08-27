import { Hono } from "hono";
import type { IgClient } from "../ig/client.js";
import { toHttpError } from "../ig/errors.js";
import { getIGMarketDetails, searchIGMarkets } from "../ig/market.js";

/**
 * Market discovery endpoints (backend-only; the frontend still never talks to
 * IG directly).
 *
 *   GET /api/markets?q=<searchTerm>  -> search instruments by name
 *   GET /api/market/:epic            -> full market + instrument + snapshot
 */
export function createMarketsRouter(ig: IgClient): Hono {
  const app = new Hono();

  app.get("/markets", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) {
      return c.json({ error: "Missing `q` search term.", code: "MISSING_QUERY" }, 400);
    }
    try {
      const result = await searchIGMarkets(ig, q);
      const markets = (result.markets ?? []).map((m) => ({
        epic: m.epic ?? "",
        instrumentName: m.instrumentName ?? "",
        instrumentType: m.instrumentType ?? "",
        marketStatus: m.marketStatus ?? "",
        expiry: m.expiry ?? null,
        currency: m.currency ?? null,
      }));
      return c.json({ query: q, count: markets.length, markets });
    } catch (err) {
      const { status, code, error } = toHttpError(err);
      return c.json({ error, code }, status as 200 | 400 | 404 | 429 | 500 | 502 | 503);
    }
  });

  app.get("/market/:epic", async (c) => {
    const epic = c.req.param("epic");
    try {
      const d = await getIGMarketDetails(ig, epic);
      return c.json({
        epic,
        instrument: d.instrument,
        market: d.market,
        snapshot: d.snapshot,
      });
    } catch (err) {
      const { status, code, error } = toHttpError(err);
      return c.json({ error, code }, status as 200 | 400 | 404 | 429 | 500 | 502 | 503);
    }
  });

  return app;
}