/**
 * Moving Average Structure engine — pure, framework-free, unit-testable.
 *
 * Mirrors the existing ema.ts / sma.ts modules: independent of React,
 * CandleKit, Lightweight Charts and localStorage. The engine consumes already-
 * computed indicator VALUES (it never recalculates EMA/SMA itself — the chart
 * panel feeds it from services/ema.ts + services/sma.ts), so the exact same
 * classification can later drive the alert engine server-side:
 *
 *   candles → calculateEMA(9) / calculateEMA(20) / calculateSMA(20)
 *           → evaluateMaStructure() → structure + live pair relationships
 *
 * ── SIX STRUCTURAL STATES ────────────────────────────────────────────────────
 * The state is the strict ordering of EMA9 / EMA20 / SMA20 (exhaustive when the
 * three values are distinct):
 *
 *   BULLISH            EMA9 > EMA20 > SMA20   (confirmed)
 *   BULLISH_WEAKENING  EMA9 > SMA20 > EMA20   (intermediate)
 *   BEARISH_HOLDING    SMA20 > EMA9 > EMA20   (intermediate — EMA9 reclaims
 *                                             EMA20 while BOTH sit under SMA20)
 *   BEARISH            SMA20 > EMA20 > EMA9   (confirmed)
 *   BEARISH_WEAKENING  EMA20 > SMA20 > EMA9   (intermediate)
 *   BULLISH_HOLDING    EMA20 > EMA9 > SMA20   (intermediate — EMA9 loses EMA20
 *                                             while BOTH sit above SMA20)
 *
 * Natural cycle (no extra top-level states exist):
 *   BULLISH → BULLISH_WEAKENING → BEARISH_HOLDING → BEARISH
 *   BEARISH → BEARISH_WEAKENING → BULLISH_HOLDING → BULLISH
 *
 * ── EQUALITY / NEAR-EQUALITY ─────────────────────────────────────────────────
 * The six states assume distinct values. A small internal epsilon collapses
 * near-equal pairs deterministically instead of inventing CROSSING/NEUTRAL/
 * EQUAL states: on a tie the fixed identity priority EMA9 > EMA20 > SMA20
 * decides which series ranks above. Provably safe: for ANY near-equal pair the
 * two candidate orderings map to cycle-ADJACENT structures (e.g. EMA9≈EMA20
 * with SMA20 below → BULLISH vs BULLISH_HOLDING), so the classification can
 * never jump across the cycle because of float noise.
 *
 * ── LIVE RELATIONSHIPS / GAP TREND ──────────────────────────────────────────
 * Each pair (EMA9/EMA20, EMA9/SMA20, EMA20/SMA20) exposes:
 *   signedGap     = first − second          (direction)
 *   distance      = |signedGap|             (crossover proximity)
 *   distanceDelta = current − previous      (per closed candle)
 *   gapTrend      = least-squares slope over the last GAP_TREND_WINDOW closed
 *                   candles → NARROWING | WIDENING | FLAT
 *
 * "NEARING" means the distance is genuinely decreasing toward a crossover —
 * never merely that the gap is numerically small, and never a percentage-of-
 * price threshold. One committed sample per CLOSED candle (forming-bucket
 * updates replace in place) makes the trend immune to single-tick noise.
 *
 * ── SLOPE / CONVERGENCE ────────────────────────────────────────────────────
 * Per-MA slope (calculateSlope) reads the CURRENT vs PREVIOUS indicator value
 * of the selected-timeframe series — actual indicator movement, never candle
 * direction — and reports only the clean trader glyphs ↗ / ↘ / --.
 *
 * Pair convergence (gapConvergence) normalizes the current distance against
 * the pair's OWN recent closed-bucket gap max: 1 − current/max(recent),
 * clamped to [0,1]. Each pair folds its own samples, so EMA9/EMA20 magnitudes
 * can never calibrate EMA20/SMA20 — and there is no probability metric; the
 * bar is purely "how close to the recent gap range". Fresh states SEED the
 * closed-bucket window from the loaded series so history load renders the
 * visual immediately.
 *
 * The user-facing vocabulary is directional only (BULLISH / BULLISH NEARING /
 * BEARISH / BEARISH NEARING); technical labels (ABOVE/BELOW/CROSSED) never
 * leave this module.
 */

/** The three series whose ordering defines the structure. */
export type MaSeriesId = "EMA9" | "EMA20" | "SMA20";

/** The six exhaustive structural states (distinct values assumed). */
export type MaStructureState =
  | "BULLISH"
  | "BULLISH_WEAKENING"
  | "BEARISH_HOLDING"
  | "BEARISH"
  | "BEARISH_WEAKENING"
  | "BULLISH_HOLDING";

/** The three tracked pairs, in fixed display order. */
export type MaPairKey = "EMA9_EMA20" | "EMA9_SMA20" | "EMA20_SMA20";

/** Whether a pair's gap is closing, opening, or statistically unchanged. */
export type GapTrend = "NARROWING" | "WIDENING" | "FLAT";

/** Trader-facing relationship status — directional vocabulary only. */
export type RelationshipStatus =
  | "BULLISH"
  | "BULLISH_NEARING"
  | "BEARISH"
  | "BEARISH_NEARING";

/** UI tone for coloring (the engine carries it so the panel stays dumb). */
export type MaTone = "bull" | "bear" | "warn";

/** Structural periods — the structure is DEFINED by these exact periods. */
export const MA_STRUCTURE_EMA_FAST = 9;
export const MA_STRUCTURE_EMA_SLOW = 20;
export const MA_STRUCTURE_SMA_PERIOD = 20;

/**
 * Internal equality tolerance. Pure float-noise scale (prices tick at 0.1+);
 * two values within this distance are "equal" and resolve via the fixed
 * tie-break instead of flickering between orderings.
 */
export const DEFAULT_STRUCTURE_EPSILON = 1e-9;

/** Committed (closed-candle) distances kept per pair for the trend slope. */
export const GAP_TREND_WINDOW = 8;

/**
 * The natural structural progression, forward and reverse. Index adjacency in
 * this array IS structural adjacency — the guarantee that makes the epsilon
 * tie-break stable (ties can only flip the state between neighbors).
 */
/** Minimal distance between two states on the cycle (0 = same, 3 = opposite). */
export function structureCycleDistance(from: MaStructureState, to: MaStructureState): number {
  const i = STRUCTURE_CYCLE.indexOf(from);
  const j = STRUCTURE_CYCLE.indexOf(to);
  if (i < 0 || j < 0) return Number.NaN;
  const forward = (j - i + STRUCTURE_CYCLE.length) % STRUCTURE_CYCLE.length;
  return Math.min(forward, STRUCTURE_CYCLE.length - forward);
}

// ── Structural classification ────────────────────────────────────────────────

/** Fixed tie-break priority: on a near-equal tie the earlier series ranks above. */
const TIE_PRIORITY: Record<MaSeriesId, number> = { EMA9: 0, EMA20: 1, SMA20: 2 };

/** Every strict ordering of the three series maps to exactly one state. */
const ORDERING_TO_STATE: Record<string, MaStructureState> = {
  "EMA9>EMA20>SMA20": "BULLISH",
  "EMA9>SMA20>EMA20": "BULLISH_WEAKENING",
  "SMA20>EMA9>EMA20": "BEARISH_HOLDING",
  "SMA20>EMA20>EMA9": "BEARISH",
  "EMA20>SMA20>EMA9": "BEARISH_WEAKENING",
  "EMA20>EMA9>SMA20": "BULLISH_HOLDING",
};

/** Does `a` rank above `b`? Strict by value, tie-broken by fixed identity priority. */
function ranksAbove(a: [MaSeriesId, number], b: [MaSeriesId, number], eps: number): boolean {
  if (a[1] > b[1] + eps) return true;
  if (b[1] > a[1] + eps) return false;
  return TIE_PRIORITY[a[0]] < TIE_PRIORITY[b[0]];
}

/** Order the three series descending by value (eps ties → fixed priority). */
function resolveOrdering(
  ema9: number,
  ema20: number,
  sma20: number,
  eps: number,
): MaSeriesId[] {
  const entries: [MaSeriesId, number][] = [
    ["EMA9", ema9],
    ["EMA20", ema20],
    ["SMA20", sma20],
  ];
  // Insertion sort over exactly three elements — deterministic even if the
  // epsilon comparator is not a strict weak order across the triple.
  for (let i = 1; i < entries.length; i++) {
    const cur = entries[i];
    let j = i - 1;
    while (j >= 0 && ranksAbove(cur, entries[j], eps)) {
      entries[j + 1] = entries[j];
      j -= 1;
    }
    entries[j + 1] = cur;
  }
  return entries.map((e) => e[0]);
}

/** True when all three values are present and finite (runtime safety net). */
function isTripleFinite(
  ema9: number,
  ema20: number,
  sma20: number,
): boolean {
  return Number.isFinite(ema9) && Number.isFinite(ema20) && Number.isFinite(sma20);
}

/**
 * Classify the structural state from the three indicator values.
 *
 * Returns null ONLY when any value is missing/non-finite (insufficient
 * history). Finite inputs always yield one of the six states — near-equal
 * values collapse deterministically (see the module header), never into an
 * extra state.
 */
export function classifyStructure(
  ema9: number | null,
  ema20: number | null,
  sma20: number | null,
  eps: number = DEFAULT_STRUCTURE_EPSILON,
): MaStructureState | null {
  if (ema9 === null || ema20 === null || sma20 === null) return null;
  if (!isTripleFinite(ema9, ema20, sma20)) return null;
  const ordering = resolveOrdering(ema9, ema20, sma20, eps);
  return ORDERING_TO_STATE[ordering.join(">")];
}

/**
 * The ordering equation as a trader-facing label, e.g. "EMA9 > EMA20 > SMA20".
 * Uses the same tie-break as `classifyStructure`, so label and state always
 * agree. Returns null for missing/non-finite values.
 */
export function structureOrderLabel(
  ema9: number | null,
  ema20: number | null,
  sma20: number | null,
  eps: number = DEFAULT_STRUCTURE_EPSILON,
): string | null {
  if (ema9 === null || ema20 === null || sma20 === null) return null;
  if (!isTripleFinite(ema9, ema20, sma20)) return null;
  return resolveOrdering(ema9, ema20, sma20, eps).join(" > ");
}

export const STRUCTURE_CYCLE: readonly MaStructureState[] = [
  "BULLISH",
  "BULLISH_WEAKENING",
  "BEARISH_HOLDING",
  "BEARISH",
  "BEARISH_WEAKENING",
  "BULLISH_HOLDING",
];

// ── Pairwise gaps ────────────────────────────────────────────────────────────

/** Signed gap + absolute distance for one pair (first − second). */
export interface PairGap {
  signedGap: number;
  distance: number;
}

export function pairwiseGap(first: number, second: number): PairGap {
  const signedGap = first - second;
  return { signedGap, distance: Math.abs(signedGap) };
}

// ── Indicator slope (per-MA direction, from the indicator series) ────────────

/** Trader-facing MA slope glyph — clean symbols, no technical wording. */
export type MaSlope = "↗" | "↘" | "--";

/**
 * Slope of one indicator from its CURRENT vs PREVIOUS value — actual indicator
 * movement (never candle direction). A small deterministic epsilon collapses
 * float-noise differences (the same convention as the structure classifier) so
 * the glyph never flickers ┌↗↘↗↘┐ on pure arithmetic jitter; there is no
 * percentage-of-price or relative threshold anywhere.
 */
export function calculateSlope(
  current: number | null,
  previous: number | null,
  eps: number = DEFAULT_STRUCTURE_EPSILON,
): MaSlope {
  if (current === null || previous === null) return "--";
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return "--";
  if (Math.abs(current - previous) <= eps) return "--";
  return current > previous ? "↗" : "↘";
}

// ── Gap trend (distance history, one sample per CLOSED candle) ──────────────

/** Per-pair gap sample state. `forming` is the live bucket's distance. */
export interface GapSampleState {
  /** Distances of the last closed candles (ascending time), capped at the window. */
  samples: number[];
  /** Distance of the currently forming bucket (replaced in place per tick). */
  forming: number | null;
  /** Bucket start (epoch ms) of `forming` — the sample clock. */
  ts: number | null;
}

export function emptyGapSamples(): GapSampleState {
  return { samples: [], forming: null, ts: null };
}

/**
 * Fold one distance sample into the history, keyed by bucket start:
 *   - new bucket  → commit the previous forming distance, start a new one;
 *   - same bucket → replace the forming distance (per-tick updates never
 *                   multiply samples — single-tick noise cannot create trend);
 *   - older ts    → RESET (history reload / refresh / replay seek — the past
 *                   can never be folded into the present's trend window).
 */
export function updateGapSamples(
  prev: GapSampleState,
  ts: number,
  distance: number,
): GapSampleState {
  if (!Number.isFinite(ts) || !Number.isFinite(distance)) return prev;
  if (prev.ts === null || ts < prev.ts) {
    // Seed, or a backward jump (history replace / replay seek) → fresh window.
    return { samples: [], forming: distance, ts };
  }
  if (ts === prev.ts) {
    // Same bucket → replace in place (history continuity across reloads).
    return { samples: prev.samples, forming: distance, ts };
  }
  // Bucket rollover → commit the closed bucket's final distance.
  const samples =
    prev.forming === null
      ? prev.samples
      : [...prev.samples, prev.forming].slice(-GAP_TREND_WINDOW);
  return { samples, forming: distance, ts };
}

// ── Series seeding (history load / stream reset → ready-to-render visuals) ───

/** One indicator sample (ascending ts) — the engine consumes VALUES only. */
export interface MaSeriesPoint {
  ts: number;
  value: number;
}

/** Per-MA indicator series handed in by the panel (same arrays it lastValue()s). */
export type MaSeriesInput = Readonly<Partial<Record<MaSeriesId, readonly MaSeriesPoint[]>>>;

/** Pristine = never seeded and never folded (fresh stream / page load). */
function isPristineGapSamples(state: GapSampleState): boolean {
  return state.ts === null && state.forming === null && state.samples.length === 0;
}

/**
 * Fold the CLOSED buckets already present in two indicator series into one
 * pair's gap window, leaving the LAST shared bucket as the forming sample.
 * One distance per shared bucket (aligned by ts). Returns null when the two
 * series never share a finite bucket.
 */
function seedGapSamples(
  a: readonly MaSeriesPoint[],
  b: readonly MaSeriesPoint[],
): GapSampleState | null {
  let i = 0;
  let j = 0;
  const closed: number[] = [];
  let lastTs: number | null = null;
  let lastDistance: number | null = null;
  while (i < a.length && j < b.length) {
    const ta = a[i].ts;
    const tb = b[j].ts;
    if (ta < tb) {
      i += 1;
      continue;
    }
    if (tb < ta) {
      j += 1;
      continue;
    }
    if (Number.isFinite(ta) && Number.isFinite(a[i].value) && Number.isFinite(b[j].value)) {
      if (lastTs !== null) closed.push(lastDistance as number);
      lastTs = ta;
      lastDistance = Math.abs(a[i].value - b[j].value);
    }
    i += 1;
    j += 1;
  }
  if (lastTs === null || lastDistance === null) return null;
  return {
    samples: closed.slice(-GAP_TREND_WINDOW),
    forming: lastDistance,
    ts: lastTs,
  };
}

/**
 * Seed every PRISTINE pair from the loaded indicator series. This is what lets
 * history load / refresh provide enough gap history for the trend + convergence
 * visuals on FIRST paint instead of after N live buckets. States that were
 * already folded or that were reset by a backward ts jump are left untouched,
 * so live folds, Load-More continuity and replay seek resets behave exactly as
 * before — the seed only ever fills a truly fresh history.
 */
export function seedGapHistory(
  history: MaGapHistory,
  series: MaSeriesInput,
): MaGapHistory {
  const next = { ...history };
  for (const { key, first, second } of PAIRS) {
    if (!isPristineGapSamples(next[key])) continue;
    const a = series[first];
    const b = series[second];
    if (!a || !b) continue;
    const seeded = seedGapSamples(a, b);
    if (seeded !== null) next[key] = seeded;
  }
  return next;
}

/**
 * Gap trend over a window of distances via least-squares slope, with a
 * noise-aware significance test: the fitted change across the window
 * (|slope| · (n−1)) must EXCEED the window's own jitter (max residual) before
 * a direction is reported. This is what makes the status robust — noise
 * oscillating around a level reads FLAT instead of flickering NARROWING/
 * WIDENING, while any clean monotone drift (however small in points, e.g. a
 * single-sample step) classifies purely by the slope's sign. There is no
 * percentage-of-price threshold anywhere: the comparison is between the
 * window's systematic change and the window's own noise.
 */
export function gapTrend(distances: readonly number[]): { trend: GapTrend; slope: number } {
  const n = distances.length;
  if (n < 2) return { trend: "FLAT", slope: 0 };
  // x = 0..n-1; slope = Σ(x−x̄)(y−ȳ) / Σ(x−x̄)²  with Σ(x−x̄)² = n(n²−1)/12.
  let mean = 0;
  for (const d of distances) mean += d;
  mean /= n;
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (i - (n - 1) / 2) * (distances[i] - mean);
  const varX = (n * (n * n - 1)) / 12;
  const slope = cov / varX;
  // Jitter of the window around the fitted line.
  let maxResidual = 0;
  for (let i = 0; i < n; i++) {
    const fit = mean + slope * (i - (n - 1) / 2);
    const residual = Math.abs(distances[i] - fit);
    if (residual > maxResidual) maxResidual = residual;
  }
  const totalChange = Math.abs(slope) * (n - 1);
  if (totalChange <= maxResidual + 1e-12) return { trend: "FLAT", slope };
  return slope < 0 ? { trend: "NARROWING", slope } : { trend: "WIDENING", slope };
}

/**
 * Pair convergence = where the CURRENT distance sits relative to the pair's OWN
 * recent closed-bucket gap history (the max of that window):
 *
 *   convergence = clamp(1 − current / max(recent), 0, 1)
 *
 *   0 → the gap is at its recent widest (nothing to show) — divergence/absent;
 *   1 → the gap has collapsed toward its recent tightest — converged.
 *
 * Normalization is per-pair by construction (each pair folds its own samples),
 * so EMA9/EMA20 magnitudes can never calibrate EMA20/SMA20. This is NOT a
 * probability or a cross probability — it is only "how close relative to the
 * recent observed range". A small-but-widening gap scores 0 because it sits at
 * (or beyond) the recent max. Returns null when there is no recent closed
 * history to calibrate against (first bucket / fresh window).
 */
export function gapConvergence(
  recent: readonly number[],
  current: number | null,
): number | null {
  if (current === null || !Number.isFinite(current) || recent.length === 0) return null;
  let recentMax = 0;
  for (const d of recent) {
    if (Number.isFinite(d) && d > recentMax) recentMax = d;
  }
  if (recentMax <= 0) return 1; // every recent closed gap was zero → already as close as possible
  return Math.max(0, Math.min(1, 1 - current / recentMax));
}

// ── Relationship status (trader-facing vocabulary) ──────────────────────────

/**
 * Direction from a signed gap: first above second reads BULLISH for all three
 * pairs (EMA9/EMA20, EMA9/SMA20, EMA20/SMA20). Near-equality (within eps) has
 * no direction — the UI shows the absence of one, never a fake label.
 */
export function pairDirection(
  signedGap: number,
  eps: number = DEFAULT_STRUCTURE_EPSILON,
): "BULLISH" | "BEARISH" | null {
  if (!Number.isFinite(signedGap)) return null;
  if (signedGap > eps) return "BULLISH";
  if (signedGap < -eps) return "BEARISH";
  return null;
}

/**
 * Status = direction + gap trend. NEARING only when the distance is genuinely
 * decreasing (NARROWING) — a small-but-widening gap is NOT nearing.
 */
export function relationshipStatus(
  direction: "BULLISH" | "BEARISH" | null,
  trend: GapTrend,
): RelationshipStatus | null {
  if (direction === null) return null;
  if (trend === "NARROWING") {
    return direction === "BULLISH" ? "BULLISH_NEARING" : "BEARISH_NEARING";
  }
  return direction;
}

const RELATIONSHIP_META: Record<RelationshipStatus, { label: string; dot: string; tone: MaTone }> = {
  BULLISH: { label: "BULLISH", dot: "🟢", tone: "bull" },
  BULLISH_NEARING: { label: "BULLISH NEARING", dot: "🟠", tone: "warn" },
  BEARISH: { label: "BEARISH", dot: "🔴", tone: "bear" },
  BEARISH_NEARING: { label: "BEARISH NEARING", dot: "🟠", tone: "warn" },
};

const STRUCTURE_META: Record<MaStructureState, { label: string; dot: string; tone: MaTone }> = {
  BULLISH: { label: "BULLISH", dot: "🟢", tone: "bull" },
  BULLISH_WEAKENING: { label: "BULLISH WEAKENING", dot: "🟠", tone: "warn" },
  BEARISH_HOLDING: { label: "BEARISH HOLDING", dot: "🟠", tone: "warn" },
  BEARISH: { label: "BEARISH", dot: "🔴", tone: "bear" },
  BEARISH_WEAKENING: { label: "BEARISH WEAKENING", dot: "🟠", tone: "warn" },
  BULLISH_HOLDING: { label: "BULLISH HOLDING", dot: "🟠", tone: "warn" },
};



// ── Evaluation (single per-frame entry point) ────────────────────────────────

/** The three indicator values for one bucket (null = insufficient history). */
export interface MaTriple {
  ema9: number | null;
  ema20: number | null;
  sma20: number | null;
}

/** Per-pair gap sample state, keyed by pair. */
export type MaGapHistory = Record<MaPairKey, GapSampleState>;

export function emptyGapHistory(): MaGapHistory {
  return {
    EMA9_EMA20: emptyGapSamples(),
    EMA9_SMA20: emptyGapSamples(),
    EMA20_SMA20: emptyGapSamples(),
  };
}

/** One pair's live relationship (null fields = direction not established). */
export interface PairRelationship {
  pair: MaPairKey;
  firstLabel: MaSeriesId;
  secondLabel: MaSeriesId;
  /** first − second (points; sign = direction). */
  signedGap: number;
  /** |signedGap| — how close the pair is to crossing. */
  distance: number;
  /** current − previous committed candle distance (null = first sample). */
  distanceDelta: number | null;
  gapTrend: GapTrend;
  /** True only when the gap is genuinely narrowing toward a crossover. */
  nearing: boolean;
  status: RelationshipStatus | null;
  label: string | null;
  dot: string | null;
  tone: MaTone | null;
  /** Per-MA slope glyphs (from the indicator series, not candle price). */
  firstSlope: MaSlope;
  secondSlope: MaSlope;
  /** [0,1] — how close to the pair's own recent gap max; null = no recent history. */
  convergence: number | null;
}

/** Everything the panel renders for one bucket — no React types in here. */
export interface MaStructureSnapshot {
  structure: MaStructureState | null;
  structureLabel: string | null;
  structureDot: string | null;
  structureTone: MaTone | null;
  orderLabel: string | null;
  relationships: readonly (PairRelationship | null)[];
}

export interface MaStructureEvaluation {
  snapshot: MaStructureSnapshot;
  /** Folded history — persist and pass back on the next call. */
  history: MaGapHistory;
}

export interface MaStructureInput extends MaTriple {
  /** Bucket start (epoch ms) of the values — the sample clock. */
  ts: number | null;
  /** History from the previous evaluation (emptyGapHistory() to start). */
  history: MaGapHistory;
  /**
   * Optional selected-timeframe indicator series (the SAME arrays the panel
   * takes the last values from). Powers per-MA slope (current vs previous
   * point) and seeds a fresh history's closed-bucket gap window so the trend +
   * convergence visuals are ready on first paint. Absent for engine callers
   * that only classify values: slopes read "--" and history is never seeded.
   */
  series?: MaSeriesInput;
}

/**
 * Fixed pair display order — the ONE source of truth for the three tracked
 * pairs. The panel keys its rows by THIS identity (not by a placeholder) so a
 * pending row keeps the same key as the real row it becomes. Exported for the
 * panel + tests; `PAIRS` below must stay in exactly this order.
 */
export const MA_PAIR_KEYS: readonly MaPairKey[] = [
  "EMA9_EMA20",
  "EMA9_SMA20",
  "EMA20_SMA20",
];

/** Fixed pair order (first reads bullish when above second). */
const PAIRS: readonly { key: MaPairKey; first: MaSeriesId; second: MaSeriesId }[] = [
  { key: "EMA9_EMA20", first: "EMA9", second: "EMA20" },
  { key: "EMA9_SMA20", first: "EMA9", second: "SMA20" },
  { key: "EMA20_SMA20", first: "EMA20", second: "SMA20" },
];

const SERIES_VALUE: Record<MaSeriesId, (t: MaTriple) => number | null> = {
  EMA9: (t) => t.ema9,
  EMA20: (t) => t.ema20,
  SMA20: (t) => t.sma20,
};

/**
 * Evaluate one bucket: structure + the three live relationships, folding the
 * gap history forward. Pure — pass `evaluation.history` back on the next call.
 *
 * Pairs with missing values keep their history untouched (the sample clock
 * only advances when a real distance exists), so a brief indicator warm-up
 * cannot corrupt the trend window.
 */
export function evaluateMaStructure(input: MaStructureInput): MaStructureEvaluation {
  const { ema9, ema20, sma20, ts, history, series } = input;
  const triple: MaTriple = { ema9, ema20, sma20 };

  const structure = classifyStructure(ema9, ema20, sma20);
  const structureMeta = structure !== null ? STRUCTURE_META[structure] : null;
  const orderLabel = structureOrderLabel(ema9, ema20, sma20);

  // Fresh (pristine) histories seed their closed-bucket gap windows from the
  // loaded series, so trend/convergence render immediately after history load
  // or a stream reset. Already-folded / reset-by-backward-jump states keep their
  // exact previous semantics (the seed never touches them).
  const nextHistory = series !== undefined ? seedGapHistory(history, series) : { ...history };

  const slopeOf = (id: MaSeriesId): MaSlope => {
    const points = series?.[id];
    if (!points || points.length < 2) return "--";
    return calculateSlope(
      points[points.length - 1].value,
      points[points.length - 2].value,
    );
  };

  const relationships = PAIRS.map(({ key, first, second }): PairRelationship | null => {
    const firstValue = SERIES_VALUE[first](triple);
    const secondValue = SERIES_VALUE[second](triple);
    if (
      firstValue === null || secondValue === null ||
      !Number.isFinite(firstValue) || !Number.isFinite(secondValue) ||
      ts === null || !Number.isFinite(ts)
    ) {
      return null; // insufficient history — pair hidden, its samples untouched
    }
    const { signedGap, distance } = pairwiseGap(firstValue, secondValue);
    const samples = updateGapSamples(nextHistory[key], ts, distance);
    nextHistory[key] = samples;

    const window =
      samples.forming === null ? samples.samples : [...samples.samples, samples.forming];
    const { trend } = gapTrend(window);
    const distanceDelta =
      samples.forming !== null && samples.samples.length > 0
        ? samples.forming - samples.samples[samples.samples.length - 1]
        : null;
    const direction = pairDirection(signedGap);
    const status = relationshipStatus(direction, trend);
    const meta = status !== null ? RELATIONSHIP_META[status] : null;
    return {
      pair: key,
      firstLabel: first,
      secondLabel: second,
      signedGap,
      distance,
      distanceDelta,
      gapTrend: trend,
      nearing: trend === "NARROWING" && direction !== null,
      status,
      label: meta !== null ? meta.label : null,
      dot: meta !== null ? meta.dot : null,
      tone: meta !== null ? meta.tone : null,
      firstSlope: slopeOf(first),
      secondSlope: slopeOf(second),
      convergence: gapConvergence(samples.samples, samples.forming ?? distance),
    };
  });

  return {
    snapshot: {
      structure,
      structureLabel: structureMeta !== null ? structureMeta.label : null,
      structureDot: structureMeta !== null ? structureMeta.dot : null,
      structureTone: structureMeta !== null ? structureMeta.tone : null,
      orderLabel,
      relationships,
    },
    history: nextHistory,
  };
}
