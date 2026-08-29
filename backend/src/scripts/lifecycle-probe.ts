/**
 * Child probe for `npm run lifecycle:test` (scenario D). Runs the REAL
 * lifecycle module — the exact code `src/index.ts` installs — inside a fresh
 * process with a live HTTP server, then triggers SIGTERM handling.
 *
 * Windows cannot deliver cross-process signals, so the probe emits the
 * `SIGTERM` event directly; this executes the EXACT handler a real OS signal
 * invokes. On Linux (Render) the platform delivers a genuine SIGTERM to this
 * same handler.
 *
 * Expected output shape (asserted by shutdown-test.ts):
 *   [PROBE] ready
 *   [SHUTDOWN] SIGTERM received — graceful shutdown starting …
 *   [SHUTDOWN] HTTP server closed — exiting cleanly (code 0).
 * exit code 0
 */
import { createServer } from "node:http";

import { installLifecycle } from "../lib/lifecycle.js";

const server = createServer((_req, res) => {
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  installLifecycle({
    closeHttpServer: (onClosed) => server.close(onClosed),
  });
  console.log("[PROBE] ready");
  // Runs the graceful-shutdown handler synchronously — identical code path to
  // a real SIGTERM from Render (Linux) or Ctrl+C (local).
  process.emit("SIGTERM");
});
