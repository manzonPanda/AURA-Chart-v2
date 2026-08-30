// One-attempt IG live credential check. Prints NO secrets — only shapes/verdicts.
// Construction mirrors backend/src/ig/auth.ts exactly:
//   cipher = base64( RSA_PKCS1v1.5( utf8( base64(password + "|" + timeStamp) ) ) )
import "dotenv/config";
// Node's crypto MODULE is required for createPublicKey/publicEncrypt — the bare
// `crypto` global in an ES module is the WebCrypto object, which has neither.
import crypto from "node:crypto";

const apiKey = process.env.IG_API_KEY ?? "";
const username = process.env.IG_USERNAME ?? "";
const password = process.env.IG_PASSWORD ?? "";
const baseUrl = process.env.IG_BASE_URL ?? "https://api.ig.com/gateway/deal";
const version = process.env.IG_SESSION_VERSION ?? "2";

if (!apiKey || !username || !password) {
  console.error("RESULT : FAIL — IG_API_KEY / IG_USERNAME / IG_PASSWORD not all set");
  process.exit(1);
}

console.log(`gateway : ${new URL(baseUrl).host}`);
console.log(`shape   : key=${apiKey.length}ch user=${username.length}ch pass=${password.length}ch`);

let keyOk = false;
let tsReceived = false;
try {
  const r = await fetch(`${baseUrl}/session/encryptionKey`, {
    headers: { "X-IG-API-KEY": apiKey, Accept: "application/json; charset=UTF-8" },
  });
  keyOk = r.ok;
  if (r.ok) {
    const j = await r.json();
    tsReceived = j.timeStamp !== undefined && j.timeStamp !== null;
  }
} catch {
  keyOk = false;
}
console.log(`key     : ${keyOk ? "PASS" : "FAIL"}${tsReceived ? " (timeStamp=received)" : ""}`);
if (!keyOk) {
  console.log("RESULT  : FAIL — key rejected by this gateway");
  process.exit(1);
}

try {
  const ek = await (await fetch(`${baseUrl}/session/encryptionKey`, {
    headers: { "X-IG-API-KEY": apiKey, Accept: "application/json; charset=UTF-8" },
  })).json();

  const spki = Buffer.from(ek.encryptionKey, "base64");
  const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });

  const inner = Buffer.from(`${password}|${ek.timeStamp}`, "utf8").toString("base64");
  const cipher = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(inner, "utf8"),
  );
  const encryptedPassword = cipher.toString("base64");

  const r = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "application/json; charset=UTF-8",
      "X-IG-API-KEY": apiKey,
      Version: version,
    },
    body: JSON.stringify({ identifier: username, password: encryptedPassword, encryptedPassword: true }),
  });

  const cst = r.headers.get("cst");
  if (r.ok && cst) {
    console.log("login   : PASS");
    console.log("RESULT  : SUCCESS");
  } else {
    let code = "unknown";
    try { code = (await r.json())?.errorCode ?? code; } catch {}
    console.log(`login   : FAIL (${code})`);
    console.log("RESULT  : FAIL — credentials rejected");
  }
} catch (err) {
  // A throw here is NOT necessarily a network error — it can come from the
  // crypto steps or response parsing too. Report the real error class/message
  // (never secret-bearing; truncated defensively).
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.log(`login   : FAIL (${reason.slice(0, 160)})`);
  console.log("RESULT  : FAIL — login could not be completed (see reason above)");
}
