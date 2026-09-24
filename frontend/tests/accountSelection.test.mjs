/**
 * P3-D — account selection + MT5 MATCH/MISMATCH tests (pure, no DOM/fetch).
 * Runs with Node's type stripping:  npm --prefix frontend run test
 *
 * Covers:
 *   1. normalizeAccountNumber      — trim/null semantics, never fabricates
 *   2. save/load selection         — guarded storage round-trip + failure paths
 *   3. resolveSelectedAccountId    — dashboard fallback chain (stored → first → null)
 *   4. findAccount / accountLabel  — lookup + display label (no secrets)
 *   5. resolveMt5Match             — match / mismatch / every unknown branch
 *   6. allowsLiveMt5Data           — only "mismatch" suppresses live data
 *   7. mt5MatchMessage             — display-safe wording for every state
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_SELECTION_STORAGE_KEY,
  normalizeAccountNumber,
  loadStoredAccountId,
  saveStoredAccountId,
  resolveSelectedAccountId,
  findAccount,
  accountLabel,
  resolveMt5Match,
  allowsLiveMt5Data,
  mt5MatchMessage,
} from "../src/services/accountSelection.ts";

/** Minimal TradingAccount shape used across the tests. */
const acct = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test Account",
  platform: "MT5",
  phase: "phase1",
  account_number: null,
  ...over,
});

/** In-memory storage, optionally throwing (private-mode simulation). */
const memStorage = (init = {}, throwOn = false) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => {
      if (throwOn) throw new Error("denied");
      return m.has(k) ? m.get(k) : null;
    },
    setItem: (k, v) => {
      if (throwOn) throw new Error("denied");
      m.set(k, v);
    },
  };
};

const mt5 = (over = {}) => ({
  connected: true,
  login: "224776",
  server: "SomeServer-Server",
  name: "Trader",
  reason: "ok",
  ...over,
});

// ── 1. normalizeAccountNumber ────────────────────────────────────────────────
test("normalizeAccountNumber trims and nulls out blanks", () => {
  assert.equal(normalizeAccountNumber("  224776  "), "224776");
  assert.equal(normalizeAccountNumber("0"), "0"); // "0" is a value, not blank
  assert.equal(normalizeAccountNumber("   "), null);
  assert.equal(normalizeAccountNumber(""), null);
  assert.equal(normalizeAccountNumber(null), null);
  assert.equal(normalizeAccountNumber(undefined), null);
  // Non-numeric values pass through (audit: one account_number is non-numeric)
  assert.equal(normalizeAccountNumber("APEX-01"), "APEX-01");
});

// ── 2. save / load ───────────────────────────────────────────────────────────
test("selection round-trips through storage", () => {
  const s = memStorage();
  saveStoredAccountId("acc-1", s);
  assert.equal(loadStoredAccountId(s), "acc-1");
  assert.equal(s.getItem(ACCOUNT_SELECTION_STORAGE_KEY), "acc-1");
});

test("load/save never throw when storage is unavailable", () => {
  const broken = memStorage({}, true);
  assert.equal(loadStoredAccountId(broken), null); // read path degrades
  assert.doesNotThrow(() => saveStoredAccountId("acc-1", broken)); // write path guarded
  assert.equal(loadStoredAccountId(memStorage({ [ACCOUNT_SELECTION_STORAGE_KEY]: "   " })), null);
});

// ── 3. resolveSelectedAccountId ─────────────────────────────────────────────
test("stored id wins only while it still exists; else first account; else null", () => {
  const a = acct({ id: "a" });
  const b = acct({ id: "b" });
  assert.equal(resolveSelectedAccountId([a, b], "b"), "b"); // stored wins
  assert.equal(resolveSelectedAccountId([a, b], "deleted-id"), "a"); // stale → first
  assert.equal(resolveSelectedAccountId([a, b], null), "a"); // nothing stored → first
  assert.equal(resolveSelectedAccountId([], "b"), null); // no accounts → null
});

// ── 4. findAccount / accountLabel ───────────────────────────────────────────
test("findAccount resolves by id and nulls out unknown/absent", () => {
  const a = acct({ id: "a" });
  assert.equal(findAccount([a], "a"), a);
  assert.equal(findAccount([a], "missing"), null);
  assert.equal(findAccount([a], null), null);
});

test("accountLabel shows name · number, else name · platform, no secrets", () => {
  assert.equal(accountLabel(acct({ name: "X", account_number: "224776" })), "X · 224776");
  assert.equal(accountLabel(acct({ name: "X", platform: "MT5" })), "X · MT5"); // null number
  assert.equal(accountLabel(acct({ name: "X", account_number: "  " })), "X · MT5"); // blank number
  assert.equal(
    accountLabel(acct({ name: null, id: "the-id", platform: null, account_number: null })),
    "the-id", // no name → id; no platform/number → nothing appended
  );
});

// ── 5. resolveMt5Match ──────────────────────────────────────────────────────
test("match: connected login equals account_number on an MT5 account", () => {
  assert.equal(
    resolveMt5Match(acct({ account_number: "224776" }), mt5({ login: "224776" })),
    "match",
  );
  // Trim/whitespace-insensitive, exactly like the dashboard's comparison
  assert.equal(
    resolveMt5Match(acct({ account_number: " 224776 " }), mt5({ login: "224776 " })),
    "match",
  );
});

test("mismatch: connected login differs from account_number", () => {
  assert.equal(
    resolveMt5Match(acct({ account_number: "111111" }), mt5({ login: "224776" })),
    "mismatch",
  );
});

test("unknown: MT5 down, no login, no account, non-MT5, or missing account_number", () => {
  assert.equal(resolveMt5Match(acct({ account_number: "1" }), mt5({ connected: false })), "unknown");
  assert.equal(resolveMt5Match(acct({ account_number: "1" }), mt5({ login: null })), "unknown");
  assert.equal(resolveMt5Match(acct({ account_number: "1" }), null), "unknown");
  assert.equal(resolveMt5Match(null, mt5()), "unknown");
  assert.equal(
    resolveMt5Match(acct({ platform: "MT4", account_number: "1" }), mt5()),
    "unknown",
  );
  // The audit's null account_number accounts — unmatchable, never a false mismatch
  assert.equal(resolveMt5Match(acct({ account_number: null }), mt5()), "unknown");
  assert.equal(resolveMt5Match(acct({ account_number: "  " }), mt5()), "unknown");
});

// ── 6. allowsLiveMt5Data ────────────────────────────────────────────────────
test("only 'mismatch' suppresses live MT5 refreshes", () => {
  assert.equal(allowsLiveMt5Data("match"), true);
  assert.equal(allowsLiveMt5Data("unknown"), true); // P3-C behaviour preserved
  assert.equal(allowsLiveMt5Data("mismatch"), false); // dashboard safety rule
});

// ── 7. mt5MatchMessage ──────────────────────────────────────────────────────
test("messages: match names the login; mismatch names login, server and account", () => {
  const account = acct({ name: "Fund A", account_number: "111" });
  const m = mt5MatchMessage("match", account, mt5({ login: "111" }));
  assert.match(m, /111/);
  assert.match(m, /Fund A/);

  const x = mt5MatchMessage("mismatch", account, mt5({ login: "224776", server: "Srv-Server" }));
  assert.match(x, /224776/);
  assert.match(x, /Srv-Server/);
  assert.match(x, /Fund A/);
  assert.match(x, /never mixed/i); // states the safety behaviour
});

test("messages: every unknown branch is explained and never says 'no trades'", () => {
  const account = acct({ name: "Fund A" }); // null account_number
  const noNumber = mt5MatchMessage("unknown", account, mt5());
  assert.match(noNumber, /no broker account number/i);

  const down = mt5MatchMessage("unknown", acct({ account_number: "1" }), mt5({ connected: false }));
  assert.match(down, /not connected/i);

  const none = mt5MatchMessage("unknown", null, mt5());
  assert.match(none, /No trading account selected/i);

  const fallback = mt5MatchMessage("unknown", acct({ account_number: "1" }), null);
  assert.match(fallback, /cannot be verified/i);

  for (const s of [noNumber, down, none, fallback]) {
    assert.doesNotMatch(s, /no trades/i); // "unknown" must never read as "no trades"
  }
});
