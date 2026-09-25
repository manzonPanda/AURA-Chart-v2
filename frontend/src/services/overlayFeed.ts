/**
 * Selected-account historical overlay FEED state machine (P3-D) — PURE module
 * (no React, no fetch) so every transition in Part 3 is unit-testable:
 *
 *   accounts → selectedAccountId → ONE GET trades(selected) → buildTradeOverlays()
 *
 * Why this exists: the P3-B feed cleared the whole overlay layer from a bare
 * `catch`, so a failed request produced an APPARENTLY EMPTY chart with no way
 * to tell "zero trades" from "request failed" from "not loaded yet". This
 * module makes those states explicit and never lets a late response from
 * Account A land after the user switched to Account B (stale guard on every
 * transition — the same boundary `handleAccountChange` enforces eagerly).
 *
 * Failure policy (non-destructive): a failed REFRESH of the account that owns
 * the current overlays keeps those overlays (they are still that account's
 * authoritative rows) and surfaces `phase: "error"` for the UI banner. A
 * failure after an account switch shows the error state over an EMPTY set —
 * the previous account's overlays were already discarded at switch time and
 * must never reappear.
 */
import { ApiError } from "./api.ts";
import { reconcileTradeOverlays } from "./tradeOverlay.ts";
import type { TradeOverlay } from "./tradeOverlay.ts";

/** Explicit feed lifecycle — "empty" is phase `ready` + tradeCount 0. */
export type OverlayFeedPhase = "idle" | "loading" | "ready" | "error" | "unauthorized";

/**
 * Coalesce concurrent refresh requests into at most one running task and one
 * trailing task. Calls made while the task is in flight never start extra work.
 */
export function createSingleFlight(task: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  let queued = false;
  return async () => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      do {
        queued = false;
        await task();
      } while (queued);
    } finally {
      inFlight = false;
      queued = false;
    }
  };
}

export interface OverlayFeedState {
  /** Account the current overlays/phase belong to (null ⇒ no scope yet). */
  accountId: string | null;
  phase: OverlayFeedPhase;
  /** Renderable overlays for `accountId` only (never merged across accounts). */
  overlays: TradeOverlay[];
  /** Row count of the last SUCCESSFUL load (0 ⇒ a proven "no trades"). */
  tradeCount: number;
  /** Display-safe failure text for phase error/unauthorized (else null). */
  errorMessage: string | null;
}

/** Signed-out / no selection / nothing loaded yet. */
export function initialOverlayFeed(): OverlayFeedState {
  return {
    accountId: null,
    phase: "idle",
    overlays: [],
    tradeCount: 0,
    errorMessage: null,
  };
}

/**
 * Begin loading `accountId`. A DIFFERENT account ⇒ the previous account's
 * overlays are dropped immediately (switch is a hard boundary); the SAME
 * account ⇒ overlays are kept (a refresh/refetch must not blank the chart).
 * A null accountId can never start a load (caller guards) — treated as reset.
 */
export function feedLoading(
  prev: OverlayFeedState,
  accountId: string | null,
): OverlayFeedState {
  if (!accountId) return initialOverlayFeed();
  if (prev.accountId !== accountId) {
    return { accountId, phase: "loading", overlays: [], tradeCount: 0, errorMessage: null };
  }
  if (prev.accountId === accountId && prev.phase === "ready") {
    // A background refresh must not create a visible loading state. Returning the
    // same object also avoids a needless header/chart render while the request
    // is in flight; account switches still take the hard loading boundary above.
    return prev;
  }
  return { ...prev, phase: "loading", errorMessage: null };
}

/**
 * Successful load for `accountId`. A response whose accountId no longer
 * matches the state's scope (stale — the user switched away while the request
 * was in flight) is DROPPED unchanged: Account A can never repopulate after
 * selecting Account B. Same-scope results reconcile by identity so duplicate
 * rows / surviving local opens behave exactly as in P3-C.
 */
export function feedSuccess(
  prev: OverlayFeedState,
  accountId: string | null,
  overlays: readonly TradeOverlay[],
  tradeCount: number,
): OverlayFeedState {
  if (!accountId || prev.accountId !== accountId) return prev; // stale response
  const next = prev.phase === "loading" && prev.overlays.length === 0
    ? [...overlays]
    : reconcileTradeOverlays(prev.overlays, overlays);
  return {
    accountId,
    phase: "ready",
    overlays: next,
    tradeCount,
    errorMessage: null,
  };
}

/**
 * Failed load for `accountId` — stale responses are dropped unchanged, and
 * the failure is CLASSIFIED so 401/403 ("unauthorized") reads differently
 * from a transport/5xx "error". Overlays for the SAME scope survive (they
 * remain this account's authoritative rows); a failure for a different scope
 * leaves whatever the current scope owns untouched.
 */
export function feedFailure(
  prev: OverlayFeedState,
  accountId: string | null,
  err: unknown,
): OverlayFeedState {
  if (!accountId || prev.accountId !== accountId) return prev; // stale failure
  const status = err instanceof ApiError ? err.status : null;
  const unauthorized = status === 401 || status === 403;
  const message =
    err instanceof Error && err.message ? err.message : "Historical trades request failed.";
  return {
    ...prev,
    phase: unauthorized ? "unauthorized" : "error",
    errorMessage: unauthorized
      ? `Not authorized to load trades for this account — ${message}`
      : `Historical trades unavailable — ${message}`,
  };
}

/** Compact selector-adjacent label: loading / N trades / No trades / state. */
export function overlayFeedLabel(state: OverlayFeedState): string {
  switch (state.phase) {
    case "idle":
      return "No trades loaded";
    case "loading":
      return "Loading trades…";
    case "ready":
      return state.tradeCount === 0 ? "No trades" : `${state.tradeCount} trades`;
    case "unauthorized":
      return "Trades not authorized";
    case "error":
      return "Trades unavailable";
  }
}

/** Full banner text for the error/unauthorized states (null otherwise). */
export function overlayFeedErrorMessage(state: OverlayFeedState): string | null {
  if (state.phase !== "error" && state.phase !== "unauthorized") return null;
  return state.errorMessage ?? "Historical trades unavailable.";
}
