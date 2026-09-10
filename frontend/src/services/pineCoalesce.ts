/**
 * Per-key coalescing of asynchronous computations — the heart of PineBridge's
 * per-indicator flight control (killzone fix).
 *
 * PROBLEM IT SOLVES
 *   PineBridge recomputes on every realtime frame. A heavy Pine drawing script
 *   (killzone boxes, session envelopes) takes longer to compute than the
 *   inter-tick interval. A global generation counter that invalidates every
 *   computation whenever ANY newer frame arrives therefore discards the heavy
 *   result EVERY time during active trading — the killzone never paints.
 *
 * CONTRACT (all state is synchronous — safe under rapid effect triggers):
 *   - `begin(key)` reserves ONE flight for `key`. If a flight is already in
 *     flight, it returns null and the caller must `markDirty(key)`: the update
 *     is remembered, never queued.
 *   - A flight token's `current` state is generation-checked per key:
 *     `isCurrent(key, token)` is true ONLY while this exact flight is still the
 *     latest for its key — a stale/cancelled result can never paint.
 *   - `finish(key, token)` releases the flight and returns true when the key is
 *     dirty → the caller immediately begins EXACTLY ONE follow-up. The dirty
 *     flag is cleared at that point, so at most one flight + one pending flag
 *     exist per key — no queue is ever built.
 *   - `cancel(key)` aborts everything for a key (layout change / teardown):
 *     any in-flight result becomes stale and no follow-up is scheduled.
 *   - Keys are independent: a heavy indicator never blocks a light one.
 *
 * Pure + framework-free (Node-testable, no React/DOM/engine imports).
 */
export class CoalescedFlights {
  private readonly busy = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly gen = new Map<string, number>();

  /** Reserve a flight for `key`. Returns null when one is already in flight
   *  (the caller should mark the key dirty instead). Otherwise returns a token
   *  for THIS exact flight (generation-checked by `isCurrent`). */
  begin(key: string): { id: number } | null {
    if (this.busy.has(key)) return null;
    this.busy.add(key);
    const id = (this.gen.get(key) ?? 0) + 1;
    this.gen.set(key, id);
    return { id };
  }

  /** True only while `token` is still the LATEST flight for `key`. */
  isCurrent(key: string, token: { id: number }): boolean {
    return this.busy.has(key) && this.gen.get(key) === token.id;
  }

  /** An update arrived while `key`'s flight was in flight — remember it for a
   *  single follow-up. Never enqueues a computation. */
  markDirty(key: string): void {
    this.dirty.add(key);
  }

  /**
   * Release `key`'s flight. Returns true when a dirty follow-up is pending —
   * the caller must immediately `begin(key)` again (exactly one follow-up).
   * When the token is stale (cancelled / superseded) returns false without
   * touching the current flight state — a stale result has no effect.
   */
  finish(key: string, token: { id: number }): boolean {
    if (this.gen.get(key) !== token.id) return false;
    this.busy.delete(key);
    if (this.dirty.has(key)) {
      this.dirty.delete(key);
      return true;
    }
    return false;
  }

  /** Abort everything for `key`: any in-flight result becomes stale (its token
   *  can no longer paint) and the dirty flag is cleared. */
  cancel(key: string): void {
    this.busy.delete(key);
    this.dirty.delete(key);
    this.gen.set(key, (this.gen.get(key) ?? 0) + 1);
  }

  /** Abort every flight (full teardown). */
  cancelAll(): void {
    for (const key of this.busy) this.gen.set(key, (this.gen.get(key) ?? 0) + 1);
    this.busy.clear();
    this.dirty.clear();
  }

  isInFlight(key: string): boolean {
    return this.busy.has(key);
  }

  isDirty(key: string): boolean {
    return this.dirty.has(key);
  }

  get inFlightCount(): number {
    return this.busy.size;
  }

  get dirtyCount(): number {
    return this.dirty.size;
  }
}