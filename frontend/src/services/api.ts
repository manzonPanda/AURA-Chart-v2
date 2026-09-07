import type { Candle, CandlesResponse, CandleGap } from "../types/candle";
import { HISTORY_LIMIT } from "../config/chart.ts";

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
  /** True when the raw DB page came back full → older rows may still exist. */
  hasMore?: boolean;
  candles: DbCandleDto[];
  /** Detected market-data gaps (epoch-ms) — derived from the calendar + loaded candles. */
  gaps?: { start: number; end: number }[];
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
 * Incremental pagination: `beforeSec` (epoch SECONDS, optional) is the
 * "Load More History" cursor — the backend returns only candles STRICTLY
 * older than it. `hasMore` reports whether older rows may still exist
 * (backend: the raw page came back full).
 *
 * Returns candles ASCENDING with `ts` = bucket start in epoch ms — the exact
 * same time base as the realtime WS frames, so the live candle merges into /
 * appends after the newest persisted bucket with no duplicates.
 */
export async function fetchCandlesDb(
  timeframe: string,
  limit = HISTORY_LIMIT,
  epic?: string,
  beforeSec?: number,
): Promise<{ epic: string; candles: Candle[]; hasMore: boolean; gaps: CandleGap[] }> {
  const qs = new URLSearchParams({ timeframe, limit: String(limit) });
  if (epic) qs.set("epic", epic);
  if (beforeSec !== undefined) qs.set("before", String(Math.floor(beforeSec)));
  const res = await fetch(`${API_BASE}/candles/db?${qs.toString()}`);

  if (!res.ok) {
    throw await toApiError(res);
  }

  const body = (await res.json()) as DbCandlesResponse;
    return {
    epic: body.epic,
    // Older backend builds don't send hasMore — approximate with page-fullness.
    hasMore: body.hasMore ?? body.candles.length >= limit,
    candles: body.candles.map((c) => ({
      ts: c.time * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
    gaps: (body.gaps ?? []).map((g) => ({
      instrument: body.epic,
      timeframe: body.timeframe,
      startTime: g.start,
      endTime: g.end,
      reason: "broker_gap" as const,
    })),
  };
}

/**
 * Fetches detected market-data gaps for the given instrument/timeframe.
 * Calls the backend's `/api/candles/db/gaps` endpoint which uses the existing
 * `detectGaps` logic + market calendar to classify expected buckets as missing.
 *
 * Returns gaps only for periods that should have had candles (i.e. market was
 * open). Weekend/closed-session gaps are excluded by the calendar.
 */
export async function fetchGaps(
  timeframe: string,
  epic?: string,
  hours?: number,
): Promise<CandleGap[]> {
  const qs = new URLSearchParams({ timeframe });
  if (epic) qs.set("epic", epic);
  if (hours) qs.set("hours", String(hours));
  const res = await fetch(`${API_BASE}/candles/db/gaps?${qs.toString()}`);
  if (!res.ok) {
    // Gaps are best-effort — if the endpoint fails, return empty (no crash).
    return [];
  }
  const body = (await res.json()) as {
    epic: string;
    timeframe: string;
    bucketSec: number;
    missing?: string[]; // ISO timestamps of missing bucket starts
    partial?: string[];
  };
  const bucketSec = body.bucketSec ?? 60;
  return (body.missing ?? []).map((iso) => ({
    instrument: body.epic,
    timeframe: body.timeframe,
    startTime: Date.parse(iso) /* epoch-ms */,
    endTime: Date.parse(iso) + bucketSec * 1000,
    reason: "broker_gap",
  }));
}

export async function fetchHealth(): Promise<{ ok: boolean; configured: boolean; environment: string }> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) return { ok: false, configured: false, environment: "unknown" };
  return (await res.json()) as { ok: boolean; configured: boolean; environment: string };
}
