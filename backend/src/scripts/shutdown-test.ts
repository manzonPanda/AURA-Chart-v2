/**
 * `npm run lifecycle:test` — OFFLINE production-hardening test for the process
 * lifecycle added before the Render deployment. No IG calls, no DB; the only
 * network touch is a guaranteed-refused localhost port inside one regression
 * check (and only if the in-flight-connect guard has regressed).
 *
 * Scenarios:
 *   A  Crash-path redaction — IG password / API key, session CST & XST and the
 *      Supabase service-role key are masked in fatal-style logs (Error values
 *      AND plain-object reasons), with truncation for huge payloads.
 *   B  RealtimeService.stop() permanently clears the Lightstreamer reconnect
 *      timer and the status heartbeat (zero unexpected pending Timers/Sockets).
 *   C  Shutdown racing an in-flight auth CANNOT open a new IG connection: the
 *      session resolves AFTER stop() and connectStream must refuse it. If the
 *      guard ever regresses, a real Lightstreamer client is created against an
 *      unreachable endpoint and holds a retry timer/socket → the check fails.
 *   D  The REAL lifecycle module, in a child process with a live HTTP server,
 *      runs its full graceful-shutdown path and exits with code 0 in order.
 *      (Windows cannot deliver cross-process signals — the probe triggers the
 *      same handler event directly; Render's Linux runtime delivers the real
 *      SIGTERM to this exact code.)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { IgClient, StreamSessionInfo } from "../ig/client.js";
import { SecretRedactor } from "../lib/redact.js";
import { RealtimeService } from "../streaming/realtimeService.js";

let failed = false;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pending event-loop resources (Timeout/Socket/…) right now. */
function activeResources(): string[] {
  return process.getActiveResourcesInfo();
}

/**
 * Timers/sockets above a measured baseline. Our own `delay()` timers are gone
 * once fired, so anything left above baseline is a LEAK (e.g. a Lightstreamer
 * reconnect timer that should have been cleared).
 */
function leaksAboveBaseline(baseline: string[]): number {
  const sensitive = (list: string[]): number =>
    list.filter((r) => r === "Timeout" || r === "Socket").length;
  return sensitive(activeResources()) - sensitive(baseline);
}

// ── A. Crash-path secret redaction ──────────────────────────────────────────
function scenarioA(): void {
  const SECRETS = [
    "SUP3R_SECRET_IG_PASSWORD",
    "IG-API-KEY-VALUE-123456",
    "CST-session-token-abcdef",
    "XST-session-token-abcdef",
    "supabase-service-role-key-000",
  ];
  const redactor = new SecretRedactor(() => SECRETS);

  const leak =
    `auth failed: password ${SECRETS[0]} key ${SECRETS[1]} ` +
    `CST ${SECRETS[2]} XST ${SECRETS[3]} supabase ${SECRETS[4]}`;
  const outError = redactor.describe(new Error(leak));
  check(
    "A1. Error log masks IG password/API key, CST, XST and Supabase key",
    !SECRETS.some((s) => outError.includes(s)) && outError.includes("[REDACTED]"),
    outError.slice(0, 100),
  );

  const huge = "T".repeat(10_000);
  const outObj = redactor.describe({ note: "unexpected rejection", token: huge });
  check(
    "A2. plain-object reason redacted + truncated",
    !outObj.includes(huge) && outObj.length < 5_000,
    `len=${outObj.length}`,
  );
}

// ── B. stop() clears reconnect + heartbeat timers ───────────────────────────
async function scenarioB(): Promise<void> {
  const baseline = activeResources();
  let authCalls = 0;
  const ig = {
    getStreamSession: async (): Promise<StreamSessionInfo> => {
      authCalls += 1;
      throw new Error("lifecycle-test: no IG session available");
    },
  } as unknown as IgClient;

  const svc = new RealtimeService(ig, "TEST.EPIC", null);
  await svc.start(); // connectStream fails → DISCONNECTED → 5s reconnect timer (+30s heartbeat)
  svc.stop();        // must clear BOTH timers permanently — shutdown disables reconnect

  await delay(120); // settle microtasks; our delay timer is gone once fired
  const leaks = leaksAboveBaseline(baseline);
  // leaks < 0 is fine — it just means some transient baseline resource (tsx
  // internals) expired meanwhile. A leak would ADD resources: reconnect (+1),
  // heartbeat (+1), or both (+2).
  check("B1. stop() leaves zero pending timers (reconnect + heartbeat cleared)", leaks <= 0,
    `leaks=${leaks} resources=[${activeResources().join(",")}]`);
  check("B2. auth attempted exactly once (no reconnect cycle)", authCalls === 1, `calls=${authCalls}`);
  check("B3. state is DISCONNECTED after stop()", svc.snapshot().state === "DISCONNECTED");
}

// ── C. shutdown races an in-flight auth → no new IG connection ──────────────
async function scenarioC(): Promise<void> {
  const baseline = activeResources();
  let releaseSession: ((session: StreamSessionInfo) => void) | null = null;
  const ig = {
    getStreamSession: (): Promise<StreamSessionInfo> =>
      new Promise<StreamSessionInfo>((resolve) => {
        releaseSession = resolve;
      }),
  } as unknown as IgClient;

  const svc = new RealtimeService(ig, "TEST.EPIC", null);
  const starting = svc.start(); // auth in flight — session NOT resolved yet
  svc.stop();                   // SIGTERM-equivalent: shutdown starts NOW
  releaseSession!({
    endpoint: "wss://127.0.0.1:9", // unreachable — a real LS client would retry forever
    accountId: "TEST_ACCOUNT",
    cst: "FAKE_CST_TOKEN_lifecycle_test",
    xSecurityToken: "FAKE_XST_TOKEN_lifecycle_test",
  });
  await starting;
  await delay(600);

  const leaks = leaksAboveBaseline(baseline);
  // leaks < 0 is fine (transient baseline resource expired) — see scenario B.
  // A regression would ADD a Lightstreamer client retry timer/socket (+1).
  check("C1. session resolved after stop() opens NO new IG connection (no LS retry timer)",
    leaks <= 0, `leaks=${leaks} resources=[${activeResources().join(",")}]`);
  check("C2. state stays DISCONNECTED after the shutdown race", svc.snapshot().state === "DISCONNECTED");
}

// ── D. real lifecycle module: full graceful shutdown in a child process ─────
async function scenarioD(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const backendRoot = path.resolve(here, "..", "..");
  const distProbe = path.join(backendRoot, "dist", "scripts", "lifecycle-probe.js");
  const srcProbe = path.join(here, "lifecycle-probe.ts");

  // Prefer the COMPILED module when a build exists (exactly what Render runs);
  // otherwise run the TS source through tsx so the check works pre-build.
  const useDist = existsSync(distProbe);
  const args = useDist ? [distProbe] : ["--import", "tsx", srcProbe];

  const child = spawn(process.execPath, args, { cwd: backendRoot, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let errOut = "";
  child.stdout?.on("data", (chunk: Buffer) => { out += String(chunk); });
  child.stderr?.on("data", (chunk: Buffer) => { errOut += String(chunk); });

  const result = await Promise.race([
    new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
    delay(10_000).then(() => null),
  ]);

  if (result === null) {
    child.kill("SIGKILL");
    check(`D1. graceful shutdown exits (probe=${useDist ? "dist" : "tsx"})`, false, "timed out after 10s");
    return;
  }

  const lines = out.split(/\r?\n/);
  const idxReady = lines.findIndex((l) => l.includes("[PROBE] ready"));
  const idxStart = lines.findIndex((l) => l.includes("graceful shutdown starting"));
  const idxClosed = lines.findIndex((l) => l.includes("exiting cleanly"));
  check(`D1. SIGTERM handled → exit code 0 (probe=${useDist ? "dist" : "tsx"})`, result === 0,
    `code=${result}${errOut.trim() ? ` stderr=${errOut.trim().slice(0, 200)}` : ""}`);
  check("D2. shutdown log order: ready → starting → closed cleanly",
    idxReady !== -1 && idxStart > idxReady && idxClosed > idxStart,
    out.trim().split(/\r?\n/).join(" | ").slice(0, 220));
}

async function main(): Promise<void> {
  console.log("=== lifecycle:test — offline production-hardening checks ===\n");
  scenarioA();
  console.log("");
  await scenarioB();
  console.log("");
  await scenarioC();
  console.log("");
  await scenarioD();
  console.log("");
  console.log(failed ? "RESULT  : FAIL" : "RESULT  : SUCCESS");
  process.exit(failed ? 1 : 0);
}

void main();
