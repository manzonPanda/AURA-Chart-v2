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

// ═══════════════════════════════════════════════════════════════════
// LIVE OPEN-TRADE + ACCOUNT-RISK DESCRIPTORS (additive — P3 untouched)
// ═══════════════════════════════════════════════════════════════════
//
// Everything above this line is the COMPLETED, VERIFIED P3 historical path and
// must never regress. What follows is purely ADDITIVE: pure builders that turn
// the authoritative `AccountState` (computed server-side by aura-backend from
// MT5 via bounded GETs) into display-only descriptors.
//
// READ-ONLY BY CONSTRUCTION
//   These are plain data. There is no callback, no handler, no command, and no
//   mutable trade state in anything below — an overlay can describe an MT5
//   position but can never change one. Rendering is handled by
//   TradeOverlayPrimitive, which attaches NO pointer/click/touch handlers.

/** A live MT5 position, normalized for display (from AccountState.positions). */
export interface LivePositionInput {
  /**
   * MT5 position id as reported by the bridge, or null when it omits one. A
   * missing id is NEVER invented: it only means the display key falls back to a
   * composite of the position's own fields.
   */
  readonly ticket: string | null;
  readonly direction: "Buy" | "Sell";
  readonly lots: number;
  readonly entryPrice: number;
  readonly sl: number | null;
  readonly tp: number | null;
  /**
   * `trades.risk_per_trade` — the 1R the live dashboard's "Total R Gained"
   * divides by. It arrives as a P1 numeric string, so it is normalized to a
   * number during the build. `riskUsd` is the legacy alias for the same value.
   */
  readonly rowRiskPerTrade?: string | number | null;
  readonly riskUsd?: number | null;
  /**
   * MT5-native account-currency P/L if the position were closed at `sl`, signed
   * as the server returned it. This is the AUTHORITATIVE money for the stop
   * label — preferred over any client-side derivation. Null when the server
   * could not compute it, in which case the stop label falls back to the proven
   * $/point sensitivity ({@link LivePositionInput.moneyPerPoint}).
   */
  readonly slValue: number | null;
  /** As {@link slValue}, but at the take-profit level. */
  readonly tpValue: number | null;
  /**
   * The account-currency RISK of this trade — 1R.
   *
   * This is the `trades.risk_per_trade` the live dashboard itself divides by for
   * "Total R Gained" (`getTradeR: profit / riskPerTrade`). It is the risk
   * recorded when the trade was placed, so it is deliberately STABLE: dragging
   * the SL later must NOT retroactively change how the trade's R is measured.
   * Deriving 1R from the live SL distance instead makes every R on the chart
   * jump every time the user adjusts a stop. Optional because the P1 payload
   * spells it `rowRiskPerTrade` / `riskUsd`; {@link buildLiveTradeOverlay}
   * resolves the aliases into this one field.
   */
  readonly riskPerTrade?: number | null;
  /**
   * The account-scoped reward:risk ratio, exactly as the server reported it (a
   * string in the P1 contract). This is the R multiple the take-profit
   * represents, so the target label never re-derives it.
   */
  readonly rewardRiskRatio: string | null;
  /** Floating P/L already netted with swap by the server. */
  readonly netPnl: number;
  /** Server-derived R (netPnl / 1R), or null when 1R is unknown. */
  readonly liveR: number | null;
  /** Server-derived $/price-point sensitivity, or null when NOT derivable (D3). */
  readonly moneyPerPoint: number | null;
  /** Account-scoped instrument spelling from the `trades` row. */
  readonly instrument: string;
  readonly openTime: string | null;
}

/** A renderable live position. Immutable, display-only. */
export interface LiveTradeOverlay {
  /**
   * Display key. Derived from the ticket when the bridge reported one, otherwise
   * from the position's own immutable fields — a ticket NUMBER is never
   * invented, only a local identity for rendering.
   */
  readonly key: string;
  readonly ticket: string | null;
  readonly epic: string;
  readonly resolved: boolean;
  readonly mt5Symbol: string;
  readonly direction: "Buy" | "Sell";
  readonly lots: number;
  readonly entryPrice: number;
  /** Actual MT5 SL — rendered as a read-only informational level. */
  readonly sl: number | null;
  /** Actual MT5 TP — rendered as a read-only informational level. */
  readonly tp: number | null;
  /** Authoritative account-currency P/L at the SL; null when not computed. */
  readonly slValue: number | null;
  /** Authoritative account-currency P/L at the TP; null when not computed. */
  readonly tpValue: number | null;
  /** The trade's recorded 1R (`trades.risk_per_trade`); null when unknown. */
  readonly riskPerTrade: number | null;
  /** Server-reported reward:risk ratio (the R the target represents). */
  readonly rewardRiskRatio: string | null;
  readonly netPnl: number;
  readonly liveR: number | null;
  readonly openTime: string | null;
  /** Non-null ONLY when the server proved the sensitivity (D3). */
  readonly moneyPerPoint: number | null;
}

export interface LiveTradeOverlayInput {
  readonly position: LivePositionInput;
  readonly chartEpic: string;
}

/**
 * Local DISPLAY key for a live position. The ticket is used when the bridge
 * reported one; otherwise the key falls back to a composite of the position's
 * own immutable fields. A ticket number is never invented — this is only an
 * identity for rendering, and it never reaches MT5.
 */
function livePositionKey(position: LivePositionInput): string {
  if (position.ticket !== null && position.ticket !== "") return `p:${position.ticket}`;
  return `p:${position.instrument}:${position.direction}:${position.entryPrice}:${position.lots}`;
}

/**
 * Map one authoritative live position onto the current chart's epic.
 *
 * Returns `null` when the position's instrument does not normalize to the
 * chart's current epic: a position on ANOTHER instrument is dropped outright,
 * so one instrument's entry price is never projected onto another instrument's
 * price axis. The raw symbol is still preserved on the object for the caller,
 * and the epic comparison is exact — no substrings, no suffix stripping.
 */
export function buildLiveTradeOverlay(input: LiveTradeOverlayInput): LiveTradeOverlay | null {
  const { position } = input;
  const symbol = normalizeMt5Symbol(position.instrument);
  const chartEpic = (input.chartEpic ?? "").trim().toUpperCase();
  if (!chartEpic || symbol.epic !== chartEpic) return null;
  return {
    key: livePositionKey(position),
    ticket: position.ticket,
    epic: symbol.epic,
    resolved: symbol.resolved,
    mt5Symbol: symbol.mt5Symbol,
    direction: position.direction,
    lots: position.lots,
    entryPrice: position.entryPrice,
    sl: position.sl,
    tp: position.tp,
    slValue: position.slValue ?? null,
    tpValue: position.tpValue ?? null,
    // 1R is recorded once, under three names across the bridge's payloads. The
    // first positive value wins so a stale/zero `riskUsd` cannot shadow the
    // real `risk_per_trade`.
    riskPerTrade: firstPositive(
      position.riskPerTrade,
      toNumber(position.rowRiskPerTrade),
      position.riskUsd,
    ),
    rewardRiskRatio: position.rewardRiskRatio ?? null,
    netPnl: position.netPnl,
    liveR: position.liveR,
    openTime: position.openTime,
    moneyPerPoint: position.moneyPerPoint,
  };
}

/** Live positions that belong to the selected chart instrument. */
export function liveTradesForEpic(
  positions: readonly LivePositionInput[],
  epic: string | null | undefined,
): LiveTradeOverlay[] {
  const wanted = (epic ?? "").trim().toUpperCase();
  if (!wanted) return [];
  const out: LiveTradeOverlay[] = [];
  for (const position of positions) {
    // buildLiveTradeOverlay already enforces the exact-epic match and returns
    // null for anything on another instrument, so a survivor is on this axis.
    const built = buildLiveTradeOverlay({ position, chartEpic: wanted });
    if (built) out.push(built);
  }
  return out;
}

/**
 * Does the account hold an OPEN live position that APPLIES to this chart?
 *
 * "Applies" means EXACTLY what {@link liveTradesForEpic} — the function that
 * feeds the live-position renderer — decided: a position that survived the
 * chart-epic match. This predicate is a final assertion on that SAME result, so
 * the risk layer can never be stricter than the live layer: if the chart is
 * already painting the live position, the risk layer is eligible too.
 *
 * In particular this must NOT re-test `overlay.resolved`. The live path binds a
 * position by epic alone (the account-scoped `instrument` spelling is whatever
 * the server's `trades` row carries, which is not always a raw MT5 symbol);
 * requiring an evidence-backed symbol mapping here would reject a live trade
 * the chart is already showing.
 *
 * Nothing here is inferred from account configuration: configured risk limits
 * alone never make a chart level.
 */
export function hasApplicableLivePosition(
  overlays: readonly LiveTradeOverlay[],
  chartEpic: string | null | undefined,
): boolean {
  const wanted = (chartEpic ?? "").trim().toUpperCase();
  if (!wanted) return false;
  return overlays.some((overlay) => overlay.epic === wanted);
}

// ── Live label metrics: %, R and $ for the position, its SL and its TP ──────

/**
 * Which account risk level a label describes.
 *
 * - `position` — the live position's own line: the CURRENT floating move from
 *   entry (its % / R / $ are what the account holds right now).
 * - `stop` / `target` — the SL / TP line: what the position would hold IF it
 *   were closed at that level.
 */
export type LiveLevelRole = "position" | "stop" | "target";

/** Everything one live label can show, or null where it is NOT derivable. */
export interface LiveLevelMetrics {
  /** Signed % move from entry, e.g. `1.95` for `+1.95%`. Null when underivable. */
  readonly percent: number | null;
  /** Signed R multiple at that level, e.g. `1.59`. Null when 1R is unknown. */
  readonly r: number | null;
  /** Signed account-currency P/L at that level, e.g. `145.92`. */
  readonly money: number | null;
}

/** +1 for a BUY (price must rise), -1 for a SELL. */
function directionSign(direction: "Buy" | "Sell"): 1 | -1 {
  return direction === "Buy" ? 1 : -1;
}

/**
 * The first strictly-positive finite candidate, or null.
 *
 * The bridge carries the same fact under several aliases (`riskPerTrade`,
 * `rowRiskPerTrade`, `riskUsd`) and any of them may be absent, zero or junk, so
 * the first usable one wins rather than letting a bad value shadow a good one.
 */
function firstPositive(...values: readonly (number | null | undefined)[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * Account-scoped percentage of a MONETARY amount — the canonical risk
 * convention this project uses everywhere (see the trading-overlay audit):
 *
 *     risk % = money / initial_balance × 100
 *
 * This is deliberately NOT a price-distance percentage (`(level−entry)/entry`).
 * A level's % answers "how much of my ACCOUNT does this risk represent", which
 * is the only reading that makes a position's stop comparable to the account's
 * own PROFIT TARGET / DAILY LOSS / MAX DRAWDOWN levels — all of which are
 * configured as percent-of-initial-balance. A price-distance % cannot be
 * compared to those and would silently mix two different units on one axis.
 *
 * Null when the amount or the account basis is unknown: with no balance there
 * is no honest percentage, so it is omitted rather than invented.
 */
export function accountPercent(
  money: number | null,
  accountBasis: number | null | undefined,
): number | null {
  if (money === null || !Number.isFinite(money)) return null;
  if (accountBasis === null || accountBasis === undefined) return null;
  if (!Number.isFinite(accountBasis) || accountBasis === 0) return null;
  const percent = (money / accountBasis) * 100;
  return Number.isFinite(percent) ? percent : null;
}

/**
 * Account-currency P/L the position would hold if closed at `levelPrice`.
 *
 * P/L is `sign × moneyPerPoint × (level - entry)`. The server's OWN `slValue` /
 * `tpValue` always win when present (MT5-native, and already netted with swap);
 * the sensitivity form is only a fallback for when the bridge omitted them.
 * Null when neither is available.
 */
export function levelMoney(
  overlay: Pick<LiveTradeOverlay, "direction" | "entryPrice" | "moneyPerPoint">,
  levelPrice: number | null,
  authoritative: number | null | undefined,
): number | null {
  if (typeof authoritative === "number" && Number.isFinite(authoritative)) return authoritative;
  if (levelPrice === null || !Number.isFinite(levelPrice)) return null;
  const mpp = overlay.moneyPerPoint;
  if (mpp === null || !Number.isFinite(mpp) || mpp === 0) return null;
  const money = directionSign(overlay.direction) * mpp * (levelPrice - overlay.entryPrice);
  return Number.isFinite(money) ? money : null;
}

/**
 * Parse an R multiple out of the account's `rrr` / `rewardRiskRatio` STRING.
 *
 * The bridge is NOT consistent about this field's shape — real payloads carry
 * `"+1.90R"` (signed, R-suffixed), `"1.63"` (bare number) and `"1:2"` /
 * `"1:2.5"` (a reward:risk PAIR). All three are accepted:
 *
 *   • a bare or signed number      → used as-is
 *   • a number with a trailing `R`  → the `R` is decoration, stripped
 *   • a `risk:reward` pair `a:b`   → the REWARD side, `b / a`
 *
 * A `1:2` reading of "1 unit of risk for 2 of reward" is the standard MT
 * convention and yields `2`; taking the risk side would silently report HALF
 * the real reward, which is the classic R:R misread.
 *
 * Null when nothing numeric can be read — never a fabricated 0.
 */
export function parseRRatio(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;

  // "1:2" / "1:2.5" — risk : reward. The FIRST side is the risk and the SECOND
  // is the reward, so the R multiple is reward / risk = 2 / 1 = 2.
  const pair = /^(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (pair) {
    const risk = Number(pair[1]);
    const reward = Number(pair[2]);
    // Guard the RISK side (the divisor) — a zero risk is not a ratio.
    if (Number.isFinite(risk) && Number.isFinite(reward) && risk !== 0) {
      const ratio = reward / risk;
      return Number.isFinite(ratio) ? ratio : null;
    }
    return null;
  }

  // "+1.90R" / "-0.50R" / "1.63" — strip the decorative suffix, then parse.
  const numeric = Number(text.replace(/R$/i, "").trim());
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * 1R — the account-currency risk the live dashboard measures against.
 *
 * `riskPerTrade` (`trades.risk_per_trade`) is the ONLY accepted primary source,
 * matching `getTradeR` / `calculateTradeR` in the live dashboard. It is fixed at
 * entry, so an R derived from it does not move when the user drags the SL.
 *
 * The live SL distance is used ONLY as a last-resort fallback when the account
 * recorded no risk at all — never in preference to a recorded 1R.
 */
function riskUnit(overlay: LiveTradeOverlay): number | null {
  const recorded = overlay.riskPerTrade;
  if (recorded !== null && Number.isFinite(recorded) && recorded > 0) return recorded;
  const fromSl = Math.abs(levelMoney(overlay, overlay.sl, overlay.slValue) ?? 0);
  return Number.isFinite(fromSl) && fromSl > 0 ? fromSl : null;
}

/**
 * The R multiple a level represents.
 *
 * 1R is `riskPerTrade` (see {@link riskUnit}), so a level's R is simply its own
 * P/L over that fixed unit — the same arithmetic the live dashboard's "Total R
 * Gained" card performs, and the R and the `$` printed beside it can never
 * disagree.
 *
 * Fallbacks run only when no 1R is known at all, in the dashboard's own order:
 * the target falls back to the account's `rrr`, then the position to the
 * server's `liveR`. Every path yields null rather than a fabricated `0.00R`.
 */
export function levelR(
  overlay: LiveTradeOverlay,
  role: LiveLevelRole,
  levelMoneyValue: number | null,
  authoritativeR: string | null | undefined = null,
): number | null {
  // PRIMARY — the dashboard's own arithmetic over the RECORDED 1R. This is
  // taken before `liveR` on purpose: the server's `live_rr` divides by the
  // CURRENT stop distance, so it shifts whenever the user drags the SL, whereas
  // `profit / riskPerTrade` is fixed at entry and matches "Total R Gained".
  if (levelMoneyValue !== null && Number.isFinite(levelMoneyValue)) {
    const oneR = riskUnit(overlay);
    if (oneR !== null) {
      const r = levelMoneyValue / oneR;
      if (Number.isFinite(r)) return r;
    }
  }
  // The target's planned reward:risk, when the account recorded one.
  if (role === "target") {
    const parsed = parseRRatio(authoritativeR);
    if (parsed !== null) return parsed;
  }
  // Last resort — the server's current R, used only when no 1R is known at all.
  if (role === "position") {
    const live = overlay.liveR;
    if (live !== null && Number.isFinite(live)) return live;
  }
  return null;
}

/**
 * Every metric one live label needs, resolved in ONE place.
 *
 * Keeping this beside the data model (rather than inline in the canvas code)
 * means the position, stop and target rows are all built by the same rules, and
 * each field degrades to null INDEPENDENTLY — a label can show `%` without `$`,
 * and neither is ever invented.
 *
 * `accountBasis` is `accounts.initial_balance`: the same denominator the
 * account's own risk levels use, so the % on a position and the % on a
 * DAILY LOSS line mean the same thing and can be compared directly.
 */
export function liveLevelMetrics(
  overlay: LiveTradeOverlay,
  role: LiveLevelRole,
  accountBasis: number | null | undefined = null,
): LiveLevelMetrics {
  if (role === "position") {
    const money = Number.isFinite(overlay.netPnl) ? overlay.netPnl : null;
    return {
      percent: accountPercent(money, accountBasis),
      r: levelR(overlay, "position", money),
      money,
    };
  }
  const isStop = role === "stop";
  const level = isStop ? overlay.sl : overlay.tp;
  const money = levelMoney(overlay, level, isStop ? overlay.slValue : overlay.tpValue);
  return {
    // A LEVEL's % is the MONEY IT REPRESENTS over the account basis, so it
    // MOVES when the user drags the stop: it answers "how much of my account do
    // I lose if this level is hit". It is the same account-scoped unit as the
    // position's % and as the account's own risk levels.
    //
    // The R, by contrast, deliberately does NOT move — it stays on the recorded
    // `riskPerTrade` (see riskUnit) so it matches the dashboard's "Total R
    // Gained" instead of re-basing whenever the stop is adjusted.
    percent: accountPercent(money, accountBasis),
    r: levelR(overlay, role, money, overlay.rewardRiskRatio),
    money,
  };
}

// ── Account risk levels (PROFIT TARGET / DAILY LOSS / MAX DRAWDOWN) ──

/** The three informational account-risk overlays, in display order. */
export type RiskLevelKind = "profitTarget" | "dailyLoss" | "maxDrawdown";

/** The authoritative monetary values, straight from the server (never derived). */
export interface AccountRiskInput {
  /** accounts.initial_balance — the absolute base the profit target is measured from. */
  readonly initialBalance: number | null;
  /** Current realized MT5 balance; the open book is added by the solver. */
  readonly balance: number | null;
  /** Current MT5 equity, including the open book. */
  readonly equity: number | null;
  /** Current authoritative open-book P/L, excluded from the non-open baseline. */
  readonly floatingPnl: number | null;
  /** Configured drawdown account basis. */
  readonly drawdownBasis: "balance" | "equity";
  /** initial_balance × profit_target_percent/100, or null when unconfigured. */
  readonly profitTargetAmount: number | null;
  /** Session-start balance × daily_loss_limit_percent/100, or null. */
  readonly dailyLossLimit: number | null;
  /** Fixed account value at the 5:00 AM PHT daily-loss floor, or null. */
  readonly dailyLossFloor: number | null;
  /** initial_balance × max_total_drawdown_percent/100, or null. */
  readonly maxDrawdown: number | null;
  /** Authoritative fixed/trailing drawdown floor, or null. */
  readonly maxDrawdownFloor: number | null;
}

/** One renderable risk annotation. Monetary value is ALWAYS present. */
export interface RiskLevelOverlay {
  readonly kind: RiskLevelKind;
  readonly label: string;
  /** Signed dollar amount for the label, e.g. -300 for a −$300 limit. */
  readonly amount: number | null;
  /**
   * The account price-axis level, or null when it is NOT mathematically
   * derivable (D3). A null here means "not a chart level": the renderer paints
   * no line, no pill and no price-scale tag for it — never a fabricated price.
   */
  readonly price: number | null;
  /** How `price` was obtained, for tests + diagnostics. */
  readonly priceSource: "derived" | "undrawable";
}

/** A position's contribution to a price-axis threshold, with its sign. */
export interface SensitivityLeg {
  /** Account-scoped instrument spelling. */
  readonly instrument: string;
  /** +1 for a BUY (price must rise), -1 for a SELL (price must fall). */
  readonly sign: 1 | -1;
  /** money per one price point of move, from the bridge's own 1R (D3). */
  readonly moneyPerPoint: number;
  /** The position's actual MT5 entry price. */
  readonly entryPrice: number;
}

/** Proven-sensitivity legs for positions on the CHART instrument only. */
function riskLegsForEpic(
  overlays: readonly LiveTradeOverlay[],
  chartEpic: string,
): SensitivityLeg[] {
  const legs: SensitivityLeg[] = [];
  for (const overlay of overlays) {
    // Applicability is the LIVE layer's decision (see
    // `hasApplicableLivePosition`): an exact chart-epic match, never a stricter
    // symbol test. Only the price sensitivity itself is a separate requirement.
    if (overlay.epic !== chartEpic) continue;
    const moneyPerPoint = overlay.moneyPerPoint;
    if (moneyPerPoint === null || !Number.isFinite(moneyPerPoint) || moneyPerPoint <= 0) {
      // Sensitivity not derivable for this leg (D3): it cannot contribute to a
      // single price threshold, so the level degrades to annotation-only.
      continue;
    }
    legs.push({
      instrument: overlay.mt5Symbol,
      sign: overlay.direction === "Buy" ? 1 : -1,
      moneyPerPoint,
      entryPrice: overlay.entryPrice,
    });
  }
  return legs;
}

/**
 * Solve the single price at which the account's P&L changes by `moneyDelta`.
 *
 * With every leg on one instrument and the same side, account P&L at price p is
 *   Σ sign_i × mpp_i × (p - entry_i) = moneyDelta
 * so, letting S = Σ sign_i × mpp_i and B = Σ sign_i × mpp_i × entry_i,
 *   p = (moneyDelta + B) / S
 *
 * The equation has a single solution only when S ≠ 0. A mixed book is NOT solved:
 * its long and short legs describe different risk boundaries, so a single price
 * would misrepresent them. Mixed and zero-sensitivity cases return null — the
 * exact D3 "monetary annotation only" outcome.
 */
export function deriveThresholdPrice(
  moneyDelta: number,
  legs: readonly SensitivityLeg[],
): number | null {
  if (!Number.isFinite(moneyDelta) || legs.length === 0) return null;
  if (legs.some((leg) => leg.sign !== legs[0].sign)) return null; // mixed book
  const aggregate = legs.reduce((sum, leg) => sum + leg.sign * leg.moneyPerPoint, 0);
  if (aggregate === 0) return null; // no single price solves the equation
  const offset = legs.reduce(
    (sum, leg) => sum + leg.sign * leg.moneyPerPoint * leg.entryPrice,
    0,
  );
  const price = (moneyDelta + offset) / aggregate;
  return Number.isFinite(price) ? price : null;
}

/**
 * Compact signed money for the risk labels, e.g. `+$5,000` / `-$1,000`.
 *
 * An exact zero renders UNSIGNED (`$0`): a `+` on zero implies a direction that
 * does not exist. Negative and positive amounts keep their sign, because a
 * limit's direction is the whole point of the annotation.
 */
export function formatRiskAmount(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  const rounded = Math.round(amount * 100) / 100;
  const sign = rounded === 0 ? "" : rounded < 0 ? "-" : "+";
  const abs = Math.abs(rounded);
  const whole = Math.floor(abs);
  const cents = Math.round((abs - whole) * 100);
  const grouped = whole.toLocaleString("en-US");
  const body = cents === 0 ? grouped : `${grouped}.${String(cents).padStart(2, "0")}`;
  return `${sign}$${body}`;
}

/** Everything the risk builder needs; every value is server-authoritative. */
export interface AccountRiskLevelsInput {
  /** The three configured monetary allowances, straight from the server. */
  readonly risk: AccountRiskInput;
  /**
   * Dollars of daily-loss budget still available, or null when the server could
   * not compute it. Defaults to the full limit when the caller has no budget.
   */
  readonly dailyLossRemaining?: number | null;
  /** Dollars of drawdown buffer still available, or null when unknown. */
  readonly drawdownRemaining?: number | null;
  /** Live overlays for the CURRENT chart instrument (sensitivity source). */
  readonly overlays: readonly LiveTradeOverlay[];
  /** The chart's current epic. */
  readonly chartEpic: string | null | undefined;
}

/**
 * Build the three informational account-risk overlays **for the chart**.
 *
 * PRODUCT RULE — these are NOT standalone chart indicators. The account's
 * configured limits are projected onto the chart ONLY while at least one OPEN
 * live position applies to the CURRENT instrument — the SAME
 * {@link liveTradesForEpic} result the live-position renderer is fed (see
 * `hasApplicableLivePosition`; no stricter, second test of its own). With no
 * such position this returns an EMPTY list: the chart must look completely
 * normal, with no risk lines, no risk pills and no risk price-scale tags,
 * however the account is configured.
 *
 * Each returned level ALWAYS carries its authoritative monetary amount. A
 * price-axis level is attached only when {@link deriveThresholdPrice} can solve
 * a single price from proven sensitivity on this instrument; otherwise the
 * level is monetary-only (D3) and the renderer draws NOTHING for it — no line,
 * no pill, no tag, never a floating label parked in a corner. Levels are
 * informational data — there is no callback and no mutable state, so they
 * cannot be dragged or edited into a new target.
 *
 * The solved price is the level at which the OPEN BOOK's floating P&L reaches
 * the threshold, which is the only price quantity that is actually derivable
 * from per-position sensitivity.
 */
export function buildAccountRiskOverlays(input: AccountRiskLevelsInput): RiskLevelOverlay[] {
  const epic = (input.chartEpic ?? "").trim().toUpperCase();
  // The applicable-position gate is the SAME predicate App.tsx uses, applied
  // here as well so no caller can ever project account limits as permanent
  // chart decorations.
  if (!hasApplicableLivePosition(input.overlays, epic)) return [];

  const legs = riskLegsForEpic(input.overlays, epic);
  const out: RiskLevelOverlay[] = [];

  const push = (
    kind: RiskLevelKind,
    title: string,
    amount: number | null,
    moneyDelta: number | null,
  ): void => {
    const price = moneyDelta === null ? null : deriveThresholdPrice(moneyDelta, legs);
    out.push({
      kind,
      label: `${title}  ${formatRiskAmount(amount)}`,
      amount,
      price,
      priceSource: price === null ? "undrawable" : "derived",
    });
  };

  // Each account threshold is converted ONCE into the open-book P&L required
  // at that threshold, then handed to the unchanged sensitivity solver.
  const initialBalance = input.risk.initialBalance;
  const profitTarget = input.risk.profitTargetAmount;
  const dailyFloor = input.risk.dailyLossFloor;
  const drawdownFloor = input.risk.maxDrawdownFloor;

  // PROFIT TARGET is an ABSOLUTE account value, not a further delta: the account
  // is expected to REACH initial_balance + target, so only the shortfall from the
  // current balance still has to be earned by the open book. The DB realized-P&L
  // sum is deliberately NOT used — it can be stale against MT5's own deal ledger.
  const profitBookPnl =
    initialBalance === null || profitTarget === null || input.risk.balance === null
      ? null
      : initialBalance + profitTarget - input.risk.balance;
  push("profitTarget", "PROFIT TARGET", profitTarget, profitBookPnl);

  // The session floor is an absolute account value. Current open-book P/L is
  // already represented by the entry-to-price equation, so subtract the current
  // realized account balance (not floating "remaining" amounts).
  const dailyBookPnl =
    dailyFloor === null || input.risk.balance === null
      ? null
      : dailyFloor - input.risk.balance;
  push("dailyLoss", "DAILY LOSS", input.risk.dailyLossLimit === null ? null : -Math.abs(input.risk.dailyLossLimit), dailyBookPnl);

  // The configured basis decides which current account value anchors the floor.
  // Equity already includes floating P/L, so remove that open-book amount before
  // handing the baseline to the unchanged entry-to-price sensitivity equation.
  // This prevents the current floating P/L from being counted twice.
  const drawdownBaseline = input.risk.drawdownBasis === "equity"
    ? input.risk.equity === null || input.risk.floatingPnl === null
      ? null
      : input.risk.equity - input.risk.floatingPnl
    : input.risk.balance;
  const drawdownBookPnl =
    drawdownFloor === null || drawdownBaseline === null
      ? null
      : drawdownFloor - drawdownBaseline;
  push("maxDrawdown", "MAX DRAWDOWN", input.risk.maxDrawdown === null ? null : -Math.abs(input.risk.maxDrawdown), drawdownBookPnl);

  return out;
}
