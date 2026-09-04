/**
 * WS client-seed registry — first frames for freshly-connected clients.
 *
 * Deliberately dependency-free (no ws / lightstreamer imports) so it is
 * unit-testable in isolation: the lightstreamer-client package keeps the
 * Node event loop alive once imported, which would hang the test runner.
 *
 * Used by RealtimeService.addClient to deliver auxiliary first frames —
 * e.g. the CURRENT EMA-alert snapshot, so a browser reconnecting after a
 * backend restart restores its UI state immediately (P1 fix).
 */

/** One seed frame, or null when a seeder has nothing to send right now. */
export type SeedFrame = Record<string, unknown> | null;

export class ClientSeeders {
  private readonly seeders = new Set<() => SeedFrame>();

  /** Register a hook returning one frame per new client (or null to skip). */
  add(seeder: () => SeedFrame): void {
    this.seeders.add(seeder);
  }

  /**
   * Collect the frames to seed a new client with. A throwing seeder never
   * breaks the connect path nor blocks the remaining seeders.
   */
  frames(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const seeder of this.seeders) {
      try {
        const frame = seeder();
        if (frame) out.push(frame);
      } catch {
        /* a seeder must never break connect */
      }
    }
    return out;
  }
}