/**
 * AURA Chart sign-in screen (P3-D) — the MISSING AUTH ENTRY POINT.
 *
 * The P3-D runtime diagnostic proved the account/trade/MT5/overlay chain was
 * already fully functional and that the ONLY broken link was the absence of a
 * way for a real user to obtain a session token: `signIn()` existed in
 * services/auth.ts but had ZERO call sites, so every trading effect correctly
 * early-returned on `isAuthenticated() === false` and the UI showed
 * "No accounts" / "No trades loaded" / "MT5 Not connected".
 *
 * This component is a THIN RENDER LAYER ONLY:
 *   * it owns no auth state machine — all transitions come from the pure,
 *     tested module services/signInFlow.ts;
 *   * it stores no session — the EXISTING P2 service (services/auth.ts) does
 *     that, in its own `aura_chart_auth.v1` shape, via the existing
 *     POST /api/auth/sign-in proxy route;
 *   * it loads nothing — accounts, trades and MT5 identity are driven by
 *     App's existing effects, which already re-run from `subscribeAuth`.
 * Subtracting this file leaves the pre-P3-D behaviour intact.
 */
import { useState, type FormEvent } from "react";

export function SignInScreen({
  submitting,
  message,
  onSubmit,
}: {
  /** True while the single sign-in attempt is in flight (blocks double submits). */
  submitting: boolean;
  /** Safe, human-readable failure text (never a token or a password), or null. */
  message: string | null;
  /** Delegates to the EXISTING auth service through App's handler. */
  onSubmit: (email: string, password: string) => void;
}): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting) return;
    onSubmit(email, password);
  };

  return (
    <div className="auth-gate">
      <form className="auth-card" onSubmit={handleSubmit} aria-label="Sign in to AURA Chart">
        <div className="brand auth-brand">
          <span className="dot" />
          <span className="brand-name">AURA</span>
          <span className="brand-sub">Chart</span>
        </div>
        <p className="auth-lead">
          Sign in with your AURA Trading Dashboard account. Your selected account scopes the
          historical trade overlay.
        </p>

        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            placeholder="you@example.com"
            required
          />
        </label>

        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            placeholder="••••••••"
            required
          />
        </label>

        {/* Explicit, visible failure state — sign-in NEVER fails silently. */}
        {message && (
          <div className="auth-error" role="alert" data-testid="auth-error">
            {message}
          </div>
        )}

        <button type="submit" className="auth-submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign In"}
        </button>

        <p className="auth-note">
          Sessions are stored locally by AURA Chart and validated against the Trading Dashboard.
        </p>
      </form>
    </div>
  );
}
