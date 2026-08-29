/**
 * Typed API errors that map to SAFE public HTTP responses.
 *
 * Contract:
 *  - The HTTP body NEVER contains credentials, tokens, or raw upstream payloads.
 *  - The HTTP body carries a stable machine `code` plus a fixed human `error`.
 *  - Raw IG errorCodes are attached internally (`igErrorCode`) and written to
 *    SERVER-side diagnostics only (one log line per error, no secrets).
 */
export type IgErrorKind =
  | "not_configured"
  | "auth"
  | "session_expired"
  | "invalid_epic"
  | "invalid_resolution"
  | "rate_limit"
  | "network"
  | "upstream"
  | "malformed"
  | "internal";

export class IgApiError extends Error {
  constructor(
    public readonly kind: IgErrorKind,
    public readonly status: number,
    /** Sanitized human message — must be secret-free before reaching here. */
    message: string,
    /** Raw IG errorCode (e.g. error.security.invalid-details). Diagnostics only. */
    public readonly igErrorCode?: string,
  ) {
    super(message);
    this.name = "IgApiError";
  }
}

/** Server-side structured diagnostics — never printed to the HTTP response. */
function logDiagnostic(err: IgApiError): void {
  const extra = [
    `kind=${err.kind}`,
    err.igErrorCode ? `ig=${err.igErrorCode}` : "",
    process.env.NODE_ENV === "test" ? "" : `at=${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join(" ");
  // Single choke point: every router funnels failures through toHttpError().
  console.error(`[ig] ${extra}`);
}

/** Maps an error kind to a SAFE public {error, code} pair for the client. */
export function toHttpError(err: unknown): { status: number; code: string; error: string } {
  if (err instanceof IgApiError) {
    logDiagnostic(err);
    switch (err.kind) {
      case "not_configured":
        return { status: 500, code: "IG_NOT_CONFIGURED", error: "Server-side configuration incomplete." };
      case "auth": {
        const coolingDown = err.status === 503;
        return {
          status: err.status,
          code: coolingDown ? "IG_AUTH_COOLDOWN" : "IG_AUTH_FAILED",
          error: "IG authentication failed",
        };
      }
      case "session_expired":
        return { status: 502, code: "IG_AUTH_FAILED", error: "IG authentication failed" };
      case "invalid_epic":
        return { status: 404, code: "IG_EPIC_NOT_FOUND", error: "Unknown instrument EPIC" };
      case "invalid_resolution":
        return { status: 400, code: "INVALID_RESOLUTION", error: "Unsupported timeframe/resolution" };
      case "rate_limit": {
        const allowance = err.igErrorCode?.includes("allowance") ?? false;
        return {
          status: 429,
          code: allowance ? "IG_ALLOWANCE_EXHAUSTED" : "IG_RATE_LIMITED",
          error: allowance
            ? "IG historical data allowance exhausted — resets daily"
            : "Market data rate limit reached",
        };
      }
      case "network":
        return { status: 502, code: "IG_UNREACHABLE", error: "Market data provider unreachable" };
      case "upstream":
        return { status: 502, code: "IG_UPSTREAM_ERROR", error: "Upstream market data error" };
      case "malformed":
        return { status: 502, code: "IG_UPSTREAM_ERROR", error: "Malformed market data response" };
      default:
        return { status: 500, code: "INTERNAL", error: "Internal API error" };
    }
  }
  return { status: 500, code: "INTERNAL", error: "Internal API error" };
}
