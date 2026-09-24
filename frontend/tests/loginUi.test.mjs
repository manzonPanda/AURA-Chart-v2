// P3-D FINAL FIX — login UI tests (script style, run by `npm --prefix frontend
// run test`). Covers the five mandated behaviours WITHOUT rewriting any existing
// P3-D test: the REAL signInFlow.ts + auth.ts modules are exercised against a
// stubbed fetch/localStorage environment (the same harness pattern as
// p2AuthTrading.test.mjs), plus structural assertions that App.tsx wires the
// gate to the existing application.
//
//   1. signed-out state renders login
//   2. successful sign-in calls the EXISTING signIn()
//   3. failed sign-in displays an error (never silent)
//   4. authenticated state renders the existing application
//   5. sign-out calls the EXISTING signOut() and clears everything
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── Browser stubs BEFORE the services are loaded (same as p2AuthTrading) ─────
const store = new Map();
const makeStorage = () => ({
  getItem: (k) => (store.has(k) ? store.get(String(k)) : null),
  setItem: (k, v) => { store.set(String(k), String(v)); },
  removeItem: (k) => { store.delete(String(k)); },
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
});
const ls = makeStorage();
globalThis.window = { localStorage: ls, sessionStorage: makeStorage() };
globalThis.localStorage = ls;

const AUTH_KEY = "aura_chart_auth.v1";
const EMAIL = "trader@example.com";
const PASSWORD = "real-password-never-logged";

const calls = [];
const queue = [];
function makeResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 400,
    status,
    statusText: "",
    headers: { get: () => null, has: () => false },
    text: async () => text,
    json: async () => body,
  };
}
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  calls.push({ url, method: init.method ?? "GET", body: init.body ?? null });
  return queue.length ? queue.shift() : makeResponse(200, {});
};

const flow = await import("../src/services/signInFlow.ts");
const auth = await import("../src/services/auth.ts");

// ── 1. signed-out state renders login ────────────────────────────────────────
test("1. signed-out renders the login screen; a stored token briefly checks first", () => {
  assert.equal(flow.resolveAuthView(false), "sign-in");
  assert.equal(flow.resolveAuthView(false, true), "checking"); // restore splash
  assert.equal(flow.resolveAuthView(true, true), "checking");  // validation pending
  assert.equal(flow.resolveAuthView(true, false), "app");      // → existing app
  assert.equal(auth.isAuthenticated(), false);                 // fresh session
  assert.equal(store.has(AUTH_KEY), false);
});

// ── 2. successful sign-in calls the EXISTING signIn() ───────────────────────
test("2. successful sign-in goes through the existing signIn() and persists its session", async () => {
  queue.push(makeResponse(200, {
    session: { access_token: "p3d-login-token-abc", token_type: "bearer" },
    user: { id: "u1", email: EMAIL },
  }));
  const outcome = await flow.performSignIn(EMAIL, PASSWORD); // NO injection ⇒ real signIn()
  assert.equal(outcome.ok, true);
  assert.equal(outcome.state.phase, "idle");
  assert.equal(outcome.state.message, null);

  // The EXISTING P2 endpoint was called with the credentials in the body …
  const signInCall = calls.find((c) => c.url === "/api/auth/sign-in");
  assert.ok(signInCall, "POST /api/auth/sign-in must be issued by the real signIn()");
  const parsed = JSON.parse(signInCall.body);
  assert.equal(parsed.email, EMAIL);
  assert.equal(parsed.password, PASSWORD);
  // … and the EXISTING auth service persisted its own storage shape.
  assert.equal(auth.isAuthenticated(), true);
  assert.equal(auth.getToken(), "p3d-login-token-abc");
  const stored = JSON.parse(store.get(AUTH_KEY));
  assert.equal(stored.v, 1);
  assert.equal(stored.accessToken, "p3d-login-token-abc");
  // Post-success the gate decision is "app" — the existing markup renders.
  assert.equal(flow.resolveAuthView(auth.isAuthenticated(), false), "app");
});

// ── 3. failed sign-in displays an error ─────────────────────────────────────
test("3. failed sign-in produces a visible, safe error — never silent, never a token", async () => {
  auth.clearSession(); // fresh signed-out browser (the state a login screen implies)
  queue.push(makeResponse(401, { error: "Invalid email or password." }));
  const bad = await flow.performSignIn(EMAIL, "wrong-password");
  assert.equal(bad.ok, false);
  assert.equal(bad.state.phase, "error");
  assert.equal(flow.signInErrorMessage(bad.state), "Invalid email or password.");
  assert.ok(!flow.signInErrorMessage(bad.state).includes("wrong-password"));
  assert.equal(auth.isAuthenticated(), false); // no session was created
  // Gate still demands login after a failure.
  assert.equal(flow.resolveAuthView(false, false), "sign-in");

  queue.push(makeResponse(500, { error: "Internal" }));
  const down = await flow.performSignIn(EMAIL, PASSWORD);
  assert.equal(down.ok, false);
  assert.equal(
    flow.signInErrorMessage(down.state),
    "Unable to sign in — the sign-in service is unavailable.",
  );

  // Local pre-flight: empty password → error state with NO network call.
  const before = calls.length;
  const empty = await flow.performSignIn(EMAIL, "");
  assert.equal(empty.ok, false);
  assert.equal(calls.length, before, "validation failure must not issue a request");
  assert.match(flow.signInErrorMessage(empty.state) ?? "", /enter your password/i);
});

// ── 4. authenticated state renders the existing application ─────────────────
test("4. authenticated state resolves to the EXISTING app, not a second UI", async () => {
  // Re-establish the session (test 3 deliberately left the browser signed out).
  queue.push(makeResponse(200, {
    session: { access_token: "p3d-login-token-abc", token_type: "bearer" },
    user: { id: "u1", email: EMAIL },
  }));
  const relogin = await flow.performSignIn(EMAIL, PASSWORD);
  assert.equal(relogin.ok, true);
  // Pure gate decision: signed in ⇒ the untouched chart application renders.
  assert.equal(flow.resolveAuthView(auth.isAuthenticated(), false), "app");

  // Structural: App.tsx wires the gate to the existing components/effects and
  // does NOT duplicate any P3-D responsibility inside the login path.
  const appSrc = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(appSrc, /resolveAuthView\(authenticated, authChecking\)/);
  assert.match(appSrc, /<SignInScreen[\s\S]*?onSubmit={handleSignIn}/);
  assert.match(appSrc, /performSignIn\(email, password\)/);
  assert.ok(appSrc.includes("import { SignInScreen }"), "SignInScreen is the only login view");
  // The login handler performs NO data loading of its own — accounts/trades/MT5
  // stay exclusively in the pre-existing effects.
  const handlerBlock = appSrc.slice(
    appSrc.indexOf("const handleSignIn"),
    appSrc.indexOf("const handleSignOut"),
  );
  assert.ok(!handlerBlock.includes("getTradingAccounts"), "no account loading in login handler");
  assert.ok(!handlerBlock.includes("getTradingTrades"), "no trade loading in login handler");
  assert.ok(!handlerBlock.includes("getMt5AccountIdentity"), "no MT5 loading in login handler");
  // The SignInScreen itself stores nothing and fetches nothing.
  const screenSrc = readFileSync(
    new URL("../src/components/Auth/SignInScreen.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(!screenSrc.includes("localStorage"), "login screen never touches storage");
  assert.ok(!screenSrc.includes("fetch("), "login screen never fetches directly");
  assert.ok(!screenSrc.includes("tradingApi"), "login screen never loads trading data");
});

// ── 5. sign-out calls the EXISTING signOut() and clears everything ──────────
test("5. sign-out revokes + clears via the existing signOut(); gate returns to login", async () => {
  assert.equal(auth.isAuthenticated(), true); // still signed in from test 2
  let notified = null;
  const unsub = auth.subscribeAuth((s) => { notified = s; });

  await auth.signOut(); // the EXISTING service (best-effort revoke, always clear)
  unsub();

  // Upstream revoke was attempted through the existing endpoint …
  const outCall = calls.find((c) => c.url === "/api/auth/sign-out");
  assert.ok(outCall, "POST /api/auth/sign-out must be issued by the real signOut()");
  // … and local state is fully cleared.
  assert.equal(auth.isAuthenticated(), false);
  assert.equal(auth.getToken(), null);
  assert.equal(store.has(AUTH_KEY), false);
  // The auth subscription fired with authenticated:false — this is what flips
  // App's gate to the login screen and re-runs the existing effects' signed-out
  // branches (accounts → [], selection → null, overlays → idle, MT5 → null).
  assert.deepEqual(notified, { authenticated: false, user: null });
  assert.equal(flow.resolveAuthView(false, false), "sign-in");

  // Structural: App wires its sign-out button to the existing signOut().
  const appSrc = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(appSrc, /onClick={handleSignOut}/);
  assert.match(appSrc, /const handleSignOut[\s\S]{0,400}?signOut\(\)/);
});
