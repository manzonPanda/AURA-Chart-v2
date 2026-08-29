/**
 * Official IG flow — VERIFIED against IG's CURRENT API Companion code
 * (popup.js caller + encryption.js wrapper + pidCrypt rsa_c.js):
 *  1. GET  /session/encryptionKey -> { encryptionKey, timeStamp }
 *  2. popup.js: PS.util.encryption.encrypt(password + "|" + timeStamp, encryptionKey)
 *     - pidCrypt.RSA.encrypt(): inner = base64(password|timeStamp)  ← inner base64 FIRST
 *     - pkcs1pad2():            PKCS#1 v1.5 type-2 over the inner-b64 bytes
 *     - wire value:             base64(cipher bytes)   (hex -> bytes -> base64)
 *  3. POST /session (Version 2) -> { identifier, password: <cipher>, encryptedPassword: true }
 *  4. capture the `CST` + `X-SECURITY-TOKEN` response headers.
 *
 * Node equivalence notes (verified from vendor source):
 *  - pkcs1pad2 stores raw charCodes; the RSA input is always the inner-base64
 *    string (pure ASCII), so charCode bytes == UTF-8 bytes.
 *  - base64(hex->bytes) == Buffer(cipher).toString("base64").
 *
 * The cipher is fresh each call (new key per request); no password is stored.
 */
import crypto from "node:crypto";
import type { IgCredentials } from "../config.js";
import { IgApiError } from "./errors.js";

export const API_KEY_HEADER = "X-IG-API-KEY";

export interface IgSession {
  cst: string;
  xSecurityToken: string;
  /**
   * IG Lightstreamer WebSocket endpoint returned by /session (e.g.
   * https://push.ig.com for live). This is provided by IG at login time and
   * must NOT be hardcoded. Absent on some gateways/limits.
   */
  lightstreamerEndpoint?: string;
  /** Account identifier to present as the Lightstreamer username. */
  lightstreamerAccountId?: string;
  /** Fallback account id parsed from the session body when available. */
  accountId?: string;
}

/**
 * IG returns /session/encryptionKey as a raw base64 SPKI (DER) string with NO
 * PEM headers or line breaks. Node (> v17 / OpenSSL 3) refuses to auto-decode
 * that, so we wrap it into a well-formed `-----BEGIN PUBLIC KEY-----` PEM first.
 * If IG ever supplies an already-formed PEM, we pass it through untouched.
 */
export function toPemPublicKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) {
    return trimmed;
  }
  const wrapped = trimmed.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${wrapped.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Official IG Companion construction (popup.js + encryption.js + rsa_c.js):
 *   1. m0    : password + "|" + timeStamp     (timeStamp from /session/encryptionKey)
 *   2. inner : base64(m0)                      ← pidCrypt.RSA.encrypt base64s FIRST
 *   3. cipher: RSA_PKCS1_PADDING over the inner-b64 ASCII bytes
 *   4. wire  : base64(cipher bytes)
 */
export function encryptPassword(
  publicKey: string,
  password: string,
  timeStamp: string | number,
): string {
  const key = crypto.createPublicKey(toPemPublicKey(publicKey));
  const inner = Buffer.from(`${password}|${String(timeStamp)}`, "utf8").toString("base64");
  return crypto
    .publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(inner, "utf8"))
    .toString("base64");
}

interface EncryptionKeyResponse {
  encryptionKey?: string;
  timeStamp?: string | number;
}

async function getEncryptionKey(
  creds: IgCredentials,
): Promise<{ key: string; timeStamp: string | number }> {
  const res = await igRawFetch(`${creds.baseUrl}/session/encryptionKey`, {
    method: "GET",
    headers: { [API_KEY_HEADER]: creds.apiKey },
    timeoutMs: 15000,
  });
  if (!res.ok) {
    throw new IgApiError("upstream", res.status, "IG did not return an encryption key.");
  }
  const body = (await res.json().catch(() => null)) as EncryptionKeyResponse | null;
  if (!body?.encryptionKey || body.timeStamp == null) {
    throw new IgApiError("malformed", 502, "IG returned an invalid encryption key response.");
  }
  return { key: body.encryptionKey, timeStamp: body.timeStamp };
}

/** Create a fresh IG session and return the CST + X-SECURITY-TOKEN tokens. */
export async function createSession(creds: IgCredentials): Promise<IgSession> {
  let encryption: { key: string; timeStamp: string | number };
  try {
    encryption = await getEncryptionKey(creds);
  } catch (err) {
    throw err instanceof IgApiError ? err : new IgApiError("network", 502, "Could not reach IG.");
  }

  const encryptedPassword = encryptPassword(encryption.key, creds.password, encryption.timeStamp);

  const res = await igRawFetch(`${creds.baseUrl}/session`, {
    method: "POST",
    headers: {
      [API_KEY_HEADER]: creds.apiKey,
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "application/json; charset=UTF-8",
      // Encrypted-password auth is the V2 login flow for affected accounts.
      Version: creds.sessionVersion || "2",
    },
    body: JSON.stringify({
      identifier: creds.username,
      password: encryptedPassword,
      encryptedPassword: true,
    }),
    timeoutMs: 20000,
  });

  const cst = res.headers.get("cst") ?? "";
  const xSecurityToken = res.headers.get("x-security-token") ?? "";

  if (!res.ok || !cst || !xSecurityToken) {
    const body = (await res.json().catch(() => null)) as { errorCode?: string } | null;
    const code = body?.errorCode ?? "";
    const hint =
      code === "error.security.client-suspended"
        ? "The API key is suspended — re-enable it in the IG app dashboard."
        : code.startsWith("validation.pattern")
          ? "IG rejected the username format — verify the identifier your platform uses."
          : code === "error.security.invalid-details"
            ? "Credentials do not match this environment (check key/username/password)."
            : "";
    // Raw IG errorCode rides along for SERVER-side diagnostics only.
    throw new IgApiError(
      "auth",
      401,
      ["IG authentication failed.", hint].filter(Boolean).join(" "),
      code || undefined,
    );
  }

  // Success: read the Lightstreamer endpoint / streaming account identifiers
  // from the session body. They are part of the login response and subject to
  // change, so they are never hardcoded.
  const sessionBody = (await res.json().catch(() => null)) as {
    lightstreamerEndpoint?: string;
    lightstreamerAccountId?: string;
    accountId?: string;
  } | null;

  return {
    cst,
    xSecurityToken,
    lightstreamerEndpoint: sessionBody?.lightstreamerEndpoint || undefined,
    lightstreamerAccountId: sessionBody?.lightstreamerAccountId || undefined,
    accountId: sessionBody?.accountId || undefined,
  };
}

async function igRawFetch(url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    return await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}