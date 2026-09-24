/**
 * Account selection + MT5 MATCH/MISMATCH (P3-D) — the AURA Chart analogue of
 * the Trading Dashboard's `AccountContextService` semantics, expressed as a
 * PURE module (no React, no fetch, no chart, no CandleKit).
 *
 * What this replaces: the P3-B overlay feed merged the historical trades of
 * EVERY account the user owns into one layer, so an account-call failure
 * silently blanked the whole layer and Account A's trades were
 * indistinguishable from Account B's.
 *
 * Rules:
 *  - The stable identity is the DASHBOARD ACCOUNT ID (a UUID) — never derived
 *    from `account_number`, which the audit found NULL on some accounts and
 *    non-numeric on others.
 *  - `account_number` is used ONLY for the optional MT5 comparison, whose
 *    semantics mirror `isActiveMt5Account()` in the Trading Dashboard: string
 *    equality after trimming, MT5 platform only, with an explicit
 *    "cannot compare" state when either side is missing.
 *  - Selection persistence uses AURA's OWN guarded-localStorage convention
 *    (see services/instruments.ts) — NOT the dashboard's user_settings column,
 *    which AURA can only reach through a generic DB proxy this backend
 *    deliberately does not expose (P2 fixed allowlist).
 *  - Nothing here throws: a stale/absent selection falls back deterministically.
 */
import type { Mt5AccountIdentity, TradingAccount } from "./tradingApi.ts";

/**
 * Versioned localStorage key for the selected ACCOUNT ID (the overlay scope).
 * Versioned because the stored value is an identifier whose contract could
 * change; an unparseable legacy value is simply ignored.
 */
export const ACCOUNT_SELECTION_STORAGE_KEY = "aura.trading.account.v1";

/** Storage surface (injectable for tests; defaults to localStorage). */
export interface AccountSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Trim-to-string, empty ⇒ null. NEVER fabricates a value. */
export function normalizeAccountNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

/** Read the persisted account id (null when absent/unavailable/blank). */
export function loadStoredAccountId(
  storage: AccountSelectionStorage = window.localStorage,
): string | null {
  try {
    return normalizeAccountNumber(storage.getItem(ACCOUNT_SELECTION_STORAGE_KEY));
  } catch {
    return null; // private mode / disabled storage — first account applies
  }
}

/** Persist the selection (guarded write — storage failures never break the UI). */
export function saveStoredAccountId(
  accountId: string,
  storage: AccountSelectionStorage = window.localStorage,
): void {
  try {
    storage.setItem(ACCOUNT_SELECTION_STORAGE_KEY, accountId);
  } catch {
    /* storage unavailable — selection stays session-only */
  }
}

/**
 * Resolve the active account id with the dashboard's fallback chain: a stored
 * id WINS only while it still exists in the user's account list (a deleted or
 * foreign account falls through), otherwise the FIRST account, otherwise null.
 * Deterministic and side-effect free — the caller decides when to persist.
 */
export function resolveSelectedAccountId(
  accounts: readonly TradingAccount[],
  storedId: string | null,
): string | null {
  const ids = accounts.map((a) => a.id).filter(Boolean);
  if (storedId && ids.includes(storedId)) return storedId;
  return ids[0] ?? null;
}

/** The selected account record (null when none/unknown). */
export function findAccount(
  accounts: readonly TradingAccount[],
  accountId: string | null,
): TradingAccount | null {
  if (!accountId) return null;
  return accounts.find((a) => a.id === accountId) ?? null;
}

/**
 * Human-readable label for the selector: the account NAME (always present),
 * plus the broker account number only when the record actually has one.
 * Never includes balances or any secret.
 */
export function accountLabel(account: TradingAccount): string {
  const name = normalizeAccountNumber(account.name) ?? account.id;
  const number = normalizeAccountNumber(account.account_number);
  if (number) return `${name} · ${number}`;
  const platform = normalizeAccountNumber(account.platform);
  return platform ? `${name} · ${platform}` : name;
}

/**
 * MATCH / MISMATCH / UNKNOWN of the selected dashboard account against the MT5
 * account the LOCAL terminal is logged into.
 *
 *  - "match"    — MT5 connected, both identifiers present and equal.
 *  - "mismatch" — MT5 connected and both identifiers present but differ. THIS
 *    is the dangerous state: live MT5 data belongs to another account.
 *  - "unknown"  — cannot compare: MT5 unreachable/not logged in, the account is
 *    not MT5 platform, or the selected account has no `account_number` (the
 *    audit found such accounts). "Unknown" NEVER means "no trades".
 */
export type Mt5MatchState = "match" | "mismatch" | "unknown";

export function resolveMt5Match(
  account: TradingAccount | null,
  mt5: Mt5AccountIdentity | null,
): Mt5MatchState {
  const mt5Login = normalizeAccountNumber(mt5?.login);
  if (!mt5?.connected || !mt5Login) return "unknown";
  if (!account) return "unknown";
  if (normalizeAccountNumber(account.platform)?.toUpperCase() !== "MT5") return "unknown";
  const accountNumber = normalizeAccountNumber(account.account_number);
  if (!accountNumber) return "unknown";
  return accountNumber === mt5Login ? "match" : "mismatch";
}

/**
 * Whether LIVE MT5-derived events may refresh the selected account's chart.
 *
 * AURA's P3-C live frames are ADVISORY ONLY: they never carry renderable trade
 * data, they only trigger a bounded refetch of the SELECTED account's own rows
 * through the P2 REST chain. The overlay layer therefore can only ever contain
 * the selected account's rows — but a live burst produced by a DIFFERENT MT5
 * account must still not be allowed to drive this account's chart, because
 * that is exactly the visible symptom of "Account B's activity while viewing
 * Account A".
 *
 * Policy — three states, never two:
 *  - "match"    → allowed (the terminal is provably the selected account).
 *  - "mismatch" → SUPPRESSED (the terminal provably belongs to another
 *    account; the dashboard's safety rule).
 *  - "unknown"  → allowed. There is NO evidence of a wrong account here (MT5
 *    down/unreachable, or the account has no `account_number` — the P3-D audit
 *    found five such accounts), and suppressing would silently regress P3-C's
 *    live behaviour for them. Historical overlays stay strictly account-scoped
 *    in every state, so no cross-account row can reach the chart regardless.
 */
export function allowsLiveMt5Data(state: Mt5MatchState): boolean {
  return state !== "mismatch";
}

/**
 * P3-C PART 8 gate: does this trade advisory's accountId hint affect the
 * SELECTED account's chart?
 *
 *  - event for ANOTHER account  → FALSE — do not refetch, do not merge, do
 *    not let foreign activity touch the selected overlay set.
 *  - event for the SELECTED one → TRUE  — trigger the existing bounded REST
 *    refetch/reconcile (advisory hint only; REST stays authoritative).
 *  - event with NO accountId    → TRUE  — upstream did not tag the event, so
 *    there is no evidence it is foreign; the refetch is still strictly scoped
 *    to the selected account server-side (`WHERE account_id = $1`), so a
 *    foreign row cannot be merged even if the hint was absent.
 *  - nothing selected           → FALSE — no refetch target exists.
 */
export function tradeEventAffectsSelection(
  eventAccountId: string | null | undefined,
  selectedAccountId: string | null | undefined,
): boolean {
  const selected = normalizeAccountNumber(selectedAccountId);
  if (!selected) return false;
  const event = normalizeAccountNumber(eventAccountId);
  if (!event) return true; // untagged hint — scoped refetch is harmless
  return event === selected;
}

/**
 * Fixed, display-safe explanation for a match state. Pure text (no JSX) so the
 * same wording is unit-testable and the UI stays a thin renderer.
 */
export function mt5MatchMessage(
  state: Mt5MatchState,
  account: TradingAccount | null,
  mt5: Mt5AccountIdentity | null,
): string {
  const login = normalizeAccountNumber(mt5?.login);
  const server = normalizeAccountNumber(mt5?.server);
  const target = account ? account.name : "no account";
  switch (state) {
    case "match":
      return `MT5 terminal is connected to ${login} — matches the selected account (${target}).`;
    case "mismatch":
      return `MT5 terminal is connected to ${login}${server ? ` (${server})` : ""}, but the selected account is ${target}. Live MT5 data is hidden so the wrong account is never mixed into this chart.`;
    default:
      if (!mt5?.connected) return "MT5 terminal not connected — account match cannot be verified.";
      if (!account) return "No trading account selected — account match cannot be verified.";
      if (!normalizeAccountNumber(account.account_number)) {
        return `The selected account (${target}) has no broker account number, so it cannot be matched against MT5.`;
      }
      return "MT5 account match cannot be verified.";
  }
}
