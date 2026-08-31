/**
 * Live-candle reconciliation core — pure, framework-free, unit-testable.
 *
 * ── WHY THIS EXISTS: the "background-tab doji" bug ──────────────────────────
 *
 * The backend aggregates IG ticks server-side and pushes COMPLETE OHLC
 * snapshots over the WS (`{time, open, high, low, close, volume}`), one per
 * tick, bucket = floor(tick time). TCP preserves order, so frames arrive in
 * order even when the browser delays/batches them in a background tab — every
 * frame is therefore an authoritative, self-contained snapshot of the forming
 * candle ("last write wins with full snapshots" is always safe).
 *
 * The corruption lived entirely in the frontend paint layer:
 *   1. `LiveBarBridge` never painted the frame's true close directly — it
 *      re-targeted a `requestAnimationFrame` "glide" whose animated close was
 *      the only value ever painted.
 *   2. Browsers FULLY PAUSE rAF while the tab is hidden, so the animated
 *      close froze at the last painted price.
 *   3. CandleKit's `controller.updateBar()` REPLACES the last bar wholesale
 *      (no max/min merging), so the chart's stored bar only ever contained the
 *      last PAINTED (animated) values.
 *   4. When the bucket rolled over while hidden, the bridge cancelled the
 *      never-fired rAF and appended the new bucket — committing the just-closed
 *      bucket with its frozen close, typically ≈ its open → a doji with real
 *      wicks (wicks were always painted from true extremes).
 *   5. Nothing reconciled on tab focus, and `updateBar` can never fix past
 *      bars (older ts is discarded) — only a manual refresh reloaded the
 *      server-correct `/api/candles/db` history.
 *
 * THE FIX (this module): keep an authoritative `LiveBar` truth for the forming
 * bucket (server frames merged with the OHLC contract below), and plan every
 * paint so the truth can never be lost:
 *   - same-bucket frame while HIDDEN → commit truth directly (no rAF);
 *   - bucket rollover → FIRST re-commit the closing bucket's true final OHLC,
 *     THEN append the new bucket (a frozen mid-glide close can never be a
 *     closed candle's last word — even when visible);
 *   - stale/out-of-order frame → skipped (never overwrites newer state);
 *   - `open` only ever comes from the bucket's first frame — never fabricated
 *     as `high=low=close=latestPrice` by a background update.
 *
 * The visible-tab glide stays purely cosmetic: it may lag the truth for ≤300 ms
 * but every path above re-commits truth before it can be frozen into a closed
 * candle, and the tab-focus flush repaints truth immediately.
 *
 * The candle-close countdown (Issue 2) is here too, derived from the candle's
 * actual bucket boundary (`nextBucketTime - currentTime`), never from
 * accumulated timer ticks.
 */

/** The single authoritative OHLC state of the forming bucket (epoch-ms ts). */
export interface LiveBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Structural subset of the backend candle frame this module consumes. */
export interface LiveCandleFrame {
  /** Bucket start, epoch SECONDS (server convention). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Floor an epoch-ms timestamp to the start of its timeframe bucket (epoch ms). */
export function alignBucket(tsMs: number, bucketSec: number): number {
  const bucketMs = bucketSec * 1000;
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

/** True when every OHLC field is a finite number (price sanity gate). */
function isSaneFrame(f: LiveCandleFrame): boolean {
  return (
    Number.isFinite(f.time) &&
    Number.isFinite(f.open) &&
    Number.isFinite(f.high) &&
    Number.isFinite(f.low) &&
    Number.isFinite(f.close)
  );
}

/** Coerce a WS frame into a truth bar for its bucket; null when unusable. */
function toBar(frame: LiveCandleFrame, bucketSec: number): LiveBar | null {
  if (!isSaneFrame(frame)) return null;
  const volume =
    typeof frame.volume === "number" && Number.isFinite(frame.volume) && frame.volume > 0
      ? frame.volume
      : undefined;
  return {
    ts: alignBucket(frame.time * 1000, bucketSec),
    open: frame.open,
    high: frame.high,
    low: frame.low,
    close: frame.close,
    ...(volume !== undefined ? { volume } : {}),
  };
}

/**
 * Merge one frame into an EXISTING same-bucket truth, per the live-OHLC
 * contract:
 *   open  = first price of the bucket — immutable;
 *   high  = max(existing, incoming);
 *   low   = min(existing, incoming);
 *   close = latest valid price (frames are TCP-ordered server snapshots);
 *   volume = the server's cumulative per-bucket volume (NOT additive).
 */
export function mergeSameBucket(prev: LiveBar, incoming: LiveBar): LiveBar {
  return {
    ts: prev.ts,
    open: prev.open,
    high: Math.max(prev.high, incoming.high),
    low: Math.min(prev.low, incoming.low),
    close: incoming.close,
    ...(incoming.volume !== undefined || prev.volume !== undefined
      ? { volume: incoming.volume ?? prev.volume }
      : {}),
  };
}

/** What a frame means relative to the current truth. */
export type FrameKind = "seed" | "same-bucket" | "new-bucket" | "stale";

export function classifyFrame(prev: LiveBar | null, frameBucketMs: number): FrameKind {
  if (!prev) return "seed";
  if (frameBucketMs < prev.ts) return "stale";
  if (frameBucketMs > prev.ts) return "new-bucket";
  return "same-bucket";
}

/** The ordered `updateBar` work a frame implies. */
export interface UpdatePlan {
  /**
   * Bars to push via `controller.updateBar(...)`, IN ORDER. On a rollover the
   * FIRST commit (when present) re-states the closing bucket's TRUE final
   * OHLC, and the LAST commit appends the new bucket.
   */
  commits: LiveBar[];
  /** True when the frame opened a new bucket (the chart appends a bar). */
  rollover: boolean;
  /** True when the frame was ignored (stale/out-of-order or unusable). */
  skipped: boolean;
  /** The authoritative forming-bucket truth after applying the frame. */
  truth: LiveBar | null;
  /**
   * True when a same-bucket frame arrived on a VISIBLE tab — the caller may
   * run the cosmetic close-glide toward `truth`. When false (hidden tab or
   * rollover) the caller must paint `commits` directly; rAF is paused in
   * background tabs, so animation can never be relied on there.
   */
  animate: boolean;
}

/**
 * Plan the chart work for one WS candle frame.
 *
 * @param prev   current authoritative forming-bucket truth (null before the
 *               first frame).
 * @param frame  the incoming backend candle snapshot.
 * @param bucketSec timeframe bucket size (60 = 1m, 180 = 3m).
 * @param opts.hidden whether the document is hidden right now — hidden tabs
 *               get direct truth commits (rAF is paused there).
 */
export function planLiveUpdate(
  prev: LiveBar | null,
  frame: LiveCandleFrame,
  bucketSec: number,
  opts: { hidden?: boolean } = {},
): UpdatePlan {
  const incoming = toBar(frame, bucketSec);
  if (!incoming) {
    return { commits: [], rollover: false, skipped: true, truth: prev, animate: false };
  }

  const kind = classifyFrame(prev, incoming.ts);

  // A delayed/stale frame must NEVER overwrite newer candle state.
  if (kind === "stale") {
    return { commits: [], rollover: false, skipped: true, truth: prev, animate: false };
  }

  // First frame of the stream, or a bucket rollover. When a bucket closes we
  // re-commit its TRUE final OHLC first — the guard against freezing an
  // animated close into a closed candle (the doji bug).
  if (kind === "seed" || kind === "new-bucket") {
    const commits: LiveBar[] = prev ? [prev] : [];
    commits.push(incoming);
    return { commits, rollover: true, skipped: false, truth: incoming, animate: false };
  }

  // Same bucket: merge into truth. Hidden tabs commit directly (rAF paused);
  // visible tabs may glide cosmetically toward the merged truth.
  const truth = mergeSameBucket(prev as LiveBar, incoming);
  if (opts.hidden) {
    return { commits: [truth], rollover: false, skipped: false, truth, animate: false };
  }
  return { commits: [], rollover: false, skipped: false, truth, animate: true };
}

/** Countdown state for the currently forming candle (Issue 2). */
export interface CountdownState {
  /** Bucket start of the forming candle (epoch ms). */
  bucketStartMs: number;
  /** When the forming candle closes = bucketStart + bucket (epoch ms). */
  closesAtMs: number;
  /** Display remaining time, clamped to [0, bucket] (ms). */
  remainingMs: number;
  /** "MM:SS" label derived from `remainingMs` (never accumulated ticks). */
  label: string;
  /**
   * True while counting down. False when the wall clock is at/past the bucket
   * boundary but the stream has not delivered the next candle yet — the UI
   * holds at 00:00 and the WS remains the ONLY creator of candles (no
   * duplicates, no optimistic bucket creation here).
   */
  active: boolean;
}

/**
 * TradingView-style countdown for the forming candle, computed from the
 * candle's ACTUAL bucket boundary: `closesAt - now`.
 *
 * Reconciliation contract: `frame.time` is the server-side bucket start, so
 * every WS frame re-anchors the countdown to the real market timestamp; the
 * browser clock only measures elapsed time since that anchor. When the wall
 * clock crosses the boundary before the next frame arrives, the countdown
 * holds at 00:00 (active=false) until the WS candle for the new bucket lands.
 */
export function candleCloseCountdown(
  frame: Pick<LiveCandleFrame, "time"> | null | undefined,
  bucketSec: number,
  nowMs: number,
): CountdownState | null {
  if (!frame || !Number.isFinite(frame.time) || !(bucketSec > 0)) return null;
  const bucketMs = bucketSec * 1000;
  const bucketStartMs = alignBucket(frame.time * 1000, bucketSec);
  const closesAtMs = bucketStartMs + bucketMs;
  const rawRemaining = closesAtMs - nowMs;
  const remainingMs = Math.min(Math.max(rawRemaining, 0), bucketMs);
  return {
    bucketStartMs,
    closesAtMs,
    remainingMs,
    label: formatCountdown(remainingMs),
    active: rawRemaining > 0,
  };
}

/** "MM:SS" — ceil so the last second never displays 00:00 early. */
export function formatCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
