/**
 * MT5 account identity reader (P3-D) — READ-ONLY local bridge access.
 *
 * The LOCKED behavior of the AURA Chart TRADING account data is untouched: the
 * browser still reaches trading data exclusively through the same-origin
 * /api/trading proxy (P2). This module adds ONE new server-side read of the
 * EXISTING pythonMt5 bridge endpoint `GET /api/account_info` — the same
 * endpoint the Trading Dashboard's "Connected services" panel already polls —
 * so AURA Chart can tell the user WHICH MT5 account the local terminal is
 * logged into and compare it against the selected dashboard account.
 *
 * Rules honoured here:
 *  - No new transport: a plain server-to-server HTTP GET (the bridge's own REST
 *    endpoint, already used by the dashboard).
 *  - No credentials: the endpoint is unauthenticated by design and returns only
 *    the locally logged-in account's identity (login/server/name). Nothing is
 *    cached, persisted, logged, or forwarded to the browser verbatim.
 *  - Never throws: every failure degrades to a typed, display-safe identity so
 *    the UI can say "MT5 unavailable" instead of blanking out.
 */
export interface Mt5BridgeSettings {
  /** Base URL of the local pythonMt5 bridge (no trailing slash). */
  baseUrl: string;
  /** Bounded outbound timeout in ms. */
  timeoutMs: number;
}

/** Why an identity could not be read — fixed, display-safe reasons. */
export type Mt5AccountReason =
  | "ok"
  | "not_logged_in"
  | "unreachable"
  | "timeout"
  | "invalid_response";

/** Display-safe identity. Never includes balances, credentials, or account metadata. */
export interface Mt5AccountIdentity {
  connected: boolean;
  login: string | null;
  server: string | null;
  name: string | null;
  reason: Mt5AccountReason;
}

const DEFAULT_BASE_URL = "http://localhost:5000";
const DEFAULT_TIMEOUT_MS = 3000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 15000;

/** Fixed path on the pythonMt5 bridge — never caller-supplied. */
export const MT5_ACCOUNT_INFO_PATH = "/api/account_info";

/**
 * Resolve the bridge settings from env (pure — unit-testable).
 * MT5_BRIDGE_URL is optional: the local dev bridge default is used when unset.
 * An out-of-range/NaN timeout falls back to the default (never weakens bounds).
 */
export function resolveMt5BridgeSettings(
  env: Record<string, string | undefined> = process.env,
): Mt5BridgeSettings {
  const rawUrl = (env.MT5_BRIDGE_URL ?? "").trim();
  const baseUrl = (rawUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const rawTimeout = Number((env.MT5_BRIDGE_TIMEOUT_MS ?? "").trim());
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout >= MIN_TIMEOUT_MS && rawTimeout <= MAX_TIMEOUT_MS
      ? Math.trunc(rawTimeout)
      : DEFAULT_TIMEOUT_MS;
  return { baseUrl, timeoutMs };
}

/**
 * MT5 logins are numeric in the terminal but are transported as strings. Trim
 * only — exactly the Trading Dashboard's `normalizeAccountNumber` semantics.
 * Never fabricates a value.
 */
export function normalizeMt5Login(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

/** Map the bridge payload onto the display-safe identity (pure). */
export function toMt5AccountIdentity(payload: unknown): Mt5AccountIdentity {
  if (!payload || typeof payload !== "object") {
    return { connected: false, login: null, server: null, name: null, reason: "invalid_response" };
  }
  const record = payload as Record<string, unknown>;
  const login = normalizeMt5Login(record.login);
  if (!login) {
    // The bridge answers this way when no terminal session is logged in.
    return { connected: false, login: null, server: null, name: null, reason: "not_logged_in" };
  }
  const server = normalizeMt5Login(record.server);
  const name = normalizeMt5Login(record.name);
  return { connected: true, login, server, name, reason: "ok" };
}

/** Offline/unavailable identity with a fixed reason. */
export function unavailableMt5Identity(reason: Mt5AccountReason): Mt5AccountIdentity {
  return { connected: false, login: null, server: null, name: null, reason };
}

/**
 * One bounded GET against the local bridge. Never throws: network failure,
 * timeout, non-2xx and malformed JSON all become typed identities.
 */
export async function readMt5Account(settings: Mt5BridgeSettings): Promise<Mt5AccountIdentity> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const res = await fetch(`${settings.baseUrl}${MT5_ACCOUNT_INFO_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return unavailableMt5Identity("unreachable");
    const payload = (await res.json().catch(() => null)) as unknown;
    return toMt5AccountIdentity(payload);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return unavailableMt5Identity("timeout");
    return unavailableMt5Identity("unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/** Factory used by the trading router (dependency-injectable in tests). */
export function createMt5AccountReader(
  settings: Mt5BridgeSettings = resolveMt5BridgeSettings(),
): () => Promise<Mt5AccountIdentity> {
  return () => readMt5Account(settings);
}
