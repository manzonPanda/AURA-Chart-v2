/**
 * Production process lifecycle (Render hardening).
 *
 * Render sends SIGTERM on every deploy/restart. Without a handler the process
 * is killed wherever it happens to be; with this module the backend runs:
 *
 *   SIGTERM / SIGINT
 *     → stops accepting new work (WS upgrades rejected, HTTP server closed)
 *     → disconnects Lightstreamer cleanly (RealtimeService.stop())
 *     → permanently stops reconnect/heartbeat timers
 *     → exits cleanly (failsafe timeout guarantees exit even if a socket lingers)
 *
 * Fatal guards: `uncaughtException` / `unhandledRejection` are logged with
 * secrets redacted, then the process exits with code 1 so the platform
 * restarts it — an unknown half-broken state is never kept alive. Registering
 * these handlers would otherwise SUPPRESS Node's crash-by-default behaviour,
 * so the crash semantics are re-implemented explicitly. Errors are never hidden.
 *
 * Deliberately NOT touched: aggregation, MID math, bucket math, persistence,
 * Supabase schema, frontend. This module only orchestrates process teardown.
 */
import { describeUnknown } from "./redact.js";
import type { SecretRedactor } from "./redact.js";

export interface LifecycleHooks {
  /** Fatal/shutdown logs are passed through this redactor. */
  redactor?: SecretRedactor;
  /** Stop the realtime service: disconnect Lightstreamer + clear all timers. */
  stopRealtime?: () => void;
  /** Close the WebSocket relay (disconnects all browser sockets). */
  closeWebSocketServer?: () => void;
  /** Stop accepting new HTTP connections; `onClosed` fires when fully drained. */
  closeHttpServer?: (onClosed: () => void) => void;
  /** Hard cap before the failsafe forces exit. Default 10 s (Render waits ~30 s). */
  shutdownTimeoutMs?: number;
}

export interface LifecycleController {
  /** True from the moment shutdown begins — reject new work (e.g. WS upgrades). */
  isShuttingDown(): boolean;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function installLifecycle(hooks: LifecycleHooks = {}): LifecycleController {
  const timeoutMs = hooks.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const redact = (value: unknown): string =>
    hooks.redactor ? hooks.redactor.describe(value) : describeUnknown(value);

  let shuttingDown = false;

  const gracefulShutdown = (signal: string): void => {
    if (shuttingDown) {
      // Second signal: the operator/platform wants out NOW.
      console.log(`[SHUTDOWN] ${signal} received again — exiting immediately.`);
      process.exit(0);
    }
    shuttingDown = true;
    console.log(`[SHUTDOWN] ${signal} received — graceful shutdown starting (timeout ${timeoutMs}ms).`);

    // 1) Disconnect Lightstreamer + permanently stop reconnect/heartbeat timers.
    //    Runs FIRST so no in-flight reconnect can open a new IG connection while
    //    the HTTP surface is torn down (connectStream also re-checks `started`).
    try {
      hooks.stopRealtime?.();
    } catch (err) {
      console.error("[SHUTDOWN] stopRealtime failed:", redact(err));
    }

    // 2) Close browser WebSocket sockets (ws close code 1001).
    try {
      hooks.closeWebSocketServer?.();
    } catch (err) {
      console.error("[SHUTDOWN] closeWebSocketServer failed:", redact(err));
    }

    // 3) Stop accepting new HTTP connections, drop idle keep-alives, drain
    //    active requests. The failsafe guarantees the process ALWAYS exits.
    const failsafe = setTimeout(() => {
      console.error(`[SHUTDOWN] graceful close did not finish within ${timeoutMs}ms — forcing exit.`);
      process.exit(0);
    }, timeoutMs);

    const onClosed = (): void => {
      clearTimeout(failsafe);
      console.log("[SHUTDOWN] HTTP server closed — exiting cleanly (code 0).");
      process.exit(0);
    };

    if (hooks.closeHttpServer) {
      try {
        hooks.closeHttpServer(onClosed);
      } catch (err) {
        console.error("[SHUTDOWN] closeHttpServer failed:", redact(err));
        clearTimeout(failsafe);
        process.exit(0);
      }
    } else {
      onClosed();
    }
  };

  // `on` (not `once`) so a SECOND signal hits the force-exit branch above.
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    console.error("[FATAL] Uncaught exception — exiting for platform restart:", redact(err));
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] Unhandled promise rejection — exiting for platform restart:", redact(reason));
    process.exit(1);
  });

  return { isShuttingDown: () => shuttingDown };
}
