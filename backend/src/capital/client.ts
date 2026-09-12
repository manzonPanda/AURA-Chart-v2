/**
 * Thin Capital.com REST client (mirrors the proven ig/client.ts seam):
 * holds a cached session, attaches CST + X-SECURITY-TOKEN, classifies upstream
 * errors, and transparently re-authenticates once per expired session.
 *
 * Session renewal: Capital.com sessions expire after ~10 minutes. Unlike IG
 * (expiry only when the server rejects), renewal here is PROACTIVE — a session
 * older than the renewal window is refreshed before it can be rejected
 * mid-request, with hard-failure cooldown and brand-new-session reuse ports
 * from the IG client to protect the auth endpoint from reconnect storms.
 *
 * Secrets: the key/custom password/tokens are held in memory only, exposed
 * solely via redactables() for the crash-path log redactor, and never logged
 * or returned to the frontend.
 */
import type { CapitalCredentials } from "../config.js";
import { capitalRawFetch, createSession, type CapitalSession } from "./auth.js";
import { CapitalApiError } from "./errors.js";
import { formatCapitalUtcIso } from "./time.js";
import type { CapitalHistoricalPricesResponse, CapitalMarketDetails } from "./types.js";
import { CAPITAL_RESOLUTION } from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;
/** Refresh a session BEFORE the documented ~10-min expiry can bite. */
const SESSION_RENEWAL_WINDOW_MS = 9 * 60_000;
/** Hard gate after a failed login — protects the API key from retry storms. */
const AUTH_FAILURE_COOLDOWN_MS = 90_000;
/** Forced re-auths closer than this REUSE the brand-new session instead. */
const SESSION_REUSE_WINDOW_MS = 15_000;

export interface CapitalRequestOptions {
  method?: "GET" | "POST";
  query?: URLSearchParams;
  body?: unknown;
}

export class CapitalClient {
  private session?: CapitalSession;
  private sessionAuthAt = 0;
  private lastAuthAt = 0;
  private lastAuthFailureAt = 0;
  /** In-flight auth promise — concurrent callers share one login. */
  private authInFlight?: Promise<void>;

  constructor(private readonly creds: CapitalCredentials) {}

  get configured(): boolean {
    return Boolean(this.creds.apiKey && this.creds.apiPassword && this.creds.identifier && this.creds.baseUrl);
  }

  /**
   * Secret VALUES currently held — apiKey, custom password, CST and
   * X-SECURITY-TOKEN. Consumed ONLY by the crash-path log redactor; values are
   * re-read at log time so rotated tokens stay covered. Never logged directly.
   */
  redactables(): Array<string | undefined> {
    return [this.creds.apiKey, this.creds.apiPassword, this.session?.cst, this.session?.xSecurityToken];
  }

  /**
   * Streaming connection data: the streaming URL plus the CURRENT session
   * tokens. The WS client must re-authenticate per reconnect (a Capital.com
   * streaming session death invalidates its CST/XST), so this never caches
   * beyond the client's own renewal discipline.
   */
  getStreamingInfo(): { url: string; session?: CapitalSession } {
    return { url: this.creds.streamingUrl, session: this.session };
  }

  /**
   * Streaming handshake headers for a LIVE session — X-CAP-API-KEY plus the
   * session's CST / X-SECURITY-TOKEN. Values are secrets: consumed by the
   * WebSocket constructor only, never logged (see redactables()).
   */
  streamingHeaders(session: CapitalSession): Record<string, string> {
    return {
      "X-CAP-API-KEY": this.creds.apiKey,
      CST: session.cst,
      "X-SECURITY-TOKEN": session.xSecurityToken,
    };
  }

  /**
   * Fresh authoritative session for streaming consumers (mirrors IgClient
   * getStreamSession): ensures a valid — proactively renewed — session exists
   * and returns the CURRENT tokens. The WS client calls this on EVERY
   * (re)connect because a Capital.com streaming session death invalidates its
   * CST/XST; the reuse window + auth cooldown inside ensureSession keep the
   * login rate safe without callers needing their own throttling.
   */
  async getStreamSession(): Promise<CapitalSession> {
    await this.ensureSession();
    return this.session as CapitalSession;
  }

  invalidateSession(): void {
    this.session = undefined;
    this.sessionAuthAt = 0;
  }

  /**
   * Proactively refresh a session older than SESSION_RENEWAL_WINDOW_MS (the
   * documented ~10-min expiry), gate hard failures behind the auth cooldown,
   * and share ONE login across concurrent callers (a page of requests arriving
   * after expiry must never mint N sessions — in-flight auth is shared).
   */
  private async ensureSession(): Promise<void> {
    if (this.session && Date.now() - this.sessionAuthAt < SESSION_RENEWAL_WINDOW_MS) return;

    const now = Date.now();
    if (now - this.lastAuthFailureAt < AUTH_FAILURE_COOLDOWN_MS) {
      const waitS = Math.ceil((AUTH_FAILURE_COOLDOWN_MS - (now - this.lastAuthFailureAt)) / 1000);
      throw new CapitalApiError(
        "auth",
        503,
        `Capital.com authentication is cooling down after a failure — retry in ~${waitS}s.`,
      );
    }

    if (!this.authInFlight) {
      this.authInFlight = createSession(this.creds)
        .then((session) => {
          this.session = session;
          this.sessionAuthAt = Date.now();
          this.lastAuthAt = this.sessionAuthAt;
        })
        .finally(() => {
          this.authInFlight = undefined;
        });
    }
    try {
      await this.authInFlight;
    } catch (err) {
      this.lastAuthFailureAt = Date.now();
      throw err;
    }
  }

  /**
   * Authenticated request with transparent ONE-time re-auth: an expired
   * session (401/403) invalidates, re-authenticates, and retries exactly once.
   * A rejection right after a fresh login throws instead of looping logins.
   */
  async request<T>(path: string, opts: CapitalRequestOptions = {}): Promise<T> {
    await this.ensureSession();
    try {
      return await this.doRequest<T>(path, opts);
    } catch (err) {
      const recentlyAuthed = Date.now() - this.lastAuthAt < 60_000;
      const retryable =
        err instanceof CapitalApiError &&
        err.kind === "session_expired" &&
        !recentlyAuthed; // fresh tokens rejected → do not loop logins

      if (!retryable) throw err;
      this.invalidateSession();
      await this.ensureSession();
      return await this.doRequest<T>(path, opts);
    }
  }

  private async doRequest<T>(path: string, opts: CapitalRequestOptions): Promise<T> {
    const url = new URL(`${this.creds.baseUrl}${path}`);
    opts.query?.forEach((value, key) => url.searchParams.set(key, value));

    const headers: Record<string, string> = {
      "X-CAP-API-KEY": this.creds.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      CST: this.session?.cst ?? "",
      "X-SECURITY-TOKEN": this.session?.xSecurityToken ?? "",
    };

    let res;
    try {
      res = await capitalRawFetch(url.toString(), {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch {
      throw new CapitalApiError(
        "network",
        502,
        "Could not reach Capital.com — check the backend network and CAPITAL_API_BASE_URL.",
      );
    }

    if (res.status === 429) {
      throw new CapitalApiError("rate_limit", 429, "Capital.com rate limit reached — retry shortly.");
    }
    if (res.status === 404) {
      throw new CapitalApiError(
        "invalid_symbol",
        404,
        "Capital.com market not found — check the symbol (e.g. GOLD, not GOLDUS/GOLDAU).",
      );
    }
    if (res.status === 401 || res.status === 403) {
      const errBody = (await res.json().catch(() => null)) as { errorCode?: string } | null;
      throw new CapitalApiError(
        "session_expired",
        401,
        "Capital.com rejected the session tokens.",
        errBody?.errorCode,
      );
    }
    if (!res.ok) {
      throw new CapitalApiError("upstream", res.status, `Capital.com returned an error (HTTP ${res.status}).`);
    }

    const body = (await res.json().catch(() => null)) as T | null;
    if (body === null) {
      throw new CapitalApiError("malformed", 502, "Capital.com returned an unparseable response.");
    }
    return body;
  }

  /**
   * Bounded page of 1-minute bars for [fromMs, toMs) — the UTC window is
   * formatted via formatCapitalUtcIso so the server interprets it as UTC wall
   * clock (never the account/display timezone). The AUTHORITATIVE per-row
   * timestamp remains snapshotTimeUTC, parsed back to epoch-ms by the
   * historical module.
   */
  async getPrices(
    symbol: string,
    fromMs: number,
    toMs: number,
    max: number,
  ): Promise<CapitalHistoricalPricesResponse> {
    const query = new URLSearchParams({
      resolution: CAPITAL_RESOLUTION,
      from: formatCapitalUtcIso(fromMs),
      to: formatCapitalUtcIso(toMs),
      max: String(Math.max(1, Math.floor(max))),
    });
    return this.request<CapitalHistoricalPricesResponse>(`/api/v1/prices/${encodeURIComponent(symbol)}`, {
      query,
    });
  }

  /** Market metadata — quoting precision (decimalPlacesFactor) + snapshot. */
  async getMarket(symbol: string): Promise<CapitalMarketDetails> {
    return this.request<CapitalMarketDetails>(`/api/v1/markets/${encodeURIComponent(symbol)}`);
  }
}