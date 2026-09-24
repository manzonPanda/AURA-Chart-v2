/**
 * Historical MT5 trade → AURA Chart overlay mapping (P3-B).
 *
 * Consumes the UNMODIFIED P1/P2 trade contract (services/tradingApi.ts
 * TradeRecord — snake_case, verbatim from the P1 aura-backend whitelist) and
 * produces the overlay geometry consumed by TradeOverlayBridge /
 * TradeOverlayPrimitive.
 *
 * Symbol normalization (P3-A evidence — mt5_p3a_diagnose.py):
 *   "XAUUSD" → "GOLD"   spot gold, `Metals\XAUUSD`, visible+selected.
 *   "GOLD" is NOT mapped to AURA GOLD: on the captured server "GOLD" resolves
 *   to `Nasdaq\Stock\GOLD` (Barrick Gold equity). Loose "GOLD" substring
 *   matching is therefore FORBIDDEN — only the exact spot symbol maps.
 *   Everything else (e.g. "DE40") is UNRESOLVED: the raw symbol is preserved,
 *   `resolved` is false, and the trade can never attach to an AURA instrument
 *   until a live/deal-evidence mapping is added. Nothing is invented.
 *
 * Time conversion lives in services/mt5Time.ts (Europe/Helsinki per-timestamp
 * DST resolution → UTC epoch-ms → AURA bucket). Entry and exit are mapped
 * INDEPENDENTLY — trades sharing a bucket stay separate events.
 *
 * Tickets: several historical rows have no ticket (P3 audit). The key falls
 * back to a composite of stored fields — ticket values are NEVER invented.
 * Framework-free (frontend/tests run it with plain node --test).
 */
import { mt5ServerWallToBucketMs, mt5ServerWallToUtcMs } from "./mt5Time.ts";
import type { TradeRecord } from "./tradingApi.ts";

/** The AURA Chart instrument an MT5 symbol maps to. */
export interface SymbolNormalization {
  /** Raw MT5 symbol as stored in trades.instrument (never rewritten). */
  readonly mt5Symbol: string;
  /** AURA Chart epic candidate (normalized symbol → epic mapping). */
  readonly epic: string;
  /** False ⇒ no evidence-backed mapping; the trade must not render anywhere. */
  readonly resolved: boolean;
}

/**
 * Exact, evidence-backed MT5 symbol → AURA instrument normalization.
 * Table-driven: entries are added ONLY from verified P3-A/live evidence.
 */
const MT5_SYMBOL_TO_EPIC: ReadonlyMap<string, string> = new Map([
  // P3-A: "XAUUSD" is the server's spot gold (Metals\XAUUSD, 2 digits,
  // visible+selected). AURA Chart GOLD = spot gold.
  ["XAUUSD", "GOLD"],
  // DE40 → DAX remains a CANDIDATE ONLY (P3-A: not finalized without live/deal
  // evidence) — deliberately NOT registered here. DE40 trades stay unresolved.
]);

export function normalizeMt5Symbol(raw: string | null | undefined): SymbolNormalization {
  const mt5Symbol = (raw ?? "").trim();
  const upper = mt5Symbol.toUpperCase();
  const epic = MT5_SYMBOL_TO_EPIC.get(upper);
  if (epic !== undefined) {
    return { mt5Symbol: mt5Symbol, epic, resolved: true };
  }
  // Unresolved: preserve the raw symbol, never guess (P3-B requirement).
  return { mt5Symbol: mt5Symbol, epic: upper, resolved: false };
}

/** P1 numeric columns arrive as node-postgres strings — parse defensively. */
export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Accept a forming-bucket value in epoch seconds OR epoch ms and normalize to
 * ms (shared by the bridge — LWC `liveCandle.time` is epoch seconds, Candle[]
 * `ts` is epoch ms).
 */
export function formingBucketToMs(formingBucketSec: number | null | undefined): number | null {
  if (formingBucketSec === null || formingBucketSec === undefined || !Number.isFinite(formingBucketSec)) {
    return null;
  }
  // Values above 1e12 are already ms; below are seconds (LWC time convention).
  return formingBucketSec > 1e12 ? formingBucketSec : formingBucketSec * 1000;
}

/** Renderable historical trade geometry — one per TradeRecord row. */
export interface TradeOverlay {
  /** Stable key. ticket when present; NEVER an invented one. */
  readonly key: string;
  /** Raw MT5 symbol + normalized AURA epic (resolved ⇒ renderable). */
  readonly mt5Symbol: string;
  readonly epic: string;
  readonly resolved: boolean;
  /** Verbatim buy_sell ("Buy" only when the row says exactly "Buy"). */
  readonly direction: "Buy" | "Sell";
  /** Entry candle bucket start, epoch-ms UTC (chart's bucket grid). */
  readonly entryBucketMs: number;
  /** Exit candle bucket start, or null ⇒ open trade (time_close IS NULL). */
  readonly exitBucketMs: number | null;
  /**
   * EXACT MT5 execution instants, epoch-ms UTC — never floored (the seconds
   * the bucket fields discard: `15:10:55` stays `…:55.000`, not `…:10:00`).
   * `entryExactMs` is always present (a row without a parsable entry is
   * dropped by buildTradeOverlays); `exitExactMs` is null ⇔ exitBucketMs is
   * null (open trade). TradeOverlayPrimitive interpolates X from these, so the
   * marker sits at the true intra-candle position — on BOTH 1m and 3m.
   */
  readonly entryExactMs: number;
  readonly exitExactMs: number | null;
  readonly entryPrice: number;
  readonly exitPrice: number | null;
  readonly sl: number | null;
  readonly tp: number | null;
  readonly lots: number | null;
  /** Realized P/L — present only after the P3-B whitelist addition upstream. */
  readonly pnl: number | null;
  readonly rrr: string | null;
  readonly status: "open" | "closed";
}

/** Composite fallback key for ticketless rows (P3 audit: ~955/2057 rows). */
function tradeKey(record: TradeRecord): string {
  const ticket = record.ticket;
  if (ticket !== null && ticket !== undefined && ticket !== "") return `t:${ticket}`;
  return `t:${record.time_open ?? "?"}|${record.instrument ?? "?"}|${record.price_open ?? "?"}|${record.buy_sell ?? "?"}`;
}

/**
 * P3-C — identity-preserving merge of a FRESH trade snapshot (the existing P2
 * REST chain) into the live overlay collection.
 *
 * Keyed by `TradeOverlay.key` — the exact same identity rule
 * {@link buildTradeOverlays} applies (ticket, else the documented composite
 * fallback). A re-delivered OPEN, an out-of-order UPDATE or an immediately
 * repeated CLOSE therefore collapses onto the row's existing overlay instead of
 * minting a second marker for the same trade.
 *
 * Semantics:
 *   * `next` (the authoritative server snapshot) WINS for every key it
 *     contains — the server is the source of truth for values, so no live
 *     event can invent a price/time that the database does not carry.
 *   * Overlays absent from `next` survive ONLY while they are still
 *     `status === "open"`: a locally-open trade that has not yet landed in a
 *     bounded window must not lose its band. Closed rows are never resurrected
 *     (they come back through `next` on the next window that contains them).
 *   * Order is deterministic (snapshot first, then surviving local opens) so
 *     React identity and the primitive's paint order stay stable on a no-op
 *     refresh — no churn, no duplicate overlay objects.
 */
export function reconcileTradeOverlays(
  existing: readonly TradeOverlay[],
  next: readonly TradeOverlay[],
): TradeOverlay[] {
  const seen = new Set<string>();
  const ordered: TradeOverlay[] = [];
  // 1. The authoritative snapshot — FIRST occurrence per key wins, so a
  //    snapshot that repeats the same row (or a re-delivered OPEN) collapses
  //    onto one overlay instead of stacking duplicate markers.
  for (const overlay of next) {
    if (seen.has(overlay.key)) continue;
    seen.add(overlay.key);
    ordered.push(overlay);
  }
  // 2. Locally-known OPEN overlays absent from the window survive (a bounded
  //    window may not include a still-open trade). Closed rows are never
  //    resurrected — they return through `next` when their window loads.
  for (const overlay of existing) {
    if (seen.has(overlay.key)) continue;
    if (overlay.status !== "open") continue;
    seen.add(overlay.key);
    ordered.push(overlay);
  }
  return ordered;
}

/**
 * Map the P1/P2 trade rows onto renderable overlay geometry (P3-B).
 *
 * Direction rule: `buy_sell` is stored verbatim ("Buy"/"Sell"); only the exact
 * string "Buy" yields a Buy overlay — anything else is Sell (never a guess
 * about a third state, and no case-folding of stored data).
 *
 * A row is DROPPED (never approximated) when its entry time is unparsable or
 * its entry price is missing: without an entry anchor there is no candle to
 * attach the marker to. Exit geometry is mapped independently; a missing
 * `time_close` ⇒ `status: "open"` (the same derivation the P1 API uses).
 */
export function buildTradeOverlays(
  records: readonly TradeRecord[],
  bucketSec: number,
): TradeOverlay[] {
  const overlays: TradeOverlay[] = [];
  for (const record of records) {
    const entryBucketMs = mt5ServerWallToBucketMs(record.time_open, bucketSec);
    if (entryBucketMs === null) continue;
    // Exact execution instant from the SAME naive string (mt5Time.ts owns the
    // Europe/Helsinki conversion — no second implementation here). The bucket
    // floor above and this value share one parse contract; the bucket stays
    // for candle association, the exact ms drives marker positioning.
    const entryExactMs = mt5ServerWallToUtcMs(record.time_open);
    if (entryExactMs === null) continue;
    const entryPrice = toNumber(record.price_open);
    if (entryPrice === null) continue;
    const exitBucketMs = record.time_close
      ? mt5ServerWallToBucketMs(record.time_close, bucketSec)
      : null;
    const exitExactMs = record.time_close ? mt5ServerWallToUtcMs(record.time_close) : null;
    const symbol = normalizeMt5Symbol(record.instrument);
    overlays.push({
      key: tradeKey(record),
      mt5Symbol: symbol.mt5Symbol,
      epic: symbol.epic,
      resolved: symbol.resolved,
      direction: record.buy_sell === "Buy" ? "Buy" : "Sell",
      entryBucketMs,
      exitBucketMs,
      entryExactMs,
      exitExactMs,
      entryPrice,
      exitPrice: toNumber(record.price_close),
      sl: toNumber(record.sl),
      tp: toNumber(record.tp),
      lots: toNumber(record.lots),
      pnl: toNumber(record.pnl),
      rrr: record.rrr ?? null,
      status: exitBucketMs === null ? "open" : "closed",
    });
  }
  return overlays;
}

/** Overlays that belong to the currently selected AURA instrument epic. */
export function overlaysForEpic(
  overlays: readonly TradeOverlay[],
  epic: string | null | undefined,
): TradeOverlay[] {
  const wanted = (epic ?? "").trim().toUpperCase();
  if (!wanted) return [];
  // Unresolved symbols never render — an unverified mapping must not paint on
  // a real instrument's chart (P3-B rule, verified by the DAX/DE40 test).
  return overlays.filter((o) => o.resolved && o.epic === wanted);
}
