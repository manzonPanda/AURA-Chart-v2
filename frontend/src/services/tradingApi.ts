/**
 * Trading data client (P2) — typed access to the SAME-ORIGIN /api/trading/*
 * proxy routes. The browser NEVER calls the Trading Dashboard URL, its
 * PostgreSQL, or MT5 directly: AURA Chart's Hono backend is the only boundary
 * (see backend/src/routes/trading.ts). The session token rides ONLY in the
 * Authorization header — never a URL or query parameter — and this module
 * performs no caching: every call is a fresh, unauthenticated-cache-free
 * fetch whose payload is handed straight to the caller.
 */
import { API_BASE, ApiError, toApiError } from "./api.ts";
import { getToken } from "./auth.ts";

/** Exact P1 read-only account contract (snake_case, verbatim from upstream). */
export interface TradingAccount {
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

/** Fixed P1 whitelist + the server-derived `status` (never a DB column). */
export interface TradeRecord {
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
  /** P3-B: added to the P1 read whitelist (single column) for the overlay. */
  pnl: string | number | null;
  status: "open" | "closed";
}

export interface TradesPagination {
  limit: number;
  count: number;
  hasMore: boolean;
  from: string | null;
  to: string | null;
  instrument: string | null;
  status: string;
}

export interface TradesResponse {
  accountId: string;
  trades: TradeRecord[];
  pagination: TradesPagination;
}

/** Live MT5 money fields are null until the later MT5 subscriber phase. */
export interface AccountState {
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

export interface TradesQuery {
  from?: string;
  to?: string;
  instrument?: string;
  status?: "open" | "closed" | "all";
  limit?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bearer-attached same-origin fetch; no token ⇒ typed NO_SESSION error. */
async function authorizedFetch(path: string, query?: URLSearchParams): Promise<Response> {
  const token = getToken();
  if (!token) throw new ApiError(401, "NO_SESSION", "Not signed in.");
  const qs = query?.size ? `?${query.toString()}` : "";
  return fetch(`${API_BASE}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function parseOk<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** Account selector list — only the signed-in user's own accounts (upstream-enforced). */
export async function getTradingAccounts(): Promise<TradingAccount[]> {
  const res = await authorizedFetch("/trading/accounts");
  const body = await parseOk<{ accounts?: TradingAccount[] }>(res);
  return body.accounts ?? [];
}

/**
 * Historical + open trades for ONE account. Query params mirror the P1
 * contract exactly (from/to/instrument/status/limit); anything else is not
 * sent. `status` semantics come from upstream: open = time_close IS NULL.
 */
export async function getTradingTrades(accountId: string, query: TradesQuery = {}): Promise<TradesResponse> {
  if (!UUID_RE.test(accountId)) {
    throw new ApiError(400, "BAD_ACCOUNT_ID", "accountId must be a UUID.");
  }
  const qs = new URLSearchParams();
  if (query.from) qs.set("from", query.from);
  if (query.to) qs.set("to", query.to);
  if (query.instrument) qs.set("instrument", query.instrument);
  if (query.status) qs.set("status", query.status);
  if (query.limit !== undefined) qs.set("limit", String(Math.max(1, Math.trunc(query.limit))));
  const res = await authorizedFetch(`/trading/accounts/${encodeURIComponent(accountId)}/trades`, qs);
  return parseOk<TradesResponse>(res);
}

/** Account state: config/limits + open-position aggregates; live money null (later phase). */
export async function getTradingAccountState(accountId: string): Promise<AccountState> {
  if (!UUID_RE.test(accountId)) {
    throw new ApiError(400, "BAD_ACCOUNT_ID", "accountId must be a UUID.");
  }
  const res = await authorizedFetch(`/trading/accounts/${encodeURIComponent(accountId)}/state`);
  return parseOk<AccountState>(res);
}

// ── P3-D: local MT5 terminal identity (MATCH / MISMATCH against the selection) ──

/** Why an identity is unavailable — mirrors backend/src/services/mt5Account.ts. */
export type Mt5AccountReason =
  | "ok"
  | "not_logged_in"
  | "unreachable"
  | "timeout"
  | "invalid_response";

/**
 * Display-safe identity of the MT5 account the LOCAL terminal is logged into.
 * Read server-side from the existing pythonMt5 bridge; the bridge URL, and any
 * balance/credentials, never reach the browser. `connected === false` means
 * "cannot compare", never "no trades".
 */
export interface Mt5AccountIdentity {
  connected: boolean;
  login: string | null;
  server: string | null;
  name: string | null;
  reason: Mt5AccountReason;
}

const OFFLINE_IDENTITY: Mt5AccountIdentity = {
  connected: false,
  login: null,
  server: null,
  name: null,
  reason: "unreachable",
};

/**
 * MT5 terminal identity. NEVER throws on bridge problems: an unreachable or
 * unconfigured bridge degrades to a typed offline identity so the UI can say
 * "MT5 unavailable" instead of failing the chart. Auth/transport failures
 * (401/NO_SESSION) DO throw — those are session problems, not MT5 problems.
 */
export async function getMt5AccountIdentity(): Promise<Mt5AccountIdentity> {
  const res = await authorizedFetch("/trading/mt5/account");
  if (res.status === 401) throw await toApiError(res);
  if (!res.ok) return OFFLINE_IDENTITY;
  const body = (await res.json().catch(() => null)) as { account?: Mt5AccountIdentity } | null;
  const account = body?.account;
  if (!account || typeof account.connected !== "boolean") return OFFLINE_IDENTITY;
  return account;
}
