/**
 * Pine `input.source()` normalization — the shared adapter that makes the
 * GENERIC `input(<price-series>, …)` form behave as a real source input.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS (root cause, probed against @heyphat/piner 0.13.0)
 *
 * TradingView treats `input(close, "Source")` as a price-source selector.
 * Piner does NOT: it classifies the generic `input()` overload as
 * `kind:"float"` (its `InputDecl.kind`) and code-generates it to
 * `$.input.auto(key, defval)` → `pickInput`, which returns a host override
 * RAW. Two consequences:
 *   1. AURA's `sanitizePinerInput` maps `float` → a NUMERIC field in the
 *      Inputs tab, so `fractal_SMA.pine`'s Source renders as a number box.
 *   2. A price-source string such as `"high"` is never resolved to a series
 *      (only `input.source(…)` → `resolveSourceInput` → `sourceByName` does
 *      that), so `ta.sma("high", n)` would be `na` even if a string arrived.
 *
 * The EXPLICIT `input.source(<series>, …)` form is classified as
 * `kind:"source"` and code-generates to `$.input.source(...)` →
 * `resolveSourceInput`, whose `sourceByName` resolves open/high/low/close/
 * hl2/hlc3/ohlc4 — the exact OHLC subset AURA exposes as `PRICE_SOURCES`.
 *
 * THE FIX: rewrite `input(<ohlc-leaf>, …)` → `input.source(<ohlc-leaf>, …)`
 * BEFORE compilation, at the single compile chokepoint. Both the import-time
 * metadata (which drives the Inputs-tab dropdown) and the live runtime run see
 * the SAME normalized source, so the metadata type and the executed math agree.
 *
 * This module has NO dependencies beyond `PRICE_SOURCES` (AURA's verified
 * price-source set), so importing it from either compile site adds no engine
 * weight and cannot form a cycle. Applied by `pinerCompile` (runtime) and
 * `compileImportedPine` (metadata).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { PRICE_SOURCES } from "./priceSource.ts";

/**
 * The OHLC builtin leaves AURA's price-source picker supports, longest-first
 * so the alternation never matches a shorter leaf that prefixes a longer one.
 * Derived from `PRICE_SOURCES` — the single source of truth — so the rewrite
 * set is exactly the set the UI dropdown offers (never an unsupported value).
 */
const SOURCE_LEAF_ALT = [...PRICE_SOURCES].sort((a, b) => b.length - a.length).join("|");

/**
 * One left-to-right scanner (String.raw, so backslashes are literal regex):
 *   1. double-quoted string     2. single-quoted string (defensive)
 *   3. `//` line comment        4. `/* … *\/` block comment
 *   5. the target: a bare `input(` (NOT `.input` / `xinput`) immediately
 *      followed by an OHLC leaf.
 *
 * Only alternative 5 carries a capture group (the leaf). The replace callback
 * rewrites alternative 5 and passes every other match through unchanged, so a
 * title like `"input(close)"` or a `// use input(close)` comment can never be
 * edited. `input.int/float/bool/…` and an already-correct `input.source(…)`
 * never match (a `.` or non-`(` follows `input`), so other input types and
 * re-runs are idempotent.
 */
const PINE_SOURCE_INPUT_RE = new RegExp(
  String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|//[^\n]*|/\*[\s\S]*?\*/|(?<![\w.])input\s*\(\s*(${SOURCE_LEAF_ALT})\b`,
  "g",
);

/**
 * Rewrite the generic `input(<ohlc-series>, …)` source form to the explicit
 * `input.source(<ohlc-series>, …)` form so Piner classifies it as a source and
 * resolves price-source overrides. Every other input kind — `input.int`,
 * `input.float`, `input.bool`, `input.color`, `input.string`, and an existing
 * `input.source` — is returned untouched. Idempotent: a second pass is a no-op.
 */
export function normalizeSourceInputs(source: string): string {
  if (typeof source !== "string" || source.length === 0) return source;
  return source.replace(PINE_SOURCE_INPUT_RE, (match: string, leaf: string | undefined) =>
    leaf ? `input.source(${leaf}` : match,
  );
}
