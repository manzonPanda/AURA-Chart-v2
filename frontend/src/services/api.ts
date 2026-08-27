import type { CandlesResponse } from "../types/candle";

/**
 * Talks ONLY to our Hono backend (`/api/...`, proxied by Vite). The browser
 * never contacts IG directly and never holds IG credentials.
 */
const API_BASE = "/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function fetchCandles(
  resolution: string,
  limit = 500,
): Promise<CandlesResponse> {
  const qs = new URLSearchParams({ resolution, limit: String(limit) });
  const res = await fetch(`${API_BASE}/candles?${qs.toString()}`);

  if (!res.ok) {
    let message = res.statusText || "Request failed";
    let code = "HTTP_ERROR";
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) message = body.error;
      if (body?.code) code = body.code;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }

  return (await res.json()) as CandlesResponse;
}

export async function fetchHealth(): Promise<{ ok: boolean; configured: boolean; environment: string }> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) return { ok: false, configured: false, environment: "unknown" };
  return (await res.json()) as { ok: boolean; configured: boolean; environment: string };
}
