/**
 * `npm run lifecycle:test` — OFFLINE production-hardening test for the process
 * lifecycle. No provider network calls, no DB; the only network touch is a
 * guaranteed-refused localhost port inside one regression check.
 *
 * Scenarios:
 *   A  Crash-path redaction — Capital API key/password, session CST & XST, the
 *      PostgreSQL password and the Supabase service-role key are masked in
 *      fatal-style logs (Error values AND plain-object reasons), with
 *      truncation for huge payloads.
 *   B  RealtimeService refuses to open a stream for a non-CAPITAL (IG/legacy)
 *      instrument — NO provider session is ever requested and NO stream object
 *      is created (IG is retired; there is NO fallback). stop() permanently
 *      clears the reconnect/heartbeat timers (zero unexpected pending
 *      Timers/Sockets).
 *   C  A CAPITAL instrument WITHOUT a CapitalClient stays DISCONNECTED
 *      (collection off until credentials exist) — never an IG/secondary
 *      provider attempt. stop() leaves no pending timers or sockets.
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

import type { CapitalClient } from "../capital/client.js";
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
 * once fired, so anything left above baseline is a LEAK (e.g. a stream
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
    "SUP3R_SECRET_CAPITAL_API_PASSWORD",
    "CAP-API-KEY-VALUE-123456",
    "CST-session-token-abcdef",
    "XST-session-token-abcdef",
    "pg-password-000-aura",
    "supabase-service-role-key-000",
  ];
  const redactor = new SecretRedactor(() => SECRETS);

  const leak =
    `auth failed: password ${SECRETS[0]} key ${SECRETS[1]} ` +
    `CST ${SECRETS[2]} XST ${SECRETS[3]} pg ${SECRETS[4]} supabase ${SECRETS[5]}`;
  const outError = redactor.describe(new Error(leak));
  check(
    "A1. Error log masks Capital API key/password, CST, XST, PG and Supabase secrets",
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

/** A Capital client spy: records session requests, never yields anything. */
function capitalSpy(): {
  capital: CapitalClient;
  sessionRequests(): number;
} {
  let sessionRequests = 0;
  const capital = {
    redactables: (): string[] => ["SPY-KEY", "SPY-SECRET"],
    getStreamingInfo: (): { url: string } => ({ url: "ws://127.0.0.1:9/connect" }),
    getStreamSession: async (): Promise<never> => {
      sessionRequests += 1;
      throw new Error("lifecycle-test: no Capital session available");
    },
  } as unknown as CapitalClient;
  return { capital, sessionRequests: () => sessionRequests };
}

// ── B. IG/legacy provider is refused; stop() clears timers ───────────────────
// The in-flight-auth race that used to live here is GONE by design: there is
// no IG auth anymore. The guarantee now is that a non-CAPITAL provider never
// even asks for a session and never creates a stream object.
async function scenarioB(): Promise<void> {
  const baseline = activeResources();
  const { capital, sessionRequests } = capitalSpy();
  const svc = new RealtimeService("TEST.EPIC", null, capital); // unregistered → legacy "IG" provider label
  await svc.start(); // connectStream must REFUSE before any session fetch
  await delay(120);
  check(
    "B1. IG-provider instrument stays DISCONNECTED (provider refused, no fallback)",
    svc.snapshot().state === "DISCONNECTED",
  );
  check("B2. NO provider session was ever requested", sessionRequests() === 0, `requests=${sessionRequests()}`);
  const leaksBefore = leaksAboveBaseline(baseline);
  svc.stop(); // must clear BOTH timers permanently — shutdown disables reconnect
  await delay(120);
  const leaks = leaksAboveBaseline(baseline);
  check(
    "B3. stop() leaves zero pending timers/sockets (reconnect + heartbeat cleared)",
    leaks <= 0 && leaksBefore >= 0, // before-stop a reconnect timer legitimately exists
    `leaks=${leaks} resources=[${activeResources().join(",")}]`,
  );
  check("B4. state is DISCONNECTED after stop()", svc.snapshot().state === "DISCONNECTED");
}

// ── C. CAPITAL instrument without a CapitalClient stays OFF (no IG fallback) ─
async function scenarioC(): Promise<void> {
  const baseline = activeResources();
  const svc = new RealtimeService("GOLD", null, null); // CAPITAL provider, no client
  await svc.start(); // capital path: no client → refused, DISCONNECTED, reconnect timer
  await delay(120);
  check(
    "C1. CAPITAL instrument without a client stays DISCONNECTED (collection off — never an IG/secondary attempt)",
    svc.snapshot().state === "DISCONNECTED",
  );
  check("C2. no stream ever reached LIVE", svc.snapshot().instruments.every((i) => i.state !== "LIVE"));
  svc.stop();
  await delay(120);
  const leaks = leaksAboveBaseline(baseline);
  check("C3. stop() leaves zero pending timers/sockets", leaks <= 0, `leaks=${leaks}`);
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
