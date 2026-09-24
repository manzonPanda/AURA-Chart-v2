// P2 — frontend auth + trading API service tests (script style, no node:test).
// Browser stubs are installed BEFORE the dynamic imports so the services run
// against a localStorage/window/fetch environment identical to the app's.
const results = [];
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
};

// ── Browser stubs ─────────────────────────────────────────────
const store = new Map();
const makeStorage = () => ({
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(String(k), String(v)); },
  removeItem: (k) => { store.delete(String(k)); },
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
});
const ls = makeStorage();
globalThis.window = { localStorage: ls, sessionStorage: makeStorage() };
globalThis.localStorage = ls;

const calls = []; // every fetch captured
const queue = []; // scripted responses, shifted in order
function makeResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 400,
    status,
    statusText: '',
    headers: { get: () => null, has: () => false },
    text: async () => text,
    json: async () => body,
  };
}
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const h = init.headers ?? {};
  const headers = typeof h.get === 'function'
    ? h
    : { get: (n) => h[n] ?? h[String(n).toLowerCase()] ?? null };
  calls.push({ url, method: init.method ?? 'GET', headers, body: init.body ?? null });
  return queue.length ? queue.shift() : makeResponse(200, {});
};

const EMAIL = 'trader@example.com';
const TOKEN = 'p2-chain-token-abc123';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

// ── Import the services (AFTER stubs are installed) ───────────
let auth, trading;
try {
  auth = await import('../src/services/auth.ts');
  trading = await import('../src/services/tradingApi.ts');
} catch (err) {
  console.log('IMPORT_FAIL: ' + (err?.stack || String(err)));
  process.exit(1);
}

check('auth exports the P2 surface',
  ['signIn', 'signOut', 'getToken', 'isAuthenticated'].every((k) => typeof auth[k] === 'function'),
  Object.keys(auth).join(','));
check('tradingApi exports the P2 surface',
  ['getTradingAccounts', 'getTradingTrades', 'getTradingAccountState'].every((k) => typeof trading[k] === 'function'),
  Object.keys(trading).join(','));

// ── Sign-in through the same-origin proxy ─────────────────────
queue.push(makeResponse(200, {
  session: { access_token: TOKEN, accessToken: TOKEN, token: TOKEN, token_type: 'bearer', user: { id: 'u1', email: EMAIL } },
  user: { id: 'u1', email: EMAIL },
  access_token: TOKEN,
  token: TOKEN,
}));
let signInErr = null;
try { await auth.signIn(EMAIL, 'password123'); } catch (err) { signInErr = err; }
check('signIn resolves', !signInErr, signInErr ? String(signInErr?.message ?? signInErr) : '');
const stored = auth.getToken();
check('signIn persists a session token', typeof stored === 'string' && stored.length > 0,
  'getToken=' + JSON.stringify(stored) + ' storageKeys=' + JSON.stringify([...store.keys()]));
check('isAuthenticated true after signIn', auth.isAuthenticated() === true);
if (calls[0]) {
  const u = calls[0].url;
  check('signIn goes to the same-origin /api/auth route', u.startsWith('/api/auth'), u);
  check('signIn never targets the dashboard/bridge/supabase hosts',
    !/localhost:5001|jakemt5|supabase/i.test(u), u);
  const bodyStr = typeof calls[0].body === 'string' ? calls[0].body : '';
  check('signIn posts credentials in the request body', bodyStr.length > 0, bodyStr.slice(0, 60));
  check('signIn does not put the password in the URL', !u.includes('password123'), u);
}

// ── Authenticated trading calls ───────────────────────────────
const authHeaderOf = (c) => c.headers.get('authorization') ?? c.headers.get('Authorization');
queue.push(makeResponse(200, { accounts: [{ id: ACCOUNT_ID, name: 'A', platform: 'MT5' }] }));
const accounts = await trading.getTradingAccounts();
check('getTradingAccounts resolves', Array.isArray(accounts) || Array.isArray(accounts?.accounts),
  JSON.stringify(accounts).slice(0, 80));
{
  const c = calls[calls.length - 1];
  check('accounts: same-origin /api/trading/accounts', c.url.startsWith('/api/trading/accounts'), c.url);
  check('accounts: Bearer token forwarded', (authHeaderOf(c) || '').includes(TOKEN), String(authHeaderOf(c)));
  check('accounts: token not in the URL', !c.url.includes(TOKEN), c.url);
}

queue.push(makeResponse(200, { trades: [], pagination: { limit: 50, count: 0, hasMore: false } }));
const trades = await trading.getTradingTrades(ACCOUNT_ID, { status: 'open', limit: 50 });
check('getTradingTrades resolves', Array.isArray(trades) || Array.isArray(trades?.trades),
  JSON.stringify(trades).slice(0, 80));
{
  const c = calls[calls.length - 1];
  const parsed = new URL(c.url, 'http://same-origin.test');
  check('trades: path /api/trading/accounts/:id/trades',
    parsed.pathname === `/api/trading/accounts/${ACCOUNT_ID}/trades`, parsed.pathname);
  check('trades: query params forwarded (status, limit)',
    parsed.searchParams.get('status') === 'open' && parsed.searchParams.get('limit') === '50',
    parsed.search);
  check('trades: Bearer token forwarded', (authHeaderOf(c) || '').includes(TOKEN));
  check('trades: token never in URL/query', !c.url.includes(TOKEN), c.url);
}

queue.push(makeResponse(200, { accountId: ACCOUNT_ID, state: { balance: null }, balance: null }));
let state = null, stateErr = null;
try { state = await trading.getTradingAccountState(ACCOUNT_ID); } catch (e) { stateErr = e; }
check('getTradingAccountState resolves', state !== null && typeof state === 'object',
  stateErr ? String(stateErr?.message ?? stateErr) : JSON.stringify(state).slice(0, 80));
{
  const c = calls[calls.length - 1];
  check('state: path /api/trading/accounts/:id/state',
    c.url.includes(`/api/trading/accounts/${ACCOUNT_ID}/state`), c.url);
  check('state: Bearer token forwarded', (authHeaderOf(c) || '').includes(TOKEN));
}

// ── Sign-out + signed-out behavior ────────────────────────────
try { await auth.signOut(); } catch (e) { /* local-only sign-out is valid */ }
check('signOut clears the token', auth.getToken() == null || auth.getToken() === '',
  'getToken=' + JSON.stringify(auth.getToken()));
check('isAuthenticated false after signOut', auth.isAuthenticated() === false);
let signedOutCall = null;
try {
  await trading.getTradingAccounts();
  signedOutCall = calls[calls.length - 1];
} catch (err) { /* refusing to call without a session is also correct P2 behavior */ }
if (signedOutCall) {
  const ah = authHeaderOf(signedOutCall);
  check('signed-out call carries no Bearer token', !ah || !ah.includes(TOKEN), String(ah));
} else {
  check('signed-out call carries no Bearer token (request not issued)', true);
}
check('every request stayed same-origin /api/*', calls.every((c) => c.url.startsWith('/api/')),
  calls.map((c) => c.url).join(' | ').slice(0, 200));

// ── Summary ───────────────────────────────────────────────────
console.log('=== p2AuthTrading.test results ===');
for (const line of results) console.log(line);
console.log(`total=${results.length} pass=${results.filter((r) => r.startsWith('PASS')).length} fail=${results.filter((r) => r.startsWith('FAIL')).length}`);
