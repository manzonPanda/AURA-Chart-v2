import type { CapitalClient } from "./capital/client.js";
import type { CandleBackend } from "./db/candleStore.js";
import type { InstrumentMeta } from "./market/instruments.js";
import { RealtimeService, RESOLUTION_BUCKET_SEC } from "./streaming/realtimeService.js";

/**
 * Builds the shared real-time service. Kept in its own module so boot-time
 * wiring stays tidy and the diagnostic scripts can reuse the same pieces.
 *
 * `candleStore` (optional) receives every COMPLETED candle via a fire-and-forget
 * upsert AFTER the live websocket fanout — persistence can never slow down or
 * break the realtime path. Pass null to run without persistence.
 *
 * Provider policy (IG retired): every instrument in `instruments` MUST be a
 * registered CAPITAL-provider instrument; the factory takes NO IG client and
 * RealtimeService refuses to open any stream for a non-CAPITAL provider — an
 * IG/legacy epic silently resolves to a DISCONNECTED state, never an IG
 * connection (there is no fallback to IG if Capital is unavailable).
 */
export function createRealtime(
  instruments: readonly InstrumentMeta[],
  candleStore?: CandleBackend | null,
  /** The Capital.com client — expected whenever Capital credentials are
   *  configured. Null ⇒ every CAPITAL instrument is skipped (DISCONNECTED)
   *  and collection stays OFF until credentials exist (no IG fallback). */
  capital?: CapitalClient | null,
): RealtimeService {
  const [first, ...rest] = instruments;
  const service = new RealtimeService(first?.epic ?? "", candleStore ?? null, capital ?? null);
  for (const meta of rest) service.addInstrument(meta);
  return service;
}

export { RESOLUTION_BUCKET_SEC };

/** Epic identifiers are not credentials; keep the log line short and safe. */
export function redactEpic(epic: string): string {
  return epic.startsWith("IX.D.") ? `IX.D…${epic.split(".").pop()}` : epic;
}
