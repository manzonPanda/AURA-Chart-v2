import { Hono } from "hono";
import type { IgClient } from "../ig/client.js";
import { toHttpError } from "../ig/errors.js";
import { fetchHistoricalCandles } from "../ig/historical.js";
import { IG_RESOLUTIONS } from "../ig/types.js";

/**
 * GET /api/candles?epic=<EPIC>&resolution=<IG_RESOLUTION>&limit=<1..500>
 *
 * `epic` is optional — when omitted the backend uses the configured
 * `IG_DAX_EPIC`. `resolution` is required and must be a supported IG
 * resolution (MINUTE, MINUTE_5, MINUTE_15, HOUR, HOUR_4, DAY, ...).
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
    const supported = IG_RESOLUTIONS as readonly string[];
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