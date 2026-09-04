import type { IgClient } from "./ig/client.js";
import type { CandleStore } from "./db/candleStore.js";
import type { InstrumentMeta } from "./market/instruments.js";
import { RealtimeService, RESOLUTION_BUCKET_SEC } from "./streaming/realtimeService.js";

/**
 * Builds the shared real-time service(s). Kept in its own module so boot-time
 * wiring stays tidy and the diagnostic scripts can reuse the same pieces.
 *
 * `candleStore` (optional) receives every COMPLETED candle via a fire-and-forget
 * upsert AFTER the live websocket fanout — persistence can never slow down or
 * break the realtime path. Pass null to run without persistence.
 */

/** Historic single-instrument wiring (BC): one instrument, DAX in practice. */
export function createRealtime(ig: IgClient, epic: string, candleStore?: CandleStore | null): RealtimeService {
  return new RealtimeService(ig, epic, candleStore ?? null);
}

/**
 * Phase 1 multi-instrument wiring: ONE service, N instruments — one
 * Lightstreamer connection and one fully isolated InstrumentUnit per EPIC
 * (shared IgClient session). instruments[0] is the DEFAULT (DAX in this
 * deployment): snapshot()/stateNow()/closed-candle listeners (EMA engine —
 * untouched) stay bound to it; the remaining instruments are capture-only
 * (aggregate → persist → relay) until a later phase promotes them.
 */
export function createMultiInstrumentRealtime(
  ig: IgClient,
  instruments: readonly InstrumentMeta[],
  candleStore?: CandleStore | null,
): RealtimeService {
  const [first, ...rest] = instruments;
  const service = new RealtimeService(ig, first?.epic ?? "", candleStore ?? null);
  for (const meta of rest) service.addInstrument(meta);
  return service;
}

export { RESOLUTION_BUCKET_SEC };

/** Epic identifiers are not credentials; keep the log line short and safe. */
export function redactEpic(epic: string): string {
  return epic.startsWith("IX.D.") ? `IX.D…${epic.split(".").pop()}` : epic;
}