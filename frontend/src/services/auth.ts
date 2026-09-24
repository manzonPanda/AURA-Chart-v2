/**
 * AURA Chart session auth — minimal, namespaced (P2).
 *
 * Signs in against the Trading Dashboard's EXISTING local auth system THROUGH
 * this app's own backend (`POST /api/auth/sign-in` → Dashboard). The browser
 * never talks to the Dashboard URL directly, and this module never sees a
 * credential beyond the sign-in call itself.
 *
 * TOKEN STORAGE CONTRACT:
 *   * One NAMESPACED localStorage key: `aura_chart_auth.v1` (versioned shape).
 *     The Dashboard's own storage keys are deliberately NOT reused — AURA Chart
 *     owns its storage and a sign-out here can never corrupt dashboard state.
 *   * Fast path is module memory; localStorage only re-hydrates after a page
 *     refresh.
 *
 * XSS TRADEOFF (documented, accepted for P2): localStorage is readable by any
 * script on this origin, so a successful XSS could exfiltrate the token.
 * Accepted because the app is a local, same-origin tool with no third-party
 * scripts; httpOnly-cookie auth would require a backend session layer that P2
 * explicitly avoids. Tokens are NEVER logged, NEVER placed in URLs/query
 * strings, and travel only in the Authorization header of same-origin calls.
 */
import { API_BASE, ApiError, toApiError } from "./api.ts";

const STORAGE_KEY = "aura_chart_auth.v1";

export interface AuthUser {
  id: string;
  email: string | null;
}

/** Versioned localStorage shape — bump `v` when the contract changes. */
interface StoredAuth {
  v: 1;
  accessToken: string;
  user: AuthUser | null;
  savedAt: number;
}

export interface AuthState {
  authenticated: boolean;
  user: AuthUser | null;
}

let cachedToken: string | null = null;
let cachedUser: AuthUser | null = null;
let hydrated = false;
const listeners = new Set<(state: AuthState) => void>();

function notify(): void {
  const state: AuthState = { authenticated: cachedToken !== null, user: cachedUser };
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      /* a broken listener can never break auth */
    }
  }
}

function readStored(): StoredAuth | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    if (parsed?.v !== 1 || typeof parsed.accessToken !== "string" || !parsed.accessToken) return null;
    return parsed;
  } catch {
    return null; // corrupted entry ⇒ treat as signed out (never throw)
  }
}

function writeStored(auth: StoredAuth): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
  } catch {
    /* storage unavailable (private mode etc.) — memory-only session */
  }
}

function clearStored(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Memory fast-path; localStorage only on first access after a refresh. */
export function getToken(): string | null {
  if (!hydrated) {
    hydrated = true;
    const stored = readStored();
    cachedToken = stored?.accessToken ?? null;
    cachedUser = stored?.user ?? null;
  }
  return cachedToken;
}

export function getUser(): AuthUser | null {
  getToken(); // ensure hydration
  return cachedUser;
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

/** React-friendly subscription. Returns the unsubscribe function. */
export function subscribeAuth(listener: (state: AuthState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fully clears local session state (used by signOut and 401 handling). */
export function clearSession(): void {
  cachedToken = null;
  cachedUser = null;
  hydrated = true;
  clearStored();
  notify();
}

/** Sign in via OUR backend (which forwards to the Dashboard's local auth). */
export async function signIn(email: string, password: string): Promise<AuthUser | null> {
  const res = await fetch(`${API_BASE}/auth/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await toApiError(res);

  const body = (await res.json()) as {
    session?: { access_token?: unknown } | null;
    user?: AuthUser | null;
  };
  const token = typeof body.session?.access_token === "string" ? body.session.access_token : null;
  if (!token) {
    // Upstream 200 without a token ⇒ contract violation; treat as failure
    // WITHOUT storing anything (and without echoing the body into the error).
    throw new ApiError(502, "BAD_SESSION", "Sign-in succeeded but no session token was returned.");
  }
  cachedToken = token;
  cachedUser = body.user ?? null;
  hydrated = true;
  writeStored({ v: 1, accessToken: token, user: cachedUser, savedAt: Date.now() });
  notify();
  return cachedUser;
}

/**
 * Sign out: best-effort upstream revoke (the Dashboard deletes its
 * public.sessions row so the token dies server-side), then ALWAYS clear local
 * state — a failed revoke must never leave a signed-in-looking UI.
 */
export async function signOut(): Promise<void> {
  const token = getToken();
  try {
    if (token) {
      await fetch(`${API_BASE}/auth/sign-out`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: "{}",
      });
    }
  } catch {
    /* network failure still signs out locally */
  } finally {
    clearSession();
  }
}

/**
 * Validate the stored token against the Dashboard (`GET /api/auth/session`
 * through our backend). Returns the user when valid; clears local state on
 * 401 (expired/revoked session) and returns null. Network failures keep the
 * stored session (optimistic) rather than signing the user out on a blip.
 */
export async function validateSession(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      clearSession();
      return null;
    }
    if (!res.ok) return getUser(); // transient upstream problem — keep session
    const body = (await res.json()) as { user?: AuthUser | null };
    if (body.user) {
      cachedUser = body.user;
      writeStored({ v: 1, accessToken: token, user: cachedUser, savedAt: Date.now() });
    }
    return body.user ?? getUser();
  } catch {
    return getUser(); // offline ⇒ optimistic
  }
}
