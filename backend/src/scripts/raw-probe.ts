/**
 * TEMPORARY probe: login once, then call /prices with max=1 and print the RAW
 * HTTP status + body errorCode + allowance block — identifies the exact IG
 * rejection reason (allowance vs token). Prints no credentials.
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { createSession } from "../ig/auth.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const session = await createSession({ ...config.ig });
  console.log("login: OK (CST/XST received)");

  const url = `${config.ig.baseUrl}/prices/${config.ig.defaultEpic}?resolution=MINUTE_15&max=1&pageSize=1`;
  const res = await fetch(url, {
    headers: {
      "X-IG-API-KEY": config.ig.apiKey,
      CST: session.cst,
      "X-SECURITY-TOKEN": session.xSecurityToken,
      ...(config.ig.accountId ? { "X-IG-ACCOUNT-ID": config.ig.accountId } : {}),
      Version: "3",
      Accept: "application/json; charset=UTF-8",
    },
  });
  console.log(`GET /prices -> HTTP ${res.status}`);
  console.log(`remainingAllowance header: ${res.headers.get("x-cap-allowance-remaining") ?? "(none)"}`);
  const body = await res.json().catch(() => null);
  console.log("body:", JSON.stringify(body)?.slice(0, 600));
}
void main();
