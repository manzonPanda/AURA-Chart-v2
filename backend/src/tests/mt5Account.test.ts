/**
 * P3-D tests — read-only MT5 account identity reader + its normalization.
 * The reader talks to the EXISTING pythonMt5 REST endpoint (no new transport);
 * these tests pin payload normalization and the unavailability reasons without
 * requiring a live bridge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MT5_ACCOUNT_INFO_PATH,
  createMt5AccountReader,
  normalizeMt5Login,
  readMt5Account,
  resolveMt5BridgeSettings,
  toMt5AccountIdentity,
  unavailableMt5Identity,
} from "../services/mt5Account.js";

test("MT5_ACCOUNT_INFO_PATH is the existing pythonMt5 endpoint", () => {
  assert.equal(MT5_ACCOUNT_INFO_PATH, "/api/account_info");
});

test("normalizeMt5Login: trim, never fabricate", () => {
  assert.equal(normalizeMt5Login(" 224776 "), "224776");
  assert.equal(normalizeMt5Login(224776), "224776");
  assert.equal(normalizeMt5Login(""), null);
  assert.equal(normalizeMt5Login(null), null);
  assert.equal(normalizeMt5Login(undefined), null);
  assert.equal(normalizeMt5Login("   "), null);
});

test("toMt5AccountIdentity: pythonMt5 build_account_payload shape → identity", () => {
  const id = toMt5AccountIdentity({
    login: 224776,
    name: "Some Name",
    server: "FundedTraderMarkets-Server",
    balance: 10000,
    starting_balance: 10000,
    info: {},
  });
  assert.equal(id.connected, true);
  assert.equal(id.login, "224776");
  assert.equal(id.server, "FundedTraderMarkets-Server");
  assert.equal(id.reason, "ok");
});

test("toMt5AccountIdentity: pythonMt5 disconnected shape (all-null payload)", () => {
  const id = toMt5AccountIdentity({ login: null, name: null, server: null, balance: 0, info: {} });
  assert.equal(id.connected, false);
  assert.equal(id.login, null);
  assert.notEqual(id.reason, null);
});

test("toMt5AccountIdentity: malformed payloads never crash and never fake a login", () => {
  for (const bad of [null, undefined, "garbage", 42, {}, { login: "  " }]) {
    const id = toMt5AccountIdentity(bad);
    assert.equal(typeof id.connected, "boolean");
    if (id.login === null) assert.equal(id.connected, false);
  }
});

test("unavailableMt5Identity: explicit reason, connected=false, no login", () => {
  const id = unavailableMt5Identity("unreachable");
  assert.equal(id.connected, false);
  assert.equal(id.login, null);
  assert.equal(id.reason, "unreachable");
});

test("resolveMt5BridgeSettings: env overrides, defaults preserved", () => {
  const s = resolveMt5BridgeSettings({ ...process.env, MT5_BRIDGE_URL: "http://127.0.0.1:5000", MT5_BRIDGE_TIMEOUT_MS: "1500" });
  assert.equal(s.baseUrl, "http://127.0.0.1:5000");
  assert.equal(s.timeoutMs, 1500);
  const d = resolveMt5BridgeSettings({});
  assert.ok(d.baseUrl.startsWith("http"));
  assert.ok(d.timeoutMs > 0);
  // garbage timeout falls back instead of NaN-propagating
  const g = resolveMt5BridgeSettings({ MT5_BRIDGE_TIMEOUT_MS: "not-a-number" });
  assert.ok(Number.isFinite(g.timeoutMs) && g.timeoutMs > 0);
});

test("readMt5Account: transport failure → unreachable identity (never throws)", async () => {
  const id = await readMt5Account({ baseUrl: "http://127.0.0.1:1", timeoutMs: 200 });
  assert.equal(id.connected, false);
  assert.equal(id.login, null);
  assert.notEqual(id.reason, null);
});

test("createMt5AccountReader: identity reachable through the real reader", async () => {
  // Bridge offline in the test env → reader degrades to unreachable (never throws);
  // the factory wiring (settings → readMt5Account) is exercised for real.
  const reader = createMt5AccountReader({ baseUrl: "http://127.0.0.1:1", timeoutMs: 200 });
  const id = await reader();
  assert.equal(id.connected, false);
  assert.equal(id.login, null);
});
