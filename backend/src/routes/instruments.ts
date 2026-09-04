import { Hono } from "hono";
import type { InstrumentMeta } from "../market/instruments.js";

/**
 * GET /api/instruments — the frontend's source of truth for the instrument
 * selector. Lists the CONFIGURED instruments (registry metadata: label,
 * quoting precision, market calendar) and which EPIC is the default. The
 * frontend never hardcodes EPICs; it reads them from here.
 */
export function createInstrumentsRouter(
  instruments: readonly InstrumentMeta[],
  defaultEpic: string,
): Hono {
  const app = new Hono();

  app.get("/instruments", (c) =>
    c.json({
      defaultEpic: defaultEpic.trim(),
      count: instruments.length,
      instruments: instruments.map((m) => ({
        epic: m.epic,
        label: m.label,
        decimals: m.decimals,
        calendar: m.calendar
          ? { id: m.calendar.id, label: m.calendar.label, timezone: m.calendar.timezone }
          : null,
      })),
    }),
  );

  return app;
}