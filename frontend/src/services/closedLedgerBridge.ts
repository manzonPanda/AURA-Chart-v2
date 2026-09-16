/**
 * Closed-live-ledger REFRESH BRIDGE (FIX A) + rollover-candidate guard (FIX B)
 * — pure, framework-free, Node-testable (no React / DOM / CandleKit imports).
 *
 * WHY (forensic report 2026-09-16, GOLD MINUTE_3): a newly closed 3M candle can
 * exist ONLY in the frontend's in-memory `closedLiveBars` ledger for ~60s —
 * Capital's authoritative MINUTE OHLC arrives ~60s late, so the third 1M
 * constituent reaches PostgreSQL late and the derived 3M history cannot contain
 * the bucket during that window. A page refresh wiped the ledger, and quote
 * frames polluted the rollover-tracking refs so the bucket was never
 * re-captured: the candle disappeared until the authoritative frame arrived.
 *
 * FIX A bridges exactly that gap: the ledger is mirrored to sessionStorage
 * (scoped `instrument|bucketSec`, age-capped) and restored during the boot
 * scope adoption — BEFORE history can arrive — so the candle stays continuously
 * represented. `pruneClosedLiveBars` stays authoritative (history wins),
 * authoritative `phase:"closed"` frames replace restored provisional values
 * through the existing ledger-merge rules, and the storage copy is removed as
 * soon as the ledger empties.
 *
 * THIS IS NOT MARKET-DATA PERSISTENCE: sessionStorage is a short-lived bridge
 * across one page reload while PostgreSQL/authoritative Capital OHLC catches
 * up. Nothing synthetic is ever created — only bars the live stream actually
 * closed are bridged.
 */

/** Maximum age of a bridged ledger entry (~the reconciler's normal cadence). */
export const CLOSED_LEDGER_MAX_AGE_MS = 15 * 60 * 1000;

/** sessionStorage key namespace — versioned so old shapes never restore. */
const KEY_PREFIX = "aura.closedLedger.v1.";

/** One closed-live ledger bar, plus the bridge stamp. `ts` = bucket start (ms). */
export interface ClosedLedgerBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  /** Epoch ms — when this entry FIRST entered the bridge (age-cap anchor). */
  savedAt?: number;
}

/** A WS closed-candle frame (`source:"ohlc"`, `phase:"closed"`) — epoch SEC. */
export interface ClosedFrame {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Minimal storage surface (subset of DOM Storage) — injectable for tests. */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `instrument|bucketSec` scoped storage key (mirrors the ledger scope key). */
export function closedLedgerStorageKey(epic: string | undefined, bucketSec: number): string {
  return `${KEY_PREFIX}${epic ?? ""}|${bucketSec}`;
}

/** The production storage (sessionStorage), or null when unavailable. Access
 *  itself can throw in exotic privacy modes — never let it escape. */
export function defaultBridgeStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Serialize ledger bars for the bridge. `savedAt` is PRESERVED when already
 * present (the age cap must survive multiple refreshes) and stamped `nowMs`
 * only for entries that lack it. Returns "" for an empty ledger (callers
 * remove the storage key instead of storing an empty list).
 */
export function serializeClosedLiveLedger(
  bars: readonly ClosedLedgerBar[],
  nowMs: number,
): string {
  const out: ClosedLedgerBar[] = [];
  for (const b of bars) {
    if (!b || typeof b !== "object") continue;
    if (!Number.isFinite(b.ts) || !Number.isFinite(b.open) || !Number.isFinite(b.high) ||
        !Number.isFinite(b.low) || !Number.isFinite(b.close)) {
      continue;
    }
    out.push({
      ts: b.ts,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      ...(Number.isFinite(b.volume) ? { volume: b.volume } : {}),
      savedAt: Number.isFinite(b.savedAt) ? (b.savedAt as number) : nowMs,
    });
  }
  return out.length === 0 ? "" : JSON.stringify(out);
}

/**
 * Parse + validate a bridged ledger payload. Malformed payloads and malformed
 * ENTRIES are ignored safely (valid siblings survive); entries older than
 * `maxAgeMs` (by their own `savedAt`) are dropped. Result is deduped by `ts`
 * and ascending. Never throws.
 */
export function parseClosedLiveLedger(
  raw: string | null | undefined,
  nowMs: number,
  maxAgeMs: number = CLOSED_LEDGER_MAX_AGE_MS,
): ClosedLedgerBar[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byTs = new Map<number, ClosedLedgerBar>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (!Number.isFinite(e.ts) || (e.ts as number) < 0) continue;
    if (!Number.isFinite(e.open) || !Number.isFinite(e.high) ||
        !Number.isFinite(e.low) || !Number.isFinite(e.close) || !Number.isFinite(e.savedAt)) {
      continue;
    }
    if (e.volume !== undefined && !Number.isFinite(e.volume)) continue;
    if (nowMs - (e.savedAt as number) > maxAgeMs) continue; // age cap (first-bridged stamp)
    const tsNum = e.ts as number;
    if (byTs.has(tsNum)) continue;
    byTs.set(tsNum, {
      ts: tsNum,
      open: e.open as number,
      high: e.high as number,
      low: e.low as number,
      close: e.close as number,
      ...(e.volume !== undefined ? { volume: e.volume as number } : {}),
      savedAt: e.savedAt as number,
    });
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** Best-effort write. An EMPTY ledger removes the key (storage cleaned). Any
 *  storage failure (quota / private mode / security) is swallowed. */
export function saveClosedLiveLedger(
  storage: StorageLike | null | undefined,
  key: string,
  bars: readonly ClosedLedgerBar[],
  nowMs: number,
): void {
  if (!storage) return;
  try {
    const payload = serializeClosedLiveLedger(bars, nowMs);
    if (payload === "") {
      storage.removeItem(key);
    } else {
      storage.setItem(key, payload);
    }
  } catch {
    /* the chart must never depend on the bridge */
  }
}

/** Best-effort read → validated, age-capped bars ([] on any failure). */
export function loadClosedLiveLedger(
  storage: StorageLike | null | undefined,
  key: string,
  nowMs: number,
  maxAgeMs: number = CLOSED_LEDGER_MAX_AGE_MS,
): ClosedLedgerBar[] {
  if (!storage) return [];
  try {
    return parseClosedLiveLedger(storage.getItem(key), nowMs, maxAgeMs);
  } catch {
    return [];
  }
}

/**
 * The closed-live LEDGER merge — extracted VERBATIM from TradingChart's
 * `closedLiveLedger` memo (authority rules unchanged):
 *
 *   1. `closedCandles` — authoritative `phase:"closed"` WS frames. WIN over
 *      any provisional entry for the same bucket (a closed bucket is final).
 *   2. `closedLiveBars` — provisional rollover captures (and restored bridge
 *      entries). Kept only for buckets the authoritative frames have not
 *      reached yet (Capital OHLC delivery lags the quote stream ~1 bucket).
 *
 * Output is ascending by bucket start; callers map it into chart bars.
 */
export function bridgeClosedLiveLedger(
  closedCandles: readonly ClosedFrame[],
  closedLiveBars: readonly ClosedLedgerBar[],
  bucketSec: number,
): ClosedLedgerBar[] {
  const bucketMs = bucketSec > 0 ? bucketSec * 1000 : 1000;
  const authBars: ClosedLedgerBar[] = [];
  for (const c of closedCandles) {
    if (!c || !Number.isFinite(c.time) || !Number.isFinite(c.close)) continue;
    authBars.push({
      ts: Math.floor((c.time * 1000) / bucketMs) * bucketMs,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      ...(Number.isFinite(c.volume) ? { volume: c.volume } : {}),
    });
  }
  const authTs = new Set(authBars.map((b) => b.ts));
  const provisional = closedLiveBars.filter((b) => !authTs.has(b.ts));
  return [...authBars, ...provisional].sort((a, b) => a.ts - b.ts);
}

// ── FIX B: rollover-candidate guard ──────────────────────────────────────────

/** Minimal shape of a WS forming-candle frame the capture effect tracks. */
export interface RolloverFrame {
  time: number;
  source?: "ohlc" | "quote";
}

export interface RolloverCandidate<F extends RolloverFrame> {
  ts: number | null;
  bar: F | null;
}

/**
 * The bucket the closed-live capture effect tracks as "the previous forming
 * candle" while history is absent (the live-only branch).
 *
 * FIX B (forensic 2026-09-16): on a refresh the WS seed's AUTHORITATIVE
 * `forming-ohlc` frame (the just-closed 3M bucket, mid-delivery) lands first
 * and the quote stream moves to the NEXT bucket within ~100 ms. Letting a
 * `source:"quote"` frame overwrite the candidate destroyed the only record of
 * the just-closed bucket: the 08:21→08:24 rollover became undetectable once
 * history loaded, so the bucket was recaptured by NOBODY and vanished after
 * the history `setData`.
 *
 * Rules (authority ordering untouched):
 *   - null frame (stream reset) → reset, exactly as before;
 *   - a quote frame NEVER evicts an authoritative (ohlc) candidate;
 *   - anything else adopts the frame (authoritative frames always win; quote
 *     continuity still works when no authoritative frame exists);
 *   - the candidate never moves backward.
 */
export function nextRolloverCandidate<F extends RolloverFrame>(
  prevTs: number | null,
  prevBar: F | null,
  frame: F | null,
): RolloverCandidate<F> {
  if (!frame) return { ts: null, bar: null };
  const frameIsQuote = (frame.source ?? "ohlc") === "quote";
  const prevIsAuth = prevBar !== null && (prevBar.source ?? "ohlc") !== "quote";
  if (frameIsQuote && prevIsAuth) {
    return { ts: prevTs, bar: prevBar }; // FIX B core: keep the authoritative candidate
  }
  if (prevTs !== null && frame.time < prevTs) {
    return { ts: prevTs, bar: prevBar }; // never move the candidate backward
  }
  return { ts: frame.time, bar: frame };
}
