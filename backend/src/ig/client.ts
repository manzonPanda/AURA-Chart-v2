/**
 * Thin IG REST client: holds a cached session, attaches the required auth
 * headers, classifies upstream errors, and transparently re-authenticates once
 * if a signed-in session expires.
 */
import type { IgCredentials } from "../config.js";
import { API_KEY_HEADER, createSession } from "./auth.js";
import { IgApiError } from "./errors.js";

export interface IgRequestOptions {
  method?: "GET" | "POST";
  query?: URLSearchParams;
  body?: unknown;
  /** IG endpoint version header — required by versioned endpoints like /prices. */
  version?: string;
}

/** Session details needed by the Lightstreamer connection (CST/XST + stream ids). */
export interface StreamSessionInfo {
  endpoint?: string;
  accountId?: string;
  cst: string;
  xSecurityToken: string;
}

const DEFAULT_TIMEOUT_MS = 20000;

export class IgClient {
  private cst?: string;
  private xSecurityToken?: string;
  private lightstreamerEndpoint?: string;
  private lightstreamerAccountId?: string;
  /** Timestamp of the last successful login — used to avoid re-login loops. */
  private lastAuthAt = 0;
  /** Timestamp of the last failed login — gates retries to protect the API key. */
  private lastAuthFailureAt = 0;

  private static readonly AUTH_FAILURE_COOLDOWN_MS = 90_000;
  /** Forced re-logins closer together than this REUSE the brand-new session
   *  instead (protects IG's login endpoint from reconnect-loop storms). */
  private static readonly SESSION_REUSE_WINDOW_MS = 15_000;

  constructor(private readonly creds: IgCredentials) {}

  get configured(): boolean {
    return Boolean(this.creds.apiKey && this.creds.username && this.creds.password && this.creds.baseUrl);
  }

  /**
   * Secret VALUES currently held by this client — the IG API key, password and
   * the live session CST / X-SECURITY-TOKEN. Consumed ONLY by the crash-path
   * log redactor (lib/redact.ts) so fatal logs can never leak them; values are
   * re-read at log time, so rotated session tokens stay covered. Never logged
   * directly and never returned to the frontend.
   */
  redactables(): Array<string | undefined> {
    return [this.creds.apiKey, this.creds.password, this.cst, this.xSecurityToken];
  }

  /**
   * Session data required to open the IG Lightstreamer streaming connection.
   * Callers must `await request()` (or this) at least once so a session exists;
   * if no live session is held yet we authenticate lazily here. No tokens are
   * ever returned to the frontend — this stays entirely backend-internal.
   */
  async getStreamSession(opts: { forceNew?: boolean } = {}): Promise<StreamSessionInfo> {
    if (opts.forceNew) {
      // A Lightstreamer session death INVALIDATES its CST/XST on IG's side, so
      // a reconnect must never re-present them — the server rejects them
      // instantly and the relay flaps CONNECTING→DISCONNECTED forever. Drop
      // the cached session and log in fresh; but reuse a session created
      // moments ago so a pathological reconnect loop cannot storm the login
      // endpoint (hard failures stay gated by AUTH_FAILURE_COOLDOWN_MS too).
      const sessionIsBrandNew = Date.now() - this.lastAuthAt < IgClient.SESSION_REUSE_WINDOW_MS;
      if (!sessionIsBrandNew) this.invalidateSession();
    }
    await this.ensureSession();
    // Prefer the endpoint IG returned at login; fall back to the REST gateway
    // host (same authority daisy-chains for some gateways).
    const endpoint =
      this.lightstreamerEndpoint ||
      this.creds.baseUrl.replace(/\/gateway\/deal$/, "") ||
      this.creds.baseUrl;
    const accountId = this.lightstreamerAccountId || this.creds.accountId || "";
    if (!this.cst || !this.xSecurityToken) {
      throw new IgApiError("auth", 503, "No IG session available for streaming.");
    }
    return {
      endpoint,
      accountId,
      cst: this.cst,
      xSecurityToken: this.xSecurityToken,
    };
  }

  private async ensureSession(): Promise<void> {
    if (this.cst && this.xSecurityToken) return;
    if (!this.configured) {
      throw new IgApiError(
        "not_configured",
        500,
        "Backend has no IG credentials configured. Set IG_API_KEY, IG_USERNAME and IG_PASSWORD.",
      );
    }
    if (Date.now() - this.lastAuthFailureAt < IgClient.AUTH_FAILURE_COOLDOWN_MS) {
      // Hard stop on credential retry storms: frontend refreshes must never
      // translate into repeated failed IG logins (suspension risk).
      throw new IgApiError(
        "auth",
        503,
        "IG authentication is cooling down after a recent failure. Fix credentials in backend/.env and restart the backend to retry immediately.",
      );
    }
    try {
      const session = await createSession(this.creds);
      this.cst = session.cst;
      this.xSecurityToken = session.xSecurityToken;
      this.lightstreamerEndpoint = session.lightstreamerEndpoint;
      this.lightstreamerAccountId = session.lightstreamerAccountId || this.creds.accountId;
      this.lastAuthAt = Date.now();
    } catch (err) {
      if (err instanceof IgApiError && err.kind === "auth") {
        this.lastAuthFailureAt = Date.now();
      }
      throw err;
    }
  }

  private invalidateSession(): void {
    this.cst = undefined;
    this.xSecurityToken = undefined;
  }

  /**
   * Signed request. If a previously-working session token expires mid-flight,
   * re-authenticate exactly once and retry. A login failure inside
   * `ensureSession` is NOT retried — it propagates with its real cause so
   * that credential problems never trigger repeated login attempts (which
   * can get the API key suspended).
   */
  async request<T>(path: string, opts: IgRequestOptions = {}): Promise<T> {
    await this.ensureSession();
    try {
      return await this.doRequest<T>(path, opts);
    } catch (err) {
      const recentlyAuthed = Date.now() - this.lastAuthAt < 60_000;
      const retryable =
        err instanceof IgApiError &&
        err.kind === "session_expired" &&
        !recentlyAuthed; // fresh tokens rejected → do not loop logins

      if (!retryable) throw err;

      this.invalidateSession();
      await this.ensureSession(); // one re-auth per expired session
      return await this.doRequest<T>(path, opts);
    }
  }

  private async doRequest<T>(path: string, opts: IgRequestOptions): Promise<T> {
    const url = new URL(`${this.creds.baseUrl}${path}`);
    opts.query?.forEach((value, key) => url.searchParams.set(key, value));

    const headers: Record<string, string> = {
      [API_KEY_HEADER]: this.creds.apiKey,
      "Content-Type": "application/json",
      "CST": this.cst ?? "",
      "X-SECURITY-TOKEN": this.xSecurityToken ?? "",
    };
    if (this.creds.accountId) headers["X-IG-ACCOUNT-ID"] = this.creds.accountId;
    if (opts.version) headers["Version"] = opts.version;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new IgApiError(
        "network",
        502,
        "Could not reach IG — check the backend network and IG_BASE_URL.",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new IgApiError("rate_limit", 429, "IG rate limit reached — retry shortly.");
    }
    if (res.status === 429) {
      throw new IgApiError("rate_limit", 429, "IG rate limit reached — retry shortly.");
    }
    if (res.status === 404) {
      throw new IgApiError(
        "invalid_epic",
        404,
        "IG instrument not found — check the EPIC, or the endpoint version is retired for this gateway.",
      );
    }
    if (res.status === 401 || res.status === 403) {
      // Read the IG errorCode so the failure is classified TRUTHFULLY:
      //  - an exhausted historical-data allowance (403) can NEVER be fixed by
      //    re-authenticating — surfacing it as "auth failed" would burn login
      //    attempts and mislead the UI;
      //  - anything else on 401/403 is treated as a dead session (re-auth once).
      const errBody = (await res.json().catch(() => null)) as { errorCode?: string } | null;
      const igErrorCode = errBody?.errorCode;
      if (igErrorCode && igErrorCode.includes("allowance")) {
        throw new IgApiError(
          "rate_limit",
          403,
          "IG historical data allowance exhausted.",
          igErrorCode,
        );
      }
      // Distinguish "our session token stopped working" (retryable after a
      // genuine re-login) from login failures, which must surface verbatim.
      throw new IgApiError("session_expired", 401, "IG rejected the session tokens.", igErrorCode);
    }
    if (!res.ok) {
      throw new IgApiError("upstream", res.status, `IG returned an error (HTTP ${res.status}).`);
    }

    const body = (await res.json().catch(() => null)) as T | null;
    if (body === null) {
      throw new IgApiError("malformed", 502, "IG returned an unparseable response.");
    }
    return body;
  }
}