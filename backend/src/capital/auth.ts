/**
 * Official Capital.com session flow:
 *   1. POST {baseUrl}/api/v1/session
 *      headers : { X-CAP-API-KEY: <apiKey>, Content-Type: application/json }
 *      body    : { identifier: <account identifier/email>, password: <API custom password> }
 *   2. capture the `CST` + `X-SECURITY-TOKEN` response headers (session tokens).
 *   3. body carries `accountId` / `clientId` — needed by streaming for some
 *      environments; always read from the response, never hardcoded.
 *
 * Sessions expire after approximately 10 minutes — callers (client.ts) renew
 * proactively and must never cache tokens past that window. The API custom
 * password is NOT the web-login password and is never stored past the request.
 *
 * Secrets handling: the raw fetch here is only reachable from the server;
 * failures are classified into CapitalApiError WITHOUT echoing the body.
 */
import type { CapitalCredentials } from "../config.js";
import { CapitalApiError } from "./errors.js";

export const CAPITAL_API_KEY_HEADER = "X-CAP-API-KEY";

export interface CapitalSession {
  cst: string;
  xSecurityToken: string;
  /** Account identifier returned by the session body (streaming sessions). */
  accountId?: string;
  /** Client id returned by the session body. */
  clientId?: string;
}

export interface CapitalSessionDeps {
  /** Injectable fetch for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

type RawFetchResponse = {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json: () => Promise<unknown>;
};

/** Minimal raw fetch with timeout — no redirect-to-login surprises. */
export async function capitalRawFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
  fetchImpl: typeof fetch = fetch,
): Promise<RawFetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    return (await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    } as RequestInit)) as unknown as RawFetchResponse;
  } finally {
    clearTimeout(timer);
  }
}

function readHeader(res: RawFetchResponse, name: string): string {
  return (res.headers.get(name) ?? "").trim();
}

/** Create a fresh Capital.com session; returns CST + X-SECURITY-TOKEN tokens. */
export async function createSession(
  creds: CapitalCredentials,
  deps: CapitalSessionDeps = {},
): Promise<CapitalSession> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: RawFetchResponse;
  try {
    res = await capitalRawFetch(
      `${creds.baseUrl}/api/v1/session`,
      {
        method: "POST",
        headers: {
          [CAPITAL_API_KEY_HEADER]: creds.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          identifier: creds.identifier,
          password: creds.apiPassword,
        }),
        timeoutMs: 20000,
      },
      fetchImpl,
    );
  } catch {
    throw new CapitalApiError("network", 502, "Could not reach Capital.com — check CAPITAL_API_BASE_URL.");
  }

  const cst = readHeader(res, "CST");
  const xSecurityToken = readHeader(res, "X-SECURITY-TOKEN");

  if (!res.ok || !cst || !xSecurityToken) {
    const body = (await res.json().catch(() => null)) as { errorCode?: string } | null;
    const code = body?.errorCode ?? "";
    // 401/403 with a body errorCode: invalid key/password/identifier. NEVER
    // echo the body — classify into a fixed, secret-free human message.
    const hint =
      code === "error.security.client-suspended"
        ? "The API key is suspended — re-enable it in the Capital.com dashboard."
        : code.startsWith("validation")
          ? "Capital.com rejected the identifier format — verify the account identifier."
          : !cst || !xSecurityToken
            ? "Capital.com did not return session tokens — verify key/password/environment."
            : "";
    throw new CapitalApiError(
      "auth",
      401,
      ["Capital.com authentication failed.", hint].filter(Boolean).join(" "),
      code || undefined,
    );
  }

  const sessionBody = (await res.json().catch(() => null)) as {
    accountId?: string;
    clientId?: string;
  } | null;

  return {
    cst,
    xSecurityToken,
    accountId: sessionBody?.accountId || undefined,
    clientId: sessionBody?.clientId || undefined,
  };
}
