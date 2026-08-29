import type { IgClient } from "./ig/client.js";
import type { CandleStore } from "./db/candleStore.js";
import { RealtimeService, RESOLUTION_BUCKET_SEC } from "./streaming/realtimeService.js";

/**
 * Builds the shared real-time service bound to one IG client + DAX epic.
 * Kept in its own module so boot-time wiring stays tidy and the diagnostic
 * script can reuse the same pieces.
 *
 * `candleStore` (optional) receives every COMPLETED candle via a fire-and-forget
 * upsert AFTER the live websocket fanout — persistence can never slow down or
 * break the realtime path. Pass null to run without persistence.
 */
export function createRealtime(ig: IgClient, epic: string, candleStore?: CandleStore | null): RealtimeService {
  return new RealtimeService(ig, epic, candleStore ?? null);
}

export { RESOLUTION_BUCKET_SEC };

/** Epic identifiers are not credentials; keep the log line short and safe. */
export function redactEpic(epic: string): string {
  return epic.startsWith("IX.D.") ? `IX.D…${epic.split(".").pop()}` : epic;
}