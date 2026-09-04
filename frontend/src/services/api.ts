import type { Candle, CandlesResponse } from "../types/candle";

/**
 * Talks ONLY to our Hono backend (`/api/...`, proxied by Vite). The browser
 * never contacts IG directly and never holds IG credentials.
 */
export const API_BASE = "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Shared error-body parsing for non-OK backend responses. */
async function toApiError(res: Response): Promise<ApiError> {
  let message = res.statusText || "Request failed";
  let code = "HTTP_ERROR";
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (body?.error) message = body.error;
    if (body?.code) code = body.code;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, code, message);
}

export async function fetchCandles(
  resolution: string,
  limit = 500,
): Promise<CandlesResponse> {
  const qs = new URLSearchParams({ resolution, limit: String(limit) });
  const res = await fetch(`${API_BASE}/candles?${qs.toString()}`);

  if (!res.ok) {
    throw await toApiError(res);
  }

  return (await res.json()) as CandlesResponse;
}

/** One persisted candle row from our Supabase table (backend `/api/candles/db`). */
interface DbCandleDto {
  /** Bucket START in epoch SECONDS (absolute UTC — epoch math is timezone-free). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number | null;
}

interface DbCandlesResponse {
  epic: string;
  timeframe: string;
  count: number;
  candles: DbCandleDto[];
}

/**
 * Chart history from OUR Supabase persistence — the normal page-load source
 * (`GET /api/candles/db`). Never touches IG historical REST, so IG 429/403
 * allowance errors cannot affect chart history. `fetchCandles` (IG REST) is
 * kept for a future bootstrap/backfill role only.
 *
 * Phase 3: `epic` selects the instrument (validated server-side against
 * GET /api/instruments). Omitted → the backend default (DAX — historic
 * behavior).
 *
 * Returns candles ASCENDING with `ts` = bucket start in epoch ms — the exact
 * same time base as the realtime WS frames, so the live candle merges into /
 * appends after the newest persisted bucket with no duplicates.
 */
export async function fetchCandlesDb(
  timeframe: string,
  limit = 500,
  epic?: string,
): Promise<{ epic: string; candles: Candle[] }> {
  const qs = new URLSearchParams({ timeframe, limit: String(limit) });
  if (epic) qs.set("epic", epic);
  const res = await fetch(`${API_BASE}/candles/db?${qs.toString()}`);

  if (!res.ok) {
    throw await toApiError(res);
  }

  const body = (await res.json()) as DbCandlesResponse;
  return {
    epic: body.epic,
    candles: body.candles.map((c) => ({
      ts: c.time * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
  };
}

export async function fetchHealth(): Promise<{ ok: boolean; configured: boolean; environment: string }> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) return { ok: false, configured: false, environment: "unknown" };
  return (await res.json()) as { ok: boolean; configured: boolean; environment: string };
}
