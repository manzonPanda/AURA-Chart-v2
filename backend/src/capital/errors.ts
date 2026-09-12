/**
 * Typed Capital.com API errors that map to SAFE public HTTP responses.
 *
 * Contract (mirrors the proven ig/errors.ts seam):
 *  - The HTTP body NEVER contains credentials, tokens, or raw upstream payloads.
 *  - The HTTP body carries a stable machine `code` plus a fixed human `error`.
 *  - Raw Capital.com errorCodes ride along internally (`capitalErrorCode`) and
 *    are written to SERVER-side diagnostics only (one log line per error, no
 *    secrets — never an API key, password, CST or X-SECURITY-TOKEN).
 *
 * This module is ISOLATED from ig/errors.ts on purpose: the IG module stays
 * untouched until the DAX decision (Phase 11), and both providers can coexist.
 */
export type CapitalErrorKind =
  | "not_configured"
  | "auth"
  | "session_expired"
  | "invalid_symbol"
  | "invalid_resolution"
  | "rate_limit"
  | "network"
  | "upstream"
  | "malformed"
  | "internal";

export class CapitalApiError extends Error {
  constructor(
    public readonly kind: CapitalErrorKind,
    public readonly status: number,
    /** Sanitized human message — must be secret-free before reaching here. */
    message: string,
    /** Raw Capital.com errorCode string. Diagnostics only. */
    public readonly capitalErrorCode?: string,
  ) {
    super(message);
    this.name = "CapitalApiError";
  }
}

/** Server-side structured diagnostics — never printed to the HTTP response. */
function logDiagnostic(err: CapitalApiError): void {
  const extra = [
    `kind=${err.kind}`,
    err.capitalErrorCode ? `cap=${err.capitalErrorCode}` : "",
    process.env.NODE_ENV === "test" ? "" : `at=${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join(" ");
  console.error(`[capital] ${extra}`);
}

/** Maps an error kind to a SAFE public {error, code} pair for the client. */
export function toHttpError(err: unknown): { status: number; code: string; error: string } {
  if (err instanceof CapitalApiError) {
    logDiagnostic(err);
    switch (err.kind) {
      case "not_configured":
        return { status: 500, code: "CAPITAL_NOT_CONFIGURED", error: "Server-side configuration incomplete." };
      case "auth": {
        const coolingDown = err.status === 503;
        return {
          status: err.status,
          code: coolingDown ? "CAPITAL_AUTH_COOLDOWN" : "CAPITAL_AUTH_FAILED",
          error: "Capital.com authentication failed",
        };
      }
      case "session_expired":
        return { status: 502, code: "CAPITAL_AUTH_FAILED", error: "Capital.com authentication failed" };
      case "invalid_symbol":
        return { status: 404, code: "CAPITAL_SYMBOL_NOT_FOUND", error: "Unknown instrument symbol" };
      case "invalid_resolution":
        return { status: 400, code: "INVALID_RESOLUTION", error: "Unsupported timeframe/resolution" };
      case "rate_limit":
        return { status: 429, code: "CAPITAL_RATE_LIMITED", error: "Market data rate limit reached" };
      case "network":
        return { status: 502, code: "CAPITAL_UNREACHABLE", error: "Market data provider unreachable" };
      case "upstream":
        return { status: 502, code: "CAPITAL_UPSTREAM_ERROR", error: "Upstream market data error" };
      case "malformed":
        return { status: 502, code: "CAPITAL_UPSTREAM_ERROR", error: "Malformed market data response" };
      default:
        return { status: 500, code: "INTERNAL", error: "Internal API error" };
    }
  }
  return { status: 500, code: "INTERNAL", error: "Internal API error" };
}
