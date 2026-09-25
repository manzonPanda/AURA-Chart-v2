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

// ── Account risk levels (PROFIT TARGET / DAILY LOSS / MAX DRAWDOWN) ──

/** The three informational account-risk overlays, in display order. */
export type RiskLevelKind = "profitTarget" | "dailyLoss" | "maxDrawdown";

/** The authoritative monetary values, straight from the server (never derived). */
export interface AccountRiskInput {
  /** initial_balance × profit_target_percent/100, or null when unconfigured. */
  readonly profitTargetAmount: number | null;
  /** initial_balance × daily_loss_limit_percent/100, or null. */
  readonly dailyLossLimit: number | null;
  /** initial_balance × max_total_drawdown_percent/100, or null. */
  readonly maxDrawdown: number | null;
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

  // PROFIT TARGET: the price at which the open book is up by the target amount.
  const target = input.risk.profitTargetAmount;
  push("profitTarget", "PROFIT TARGET", target, target === null ? null : Math.abs(target));

  // DAILY LOSS: the price at which the open book would consume the remaining
  // daily budget (a negative money delta for a BUY book).
  const dailyBudget = input.dailyLossRemaining ?? input.risk.dailyLossLimit;
  const dailyLimit = input.risk.dailyLossLimit;
  const dailyAmount = dailyLimit === null ? null : -(input.dailyLossRemaining ?? dailyLimit);
  push("dailyLoss", "DAILY LOSS", dailyAmount, dailyBudget === null ? null : -Math.abs(dailyBudget));

  // MAX DRAWDOWN: same shape, against the remaining drawdown buffer.
  const drawdownBuffer = input.drawdownRemaining ?? input.risk.maxDrawdown;
  const maxDrawdown = input.risk.maxDrawdown;
  const drawdownAmount = maxDrawdown === null ? null : -(input.drawdownRemaining ?? maxDrawdown);
  push("maxDrawdown", "MAX DRAWDOWN", drawdownAmount, drawdownBuffer === null ? null : -Math.abs(drawdownBuffer));

  return out;
}
