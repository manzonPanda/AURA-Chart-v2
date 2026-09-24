/**
 * Trading Dashboard (aura-backend) API client — P2 server-to-server boundary.
 *
 * The ONLY component in AURA Chart that talks to the Trading Dashboard. Every
 * call carries the END USER'S OWN session token (obtained from the Dashboard's
 * local auth system, forwarded by the browser to this backend). This backend
 * never validates, decodes or stores the token — the Dashboard's
 * authMiddleware (HMAC + public.sessions row) remains the single source of
 * authentication truth, and its P1 account-ownership layer remains the single
 * authorization boundary.
 *
 * SECURITY:
 *   * Paths are a fixed allowlist (the three P1 trading endpoints + the two
 *     auth endpoints). No caller input ever reaches the path.
 *   * The token travels ONLY in the Authorization header — never in URLs,
 *     query strings or logs.
 *   * Requests are bounded by an AbortController timeout (config).
 *   * No response caching, no persistence: trading data flows straight
 *     through to the proxy routes and is discarded.
 */

/** The exact P1 read-only response contract (aura-backend trading-overlay.js). */
export interface DashboardAccount {
  id: string;
  account_number: string | null;
  name: string;
  platform: string;
  phase: string;
  status: string | null;
  initial_balance: string | number | null;
  profit_target_percent: string | number | null;
  max_total_drawdown_percent: string | number | null;
  daily_loss_limit_percent: string | number | null;
  start_date: string | null;
  drawdown_mode: string;
  drawdown_basis: string;
  drawdown_stop_at_initial_balance: boolean;
  drawdown_eod_timezone: string;
  created_at: string;
  updated_at: string;
}

export interface DashboardTrade {
  account_id: string;
  ticket: string | number | null;
  instrument: string | null;
  buy_sell: "Buy" | "Sell" | null;
  lots: string | number | null;
  price_open: string | number | null;
  price_close: string | number | null;
  sl: string | number | null;
  tp: string | number | null;
  risk_per_trade: string | number | null;
  rrr: string | null;
  mfe: string | number | null;
  mae: string | number | null;
  time_open: string | null;
  time_close: string | null;
  /** Derived server-side from time_close — never a DB column. */
  status: "open" | "closed";
}

export interface DashboardPagination {
  limit: number;
  count: number;
  hasMore: boolean;
  from: string | null;
  to: string | null;
  instrument: string | null;
  status: string;
}

export interface DashboardTradesResponse {
  accountId: string;
  trades: DashboardTrade[];
  pagination: DashboardPagination;
}

export interface DashboardAccountState {
  accountId: string;
  accountNumber: string | null;
  name: string;
  platform: string;
  phase: string;
  status: string | null;
  initialBalance: unknown;
  profitTargetPercent: unknown;
  dailyLossLimitPercent: unknown;
  maxTotalDrawdownPercent: unknown;
  drawdownMode: string;
  drawdownBasis: string;
  drawdownStopAtInitialBalance: boolean;
  drawdownEodTimezone: string;
  startDate: string | null;
  openPositions: number;
  openLots: string | number | null;
  /** Live MT5 money fields — null until the later MT5 subscriber phase. */
  balance: null;
  equity: null;
  floatingPnl: null;
  dailyPnl: null;
  dailyLossLimit: null;
  maxDrawdown: null;
  currentDrawdown: null;
  drawdownRemaining: null;
  openRisk: null;
  updatedAt: string;
}

export interface DashboardSession {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  user?: { id: string; email: string | null };
}

/** Upstream non-2xx, normalised WITHOUT leaking token or internals. */
export class DashboardApiError extends Error {
  readonly status: number;
  readonly upstreamError: string | null;

  constructor(status: number, message: string, upstreamError: string | null = null) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.upstreamError = upstreamError;
  }
}

export interface DashboardApiErrorLike {
  error?: string;
}

/** Allowlisted trades query params — only these ever reach the upstream URL. */
export interface TradesQuery {
  from?: string | null;
  to?: string | null;
  instrument?: string | null;
  status?: "open" | "closed" | "all";
  limit?: number;
}

/** Fixed upstream paths — the ONLY paths this client will ever request. */
const PATH = {
  signIn: "/api/auth/sign-in",
  session: "/api/auth/session",
  signOut: "/api/auth/sign-out",
  accounts: "/api/trading/accounts",
  trades: (accountId: string) => `/api/trading/accounts/${encodeURIComponent(accountId)}/trades`,
  state: (accountId: string) => `/api/trading/accounts/${encodeURIComponent(accountId)}/state`,
} as const;

/**
 * Server-to-server client for the Trading Dashboard (aura-backend). The token
 * is the END USER'S session token, forwarded opaquely in the Authorization
 * header only. Nothing is cached, nothing is persisted, tokens are never
 * logged and never appear in URLs or error messages.
 */
export class DashboardClient {
  constructor(
    /** DASHBOARD_API_URL (trailing slash already stripped by config). */
    private readonly baseUrl: string,
    /** Outbound timeout in ms (config-clamped 1s–30s). */
    private readonly timeoutMs: number,
  ) {}

  /**
   * Single bounded upstream request. Fixed path allowlist, JSON in/out,
   * AbortController timeout, token strictly header-only.
   */
  private async request<T>(
    path: string,
    opts: { token?: string | null; method?: "GET" | "POST"; body?: unknown; query?: URLSearchParams } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${opts.query?.size ? `?${opts.query.toString()}` : ""}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure vs timeout — both normalised WITHOUT the URL's token
      // (there is none) and without leaking internals. Token is never logged.
      if (err instanceof Error && err.name === "AbortError") {
        throw new DashboardApiError(504, "Trading Dashboard request timed out.");
      }
      throw new DashboardApiError(502, "Trading Dashboard is unreachable.");
    } finally {
      clearTimeout(timer);
    }

    // Bounded body read: parse JSON when present, otherwise a fixed message.
    let payload: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = null;
      }
    }

    if (!res.ok) {
      const upstreamError =
        payload !== null && typeof payload === "object" && payload !== null
          ? ((payload as DashboardApiErrorLike).error ?? null)
          : null;
      // Forward the upstream STATUS (meaningful error semantics) with a
      // message that never contains the token or any header content.
      throw new DashboardApiError(
        res.status,
        upstreamError || `Trading Dashboard request failed (HTTP ${res.status}).`,
        upstreamError,
      );
    }
    return payload as T;
  }

  // ── Auth (the Dashboard stays the single source of truth) ─────

  signIn(email: string, password: string): Promise<{ session: DashboardSession; user: DashboardSession["user"] }> {
    return this.request(PATH.signIn, { method: "POST", body: { email, password } });
  }

  getSession(token: string): Promise<{ user: { id: string; email: string | null } }> {
    return this.request(PATH.session, { token });
  }

  signOut(token: string): Promise<{ ok: boolean }> {
    return this.request(PATH.signOut, { token, method: "POST", body: {} });
  }

  // ── Trading (P1 read-only endpoints, forwarded verbatim) ──────

  listAccounts(token: string): Promise<{ accounts: DashboardAccount[] }> {
    return this.request(PATH.accounts, { token });
  }

  listTrades(token: string, accountId: string, query: TradesQuery = {}): Promise<DashboardTradesResponse> {
    const qs = new URLSearchParams();
    if (query.from) qs.set("from", query.from);
    if (query.to) qs.set("to", query.to);
    if (query.instrument) qs.set("instrument", query.instrument);
    if (query.status) qs.set("status", query.status);
    if (query.limit !== undefined) qs.set("limit", String(Math.max(1, Math.trunc(query.limit))));
    return this.request(PATH.trades(accountId), { token, query: qs });
  }

  getAccountState(token: string, accountId: string): Promise<DashboardAccountState> {
    return this.request(PATH.state(accountId), { token });
  }
}
