/**
 * P3-D AUTH ENTRY POINT — framework-free state logic for the AURA Chart
 * sign-in screen.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The P3-D runtime diagnostic proved that the account/trade/MT5/overlay chain
 * was already fully functional and that the ONLY broken link was the very
 * first hop: the browser had no session token and AURA Chart offered no way to
 * obtain one (`signIn` had zero call sites; the `aura_chart_auth.v1` key was
 * never written by the app). Every downstream effect correctly early-returns
 * on `isAuthenticated() === false`, which is exactly why the UI showed
 * "No accounts" / "No trades loaded" / "MT5 Not connected".
 *
 * This module adds NOTHING to the authentication system. It reuses the
 * EXISTING P2 service (`services/auth.ts` → `signIn` / `signOut` /
 * `validateSession` / `subscribeAuth`) and only owns the login FORM's local
 * presentation state: submitting, error classification and message safety.
 *
 * Kept out of the .tsx component for the same reason as services/overlayFeed.ts:
 * the repository's tests run under plain `node --test` with type stripping and
 * no DOM, so every decision lives in a pure module and the component is a thin
 * render layer.
 *
 * NEVER: no token/password in any message, no new transport, no direct call to
 * the Trading Dashboard, no second state machine.
 */
import { ApiError } from "./api.ts";
import { signIn as defaultSignIn } from "./auth.ts";

// ── View selection (signed-out → login, signed-in → the existing app) ───────

/** Which top-level view the auth gate renders. */
export type AuthView = "checking" | "sign-in" | "app";

/**
 * Pure decision behind the app's auth gate: unauthenticated ⇒ the P3-D login
 * screen; authenticated ⇒ the UNCHANGED existing chart app (which then runs
 * its own, already-working account/trade/MT5 effects).
 *
 * `checking` is the brief re-validation pass on a cold start that already had
 * a token in storage: the gate defers to the login screen only once
 * `validateSession()` has answered, so an EXPIRED stored session lands on the
 * form instead of on the confusing "No accounts / No trades loaded" chart.
 */
export function resolveAuthView(authenticated: boolean, checking = false): AuthView {
  if (checking) return "checking";
  return authenticated ? "app" : "sign-in";
}

// ── Login form state ───────────────────────────────────────────────────────

export type SignInPhase = "idle" | "submitting" | "error";

export interface SignInState {
  phase: SignInPhase;
  /** Echo of the last submitted email — display only, never a credential. */
  email: string;
  /** Human-readable failure text, or null. NEVER carries a token/password. */
  message: string | null;
}

export function initialSignInState(): SignInState {
  return { phase: "idle", email: "", message: null };
}

/** Entering a submit: clears any previous failure, blocks double submits. */
export function signInSubmitting(prev: SignInState, email: string): SignInState {
  void prev;
  return { phase: "submitting", email: normalizeEmail(email), message: null };
}

/** A successful submit resets the form (the gate switches views instead). */
export function signInSucceeded(): SignInState {
  return initialSignInState();
}

export function signInFailed(prev: SignInState, error: unknown, email: string): SignInState {
  void prev;
  return {
    phase: "error",
    email: normalizeEmail(email),
    message: sanitizeSignInMessage(signInFailureMessage(error)),
  };
}

export function signInErrorMessage(state: SignInState): string | null {
  return state.phase === "error" ? state.message : null;
}

export function isSignInSubmitting(state: SignInState): boolean {
  return state.phase === "submitting";
}

// ── Input handling ─────────────────────────────────────────────────────────

export function normalizeEmail(value: string): string {
  return (value ?? "").trim();
}

/**
 * Local pre-flight so an empty form produces an immediate, clear error WITHOUT
 * a network round-trip. Returns the error text, or null when submittable.
 */
export function validateSignInInput(email: string, password: string): string | null {
  if (!normalizeEmail(email)) return "Enter your email address.";
  if (!(password ?? "").length) return "Enter your password.";
  return null;
}

export function canSubmitSignIn(email: string, password: string): boolean {
  return validateSignInInput(email, password) === null;
}

// ── Failure classification (safe, actionable, credential-free) ─────────────

/** Anything that could plausibly be a credential echo is stripped before display. */
const CREDENTIAL_LOOKING = /[A-Za-z0-9_-]{25,}\.[A-Za-z0-9_-]{20,}/g; // JWT-shaped
const REDACTED = "[redacted]";

/**
 * Last line of defence for the visible message: a token can never reach the
 * screen even if an upstream error text somehow contained one. Long
 * JWT/base64url-shaped runs are redacted; nothing else is rewritten.
 */
export function sanitizeSignInMessage(message: string): string {
  return String(message ?? "").replace(CREDENTIAL_LOOKING, REDACTED).slice(0, 300);
}

/**
 * Classify a sign-in failure into a clear, user-actionable sentence.
 *
 * Codes come from the EXISTING P2 chain: the AURA backend mirrors the
 * Dashboard's status, so a wrong password arrives as 401 (`INVALID_CREDENTIALS`
 * / `UNAUTHORIZED`) and an unreachable Dashboard as 502/503/504. The
 * distinction matters: "Invalid email or password" tells the user to retype
 * credentials, while "Unable to sign in" tells them the service, not their
 * typing, is the problem. Failures are NEVER silent.
 */
export function signInFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 400) return "Invalid email or password.";
    if (error.status === 403) return "This account is not permitted to sign in.";
    if (error.status === 429) return "Too many attempts — wait a moment and try again.";
    if (error.status >= 500) return "Unable to sign in — the sign-in service is unavailable.";
    // Any other explicit upstream message is safe, useful and never a secret.
    if (error.message && error.message !== error.code) return `Unable to sign in — ${error.message}`;
    return "Unable to sign in.";
  }
  const text = error instanceof Error ? error.message : "";
  if (/failed to fetch|networkerror|load failed|econnrefused|socket hang up/i.test(text)) {
    return "Unable to sign in — the AURA backend is unreachable.";
  }
  return "Unable to sign in.";
}

// ── Orchestration (the UI's ONE tested call path into the existing service) ──

/** A local (pre-flight) rejection: the error state shape, with no network call. */
export function signInRejected(email: string, message: string): SignInState {
  return {
    phase: "error",
    email: normalizeEmail(email),
    message: sanitizeSignInMessage(message),
  };
}

/** Result of one submit attempt: the next form state + whether the gate may open. */
export interface SignInOutcome {
  ok: boolean;
  state: SignInState;
}

/**
 * ONE submit attempt. This is the whole login behaviour, kept framework-free so
 * it is directly testable:
 *
 *   1. local pre-flight (empty fields ⇒ immediate, clear error, NO request);
 *   2. `signIn(email, password)` — the EXISTING P2 service, injected so the
 *      test can prove it is the function actually called, with the user's raw
 *      password and never anything else;
 *   3. success ⇒ `signInSucceeded()` (the auth service has already persisted
 *      the session in its own `aura_chart_auth.v1` shape — this module never
 *      stores anything); failure ⇒ `signInFailed()` with a safe message.
 *
 * `ok:true` means "a session now exists"; the caller then only has to flip its
 * view, because every downstream account/trade/MT5 effect is already driven by
 * the existing `subscribeAuth` subscription.
 */
export async function performSignIn(
  email: string,
  password: string,
  signInFn: (email: string, password: string) => Promise<unknown> = defaultSignIn,
): Promise<SignInOutcome> {
  const inputError = validateSignInInput(email, password);
  if (inputError) return { ok: false, state: signInRejected(email, inputError) };
  try {
    await signInFn(normalizeEmail(email), password);
  } catch (error) {
    return { ok: false, state: signInFailed(initialSignInState(), error, email) };
  }
  return { ok: true, state: signInSucceeded() };
}
