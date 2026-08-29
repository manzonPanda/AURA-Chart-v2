import { Hono } from "hono";
import type { IgClient } from "../ig/client.js";
import { toHttpError } from "../ig/errors.js";
import { fetchHistoricalCandles } from "../ig/historical.js";
import { CHART_RESOLUTIONS } from "../ig/types.js";

/**
 * GET /api/candles?epic=<EPIC>&resolution=<CHART_RESOLUTION>&limit=<1..500>
 *
 * `resolution` is an INTERNAL chart resolution — only `MINUTE` (native 1m) and
 * `MINUTE_3` (backend-aggregated 3m from 1m) are accepted. IG-specific
 * implementation details never leak to the UI; MINUTE_3 is produced server-side
 * from 1-minute IG data, never requested from IG.
 */
export function createCandlesRouter(ig: IgClient, defaultEpic: string): Hono {
  const app = new Hono();

  app.get("/candles", async (c) => {
    const epic = (c.req.query("epic") ?? "").trim() || defaultEpic.trim();
    if (!epic) {
      return c.json(
        {
          error: "No instrument EPIC configured — set IG_DAX_EPIC or pass an `epic` query parameter.",
          code: "EPIC_MISSING",
        },
        400,
      );
    }

    const resolution = (c.req.query("resolution") ?? "").trim().toUpperCase();
    const supported = CHART_RESOLUTIONS as readonly string[];
    if (!supported.includes(resolution)) {
      return c.json(
        {
          error: `Invalid resolution "${resolution}". Supported: ${supported.join(", ")}`,
          code: "INVALID_RESOLUTION",
        },
        400,
      );
    }

    const parsedLimit = Number(c.req.query("limit"));
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 500;

    try {
      const candles = await fetchHistoricalCandles(ig, { epic, resolution, limit });
      return c.json({ epic, resolution, count: candles.length, candles });
    } catch (err) {
      const { status, code, error } = toHttpError(err);
      return c.json({ error, code }, status as 200 | 400 | 404 | 429 | 500 | 502 | 503);
    }
  });

  return app;
}